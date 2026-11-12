/*
 * ★V8 流入と計測の一覧の行づくり（データの形と並べ方だけ。見た目は持たない）。
 * 今の一覧（app/inflow-links/page.tsx の InflowLinksPageInner）と同じ判断を写した。
 * src/v8 からは @/app を import できないので、元を直したらここも直す。
 */
import type { EntryRoute, Scenario, Tag } from '@line-crm/shared'
import { formatDate as polishFormatDate } from '@/lib/format'


export interface RefRouteStats {
  refCode: string
  /** entry_routes に登録された name。未登録なら null。 */
  name: string | null
  friendCount: number
  clickCount: number
  latestAt: string | null
  orderCount?: number
  refundedOrderCount?: number
  cancelledOrderCount?: number
}

export interface RefSummaryData {
  routes: RefRouteStats[]
  totalFriends: number
  friendsWithRef: number
  friendsWithoutRef: number
  routeTotal?: number
  totalClicks?: number
  averageAddRate?: number
  orders?: {
    total: number
    linked: number
    attributed: number
    refunded: number
    cancelled: number
  }
}

export function isRefSummaryData(value: unknown): value is RefSummaryData {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RefSummaryData>
  return Array.isArray(candidate.routes)
    && Number.isFinite(candidate.totalFriends)
    && Number.isFinite(candidate.friendsWithRef)
    && Number.isFinite(candidate.friendsWithoutRef)
}

export interface TrackedLinkRow {
  id: string
  name: string
  scenarioId: string | null
  isActive: boolean
}

export type RouteRow = {
  source: 'entry_route' | 'tracked_link' | 'orphan'
  /** entry_routes に登録があれば id。tracked_link / orphan は null。 */
  entryRouteId: string | null
  refCode: string
  genre: string | null
  name: string
  poolId: string | null
  tagId: string | null
  scenarioId: string | null
  /** 友だちになった直後に送るテンプレート（entry_route のみ）。WEB033。 */
  introTemplateId: string | null
  /** entry_route のみ意味を持つ（並走／上書き）。他は null。 */
  runAccountFriendAddScenarios: boolean | null
  /** 登録の有効・無効。tracked_link は true、未登録 ref は null。 */
  isActive: boolean | null
  stats: RefRouteStats | undefined
}

/**
 * entry_routes → tracked_links → 実流入だけの ref（orphan）の順に1つの行へまとめる。
 * Worker の applyRefAttribution と同じ優先順位。
 */
export function buildRows(
  routes: EntryRoute[],
  trackedLinks: TrackedLinkRow[],
  summary: RefSummaryData | null,
): RouteRow[] {
  const statsByRef = new Map<string, RefRouteStats>()
  summary?.routes?.forEach((r) => statsByRef.set(r.refCode, r))
  const built = new Map<string, RouteRow>()
  // 停止中の entry_route と有効な tracked_link が同じ ref にあると、実際に動くのは tracked_link。
  const activeTrackedLinkRefCodes = new Set(trackedLinks.filter((tl) => tl.isActive).map((tl) => tl.id))
  for (const r of routes) {
    if (!r.isActive && activeTrackedLinkRefCodes.has(r.refCode)) continue
    built.set(r.refCode, {
      source: 'entry_route',
      entryRouteId: r.id,
      refCode: r.refCode,
      genre: r.genre,
      name: r.name,
      poolId: r.poolId,
      tagId: r.tagId,
      scenarioId: r.scenarioId,
      introTemplateId: r.introTemplateId ?? null,
      runAccountFriendAddScenarios: r.runAccountFriendAddScenarios,
      isActive: r.isActive,
      stats: statsByRef.get(r.refCode),
    })
  }
  for (const tl of trackedLinks) {
    if (built.has(tl.id)) continue
    // 友だちの ref に焼かれた（集計に出る）有効なものだけ。クリック計測だけのものは出さない。
    if (!statsByRef.has(tl.id)) continue
    if (!tl.isActive) continue
    built.set(tl.id, {
      source: 'tracked_link',
      entryRouteId: null,
      refCode: tl.id,
      genre: null,
      name: tl.name,
      poolId: null,
      tagId: null,
      scenarioId: tl.scenarioId,
      introTemplateId: null,
      runAccountFriendAddScenarios: null,
      isActive: true,
      stats: statsByRef.get(tl.id),
    })
  }
  for (const s of summary?.routes ?? []) {
    if (built.has(s.refCode)) continue
    built.set(s.refCode, {
      source: 'orphan',
      entryRouteId: null,
      refCode: s.refCode,
      genre: null,
      name: s.name ?? '（未登録）',
      poolId: null,
      tagId: null,
      scenarioId: null,
      introTemplateId: null,
      runAccountFriendAddScenarios: null,
      isActive: null,
      stats: s,
    })
  }
  return Array.from(built.values())
}

