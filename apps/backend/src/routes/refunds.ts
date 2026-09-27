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
 * The idempotency guard is scoped to the (`refundId`, `escrowId`) pair, not
 * `refundId` alone (issue #315). A `refundId` that is reused across two
 * different escrows (e.g. a client bug) is therefore rejected with 409
 * REFUND_ID_REUSED_ACROSS_ESCROWS instead of being silently cross-applied to
 * the wrong escrow's dispute.
 *
 * The `amount` is validated locally against the escrow's actual disputed
 * balance before the on-chain call is attempted (issue #316). A mismatched
 * amount is rejected with 400 REFUND_AMOUNT_MISMATCH and never reaches
 * Trustless Work, so we fail fast instead of relying solely on the
 * downstream API/contract to catch it.
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
 * 400 REFUND_AMOUNT_MISMATCH when `amount` doesn't equal the disputed balance;
 * 409 REFUND_ALREADY_CLAIMED for a second identical call against the same
 * escrow; 409 REFUND_ID_REUSED_ACROSS_ESCROWS when the same `refundId` is
 * reused against a different escrow;
 * 502 REFUND_EXECUTION_FAILED if the chain rejected it;
 * 503 REFUND_EXECUTION_UNAVAILABLE if Trustless Work isn't configured.
 *
 * GET /api/refunds/claim/:refundId
 *
 * Returns the existing claim record or 404 if not yet claimed.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { refundService } from "../services/refund.service";
import { AppError } from "../middleware/errorHandler";

export const refundsRouter = Router();

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

/**
 * Normalize an amount to a comparable numeric value.
 * Returns null when the value can't be parsed as a finite number.
 */
function normalizeAmount(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

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
    // Local pre-submission guard (issue #316): compare the requested amount
    // against the escrow's actual disputed balance before attempting the
    // on-chain call. Fail fast with 400 instead of relying on Trustless Work
    // / the contract to reject a mismatched amount downstream.
    const disputedBalance = await refundService.getDisputedBalance(parsed.data.escrowId);
    if (disputedBalance !== null) {
      const requested = normalizeAmount(parsed.data.amount);
      if (requested === null) {
        return res.status(400).json({
          error: {
            code: "REFUND_AMOUNT_MISMATCH",
            message: "amount is required and must equal the disputed escrow balance",
          },
        });
      }
      if (requested !== disputedBalance) {
        return res.status(400).json({
          error: {
            code: "REFUND_AMOUNT_MISMATCH",
            message: `amount (${requested}) does not equal the disputed escrow balance (${disputedBalance})`,
          },
        });
      }
    }

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
    if (err instanceof AppError && err.code === "REFUND_ID_REUSED_ACROSS_ESCROWS") {
      // The same refundId was already claimed against a different escrow.
      // Do NOT return the other escrow's claim — that would leak/cross-apply
      // a refund record to the wrong escrow (issue #315).
      return res.status(409).json({
        error: { code: err.code, message: err.message },
        claim: null,
      });
    }
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
