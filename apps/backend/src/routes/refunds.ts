/**
 * POST /api/refunds/claim
 *
 * Idempotent refund-claim endpoint (issue #153) that executes the refund
 * on-chain via Trustless Work (issue #252).
 *
 * Calling this endpoint twice with the same `refundId` returns 409 with
 * code REFUND_ALREADY_CLAIMED on the second call — unless the first on-chain
 * attempt failed, in which case the refund is retried.
 *
 * Retries are bounded (issue #329): a refund that keeps failing on-chain is
 * only auto-retried up to MAX_REFUND_RETRIES times. Once the budget is spent
 * the endpoint stops attempting the on-chain call and returns 409 with code
 * REFUND_NEEDS_MANUAL_INTERVENTION, a terminal state requiring an operator.
 *
 * Request body:
 *   {
 *     "refundId":       "string — unique idempotency key",
 *     "escrowId":       "string — Trustless Work escrow contract id (C...)",
 *     "refundTo":       "string — buyer's Stellar address receiving the refund",
 *     "amount":         "string | number — full disputed escrow balance",
 *     "escrowType":     "single-release | multi-release — default single-release",
 *     "milestoneIndex": "string — required for multi-release",
 *     "currency":       "string — optional, e.g. USDC",
 *     "claimedBy":      "string — optional, caller user-id"
 *   }
 *
 * Responses: 201 with `claim.status = "submitted"` and `claim.txHash`;
 * 502 REFUND_EXECUTION_FAILED if the chain rejected it;
 * 503 REFUND_EXECUTION_UNAVAILABLE if Trustless Work isn't configured;
 * 409 REFUND_NEEDS_MANUAL_INTERVENTION once the retry budget is exhausted.
 *
 * GET /api/refunds/claim/:refundId
 *
 * Returns the existing claim record or 404 if not yet claimed.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { refundService } from "../services/refund.service";
import { AppError } from "../middleware/errorHandler";
import { alertService } from "../services/alert.service";

export const refundsRouter = Router();

/**
 * Maximum number of on-chain attempts (initial + retries) for a single
 * refundId before the refund is parked in a terminal state (issue #329).
 */
export const MAX_REFUND_ATTEMPTS = 5;

const claimSchema = z.object({
  refundId: z.string().min(1, "refundId is required"),
  escrowId: z.string().min(1, "escrowId is required"),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  claimedBy: z.string().optional(),
  refundTo: z.string().regex(/^[GC][A-Z2-7]{55}$/, "refundTo must be a Stellar address"),
  escrowType: z.enum(["single-release", "multi-release"]).optional(),
  milestoneIndex: z.string().optional(),
});

// POST /api/refunds/claim
refundsRouter.post("/claim", async (req: Request, res: Response, next: NextFunction) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: {
        code: "REFUND_INVALID_PAYLOAD",
        message: "Invalid refund claim payload",
        details: parsed.error.flatten(),
      },
    });
  }

  try {
    const record = await refundService.claimRefund(parsed.data);
    return res.status(201).json({ success: true, claim: record });
  } catch (err) {
    if (err instanceof AppError && err.code === "REFUND_ALREADY_CLAIMED") {
      // Fetch original claim so the caller can get an idempotent response
      const existing = await refundService.getClaimStatus(parsed.data.refundId);
      return res.status(409).json({
        error: { code: err.code, message: err.message },
        claim: existing ?? null,
      });
    }

    // Retry budget exhausted (issue #329): the refund has failed on-chain too
    // many times. Stop attempting the on-chain call and surface a terminal
    // state that requires manual intervention.
    if (err instanceof AppError && err.code === "REFUND_RETRY_LIMIT_EXCEEDED") {
      const existing = await refundService.getClaimStatus(parsed.data.refundId);
      return res.status(409).json({
        error: {
          code: "REFUND_NEEDS_MANUAL_INTERVENTION",
          message:
            `Refund ${parsed.data.refundId} failed on-chain ${MAX_REFUND_ATTEMPTS} times ` +
            "and will not be retried automatically. Manual intervention is required.",
        },
        claim: existing ?? null,
      });
    }

    // A failed refund means someone is currently out money — raise a dedicated,
    // higher-urgency alert (issue #328) distinct from the general Sentry stream.
    await alertService.raiseCriticalAlert({
      kind: "refund_failure",
      summary: `Refund execution failed for refundId=${parsed.data.refundId}`,
      details: {
        refundId: parsed.data.refundId,
        escrowId: parsed.data.escrowId,
        refundTo: parsed.data.refundTo,
        amount: parsed.data.amount,
        currency: parsed.data.currency,
        claimedBy: parsed.data.claimedBy,
        errorCode: err instanceof AppError ? err.code : undefined,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });

    // Express 4 doesn't catch async throws — hand off to the global errorHandler
    // (maps REFUND_EXECUTION_FAILED → 502, REFUND_EXECUTION_UNAVAILABLE → 503).
    return next(err);
  }
});

// GET /api/refunds/claim/:refundId
refundsRouter.get("/claim/:refundId", async (req: Request, res: Response) => {
  const { refundId } = req.params;
  if (!refundId) {
    return res.status(400).json({
      error: { code: "REFUND_INVALID_PAYLOAD", message: "refundId param is required" },
    });
  }

  const record = await refundService.getClaimStatus(refundId);
  if (!record) {
    return res.status(404).json({
      error: { code: "REFUND_NOT_FOUND", message: `No claim found for refundId: ${refundId}` },
    });
  }

  return res.json({ claim: record });
});
