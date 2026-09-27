/**
 * Backend-only Trustless Work client (#252).
 *
 * Trustless Work's escrow endpoints never touch the chain themselves — they
 * return an unsigned Soroban transaction (XDR) that the role named in the
 * payload must sign. The backend holds the platform's dispute-resolver key, so
 * it can build → sign → submit a dispute resolution end to end:
 *
 *   1. POST /escrow/{type}/resolve-dispute        → { unsignedTransaction }
 *   2. sign the XDR with TRUSTLESS_WORK_DISPUTE_RESOLVER_SECRET
 *   3. POST /helper/send-transaction { signedXdr } → submitted to Stellar
 *
 * Endpoint paths and payload shapes mirror @trustless-work/escrow v2.0.8,
 * which the frontend uses for the same calls.
 */
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../config/env";

export type EscrowType = "single-release" | "multi-release";

export interface Distribution {
  /** Stellar address receiving funds. */
  address: string;
  /** Amount in the escrow's token units (not stroops). */
  amount: number;
}

export interface ResolveDisputeInput {
  contractId: string;
  escrowType: EscrowType;
  distributions: Distribution[];
  /** Required for multi-release escrows. */
  milestoneIndex?: string;
}

export interface SubmittedTransaction {
  txHash: string;
  status: string;
  message: string;
}

export interface TrustlessWorkClient {
  /** Resolves a dispute on-chain, moving escrowed funds per `distributions`. */
  resolveDispute(input: ResolveDisputeInput): Promise<SubmittedTransaction>;
}

export class TrustlessWorkError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TrustlessWorkError";
  }
}

export class TrustlessWorkNotConfiguredError extends Error {
  constructor() {
    super(
      "TRUSTLESS_WORK_API_KEY and TRUSTLESS_WORK_DISPUTE_RESOLVER_SECRET must be configured to execute refunds",
    );
    this.name = "TrustlessWorkNotConfiguredError";
  }
}

/**
 * Raised when a refund has exhausted its bounded retry budget (#329). Callers
 * should surface this as a terminal "needs manual intervention" state instead
 * of attempting the on-chain call again.
 */
export class TrustlessWorkRetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly maxAttempts: number,
    public readonly lastError?: string,
  ) {
    super(
      `Refund retry budget exhausted after ${attempts}/${maxAttempts} attempts; manual intervention required` +
        (lastError ? `: ${lastError}` : ""),
    );
    this.name = "TrustlessWorkRetryExhaustedError";
  }
}

/**
 * Maximum number of on-chain attempts (initial + retries) for a single refund
 * before the endpoint stops auto-retrying and reports a terminal state (#329).
 * Bounds the retry-on-failure path so a permanently-failing refund cannot
 * hammer Trustless Work's API indefinitely.
 */
export const MAX_REFUND_ATTEMPTS = 5;

/**
 * Base delay (ms) for exponential backoff between refund retries. The delay
 * grows as `base * 2^(attempt-1)` and is capped at MAX_REFUND_BACKOFF_MS.
 */
export const REFUND_RETRY_BASE_BACKOFF_MS = 1_000;
export const MAX_REFUND_BACKOFF_MS = 30_000;

/**
 * Returns the backoff delay (ms) to wait before the given attempt number
 * (1-based). Attempt 1 is the initial call and has no delay.
 */
export function refundRetryBackoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(REFUND_RETRY_BASE_BACKOFF_MS * 2 ** (attempt - 2), MAX_REFUND_BACKOFF_MS);
}

/**
 * Returns true when the refund has consumed its retry budget and must stop
 * auto-retrying. `attempts` is the number of on-chain attempts already made.
 */
export function isRefundRetryExhausted(attempts: number): boolean {
  return attempts >= MAX_REFUND_ATTEMPTS;
}

function requireTrustlessWorkConfig(): { apiUrl: string; apiKey: string; signer: Keypair; networkPassphrase: string } {
  const apiKey = env.TRUSTLESS_WORK_API_KEY;
  const secret = env.TRUSTLESS_WORK_DISPUTE_RESOLVER_SECRET;
  if (!apiKey || !secret) {
    throw new TrustlessWorkNotConfiguredError();
  }

  return {
    apiUrl: env.TRUSTLESS_WORK_API_URL.replace(/\/+$/, ""),
    apiKey,
    signer: Keypair.fromSecret(secret),
    networkPassphrase: env.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  };
}

/**
 * Creates the Trustless Work client. Config is resolved per call so the app
 * boots without Trustless Work credentials; only refund execution requires them.
 * The API key and signing secret are never included in logs or errors.
 */
export function createTrustlessWorkClient(): TrustlessWorkClient {
  async function post<T>(apiUrl: string, apiKey: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
    });

    const json = (await response.json().catch(() => ({}))) as { message?: string } & T;
    if (!response.ok) {
      throw new TrustlessWorkError(
        `Trustless Work ${path} failed: ${json.message ?? response.statusText}`,
        response.status,
      );
    }
    return json;
  }

  return {
    async resolveDispute({ contractId, escrowType, distributions, milestoneIndex }) {
      const { apiUrl, apiKey, signer, networkPassphrase } = requireTrustlessWorkConfig();

      const endpoint = escrowType === "single-release" ? "resolve-dispute" : "resolve-milestone-dispute";
      const payload = {
        contractId,
        disputeResolver: signer.publicKey(),
        distributions,
        ...(escrowType === "multi-release" ? { milestoneIndex } : {}),
      };

      const { unsignedTransaction } = await post<{ unsignedTransaction?: string }>(
        apiUrl,
        apiKey,
        `/escrow/${escrowType}/${endpoint}`,
        payload,
      );
      if (!unsignedTransaction) {
        throw new TrustlessWorkError(`Trustless Work /escrow/${escrowType}/${endpoint} returned no unsignedTransaction`);
      }

      const tx = TransactionBuilder.fromXDR(unsignedTransaction, networkPassphrase);
      tx.sign(signer);
      const txHash = tx.hash().toString("hex");

      const result = await post<{ status?: string; message?: string }>(apiUrl, apiKey, "/helper/send-transaction", {
        signedXdr: tx.toXDR(),
      });
      if (result.status !== "SUCCESS") {
        throw new TrustlessWorkError(
          `Stellar transaction ${txHash} was not accepted: ${result.message ?? result.status ?? "unknown status"}`,
        );
      }

      return { txHash, status: result.status, message: result.message ?? "" };
    },
  };
}

export const trustlessWorkClient = createTrustlessWorkClient();
