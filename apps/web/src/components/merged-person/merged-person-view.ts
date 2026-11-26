import type {
  MergedPersonDeliveryPriority,
  MergedPersonDeliveryPurpose,
  MergedPersonEventType,
  MergedPersonProfileSource,
  MergedPersonProfileUpdateMode,
  MergedPersonStatus,
} from '@line-crm/shared'
import { formatDateTime, formatDay } from '@/lib/format'

/**
 * 統合ユーザー詳細（設計 `w8W4Eh` 3-3-A）が読む言い換えと判断。
 *
 * この画面は**まとめた結果**を見せる。どこから採った値なのか、どちらの
 * アカウントから送るのか、誰がいつ決めたのかが読めないと、まとめ方を
 * 疑ったときに確かめる手がかりが無くなる。
 *
 * Reactを通さない形でここに集める。未取得と実値0の言い分け、失敗の
 * 言い換え、版が競合したときの扱いは、どれも画面ごとに揺れてはいけない。
 */

/** 取得元が無い値。取得できた 0 とは別。 */
export const NOT_AVAILABLE = '—'

function knownText(table: object, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? (table as Record<string, string>)[key] : fallback
}

/**
 * 統合ユーザーのidを、一覧の行から取り出す。
 *
 * 一覧（`/api/users-grouped`）は `identityKey` を
 * `'uid:' || friends.user_id`（＝ `users.id`）の形で返す
 * （`apps/worker/src/services/users-grouped.ts` の `IDENTITY_KEY_SQL`）。
 * **`uid` 以外の行は統合ユーザーではない**ので、詳細を開く先が無い。
 * `url_token` は「同じ人らしい」でまとめただけ、`solo` は1件だけの友だち。
 *
 * 文字を切り出しているのは、一覧が統合ユーザーのidをそのまま返さない
 * ため。読み口が `mergedPersonId` を返すようになったら、ここは消せる。
 */
export function mergedPersonIdOf(row: {
  identityKey: string
  identityKeyKind: 'url_token' | 'uid' | 'solo'
}): string | null {
  if (row.identityKeyKind !== 'uid') return null
  if (!row.identityKey.startsWith('uid:')) return null
  const id = row.identityKey.slice('uid:'.length)
  return id.length > 0 ? id : null
}

const STATUS: Record<MergedPersonStatus, string> = {
  active: '運用中',
  review: '確認待ち',
  archived: '停止',
}

export function statusText(status: MergedPersonStatus): string {
  return knownText(STATUS, status, '状態を確認できません')
}

const SOURCE: Record<MergedPersonProfileSource, string> = {
  friend: '友だち',
  friend_field: '友だち情報',
  form: '回答フォーム',
  ec: 'EC連携',
  manual: '手で入力',
}

/** 採用元。「どこから採ったか」が読めないと、値を疑ったとき確かめられない。 */
export function sourceText(sourceType: MergedPersonProfileSource): string {
  return knownText(SOURCE, sourceType, '取得元を確認できません')
}

const UPDATE_MODE: Record<MergedPersonProfileUpdateMode, string> = {
  auto: '新しい値で自動更新',
  fixed: 'この値で固定',
}

export function updateModeText(mode: MergedPersonProfileUpdateMode): string {
  return knownText(UPDATE_MODE, mode, '更新方法を確認できません')
}

const PURPOSE: Record<MergedPersonDeliveryPurpose, string> = {
  broadcast: '一斉配信',
  scenario: 'シナリオ配信',
  reminder: 'リマインド',
  transactional: '手続きの通知',
  manual: '個別の送信',
}

export function purposeText(purpose: MergedPersonDeliveryPurpose): string {
  return knownText(PURPOSE, purpose, '用途を確認できません')
}

const EVENT: Record<MergedPersonEventType, string> = {
  candidate: '候補',
  link: '結び付け',
  unlink: '解除',
  profile: 'プロフィール',
  priority: '配信の優先順',
  migration: '移行',
}

export function eventText(eventType: MergedPersonEventType): string {
  return knownText(EVENT, eventType, '履歴の種類を確認できません')
}

/**
 * 確からしさ。
 *
 * `null` は**移行前の既存の結び付きなど、記録していない**という意味で、
 * 「0%」ではない。0 と同じ見せ方にすると、根拠が無いまま結び付けたように読める。
 */
