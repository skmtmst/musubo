'use client'
import { type ChatDetail as ApiChatDetail,type ChatListItem } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { jstCalendar,jstDate } from '@/lib/jst-datetime';
import { type PendingAttachmentView } from '@/v8/inbox-chat/attachment-chip';
import type { ChatAttachment } from '@line-crm/shared';
import { EMAIL_SOURCE_LABEL, type EmailSource } from './email-sources';
import styles from './list-parts.module.css';
import { type InboxSavedViewConditions } from './saved-view-types';

export type Chat = ChatListItem

/**
 * 会話のメッセージ1件。形は `api.ts` の `ChatDetailMessage`
 *（`GET /api/chats/:id` の実応答）に寄せる。画面が独自の型を持つと
 * 口の形が変わっても型検査が黙るため、ここでは別名にするだけ。
 */
export type ChatDetail = ApiChatDetail

export type StatusFilter = 'all' | 'unread' | 'in_progress' | 'on_hold' | 'resolved'

/** 受信箱に混ぜるメールの1件（共通は /api/support/inbox、店舗は /api/account-email/:accountId/inbox）。 */
export interface EmailInboxItem {
  id: string
  threadId: string
  /** 届いた経路。口の応答には無く、読み込んだ経路を画面が付ける。開く口・既読・札はこれで決める。 */
  source: EmailSource
  customerName: string
  /** 相手のメールアドレス。友だちを手で探すときの手がかりになる。 */
  customerIdentifier?: string
  subject: string
  preview: string
  status: 'unread' | 'in_progress' | 'on_hold' | 'resolved'
  revision: number
  assignedStaffId?: string | null
  assignedStaffName?: string | null
  /** 受信・送信のうち新しい方の時刻。口はこの順で返す。無い口は受信時刻に倒す。 */
  lastMessageAt?: string | null
  lastIncomingAt: string
  /** 口が返した未読。一覧の並び（未読が先）と続きの位置はこの値で決め、開いても書き換えない。 */
  isUnread: boolean
  /**
   * 開いて既読にした印。赤い点と太字だけを消し、行の位置は読み直すまで動かさない
   * （並びの値を書き換えると、開いた行が下へ跳ねたり、続きを待つ側へ回って見えなくなる）。
   */
  readNow?: boolean
}

/** 画面に出す未読（赤い点・太字）。開いて既読にした行は消す。 */
export function emailShownUnread(item: Pick<EmailInboxItem, 'isUnread' | 'readNow'>): boolean {
  return item.isUnread && !item.readNow
}

/** 受信箱一覧の続きを読む位置。口の並び（未読が先・新しい順）と同じ3点。 */
export type ListCursor = { at: string; id: string; unread: 0 | 1 }

/** 一覧の並び。既定は未読が先。`latest` は未読を先にせず新しい順だけ。URL の `?sort=` に残す。 */
export type InboxSort = 'unread_first' | 'latest'

export const INBOX_SORT_OPTIONS: { value: InboxSort; label: string }[] = [
  { value: 'unread_first', label: '未読が先・新しい順' },
  { value: 'latest', label: '新しい順' },
]

/** URL の `?sort=` から並びを読む。知らない値は既定（未読が先）。 */
export function inboxSortFromParam(value: string | null | undefined): InboxSort {
  return value === 'latest' ? 'latest' : 'unread_first'
}

export const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'unread', label: '未対応' },
  { key: 'in_progress', label: '対応中' },
  { key: 'on_hold', label: '保留' },
  { key: 'resolved', label: '対応済み' },
]

/*
 * ★V8（ XqSvX「状態」）：絵の切り替えは 未対応・対応中・保留・対応済み の4つで、件数つき。
 * 「すべて」は無い。選んでいる所をもう一度押すと絞り込みを外す（すべてに戻る）。
 */
export const statusFiltersV8 = statusFilters.filter((f) => f.key !== 'all')

export type InboxSavedView = {
  id: string
  name: string
  conditions: InboxSavedViewConditions
  createdBy: string | null
  isShared: boolean
  isFavorite?: boolean
  /** 保存条件を現在の受信箱へ当てた件数。未接続は null。 */
  matchCount?: number | null
}

