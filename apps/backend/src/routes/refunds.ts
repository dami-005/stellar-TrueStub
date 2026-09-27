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
 * 503 REFUND_EXECUTION_UNAVAILABLE if Trustless Work isn't configured.
 *
 * GET /api/refunds/claim/:refundId
 *
 * Returns the existing claim record or 404 if not yet claimed.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { refundService } from "../services/refund.service";
import { changelogService } from "../services/changelog.service";
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

  const { refundId, escrowId, escrowType, milestoneIndex } = parsed.data;

  // Enrich Sentry scope with the business identifiers for this refund so any
  // error reported below is immediately traceable to the specific refund.
  Sentry.setTag("route", "refunds.claim");
  Sentry.setTag("refundId", refundId);
  Sentry.setTag("escrowId", escrowId);
  Sentry.setContext("refund", {
    refundId,
    escrowId,
    escrowType: escrowType ?? "single-release",
    milestoneIndex: milestoneIndex ?? null,
    amount: parsed.data.amount ?? null,
    currency: parsed.data.currency ?? null,
    claimedBy: parsed.data.claimedBy ?? null,
  });

  try {
    const record = await refundService.claimRefund(parsed.data);

    // Permanent audit trail: record the refund submission in the changelog so
    // every refund attempt that reached the chain has an immutable entry.
    await changelogService.append({
      entityType: "refund",
      entityId: refundId,
      action: "refund.submitted",
      actor: parsed.data.claimedBy ?? null,
      metadata: {
        escrowId,
        escrowType: escrowType ?? "single-release",
        milestoneIndex: milestoneIndex ?? null,
        amount: parsed.data.amount ?? null,
        currency: parsed.data.currency ?? null,
        refundTo: parsed.data.refundTo,
        txHash: record.txHash ?? null,
        status: record.status,
      },
    });

    // A refund that is already completed on-chain gets a second, distinct
    // changelog entry so completion is independently auditable.
    if (record.status === "completed") {
      await changelogService.append({
        entityType: "refund",
        entityId: refundId,
        action: "refund.completed",
        actor: parsed.data.claimedBy ?? null,
        metadata: {
          escrowId,
          amount: parsed.data.amount ?? null,
          currency: parsed.data.currency ?? null,
          refundTo: parsed.data.refundTo,
          txHash: record.txHash ?? null,
        },
      });
    }

    return res.status(201).json({ success: true, claim: record });
  } catch (err) {
    if (err instanceof AppError && err.code === "REFUND_ALREADY_CLAIMED") {
      // Fetch original claim so the caller can get an idempotent response
      const existing = await refundService.getClaimStatus(refundId);
      return res.status(409).json({
        error: { code: err.code, message: err.message },
        claim: existing ?? null,
      });
    }

    // Record the specific failure step so the Sentry event pinpoints where the
    // refund flow broke (validation already passed at this point).
    Sentry.setContext("refund_failure", {
      step: "claimRefund",
      code: err instanceof AppError ? err.code : "UNKNOWN",
      message: err instanceof Error ? err.message : String(err),
    });
    Sentry.captureException(err);

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

  Sentry.setTag("route", "refunds.claim.status");
  Sentry.setTag("refundId", refundId);
  Sentry.setContext("refund", { refundId });

  const record = await refundService.getClaimStatus(refundId);
  if (!record) {
    return res.status(404).json({
      error: { code: "REFUND_NOT_FOUND", message: `No claim found for refundId: ${refundId}` },
    });
  }

  return res.json({ claim: record });
});