export function confidenceText(confidence: number | null): string {
  return confidence === null ? NOT_AVAILABLE : `${confidence}%`
}

/** 画面へ出してよい値。`valuePreview` が無ければ「—」。生値は組み立てない。 */
export function previewText(valuePreview: string | null): string {
  return valuePreview ?? NOT_AVAILABLE
}

/** 日時。`—` と実際の日時を混ぜない。 */
export function dateText(value: string | null): string {
  if (!value) return NOT_AVAILABLE
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE
  return formatDateTime(date)
}

/**
 * 用途ごとに配信元をまとめる。
 *
 * 契約は `deliveryPriorities` を平らな配列で返すが、**優先順は用途ごとに
 * 独立している**（一斉配信の1位とリマインドの1位は別）。用途を混ぜて
 * 並べると、順位が重複した一覧に見える。
 */
export function groupByPurpose(
  priorities: MergedPersonDeliveryPriority[],
): Array<{ purpose: MergedPersonDeliveryPurpose; rows: MergedPersonDeliveryPriority[] }> {
  const order: MergedPersonDeliveryPurpose[] = [
    'broadcast', 'scenario', 'reminder', 'transactional', 'manual',
  ]
  const groups = new Map<MergedPersonDeliveryPurpose, MergedPersonDeliveryPriority[]>()
  for (const row of priorities) {
    const rows = groups.get(row.purpose) ?? []
    rows.push(row)
    groups.set(row.purpose, rows)
  }
  return order
    .filter((purpose) => groups.has(purpose))
    .map((purpose) => ({
      purpose,
      rows: [...(groups.get(purpose) ?? [])].sort((a, b) => a.priority - b.priority),
    }))
}

/** 日付だけ。狭い列で時刻まで出すと、2行に折れて表がはみ出す。 */
export function dayText(value: string | null): string {
  if (!value) return NOT_AVAILABLE
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE
  return formatDay(date)
}

export type MergedPersonFailure = {
  kind: 'forbidden' | 'error' | 'stale'
  title: string
  description: string
}

type FailureInput = { status?: number; code?: string | null } | null | undefined

/**
 * 失敗を、画面に出してよい形へ落とす。
 *
 * **統合ユーザーの名前・マスク値・内部IDはここを通らない。** 権限が無い人へ、
 * 伏せるべき中身が断片的に見えるのを防ぐ。Worker の `code` はそのまま出さず、
 * 対応が分かれるものだけ言い分ける。
 */
export function failureOf(input: FailureInput): MergedPersonFailure {
  if (input?.status === 403) {
    return {
      kind: 'forbidden',
      title: 'この統合ユーザーを見る権限がありません',
      description: '見るには権限が要ります。オーナーか管理者に追加を依頼してください。',
    }
  }
  /*
   * **`code` では見分けられない。** `extractApiErrorCode` は本文の `error` が
   * 英小文字のsnake_caseのときだけコードとして拾う。Workerは `error` に
   * 日本語の文、`code` に `STALE_PERSON` を入れるので、画面へ届く
   * `ApiError.code` は常に `undefined` になる（実際に409の絵を撮って気づいた）。
   * この読み口の409は版の競合しか無いので、状態番号だけで判断する。
   */
  if (input?.status === 409) {
    return {
      kind: 'stale',
      title: '別の人が先に変更しました',
      description: '最新の状態を読み直してから、もう一度変更してください。',
    }
  }
  return {
    kind: 'error',
    title: '統合ユーザーを表示できませんでした',
    description: '時間をおいて読み直してください。直らない場合はエラー報告へ。',
  }
}

/**
 * 配信元の保存を送ってよいか。
 *
 * **空配列は「全部解除」**なので、押し間違いで送られてはいけない。
 * 明示的に全部解除を選んだときだけ通す（設計 `w8W4Eh` の「優先順位を変更」）。
 */
export function canSaveDeliveryPriorities(input: {
  priorities: MergedPersonDeliveryPriority[]
  confirmedClearAll: boolean
  busy: boolean
}): boolean {
  if (input.busy) return false
  const active = input.priorities.filter((row) => row.isActive)
  if (active.length === 0) return input.confirmedClearAll
  return true
}
