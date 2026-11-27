'use client'

/*
 * ★V8 分析（Pencil：友だちの増減 ・1152 ・閲覧のみ ・
 * 配信の反応 ・経路と成果 ・URLクリック ・成果地点ごとの
 * レポート ・ファネル ・クロス分析 ・使われ方 ・
 * 保存した分析 ）。
 *
 * 型（ListPage）に、板の頭・二段の切り替え（組／見かた）・閲覧のみの帯・
 * 見かたごとの数の帯と本文を渡す。ファネルの作る・編集フォームと結果の保存欄だけは、
 * 入口（app/analytics/page.tsx）が今の部品を `slots` で渡す。
 *
 * 受け付ける URL・呼ぶ口・権限は今の画面と同じ（BEHAVIOR.md）。
 */
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Tabs } from '@/components/shared/tabs'
import SegmentedControl from '@/components/shared/segmented'
import { useRouter, useSearchParams } from 'next/navigation'
import { Download, Plus } from 'lucide-react'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { AnalyticsExportContextV8, CsvExportButton, type ExportAction } from './parts'
import FriendsV8 from './friends'
import ReactionsV8 from './reactions'
import RoutesV8 from './routes'
import UrlClicksV8 from './url-clicks'
import ConversionReportV8 from './conversion-report'
import UsageV8 from './usage'
import SavedV8 from './saved'
import FunnelV8, { type FunnelFormSlot, type FunnelSaveSlot } from './funnel'
import CrossV8 from './cross'
import SegmentsV8 from './segments'
import styles from './analytics.module.css'

import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

export const ANALYTICS_TABS = ['friends', 'reactions', 'routes', 'usage', 'cross', 'funnel', 'url-clicks', 'saved', 'segments'] as const
export type AnalyticsTabV8 = (typeof ANALYTICS_TABS)[number] | 'conversion-report'

/** 絵の二段：上は組（成果を見る・お客さまを分析・利用と保存）、下はその組の見かた。 */
const GROUPS: Array<{ label: string; tabs: Array<{ key: string; label: string }> }> = [
  { label: '成果を見る', tabs: [{ key: 'friends', label: '友だちの増減' }, { key: 'reactions', label: '配信の反応' }, { key: 'routes', label: '経路と成果' }, { key: 'url-clicks', label: 'URLクリック' }] },
  { label: 'お客さまを分析', tabs: [{ key: 'funnel', label: 'ファネル' }, { key: 'cross', label: 'クロス分析' }, { key: 'segments', label: 'お客さまの分け方' }] },
  { label: '利用と保存', tabs: [{ key: 'usage', label: '使われ方' }, { key: 'saved', label: '保存した分析' }] },
]
/** 成果地点ごとのレポートは「経路と成果」の中の1つの見かた（ はタブが経路と成果）。 */
const tabOwner = (tab: string) => tab === 'conversion-report' ? 'routes' : tab
const hrefOf = (key: string) => `/analytics?tab=${key}`

const BOARD: Record<string, string> = {
  reactions: 'yvOtn', routes: 'PFe9c', usage: 'N8ZrUl', cross: 'u5CuB8', funnel: 'DkRDE',
  'url-clicks': 'iK4cQ', saved: 'bglah', 'conversion-report': 'AzrZq', segments: 'RMajm',
}

/** 作る・編集のフォームと結果の保存欄は、入口が今の部品を渡す（src/v8 から @/app を読めないため）。 */
export type AnalyticsSlotsV8 = {
  renderFunnelForm?: (props: Parameters<FunnelFormSlot>[0] & { accountId: string }) => ReactNode
  renderSave?: (props: Parameters<FunnelSaveSlot>[0] & { accountId: string; sourceKind: 'cross' | 'funnel' }) => ReactNode
  funnelStepKindsLabel?: string
}


function readTab(params: URLSearchParams): AnalyticsTabV8 {
  if (params.get('tab') === 'conversion-report' || params.get('view') === 'conversion-report') return 'conversion-report'
  const raw = params.get('tab')
  // 旧キー clicks（Search Console 側の以前の表記）は URL クリックへ寄せる。知らない値は先頭へ。
  const key = raw === 'clicks' ? 'url-clicks' : raw
  return (ANALYTICS_TABS as readonly string[]).includes(key ?? '') ? key as AnalyticsTabV8 : 'friends'
}

function Navigation({ active, savedCount }: { active: AnalyticsTabV8; savedCount: number | null }) {
  const owner = tabOwner(active)
  const group = GROUPS.find((item) => item.tabs.some((tab) => tab.key === owner)) ?? GROUPS[0]
  const router = useRouter()
  /* 88: 上の段（組）は下線のタブ、下の段（見かた）は灰の箱の切り替え。移動は履歴を積まない置き換え。 */
  return <div className={styles.navigation}>
    <Tabs label="分析の組" items={GROUPS.map((item) => ({ label: item.label, href: hrefOf(item.tabs[0].key), current: item.label === group.label }))} />
    <SegmentedControl aria-label="分析の見かた" value={owner}
      onChange={(key) => router.replace(hrefOf(key))}
      options={group.tabs.map((item) => ({ value: item.key, label: item.label, count: item.key === 'saved' ? savedCount ?? undefined : undefined }))} />
  </div>
}

