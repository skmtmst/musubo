import type { ChatDetailMessage } from '@/lib/api'

/**
 * 送信まわりの楽観更新の共通処理。
 *
 * `page.tsx` に画像送信と本文送信の2経路があり、一覧の当て直しと
 * 並べ替えがほぼ同じ書き方で複製されていた。振る舞いは変えず、
 * 並べる部分だけここに寄せる。口の呼び出しや署名・冪等キーは
 * 呼び出し側（`page.tsx`）に残す。
 */

/** 一覧の当て直しに要る最小形。`page.tsx` の行と構造で合わせる。 */
export interface SendListRow {
  id: string
  lastMessageAt: string | null
  status: string
}

/**
 * 送った直後の一覧を作る。やることは3つだけで、2経路とも同じ。
 *
 * 1. 当てた行だけ時刻・対応中・プレビューに書き換える
 * 2. 別の絞り込みを見ているときは一覧から外す
 * 3. 新しいものが上に来るよう並べ直す
 */
export function refreshChatListAfterSend<T extends SendListRow>(
  prev: T[],
  currentFilter: string,
  update: (row: T) => T,
): T[] {
  const updated = prev.map(update)
  const filtered = currentFilter === 'all'
    ? updated
    : updated.filter((row) => row.status === currentFilter)
  return [...filtered].sort((a, b) => {
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return bt - at
  })
}

/**
 * 送った文面の楽観表示1件を作る。口の応答が来るまでの一瞬だけ見せる。
 * 形は `ChatDetailMessage`（`GET /api/chats/:id` の実応答）に従い、
 * 口が付けない項目は `null` で埋める。
 */
export function buildOutgoingMessage(input: {
  id?: string
  messageType: string
  content: string
  sentByStaffName: string
  sentAt: string
  /** 引用返信のとき、口の応答が来るまで画面へ出す引用元の要約。 */
  quoted?: ChatDetailMessage['quoted']
}): ChatDetailMessage {
  return {
    id: input.id ?? crypto.randomUUID(),
    direction: 'outgoing',
    messageType: input.messageType,
    content: input.content,
    isUnsent: false,
    source: null,
    originKind: null,
    sentByStaffId: null,
    sentByStaffName: input.sentByStaffName,
    scenarioName: null,
    quoted: input.quoted ?? null,
    createdAt: input.sentAt,
  }
}

/** サーバーの再読込が先に届いたときは、保存済みの行を優先する。 */
export function appendSentMessages(current: ChatDetailMessage[], sent: ChatDetailMessage[]): ChatDetailMessage[] {
  const existing = new Set(current.map((message) => message.id))
  return [...current, ...sent.filter((message) => !existing.has(message.id))]
}
