import { hasuraClient } from "../lib/hasura";

interface EscrowMutationData {
  update_escrow_transactions?: { affected_rows?: number };
}

interface NotificationMutationData {
  insert_notifications_one?: { id?: string } | null;
}

interface RefundRetryData {
  refunds?: { id?: string; retry_count?: number }[];
}

interface RefundRetryMutationData {
  update_refunds?: { affected_rows?: number };
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
   *
   * Replay/dedup: the update is naturally idempotent — re-applying the same
   * `status` for the same `contract_id` converges to the same end state and
   * reports `affected_rows: 0` when the row already holds that status. Callers
   * use that signal to skip duplicate side effects (e.g. notifications) for a
   * replayed delivery.
   */
  static async updateEscrowStatus(
    contractId: string,
    status: string
  ): Promise<{ affected_rows: number }> {
    const query = `
      mutation UpdateEscrowStatus($contractId: String!, $status: String!) {
        update_escrow_transactions(
          where: { contract_id: { _eq: $contractId }, status: { _neq: $status } }
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
   * Inserts a notification, deduplicating replayed webhook deliveries.
   *
   * A replayed signed payload would otherwise send the same notification
   * twice. The insert is guarded by a `notifications` uniqueness constraint on
   * `(user_id, type, title, message)`; on conflict the existing row is returned
   * instead of a duplicate being created, so the same event converges to a
   * single notification.
   */
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
          on_conflict: {
            constraint: notifications_user_id_type_title_message_key
            update_columns: []
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

  /**
   * Reads the persisted retry counter for a refund so the retry-on-failure
   * path can enforce a bounded budget across requests. Returns `null` when the
   * refund row does not exist.
   */
  static async getRefundRetryCount(refundId: string): Promise<number | null> {
    const query = `
      query GetRefundRetryCount($refundId: String!) {
        refunds(where: { id: { _eq: $refundId } }, limit: 1) {
          id
          retry_count
        }
      }
    `;

    let data: RefundRetryData;
    try {
      data = await hasuraClient.request<RefundRetryData>(query, { refundId });
    } catch {
      throw new Error("Failed to read refund retry count from Hasura");
    }

    const refund = data.refunds?.[0];
    if (!refund) {
      return null;
    }
    return refund.retry_count ?? 0;
  }

  /**
   * Atomically increments the persisted retry counter for a refund. The
   * increment is guarded by `retry_count: { _lt: $maxRetries }` so concurrent
   * retry requests cannot push the counter past the cap; `affected_rows: 0`
   * signals the budget is exhausted and the caller must stop retrying.
   */
  static async incrementRefundRetryCount(
    refundId: string,
    maxRetries: number
  ): Promise<{ affected_rows: number }> {
    const mutation = `
      mutation IncrementRefundRetryCount($refundId: String!, $maxRetries: Int!) {
        update_refunds(
          where: { id: { _eq: $refundId }, retry_count: { _lt: $maxRetries } }
          _inc: { retry_count: 1 }
        ) {
          affected_rows
        }
      }
    `;

    let data: RefundRetryMutationData;
    try {
      data = await hasuraClient.request<RefundRetryMutationData>(mutation, {
        refundId,
        maxRetries,
      });
    } catch {
      throw new Error("Failed to increment refund retry count in Hasura");
    }
    return { affected_rows: data.update_refunds?.affected_rows ?? 0 };
  }
}
