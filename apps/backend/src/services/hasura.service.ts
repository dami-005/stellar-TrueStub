import { hasuraClient } from "../lib/hasura";

interface EscrowMutationData {
  update_escrow_transactions?: { affected_rows?: number };
}

interface NotificationMutationData {
  insert_notifications_one?: { id?: string } | null;
}

interface EscrowTransactionData {
  escrow_transactions?: Array<{ amount?: number | string | null }>;
}

export class HasuraService {
  /**
   * The single authoritative write path for `escrow_transactions.status`
   * (called only from the HMAC-verified `/webhooks/escrow-status` route).
   *
   * Failures are surfaced, not swallowed: the webhook must answer non-2xx so
   * Trustless Work retries the delivery instead of the update being lost. The
   * thrown error is generic so admin credentials and remote error payloads
   * stay out of logs and responses.
   */
  static async updateEscrowStatus(
    contractId: string,
    status: string
  ): Promise<{ affected_rows: number }> {
    const query = `
      mutation UpdateEscrowStatus($contractId: String!, $status: String!) {
        update_escrow_transactions(
          where: { contract_id: { _eq: $contractId } }
          _set: { status: $status, updated_at: "now()" }
        ) {
          affected_rows
        }
      }
    `;

    let data: EscrowMutationData;
    try {
      data = await hasuraClient.request<EscrowMutationData>(query, {
        contractId,
        status,
      });
    } catch {
      throw new Error("Failed to update escrow status in Hasura");
    }
    return { affected_rows: data.update_escrow_transactions?.affected_rows ?? 0 };
  }

  /**
   * Reads the escrow's disputed balance so the refunds claim flow can validate
   * the requested `amount` locally before submitting to Trustless Work.
   *
   * Returns `null` when the escrow is unknown or the balance is unavailable so
   * callers can decide how to fail; a thrown error is reserved for transport
   * failures against Hasura.
   */
  static async getEscrowDisputedBalance(
    contractId: string
  ): Promise<number | null> {
    const query = `
      query GetEscrowDisputedBalance($contractId: String!) {
        escrow_transactions(
          where: { contract_id: { _eq: $contractId } }
          limit: 1
        ) {
          amount
        }
      }
    `;

    let data: EscrowTransactionData;
    try {
      data = await hasuraClient.request<EscrowTransactionData>(query, {
        contractId,
      });
    } catch {
      throw new Error("Failed to fetch escrow balance from Hasura");
    }

    const raw = data.escrow_transactions?.[0]?.amount;
    if (raw === undefined || raw === null) {
      return null;
    }
    const balance = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(balance) ? balance : null;
  }

  static async insertNotification(notification: {
    userId: string;
    type: string;
    title: string;
    message: string;
  }): Promise<boolean> {
    const mutation = `
      mutation InsertNotification($userId: String!, $type: String!, $title: String!, $message: String!) {
        insert_notifications_one(
          object: {
            user_id: $userId
            type: $type
            title: $title
            message: $message
            read: false
          }
        ) {
          id
        }
      }
    `;

    try {
      const data = await hasuraClient.request<NotificationMutationData>(mutation, notification);
      return Boolean(data.insert_notifications_one?.id);
    } catch {
      return false;
    }
  }
}
