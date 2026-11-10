import type { InboxSavedViewConditions } from './saved-view-types'
import { formatNumber } from '@/lib/format'

/**
 * 保存した検索の中身を、運用者の言葉で1行にする（設計 `ASsb3`）。
 *
 * 設計は名前の下に「対応マーク：未対応／期限：超過」のように**何で絞ったか**を
 * 出す。名前だけだと、`未対応・期限超過` と `見本担当の未対応` のどちらを押せば
 * いいのかが名前の付け方頼みになる。
 *
 * **絞っていない軸は出さない。** 「受信経路：すべて」まで並べると、
 * 本当に絞った軸が埋もれる。
 */

const STATUS_LABELS: Record<string, string> = {
  unread: '未対応',
  in_progress: '対応中',
  on_hold: '保留',
  resolved: '対応済み',
}

const CHANNEL_LABELS: Record<string, string> = {
  line: 'LINE',
  email: 'メール',
}

const SORT_LABELS: Record<string, string> = {
  newest: '新しい順',
  waiting_desc: '待ち時間が長い順',
}

/** 担当者IDを名前にするための対応表。取れないときは渡さなくてよい。 */
export type OperatorNames = ReadonlyMap<string, string>

export function savedViewSummary(
  conditions: InboxSavedViewConditions,
  operatorNames: OperatorNames = new Map(),
): string {
  const parts: string[] = []

  if (conditions.query.trim()) parts.push(`語：${conditions.query.trim()}`)

  if (conditions.channels.length > 0 && conditions.channels.length < 2) {
    parts.push(`受信経路：${conditions.channels.map((c) => CHANNEL_LABELS[c] ?? c).join('・')}`)
  }

  /*
    **軸の並びは設計に合わせる。**
    設計 `ASsb3` は「担当者：見本／対応マーク：未対応」と、担当者を先に出す。
    絞り込みで先に決めるのが担当者だから。
    （「対応マーク」は設計の言い方。実装は要件書 `管理画面-02:77` どおり「対応状況」）
  */
  if (conditions.assignees.length > 0) {
    /*
      **IDのまま出さない。** 名前が引けないときは人数で言う。
      `operator-kenta` と書かれても、それが誰なのかは分からない。
    */
    const names = conditions.assignees.map((id) => operatorNames.get(id)).filter(Boolean)
    parts.push(names.length === conditions.assignees.length
      ? `担当者：${names.join('・')}`
      : `担当者：${formatNumber(conditions.assignees.length)}人`)
  }

  if (conditions.statuses.length > 0 && conditions.statuses.length < 4) {
    parts.push(`対応状況：${conditions.statuses.map((s) => STATUS_LABELS[s] ?? s).join('・')}`)
  }

  // 「要返信」は N-020 で保存対象になった軸。「1時間以上待ち」は
  // due（旧軸）と quickFilter のどちらが立っていても出す。
  // INBOX-10: 対応期限ではなく「未対応のまま最後のやり取りから1時間」
  // を数えるため、実態に合う名前を使う。
  if (conditions.quickFilter === 'reply') parts.push('要返信')
  if (conditions.due === 'overdue' || conditions.quickFilter === 'overdue') parts.push('1時間以上待ち')

  // 設計 `ASsb3` は「未読のみ」。「自分の」は担当者の軸が言っている。
  if (conditions.unread === 'mine') parts.push('未読のみ')

  if (conditions.messageTypes.length > 0) parts.push(`種別：${formatNumber(conditions.messageTypes.length)}件`)

  if (conditions.receivedFrom || conditions.receivedTo) {
    parts.push(`受信日：${conditions.receivedFrom ?? ''}〜${conditions.receivedTo ?? ''}`)
  }

  if (conditions.sort !== 'newest') parts.push(SORT_LABELS[conditions.sort] ?? conditions.sort)

  /*
    **絞っていないことを黙らない。** 空文字を返すと、名前の下が
    ただの隙間になり「読み込めていない」のか「絞っていない」のかが分からない。
  */
  return parts.length > 0 ? parts.join('／') : '絞り込みなし'
}