/**
 * 選んでいるアカウントで行を出すか（app/inflow-links/visibility.ts と同じ）。
 * Pool未設定の entry_route は作りたてで消えないように出す。
 */
export function shouldShowRow(
  row: Pick<RouteRow, 'source' | 'poolId'> & { friendCount: number },
  selectedAccountId: string | null,
  poolRoutesToAccount: (poolId: string | null, accountId: string) => boolean,
): boolean {
  if (!selectedAccountId) return true
  if (row.friendCount > 0) return true
  if (row.source === 'orphan') return false
  if (row.source === 'entry_route' && row.poolId === null) return true
  return poolRoutesToAccount(row.poolId, selectedAccountId)
}

/**
 * 友だちになっても何も起きない（タグもシナリオもすぐ送るテンプレートも無い登録済み）経路か。
 * WEB033：すぐ送るテンプレートだけを設定した経路を「未設定」と数えない。
 */
export function isUnconfigured(row: RouteRow): boolean {
  return !row.scenarioId && !row.tagId && !row.introTemplateId && row.source === 'entry_route'
}

export type RouteFilter = 'all' | 'has-friends' | 'no-friends' | 'unconfigured'
export type RouteSort = 'friends-desc' | 'clicks-desc' | 'latest-desc' | 'name'

export function matchesFilter(row: RouteRow, filter: RouteFilter, summaryAvailable: boolean): boolean {
  if (filter === 'has-friends') return summaryAvailable && (row.stats?.friendCount ?? 0) > 0
  if (filter === 'no-friends') return summaryAvailable && (row.stats?.friendCount ?? 0) === 0
  if (filter === 'unconfigured') return isUnconfigured(row)
  return true
}

export function sortRows(rows: RouteRow[], sort: RouteSort): RouteRow[] {
  return [...rows].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'ja')
    if (sort === 'clicks-desc') return (b.stats?.clickCount ?? 0) - (a.stats?.clickCount ?? 0)
    if (sort === 'friends-desc') return (b.stats?.friendCount ?? 0) - (a.stats?.friendCount ?? 0)
    const sa = a.stats?.latestAt ?? ''
    const sb = b.stats?.latestAt ?? ''
    if (!sa && !sb) return 0
    if (!sa) return 1
    if (!sb) return -1
    return sb.localeCompare(sa)
  })
}

/** 「友だちになったら」の2行。絵の「シナリオ／タグ・同時配信なし」の並び。 */
export function becameLines(row: RouteRow, sc: Scenario | undefined, tag: Tag | undefined, introTemplateName?: string | null): [string, string] {
  const first = sc ? `シナリオ「${sc.name}」` : '—'
  if (tag) {
    const suffix = row.runAccountFriendAddScenarios === false ? '・同時配信なし' : ''
    return [first, `タグ「${tag.name}」${suffix}`]
  }
  if (sc) return [first, row.runAccountFriendAddScenarios === false ? '同時配信なし' : '—']
  // WEB033：すぐ送るテンプレートだけのときは「何も付けない」と言わない。
  if (row.introTemplateId) return ['—', introTemplateName ? `テンプレート「${introTemplateName}」を送る` : 'テンプレートを送る']
  return ['—', '何も付けない']
}

/** 流入元名の下の札。測れていない受付中は何も付けない（測ったふりをしない）。 */
export function routeStatus(row: RouteRow): 'measured' | 'unregistered' | 'stopped' | null {
  if (row.isActive === false) return 'stopped'
  if (row.source === 'orphan') return 'unregistered'
  if (row.source === 'tracked_link') return 'measured'
  return row.stats ? 'measured' : null
}

/** 最新追加の日時（絵の「9/30 14:12」の形）。読めなければ「—」。 */
export function formatLatest(iso: string | null | undefined): string {
  return polishFormatDate(iso, { style: 'list', fallback: '—' })
}