/** 受信経路の札。色は LINE が緑・Instagram が公式の2色・メールが灰。字でも経路が分かる。 */
export function ChannelBadge({ channel, emailSource }: { channel: 'line' | 'email' | 'instagram'; emailSource?: EmailSource }) {
  if (channel === 'line') return (
    <span className={`bg-accent-deep text-on-accent inline-flex h-5 min-w-8 items-center justify-center rounded-mini px-1.5 text-micro font-medium ${styles.channelBadge}`}>
      LINE
    </span>
  )
  if (channel === 'instagram') return (
    <span data-channel-badge="instagram" className={`inline-flex h-5 min-w-8 items-center justify-center rounded-mini px-1.5 text-micro font-medium ${styles.channelBadge} ${styles.channelBadgeInstagram}`}>
      Instagram
    </span>
  )
  return (
    <span
      data-email-source={emailSource}
      className={`bg-canvas-sunken text-ink-secondary border-hairline inline-flex h-5 min-w-8 items-center justify-center rounded-mini border px-1.5 text-micro font-medium ${styles.channelBadge}`}
    >
      {emailSource ? `${EMAIL_SOURCE_LABEL[emailSource]}メール` : 'メール'}
    </span>
  )
}

// 一覧の1ページ件数。worker 側の上限(MAX_LIST_LIMIT=200)と揃える。
// 300 のままだと API が200件に丸めるのに画面は300件で「続き」を判定し、
// 201件目以降に「さらに読み込む」が出ず開けなくなる。

/** 会話の中を探す：昔の当たりまで読み足す1回の件数（会話詳細の口の上限）と回数の上限。 */
export const CHAT_SEARCH_FILL_PAGE = 1000

export const CHAT_SEARCH_FILL_MAX_ROUNDS = 20

/** 一覧の末尾から「続きを読む」位置を作る。口の並び（未読が先・新しい順）と同じ3点。 */
export function toListCursor(
  last: Pick<ChatListItem, 'id' | 'lastMessageAt' | 'isUnread'> | undefined,
): ListCursor | null {
  if (!last?.lastMessageAt) return null
  return { at: last.lastMessageAt, id: last.id, unread: last.isUnread ? 1 : 0 }
}

/** 対応が必要な会話の行き先（ID27「いちばん古い会話を開く」）。メールは届いた経路で開き分ける。 */
export type OldestAttentionTarget = { kind: 'chat'; id: string } | { kind: 'email'; threadId: string; source: EmailSource }

/*
 * LINE とメールを混ぜて、まだ対応していない物のうち最も古い物を選ぶ。
 * LINE は status='unread'（自動応答に掛からなかった真の要対応）だけ、
 * メールは未読だけを見る。時刻が無い・読めない物は選ばない。
 */
export function oldestAttentionTarget(
  chats: Pick<ChatListItem, 'id' | 'status' | 'lastMessageAt'>[],
  emails: Pick<EmailInboxItem, 'threadId' | 'source' | 'isUnread' | 'readNow' | 'lastMessageAt' | 'lastIncomingAt'>[],
): OldestAttentionTarget | null {
  let bestAt = Number.POSITIVE_INFINITY
  let bestTarget: OldestAttentionTarget | null = null
  const consider = (at: string | null | undefined, target: OldestAttentionTarget) => {
    const ms = at ? Date.parse(at) : NaN
    if (!Number.isFinite(ms)) return
    if (ms < bestAt) {
      bestAt = ms
      bestTarget = target
    }
  }
  for (const chat of chats) {
    if (chat.status !== 'unread') continue
    consider(chat.lastMessageAt, { kind: 'chat', id: chat.id })
  }
  for (const mail of emails) {
    if (!emailShownUnread(mail)) continue
    consider(mail.lastMessageAt ?? mail.lastIncomingAt, { kind: 'email', threadId: mail.threadId, source: mail.source })
  }
  return bestTarget
}

export function formatInboxDatetime(iso: string | null): string {
  if (!iso) return '—'
  return formatDateTime(iso)
}

/*
 * 予約時刻は「日本時間」が約束(INBOX-21)。入力欄も一覧も端末の
 * 時間帯ではなく Asia/Tokyo で読み書きする。JST は夏時間がないので
 * オフセットは常に +09:00。
 */
export const INBOX_TIME_ZONE = 'Asia/Tokyo'

export function formatJstScheduledAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDateTime(d)
}

/**
 * datetime-local の値(日本時間の約束)をオフセット付きのISOへ変える(INBOX-21)。
 * 'YYYY-MM-DDTHH:MM' のまま送ると、サーバー側の Date.parse がその実行環境の
 * 時間帯(UTC)で読み、選んだ時刻から9時間ずれた予約になる。JSTは夏時間が
 * ないので +09:00 で固定する。すでにオフセット付きの値はそのまま通す。
 */
export function jstDatetimeLocalToIso(local: string): string {
  if (!local) return local
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(local)) return local
  return `${local}+09:00`
}

/** UTCのISOを datetime-local の値へ戻す(日本時間で見せる)。 */
export function isoToJstDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: INBOX_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  // '24' 表記の深夜0時は datetime-local が読めないので '00' に直す。
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}`
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes}B`
  return `${Math.round(bytes / 1024)}KB`
}

/** サーバーと同じ数え方(JSの .length)。差し込みは解決後の長さでサーバーが最終判定する。 */
export const MESSAGE_MAX_LENGTH = 5000

