import { knownValue } from '@/lib/known-value'
/*
 * ★V8 外部連携で使う言葉と小さな変換（一覧・作る画面で共有）。
 * 送れる出来事の正本は packages/db/src/webhooks.ts の KNOWN_OUTGOING_EVENT_TYPES。
 */
import { ecEventLabel } from '@line-crm/shared'
import { formatDate as polishFormatDate } from '@/lib/format'


/** 出来事の種類 → 一覧の「いつ送るか」の言葉（絵：「友だちになった・タグが付いた」）。 */
const EVENT_WORD: Record<string, string> = {
  friend_add: '友だちになった',
  friend_unfollow: '友だちを解除された',
  message_received: 'メッセージを受け取った',
  postback_received: 'ボタン操作を受け取った',
  tag_change: 'タグが付いた',
  staff_assigned: '担当が割り当てられた',
  manual_reply_sent: '個別返信を送った',
  cv_fire: '成果地点が起きた',
  form_submitted: 'フォームが送られた',
  booking_created: '予約が入った',
  // 古い書き方（点つき）。今の一覧にも残っていることがある。
  'conversion.confirmed': '注文が確定した',
  'friend.added': '友だちになった',
  'form.submitted': 'フォームが送られた',
  'booking.created': '予約が入った',
  'friend.tag_added': 'タグが追加されたとき',
  'message.received': 'メッセージを受け取ったとき',
  'conversion.created': '成果が認められたとき',
  'order.created': '注文が確定したとき',
  'inventory.low': '在庫が少なくなったとき',
  'shipment.completed': '発送が完了したとき',
  '*': 'すべての出来事',
}

/** 出来事の種類 → 「送るもの」の言葉。 */
const PAYLOAD_WORD: Record<string, string> = {
  friend_add: '友だちの名前・タグ',
  friend_unfollow: '友だちの名前',
  message_received: 'メッセージの本文',
  postback_received: '押されたボタン',
  tag_change: '友だちの名前・タグ',
  staff_assigned: '担当者の名前',
  manual_reply_sent: '返信の本文',
  cv_fire: '成果地点の中身',
  form_submitted: '回答のすべて',
  booking_created: '予約の中身',
  'conversion.confirmed': '注文の中身',
  'friend.added': '友だちの名前・タグ',
  'form.submitted': '回答のすべて',
  'booking.created': '予約の中身',
  '*': '選んだ出来事の項目',
}

export function eventWord(type: string): string {
  const known = knownValue(EVENT_WORD, type, '')
  if (known) return known
  if (type.startsWith('ec.')) return ecEventLabel(type)
  if (type.startsWith('incoming_webhook.')) return '受け取った知らせ'
  return type
}

/** 一覧の「いつ送るか」。2つまでは並べ、それより多いときは「ほか N件」。 */
export function eventLabel(types: readonly string[]): string {
  if (types.length === 0) return 'まだ決めていません'
  const words = types.map(eventWord)
  if (words.length <= 2) return words.join('・')
  return `${words.slice(0, 2).join('・')} ほか${words.length - 2} 件`
}

export function payloadLabel(types: readonly string[]): string {
  const first = types[0]
  if (!first) return 'まだ決めていません'
  const known = knownValue(PAYLOAD_WORD, first, '')
  if (known) return known
  if (first.startsWith('ec.order')) return '注文の中身'
  return '選んだ出来事の項目'
}

/** URL の値や query を一覧へ出さず、相手を見分けられる範囲だけ残す（絵：https://crm.example.com/••••）。 */
/** 送り先の URL のホスト名だけ（狭い幅の一覧の2行目「… → crm.example.com」）。 */
export function urlHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return 'URLを確かめてください'
  }
}

export function maskedUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}/••••`
  } catch {
    return 'URLを確かめてください'
  }
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}



/** 「9/30 10:12」（日本時間）。表の狭い列で使う。読めない値は「—」。 */
export function shortDateTime(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}
