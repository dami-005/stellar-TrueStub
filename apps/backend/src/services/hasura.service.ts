import { hasuraClient } from "../lib/hasura";

interface EscrowMutationData {
  update_escrow_transactions?: { affected_rows?: number };
}

interface NotificationMutationData {
  insert_notifications_one?: { id?: string } | null;
}

interface EscrowTransactionRow {
  contract_id: string;
  status: string;
  updated_at?: string;
}

interface EscrowTransactionsQueryData {
  escrow_transactions?: EscrowTransactionRow[];
}

export interface EscrowStatusMismatch {
  contractId: string;
  hasuraStatus: string;
  liveStatus: string;
}

export interface ReconciliationResult {
  checked: number;
  mismatches: EscrowStatusMismatch[];
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
   * Reads a sample of the most recently updated escrow transactions so the
   * reconciliation job can compare Hasura's status against Trustless Work's
   * live state. Read-only: never mutates the authoritative write path.
   */
  static async getRecentEscrowTransactions(
    limit = 50
  ): Promise<EscrowTransactionRow[]> {
    const query = `
      query RecentEscrowTransactions($limit: Int!) {
        escrow_transactions(order_by: { updated_at: desc }, limit: $limit) {
          contract_id
          status
          updated_at
        }
      }
    `;

    try {
      const data = await hasuraClient.request<EscrowTransactionsQueryData>(query, {
        limit,
      });
      return data.escrow_transactions ?? [];
    } catch {
      throw new Error("Failed to read escrow transactions from Hasura");
    }
  }

  /**
   * Spot-checks a sample of recent escrows' Hasura status against Trustless
   * Work's live state and reports mismatches. A deliberately-introduced status
   * mismatch (e.g. manually editing a test escrow's Hasura status) is caught
   * here. The live-state lookup is injected so this service stays free of
   * Trustless Work transport concerns and remains testable.
   */
  static async reconcileEscrowStatuses(
    fetchLiveStatus: (contractId: string) => Promise<string | null>,
    limit = 50
  ): Promise<ReconciliationResult> {
    const rows = await HasuraService.getRecentEscrowTransactions(limit);
    const mismatches: EscrowStatusMismatch[] = [];

    for (const row of rows) {
      const liveStatus = await fetchLiveStatus(row.contract_id);
      if (liveStatus && liveStatus !== row.status) {
        mismatches.push({
          contractId: row.contract_id,
          hasuraStatus: row.status,
          liveStatus,
        });
      }
    }

    return { checked: rows.length, mismatches };
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