/**
 * 設計 `xGLVe` は、返信を待たせている行だけ日付ではなく待ち時間を出す
 * （`1時間12分`）。上の帯の「最長 ◯◯待ち」と同じ物差し。
 * **最終受信からの差なので、新しい口は要らない。**
 */
export function formatWaitingDuration(iso: string | null, nowMs: number): string | null {
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return null
  const minutes = Math.floor((nowMs - at) / 60000)
  if (minutes < 0) return null
  if (minutes < 1) return '1分未満'
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  return `${hours}時間${minutes % 60}分`
}

export function sameYmd(aIso: string, bIso: string): boolean {
  return jstDate(new Date(aIso)) === jstDate(new Date(bIso))
}

/** ★V8 やりとりの日付の区切り（8月19日（火））。 */
export function formatDayJa(iso: string): string {
  const d = jstCalendar(new Date(iso))
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${'日月火水木金土'[d.getUTCDay()]}）`
}

/** ★V8 担当者の名前が無いこちらの吹き出しの「自動：…」。口の source をそのまま言葉にする。 */
export const AUTO_SOURCE_LABEL: Record<string, string> = {
  auto_reply: '自動応答',
  'auto-reply': '自動応答',
  broadcast: '一斉配信',
  reminder: 'リマインダ',
  scenario: 'シナリオ配信',
  automation: 'オートメーション',
  booking: '予約の通知',
}

export function formatYmdSlash(iso: string): string {
  const d = jstCalendar(new Date(iso))
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * URL状態の友だちIDが口へ渡せる形か。
 *
 * `api.chats.get` はIDを素のまま path へ入れるため、`/ ? #`
 * 空白を含む値はここで弾く。弾いた値は口を呼ばず、別人も開かない(#673)。
 */
export function isSafeFriendIdForInbox(value: string): boolean {
  if (!value || value.length > 128) return false
  return /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * URLで会話を開けなかった理由ごとの案内文。
 *
 * どれも「別人を開かない」で揃える。理由を混ぜると、権限が無いのか
 * 選んでいるアカウントが違うのかが読み手に伝わらない(#673)。
 */
export const DEEP_LINK_NOTICE = {
  /** IDの形が壊れている。口は呼ばない。 */
  malformed: '指定の会話を開けませんでした。URLの指定が正しくありません。友だち詳細の「受信箱で開く」から開き直してください。',
  /** 存在しない、または見る権限が無い。 */
  unavailable: '指定の会話を開けませんでした。存在しないか、見る権限がありません。URLを確かめるか、友だち詳細の「受信箱で開く」から開き直してください。',
  /** 見る権限はあるが、いま選んでいるアカウントの相手ではない。 */
  otherAccount: '指定の会話は、いま選んでいるLINEアカウントの相手ではありません。返信の送信元が変わって別のアカウントから送ってしまうため、開きません。上のアカウント切替で相手のアカウントに変えてから開き直してください。',
} as const

/** URLに残す保存検索IDの名前。再読込・共有で同じ条件を復元する足場(N-021)。 */
export const SAVED_VIEW_URL_KEY = 'savedView'

/**
 * 受信箱のURLを組み立てる。
 *
 * 保存検索を選んだあとは `savedView=<id>` を channel と一緒に残す。
 * URLが条件を持たないと、再読込・共有のたびに絞り込みが消える(N-021)。
 */
export function buildInboxUrl(channel: 'all' | 'line' | 'email', savedViewId: string | null): string {
  const query = new URLSearchParams()
  if (channel !== 'all') query.set('channel', channel)
  if (savedViewId) query.set(SAVED_VIEW_URL_KEY, savedViewId)
  const text = query.toString()
  return text ? `/chats?${text}` : '/chats'
}

/*
 * 下書きの保管キー(#962 F06)。同じ会話IDが別アカウントにもあり得るので、
 * アカウントと会話の両方で区切る。`\u001f` はIDに出ない区切り。
 */
export function draftKeyOf(accountId: string | null | undefined, chatId: string | null | undefined): string {
  return `${accountId ?? ''}\u001f${chatId ?? ''}`
}
export const CHANNELS = [{ key: 'all', label: 'すべて' }, { key: 'line', label: 'LINE' }, { key: 'email', label: 'メール' }] as const

export function resolveInboxChannel(requested: string | null, _emailInboxEnabled: boolean): 'all' | 'line' | 'email' {
  return requested === 'line' || requested === 'email' ? requested : 'all'
}
export const CORRECTION_TEMPLATE = '先ほどのメッセージに誤りがありました。正しくは次のとおりです。\n'
export type PendingAttachment = PendingAttachmentView & { file: File; job: number; attachment?: ChatAttachment }
