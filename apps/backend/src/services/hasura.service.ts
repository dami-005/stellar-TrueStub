import { hasuraClient } from "../lib/hasura";

interface EscrowMutationData {
  update_escrow_transactions?: { affected_rows?: number };
}

interface NotificationMutationData {
  insert_notifications_one?: { id?: string } | null;
}

interface EscrowByIdData {
  escrow_transactions?: Array<{
    id: string;
    contract_id: string;
    buyer_id: string;
    seller_id: string;
    amount: number;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
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
   * Fetch a single escrow transaction by its ID.
   *
   * Returns `null` when no escrow matches the given ID so callers can answer
   * 404 without leaking whether the ID exists. Authorization (party check) is
   * enforced by the caller against `buyer_id`/`seller_id`.
   */
  static async getEscrowById(id: string): Promise<EscrowByIdData["escrow_transactions"] extends Array<infer T> ? T | null : never> {
    const query = `
      query GetEscrowById($id: uuid!) {
        escrow_transactions(where: { id: { _eq: $id } }, limit: 1) {
          id
          contract_id
          buyer_id
          seller_id
          amount
          status
          created_at
          updated_at
        }
      }
    `;

    let data: EscrowByIdData;
    try {
      data = await hasuraClient.request<EscrowByIdData>(query, { id });
    } catch {
      throw new Error("Failed to fetch escrow from Hasura");
    }
    return data.escrow_transactions?.[0] ?? null;
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
