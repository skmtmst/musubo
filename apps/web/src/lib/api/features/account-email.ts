import { fetchApi } from '../transport/request'
import { downloadApiFile } from '../transport/download'
import type { ApiResponse } from '@line-crm/shared'
import type {
  AccountEmailConnection,
  AccountEmailInboxList,
  AccountEmailThreadDetail,
  AccountEmailThreadStatus,
} from '../types/account-email'

/** 店舗のメール受信箱の口の頭。LINE アカウントは必ず URL に入れる。 */
function accountEmailPath(accountId: string): string {
  return `/api/account-email/${encodeURIComponent(accountId)}`
}

/**
 * 店舗のメール受信箱（転送用アドレス方式）。
 * 既存の共通メール（`/api/support/*`）とは別の口で、失敗しても既存の口へは戻らない。
 */
export const accountEmailMethods = {
  accountEmail: {
    /** 接続の状態。アドレスなどは管理者にだけ値が入る。 */
    connection: (accountId: string) =>
      fetchApi<ApiResponse<AccountEmailConnection>>(`${accountEmailPath(accountId)}/connection`, { accountId }),
    /** 転送用アドレスを発行する。有効な接続があるときは 409（解除してから発行し直す）。 */
    issue: (accountId: string, mailbox: string) =>
      fetchApi<ApiResponse<AccountEmailConnection>>(`${accountEmailPath(accountId)}/connection`, {
        method: 'POST',
        body: JSON.stringify({ mailbox }),
        accountId,
      }),
    /**
     * 接続を解除する。転送用アドレスは使えなくなる。
     * If-Match の接続 ID が現在の接続と一致する場合に解除する。
     */
    disconnect: (accountId: string, connectionId: string) =>
      fetchApi<ApiResponse<AccountEmailConnection>>(`${accountEmailPath(accountId)}/connection`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${connectionId}"` },
        accountId,
      }),
    /** お店のメールアドレスへ受信確認のメールを送る（送り直しも同じ口）。 */
    verify: (accountId: string) =>
      fetchApi<ApiResponse<AccountEmailConnection>>(`${accountEmailPath(accountId)}/connection/verify`, {
        method: 'POST',
        body: '{}',
        accountId,
      }),
    /** 一覧。検索条件は既存のメール一覧と同じ並び（`buildSupportEmailInboxQuery`）。 */
    inbox: (accountId: string, query: string) =>
      fetchApi<ApiResponse<AccountEmailInboxList>>(`${accountEmailPath(accountId)}/inbox?${query}`, { accountId }),
    /** 会話の詳細。after= は新着の差分、before= は古い履歴。 */
    thread: (accountId: string, threadId: string, cursor?: { after?: string | null; before?: string | null }) => {
      const query = new URLSearchParams()
      if (cursor?.after) query.set('after', cursor.after)
      else if (cursor?.before) query.set('before', cursor.before)
      const suffix = query.toString()
      return fetchApi<ApiResponse<AccountEmailThreadDetail>>(
        `${accountEmailPath(accountId)}/threads/${encodeURIComponent(threadId)}${suffix ? `?${suffix}` : ''}`,
        { accountId },
      )
    },
    /** 対応状況を変える。読んだ版を送り、ほかの人の変更や新着と食い違えば 409。 */
    updateStatus: (accountId: string, threadId: string, status: AccountEmailThreadStatus, expectedRevision: number) =>
      fetchApi<ApiResponse<{ status: AccountEmailThreadStatus; revision: number }>>(
        `${accountEmailPath(accountId)}/threads/${encodeURIComponent(threadId)}/status`,
        { method: 'PATCH', body: JSON.stringify({ status, expectedRevision }), accountId },
      ),
    /** 開いた会話を、ログイン中の担当者だけ既読にする。 */
    markRead: (accountId: string, threadId: string) =>
      fetchApi<ApiResponse<unknown>>(`${accountEmailPath(accountId)}/threads/${encodeURIComponent(threadId)}/read`, {
        method: 'POST',
        body: '{}',
        accountId,
      }),
    /** この店舗のメールを、ログイン中の担当者だけまとめて既読にする。 */
    markAllRead: (accountId: string) =>
      fetchApi<ApiResponse<unknown>>(`${accountEmailPath(accountId)}/read-all`, {
        method: 'POST',
        body: '{}',
        accountId,
      }),
    /** 添付を認証付きで取り、ブラウザの保存へ渡す。 */
    downloadAttachment: (accountId: string, attachmentId: string, filename: string) =>
      downloadApiFile(`${accountEmailPath(accountId)}/attachments/${encodeURIComponent(attachmentId)}`, filename),
  },
}
