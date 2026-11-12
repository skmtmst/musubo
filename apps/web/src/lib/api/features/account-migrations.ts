import { fetchApi } from '../transport/request'
import type { ApiResponse } from '@line-crm/shared'
import type {
  AccountHandover,
  AccountHandoverDecision,
  HandoverMatchCounts,
  HandoverMatchBucket,
  UidMigrationRun,
  UidMigrationItem,
  FriendMigrationJob,
} from '../types/accounts'

export const accountMigrationsMethods = {
/**
   * LINEアカウントの乗り換え（引き継ぎ）。設計 ★管理画面 33-4（`nx3XW`）。台帳 #133。
   *
   * 5 段の流れ。**事前確認（段3）だけでは元のアカウントは何も変わらない。**
   */
  accountHandovers: {
    /** 段1。引き継ぎコードを出す。生きているコードがあればそれを返す。 */
    issue: (fromAccountId: string) =>
      fetchApi<ApiResponse<AccountHandover>>('/api/account-handovers', {
        method: 'POST',
        body: JSON.stringify({ fromAccountId }),
      }),
    /** 段2。受け取り先でコードを読む。 */
    link: (code: string, toAccountId: string) =>
      fetchApi<ApiResponse<AccountHandover>>('/api/account-handovers/link', {
        method: 'POST',
        body: JSON.stringify({ code, toAccountId }),
      }),
    get: (id: string) =>
      fetchApi<ApiResponse<AccountHandover & {
        decisions: AccountHandoverDecision[]
        /** 段4でまだ決めていない「要確認」の数。0 になるまで本実行できない。 */
        unresolvedReviews: number | null
      }>>(`/api/account-handovers/${id}`),
    listForAccount: (accountId: string) =>
      fetchApi<ApiResponse<AccountHandover[]>>(`/api/line-accounts/${accountId}/handovers`),
    /**
     * 段3。事前確認の結果を保存する。
     * **4区分の合計が `sourceFriendTotal` と合わないと 422 で断られる。**
     */
    preview: (
      id: string,
      input: { sourceFriendTotal: number; counts: HandoverMatchCounts; declaredFriendTotal?: number | null },
    ) =>
      fetchApi<ApiResponse<AccountHandover>>(`/api/account-handovers/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    /** 段4。競合の判断を保存する。`link` は相手が要る。 */
    saveDecisions: (
      id: string,
      decisions: Array<{
        fromFriendId: string
        toFriendId?: string | null
        decision: 'link' | 'new' | 'skip'
        bucket: HandoverMatchBucket
        note?: string | null
      }>,
    ) =>
      fetchApi<ApiResponse<AccountHandover & { unresolvedReviews: number | null }>>(
        `/api/account-handovers/${id}/decisions`,
        { method: 'PUT', body: JSON.stringify({ decisions }) },
      ),
    /** 段5。本実行と照合。要確認がのこっていると 422 で止まる。本人確認（step-up）が要る。 */
    execute: (id: string, stepUpToken?: string, expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<AccountHandover & { plannedCount: number }>>(
        `/api/account-handovers/${id}/execute`,
        {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify({ expectedConfirmationRevision }),
        },
      ),
    cancel: (id: string, expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<AccountHandover>>(`/api/account-handovers/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ expectedConfirmationRevision }),
      }),
    /** 段6。切り戻し。本実行から7日間だけ。本人確認（step-up）が要る。 */
    rollback: (id: string, note?: string, stepUpToken?: string, expectedConfirmationRevision?: number) =>
      fetchApi<ApiResponse<AccountHandover & { restoredCount: number }>>(
        `/api/account-handovers/${id}/rollback`,
        {
          method: 'POST',
          headers: stepUpToken ? { 'X-Step-Up-Token': stepUpToken } : undefined,
          body: JSON.stringify({ note: note ?? null, expectedConfirmationRevision }),
        },
      ),
  },
  friendMigrations: {
    list: () => fetchApi<ApiResponse<UidMigrationRun[]>>('/api/friends/migrations'),
    get: (id: string) => fetchApi<ApiResponse<UidMigrationRun>>(`/api/friends/migrations/${id}`),
    dryRun: (input: {
      fromAccountId: string
      toAccountId: string
      purpose: string
      sourceFilename: string
      sourceChecksum: string
      mappings: Array<{ oldUid: string; newUid: string | null; evidenceType: UidMigrationItem['evidenceType'] }>
    }) => fetchApi<ApiResponse<UidMigrationRun>>('/api/friends/migrations', {
      method: 'POST', body: JSON.stringify({ ...input, sourceKind: 'csv' }),
    }),
    decide: (runId: string, itemId: string, decision: 'link' | 'create' | 'exclude') =>
      fetchApi<ApiResponse<UidMigrationRun & { unresolved: number | null }>>(
        `/api/friends/migrations/${runId}/items/${itemId}`,
        { method: 'PATCH', body: JSON.stringify({ decision }) },
      ),
    execute: (id: string) => fetchApi<ApiResponse<UidMigrationRun>>(`/api/friends/migrations/${id}/execute`, { method: 'POST' }),
    rollback: (id: string) => fetchApi<ApiResponse<UidMigrationRun>>(`/api/friends/migrations/${id}/rollback`, { method: 'POST' }),
    createExport: (input: { accountId: string; columns: Array<'basic' | 'friend_fields' | 'tags_fields' | 'support'>; encoding: 'utf-8' | 'shift_jis' }) =>
      fetchApi<ApiResponse<{ id: string; rowCount: number | null; status: string; downloadUrl: string }>>('/api/friends/exports', {
        method: 'POST', body: JSON.stringify(input),
      }),
    previewImport: (input: {
      accountId: string
      sourceFilename: string
      sourceChecksum: string
      rows: Array<{ lineUid: string; friendFields?: Record<string, string | null>; displayName: string | null; realName: string | null; systemDisplayName: string | null }>
    }) => fetchApi<ApiResponse<{
      id: string
      status: string
      duplicate: boolean
      result: { summary: { add: number; update: number; unchanged: number; conflict: number; error: number }; rows: unknown[] }
    }>>('/api/friends/imports', { method: 'POST', body: JSON.stringify(input) }),
    executeImport: (id: string) => fetchApi<ApiResponse<{ id: string; status: string; applied?: number; duplicate: boolean }>>(
      `/api/friends/imports/${id}/execute`, { method: 'POST' },
    ),
    jobs: () => fetchApi<ApiResponse<FriendMigrationJob[]>>('/api/friends/migration-jobs'),
  },
}
