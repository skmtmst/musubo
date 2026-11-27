import { knownValue } from '@/lib/known-value'
/* app/settings/manual-links/manual-link-view.ts から写した（src/v8 は @/app を読めない）。開けない数の言い方だけ ★V8  に合わせた。 */
import { MANUAL_LINKS } from '@/lib/manual-links'
import type { ManualLink } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/**
 * 設計 ★管理画面 34-4「マニュアルの正本表」（`f9oUm`）。
 *
 * トップバーの「マニュアル」がどこを開くかを、運営だけが決める表。
 *
 * **表の正本はサーバにある。** 一覧は `GET /api/manual-links` を読む
 * （`page.tsx` が `api.manualLinks.list` で取得）。
 * 下の 4 つの作業 ID は、サーバにまだ無い分の手元の行。
 * 出せない分を 0 件として描かず、何が足りないかを言う。
 */

/** リンクの状態。設計の 3 つ。 */
export type LinkStatus = 'ok' | 'broken' | 'unset'

export const LINK_STATUS_LABEL: Record<LinkStatus, string> = {
  ok: '開けます',
  broken: '開けません',
  unset: 'まだ決めていません',
}

export function manualLinkStatusLabel(status: string): string {
  return knownValue(LINK_STATUS_LABEL, status, '状態を確認できません')
}

export interface ManualLinkRow {
  /** 画面 ID。作業 ID のときは `—`（画面に結び付いていない）。 */
  screenId: string
  /** 作業 ID。画面 ID のときは null。 */
  taskId: string | null
  /** 画面名・作業名。 */
  name: string
  url: string
  /** 最後に確かめた日。確かめていなければ null。 */
  checkedAt: string | null
  status: LinkStatus
}

/** 作業 ID の呼び名。要件 §8-2「正本表に『作業 ID』の列を足して吸収する」。 */
const TASK_NAMES: Record<keyof typeof MANUAL_LINKS, string> = {
  createOfficialAccount: 'LINE公式アカウントを作る',
  enableMessagingApi: 'Messaging APIを有効にする',
  findChannelCredentials: '2つの値の場所を見る',
  createLiffApp: 'LIFFアプリを作る',
}

/**
 * URL からリンクの状態を決める。
 *
 * **「決めていない」と「開けない」を言い分ける。**
 * どちらもマニュアルは開かないが、運営のやることが違う——
 * 前者は決める、後者は直す。
 */
export function statusOf(url: string, checkedAt: string | null): LinkStatus {
  if (url.trim() === '') return 'unset'
  // 確かめていない URL を「開けます」と言わない。確かめて初めて言える。
  return checkedAt == null ? 'unset' : 'ok'
}

/** いま手元にある行。作業 ID の 4 つだけ。 */
export function localRows(): ManualLinkRow[] {
  return (Object.keys(MANUAL_LINKS) as Array<keyof typeof MANUAL_LINKS>).map((key) => {
    const url = MANUAL_LINKS[key]
    return {
      screenId: '—',
      taskId: key,
      name: TASK_NAMES[key],
      url,
      checkedAt: null,
      status: statusOf(url, null),
    }
  })
}

export function manualLinkRow(link: ManualLink): ManualLinkRow {
  return {
    screenId: link.keyKind === 'screen' ? link.key : '—',
    taskId: link.keyKind === 'task' ? link.key : null,
    name: link.name,
    url: link.url ?? '',
    checkedAt: link.lastCheckedAt === null || typeof link.lastCheckedAt === 'string' ? link.lastCheckedAt : '日時を確認できません',
    status: link.status,
  }
}

/** URL の見せ方。空のときは URL に見せない。 */
export function urlLabel(url: string): string {
  return url.trim() === '' ? '（まだ決めていません）' : url
}

/** 最後に確かめた日。確かめていなければ `—`。 */
export function checkedLabel(checkedAt: string | null): string {
  if (!checkedAt) return '—'
  if (/^\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}$/.test(checkedAt)) return checkedAt
  const date = new Date(checkedAt)
  if (Number.isNaN(date.getTime())) return checkedAt
  return formatDateTime(date)
}

/** 絞り込みの区分。設計の「状態：すべて」。 */
export type StatusFilter = 'all' | LinkStatus

export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'ok', label: '開けます' },
  { value: 'broken', label: '開けません' },
  { value: 'unset', label: 'まだ決めていません' },
]

export function matchesStatus(row: ManualLinkRow, filter: StatusFilter): boolean {
  return filter === 'all' || row.status === filter
}

/** 画面ID・画面名で探す。作業 ID も同じ欄で引ける。 */
export function matchesQuery(row: ManualLinkRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [row.screenId, row.taskId ?? '', row.name].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
}

/**
 * 開けないリンクの数の言い方。
 * **0 件のときは何も言わない。**「0件あります」は読み手の仕事を増やすだけ。
 */
export function brokenNotice(rows: ReadonlyArray<ManualLinkRow>): string | null {
  const broken = rows.filter((r) => r.status === 'broken').length
  if (broken === 0) return null
  return `開けないリンクが ${broken} 件あります。直すまで、その画面の「マニュアル」は押しても何も出ません。`
}

/**
 * 表に出ていない画面の数の言い方。
 *
 * **262 件を「0 件」と書かない。** 引く口が無いだけで、画面はある。
 */
export const MISSING_SCREENS_NOTE =
  '画面ごとのマニュアルの対応表は、まだ保存する口がありません。いま出せるのは、店舗を登録するときの案内リンク4件だけです。'

/** 「いま全部を確かめる」が押せない理由。 */
export const VERIFY_UNAVAILABLE_NOTE =
  'リンクが開けるかを確かめる仕組みが、まだ入っていません。'

/** 確認のしかた。設計 `f9oUm` の締めの1行。 */
export const VERIFY_SCHEDULE_NOTE =
  '確かめるのは毎日 04:00 と、この画面の「いま全部を確かめる」を押したときです。'

/**
 * この表を触れる人。サーバー（`manual-links.ts` の `canOperate`）を広めに写す。
 *
 * 運営の代表（`env-owner`）か、マニュアルの編集権限
 * （`manual.link.edit`）を持つ人は必ず出す。代表者（owner）も出す。
 * 以前は代表者だけを見ていたため、権限を持つ人でも表が出なかった。
 * 最終の可否はサーバーが決める。権限が足りない操作は 403 として
 * 理由と依頼先を画面に出す。
 */
export { canEditManualLinks as canEditTable } from '@/lib/manual-link-access'
