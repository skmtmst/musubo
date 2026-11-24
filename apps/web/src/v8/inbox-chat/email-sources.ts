import { ACCOUNT_EMAIL_RECEIVE_ONLY_NOTE } from '@/lib/status-labels'

/**
 * 受信箱のメールが届いた経路。
 * - shared（共通）：これまでの共通の窓口に届くメール（/api/support/*）。どの店舗にも属さない。
 * - store（店舗）：選んでいる LINE アカウントの転送用アドレスに届くメール（/api/account-email/:accountId/*）。
 * 一覧の札・開く口・既読・対応状況・返信は行ごとにこの経路で決め、経路をまたいで読み書きしない。
 */
export type EmailSource = 'shared' | 'store'

/** 行の札・会話の頭・顧客情報で使う呼び名。 */
export const EMAIL_SOURCE_LABEL: Record<EmailSource, string> = { shared: '共通', store: '店舗' }

/** 会話の識別。両方の口とも行の id は `email:<threadId>` なので、経路と threadId の組で持つ。 */
export type EmailRef = { source: EmailSource; threadId: string }

export function emailKey(ref: EmailRef): string {
  return `${ref.source}:${ref.threadId}`
}

export function sameEmail(a: EmailRef | null | undefined, b: EmailRef | null | undefined): boolean {
  return Boolean(a && b && a.source === b.source && a.threadId === b.threadId)
}

/** URL で店舗の会話を指す印（`?thread=<id>&source=store`）。印が無い `?thread=` は従来どおり共通。 */
export const EMAIL_SOURCE_URL_KEY = 'source'

export function emailSourceFromParam(value: string | null | undefined): EmailSource {
  return value === 'store' ? 'store' : 'shared'
}

/** 店舗の会話の返信欄を押せない形にするときの吹き出し。設定のメールの枠と同じ言葉。 */
export const STORE_EMAIL_REPLY_LOCK_REASON = ACCOUNT_EMAIL_RECEIVE_ONLY_NOTE

type MergeRow = { isUnread: boolean; lastMessageAt?: string | null; lastIncomingAt: string }

const rowAt = (row: MergeRow) => row.lastMessageAt ?? row.lastIncomingAt

/** 口の並び（未読が先→新しい順）で a が b より前なら負。新しい順（latest）は時刻だけで比べる。 */
export function compareEmailRows(a: MergeRow, b: MergeRow, latest: boolean): number {
  return (latest ? 0 : Number(b.isUnread) - Number(a.isUnread)) || String(rowAt(b)).localeCompare(String(rowAt(a)))
}

/**
 * 共通と店舗の一覧を1本に混ぜる。どちらの口も「未読が先→新しい順」で返すので、先頭どうしを比べて混ぜる。
 * 続きのある経路を読み切ったら、もう一方の残りは出さずに待つ（held）。続きを読んだ行が、見えている行の
 * 間へ後から挟まらず、見えている一覧がいつも全体の並びの先頭どおりになる。
 * 新しい順は口が並びを持たないので、読んだ範囲を時刻で並べ直すだけにする（待たせる行は無い）。
 */
export function mergeEmailRows<T extends MergeRow>(
  shared: readonly T[],
  store: readonly T[],
  { sharedMore, storeMore, latest }: { sharedMore: boolean; storeMore: boolean; latest: boolean },
): { rows: T[]; held: number } {
  if (latest) return { rows: [...shared, ...store].sort((a, b) => compareEmailRows(a, b, true)), held: 0 }
  const rows: T[] = []
  let i = 0
  let j = 0
  while (i < shared.length || j < store.length) {
    if (i >= shared.length) {
      if (sharedMore) break
      rows.push(store[j++])
    } else if (j >= store.length) {
      if (storeMore) break
      rows.push(shared[i++])
    } else {
      rows.push(compareEmailRows(shared[i], store[j], false) <= 0 ? shared[i++] : store[j++])
    }
  }
  return { rows, held: shared.length - i + store.length - j }
}

/**
 * 1ページ読んだあとの位置と続きの有無。offset は経路ごとに数える。
 * 空のページは終わり。共通の口は末尾を越えた offset で総数を0と返すので、空のページの総数で
 * それまでに読んだ件数や行を消さない。店舗の口は nextOffset を返すのでそれを優先する。
 */
export function nextEmailPage({ offset, received, total, nextOffset, pageSize }: {
  offset: number
  received: number
  total?: number | null
  nextOffset?: number | null
  pageSize: number
}): { loaded: number; hasMore: boolean } {
  const loaded = offset + received
  if (received === 0) return { loaded: offset, hasMore: false }
  if (nextOffset === null) return { loaded, hasMore: false }
  if (typeof nextOffset === 'number' && Number.isFinite(nextOffset)) return { loaded, hasMore: nextOffset > offset }
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return { loaded, hasMore: loaded < total }
  return { loaded, hasMore: received >= pageSize }
}

/**
 * 一覧の失敗の分け方。共通の口が権限（403）で断ったときは共通を出さないだけにし、失敗のお知らせにも
 * 店舗の失敗にも数えない。店舗の口の失敗は権限も含めて隠さず知らせる。
 */
export function classifyEmailFailure(source: EmailSource, cause: unknown): 'error' | 'forbidden' {
  // 通信の失敗（ApiError）は状態番号を持つ。時間切れ・success:false などは番号を持たないので失敗のまま。
  const status = typeof cause === 'object' && cause !== null && 'status' in cause ? (cause as { status: unknown }).status : null
  return source === 'shared' && status === 403 ? 'forbidden' : 'error'
}
