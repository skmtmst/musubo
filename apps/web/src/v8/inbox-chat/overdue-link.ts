/*
 * 受信箱を上の絞り込み（すべて・要返信・期限超過）を選んだ状態で開く URL の指定。
 * 統括の「返信の期限を過ぎた会話」から `?quick=overdue` で来る。
 * 期限を使う店では「期限超過」、使わない店では「1時間以上待ち」の絞り込みになる（上の札と同じ）。
 */
export type InboxQuickFilter = 'all' | 'reply' | 'overdue'

export const INBOX_QUICK_URL_KEY = 'quick'

/** 受信箱を期限超過の絞り込みで開く道。開く前に、対象の店へ切り替えておく。 */
export const INBOX_OVERDUE_HREF = `/chats?${INBOX_QUICK_URL_KEY}=overdue`

/** URL の値を絞り込みへ。知らない値は「すべて」。 */
export function inboxQuickFilterFromParam(raw: string | null): InboxQuickFilter {
  const value = (raw ?? '').trim()
  return value === 'reply' || value === 'overdue' ? value : 'all'
}