function AnalyticsInnerV8({ slots }: { slots?: AnalyticsSlotsV8 }) {
  const params = useSearchParams()
  const tab = readTab(params)
  usePageTitle('分析')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const role = useStaffRole()
  const canManage = canManageRole(role)
  const manageReason = usePermissionLockReason(canManage)
  const canRunRole = role !== null && role !== 'viewer'
  const runReason = usePermissionLockReason(canRunRole)
  const canRun = canRunRole && !runReason
  const readOnly = role !== null && !canManage
  const narrow = useNarrowViewport(1351)
  const scope = `${selectedAccountId}:${tab}`
  const [exportAction, setExportAction] = useState<(ExportAction & { scope: string }) | null>(null)
  const registerExport = useCallback((action: ExportAction | null) => setExportAction(action ? { ...action, scope } : null), [scope])
  const [savedCount, setSavedCount] = useState<number | null>(null)
  useEffect(() => { setSavedCount(null) }, [selectedAccountId])

  if (accountLoading) return <div className={styles.waiting}>分析を読み込んでいます</div>
  if (!selectedAccountId) return <div className={styles.waiting}>LINE公式アカウントを選んでください</div>

  const board = tab === 'friends' ? (readOnly ? 'L4Uov' : narrow ? 'eEhYU' : 'ws9wt') : BOARD[tab]
  const exportReady = exportAction !== null && exportAction.scope === scope && !exportAction.disabled
  const exportReason = exportReady ? undefined : tab === 'segments' ? 'この見かたではCSVを書き出せません。'
    : exportAction?.scope === scope ? exportAction.disabledReason : '書き出す集計結果を確認しています。'
  const actions = <>
    <CsvExportButton variant="text" className={readOnly ? undefined : styles.csvButton} disabled={!exportReady} disabledReason={exportReason} onClick={() => exportAction?.scope === scope && exportAction.onClick()}><Download size={16} aria-hidden="true" />CSVで書き出す</CsvExportButton>
    {canManage
      ? <Button variant="primary" lockedReason={manageReason} href="/analytics/reports/new"><Plus size={16} aria-hidden="true" />レポートを作る</Button>
      : <Button variant="primary" lockedReason={manageReason} disabled={!manageReason}><Plus size={16} aria-hidden="true" />レポートを作る</Button>}
  </>
  const tabs = <>
    <Navigation active={tab} savedCount={savedCount} />
    {readOnly ? <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div> : null}
  </>
  const content = tab === 'friends' ? <FriendsV8 key={selectedAccountId} accountId={selectedAccountId} />
    : tab === 'reactions' ? <ReactionsV8 key={selectedAccountId} accountId={selectedAccountId} />
    : tab === 'routes' ? <RoutesV8 key={selectedAccountId} accountId={selectedAccountId} />
    : tab === 'conversion-report' ? <ConversionReportV8 key={selectedAccountId} accountId={selectedAccountId} />
    : tab === 'cross' ? <CrossV8 key={selectedAccountId} accountId={selectedAccountId} canManage={canManage}
      renderSave={slots?.renderSave ? (props) => slots.renderSave?.({ ...props, accountId: selectedAccountId, sourceKind: 'cross' }) : undefined} />
    : tab === 'funnel' ? <FunnelV8 key={selectedAccountId} accountId={selectedAccountId} canManage={canManage} canRun={canRun}
      presetConversion={params.get('conversionPointId') ? { id: params.get('conversionPointId') ?? '', name: params.get('conversionPointName') ?? '' } : null}
      renderForm={slots?.renderFunnelForm ? (props) => slots.renderFunnelForm?.({ ...props, accountId: selectedAccountId }) : undefined}
      renderSave={slots?.renderSave ? (props) => slots.renderSave?.({ ...props, accountId: selectedAccountId, sourceKind: 'funnel' }) : undefined}
      stepKindsLabel={slots?.funnelStepKindsLabel} />
    : tab === 'saved' ? <SavedV8 key={selectedAccountId} accountId={selectedAccountId} onCountChange={setSavedCount} canManage={canManage} />
    : tab === 'segments' ? <SegmentsV8 key={selectedAccountId} accountId={selectedAccountId} canManage={canManage} />
    : tab === 'usage' ? <UsageV8 key={selectedAccountId} accountId={selectedAccountId} />
    : <UrlClicksV8 key={selectedAccountId} accountId={selectedAccountId} />

  return <AnalyticsExportContextV8.Provider value={registerExport}>
    <ListPage
      boardId={board}
      title="分析"
      help={<span className={styles.description}>友だちの増減・配信の反応・経路と成果を、期間を決めて見ます。気になる見かたは保存して、レポートで毎週届けられます。</span>}
      actions={actions}
      tabs={tabs}
    >
      {content}
    </ListPage>
  </AnalyticsExportContextV8.Provider>
}

export default function AnalyticsV8({ slots }: { slots?: AnalyticsSlotsV8 }) {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return <Suspense fallback={<div className={styles.waiting}>読み込み中…</div>}><AnalyticsInnerV8 slots={slots} /></Suspense>
}
