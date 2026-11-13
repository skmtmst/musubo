'use client'
import { lockReason } from '@/components/shared/permission-lock'
import { DetailContent, DetailField, DetailSection } from '@/components/shared/detail-content'

import Toggle from '@/components/shared/toggle'
import { useListUrlValue } from '@/components/shared/list-url-state';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bookmark, Check, CircleHelp, Copy, Download, History, PenLine, Send, Undo2 } from 'lucide-react';
import type { NenCampaignSetting, NenColumn, NenColumnDeliveryPreview, NenColumnMetrics, NenDeliveryDetail, NenDeliveryList, NenFlowMetrics } from '@/lib/api';
import { useListItemHref } from '@/components/shared/list-navigation';


import { RowNameLink } from '@/components/shared/table';


import { jstDate } from '@/lib/jst-datetime';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';

import Link from '@/components/shared/list-navigation'
import { Eye } from 'lucide-react';

import { ListPage, ListPagePagination } from '@/components/templates';
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu as SharedRowMenu } from '@/components/shared/row-actions';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import LinePreview, { LinePreviewFlex, LinePreviewMessage } from '@/components/shared/line-preview'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Drawer from '@/components/shared/drawer'
import Dialog from '@/components/shared/dialog'
import ColumnPreview, { replaceCampaignSamples } from './preview'
import SegmentedControl from '@/components/shared/segmented'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import Radio from '@/components/shared/radio'
import Select from '@/components/shared/select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { Tabs } from '@/components/shared/tabs';
import { TextArea, TextField } from '@/components/shared/text-field';
import { Field, FieldError } from '@/components/shared/form-controls';
import { useFieldValidation } from '@/lib/use-field-validation';
import DateTimeField from '@/components/shared/date-time-field'
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { csvCell } from '@/lib/presentation';
import { formatNumber, formatYen as polishFormatYen } from '@/lib/format';
import { canRetryDelivery, deliveryTriggerLabel, formatCampaignAudience, formatCampaignTiming, isPastScheduledAt, jstDateTime, jstMonthDay, num, publishedAtIso, skippedNoRetryNote, statusLabel, type ColumnDeliveryPlan, type FriendOption, type NenCoupon, type NenKpis, type NenTab } from './display';
import StatusBadge from '@/components/shared/status-badge'
import styles from './list.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';

/*
 * ★V8-B NEN配信の一覧（Pencil「★V8-B 画面の地図」専用機能の組）。
 * 自動配信 ・コラム ・送った履歴 ・誕生日クーポンの決めごと（引き出し）。
 *
 * 取得・保存は今の入口（app/nen-campaigns/page.tsx）が持ったまま。ここは見せ方だけ。
 * 外側（見出し・タブ・数の帯・案内・道具の段）は4つのタブで同じ形にし、
 * 表は「見出し 36・行 56」の同じ物差しで並べる（タブを替えても表の頭が動かない）。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

export type { NenTab } from './display'

/** 入口（page.tsx）から受け取るもの。今の画面（管理画面）に渡しているものと同じ形。 */
export type NenCampaignsListProps = {
  tab: NenTab
  topAction?: ReactNode
  onTabChange: (tab: NenTab) => void
  settings: NenCampaignSetting[]
  columns: NenColumn[]
  columnsTotal: number | null
  /** WEB231：200本より先のコラムを読む。渡されたときだけ「続きを読み込む」を出す。 */
  onLoadMoreColumns?: () => Promise<void>
  kpis: NenKpis | null
  flowMetrics: NenFlowMetrics | null
  columnMetrics: NenColumnMetrics | null
  deliveryList: NenDeliveryList | null
  deliveryDetail: NenDeliveryDetail | null
  friends: FriendOption[]
  testFriendId: string
  onTestFriendChange: (id: string) => void
  accountId: string | null
  currentAccountData?: boolean
  loading: boolean
  tabError?: string
  onRetryTab?: () => void
  kpisFailed?: boolean
  notice: { tone: 'success' | 'error'; text: string } | null
  saving: string | null
  testing: string | null
  previewCampaignKey: string | null
  onPreviewCampaign: (key: string | null) => void
  onToggleSetting: (setting: NenCampaignSetting) => Promise<boolean | void>
  onTestSend: (setting: NenCampaignSetting) => void
  coupon: NenCoupon
  couponOpen: boolean
  onCouponOpenChange: (open: boolean) => void
  onCouponChange: (coupon: NenCoupon) => void
  onSaveCoupon: () => void
  savingCoupon: boolean
  selectedColumnId: string | null
  onSelectColumn: (id: string | null) => void
  audienceCount: number | null
  plan: ColumnDeliveryPlan
  onPlanChange: (plan: ColumnDeliveryPlan) => void
  introDraft: string
  onIntroChange: (text: string) => void
  onSaveIntro: (column: NenColumn) => void
  savingColumnId: string | null
  onPreviewColumn: (column: NenColumn) => Promise<NenColumnDeliveryPreview>
  onDeliverColumn: (column: NenColumn, scheduledAt: string | undefined, confirmation: { recipientCount: number; confirmationToken: string }) => Promise<boolean | void>
  onDuplicateColumn: (column: NenColumn) => void
  duplicatingColumnId?: string | null
  onTestColumn: (column: NenColumn) => void
  onShowDelivery: (id: string) => void
  onRetryDelivery: (id: string, version: number, reason: string) => void
  onChangeDeliveryView: (status?: string, cursor?: string, q?: string) => void
}

const BOARD: Record<NenTab, string> = { auto: 'MuhWR', paused: 'MuhWR', columns: 'Jxmqh', history: 'Tj7n4' }
const PAGE_SIZES = STANDARD_PAGE_SIZES
const NO_MANAGE_NOTE = '閲覧のみのため変えられません。変える操作はオーナーか管理者に頼んでください。'

/* 自動配信の CSV（一覧に出ている決めごとをそのまま出す）。 */
function autoSettingsToCsv(settings: NenCampaignSetting[], sentByKey: Map<string, number>): string {
  const header = ['配信名', 'きっかけ', '対象', '状態', '今月送信（通）']
  const lines = settings.map((setting) => [
    setting.label,
    formatCampaignTiming(setting),
    formatCampaignAudience(setting),
    setting.isEnabled ? '有効' : '停止中',
    String(sentByKey.get(setting.campaignKey) ?? 0),
  ].map(csvCell).join(','))
  return `﻿${[header.join(','), ...lines].join('\n')}`
}

function downloadCsv(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 状態の札（点＋文字）。tone は 動いている＝ok・予約中＝info・止めている／送っていない＝off。 */
function Pill({ tone, children }: { tone: 'ok' | 'info' | 'off' | 'danger'; children: ReactNode }) {
  return (
    <StatusBadge tone={tone === 'ok' ? 'success' : tone === 'off' ? 'neutral' : tone}>{children}</StatusBadge>
  )
}

/** 行の右端の「…」。押すと行の操作のメニュー（右クリックだけにしない）。 */
function RowMenu({ subject, items }: { subject: string; items: ActionMenuItem[] }) {
  if (items.length === 0) return <span className={styles.menuSpace} aria-hidden="true" />
  return (
    <span className={styles.menuBox}>
      <SharedRowMenu label={`「${subject}」の操作`} items={items} />
    </span>
  )
}

/** 表の下の件数とページ送り。2ページ以上は共通のページ送り（件数の文つき）、1ページでも件数は出す。 */
export function Pager({ total, page, size, onPage }: { total: number; page: number; size: number; onPage: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / size))
  return (
    <div className={styles.pagerRow}>
      <Pagination page={page} pageCount={pageCount} onPageChange={onPage} range={{ total, first: total === 0 ? 0 : (page - 1) * size + 1, last: Math.min(total, page * size) }} />
    </div>
  )
}

export default function NenCampaignsList(props: NenCampaignsListProps) {
  const { tab, settings, columns, kpis, loading } = props
  const staffRole = useStaffRole()
  const canEdit = canManageRole(staffRole)

  // コラムは自分のタブを持つので、自動配信の表には出さない。
  const autoSettings = useMemo(() => settings.filter((setting) => setting.category !== 'column'), [settings])
  const enabledCount = autoSettings.filter((setting) => setting.isEnabled).length
  const pausedCount = autoSettings.length - enabledCount
  const publishedCount = columns.filter((column) => column.publishedAt != null).length
  const columnTotal = props.columnsTotal ?? columns.length
  const settingsUnknown = Boolean(props.tabError) || (loading && settings.length === 0)
  const columnsUnknown = Boolean(props.tabError) || (loading && columns.length === 0)
  const sentByKey = useMemo(
    () => new Map((props.flowMetrics?.flows ?? []).map((flow) => [flow.campaignKey, flow.sent])),
    [props.flowMetrics],
  )
  const tabError = props.tabError ?? ''

  const exportCsv = () => downloadCsv(autoSettingsToCsv(autoSettings, sentByKey), csvFileName("NEN配信"))

  const actions = tab === 'columns'
    ? (canEdit ? props.topAction ?? <Button href="/nen-campaigns/columns/new"><PenLine size={16} aria-hidden="true" />コラムを書く</Button> : null)
    : <><Button type="button" onClick={exportCsv} disabled={autoSettings.length === 0}><Download size={16} aria-hidden="true" />CSVで書き出す</Button>{canEdit ? props.topAction : null}</>

  // 取れていないタブの件数に 0 を出さない。
  const countLabel = (base: string, count: number) => (tabError || (loading && settings.length === 0) ? base : `${base} ${count}`)
  const tabs = (
    <div className={styles.tabs}>
      <Tabs
        label="NEN配信の種類"
        items={[
          { label: countLabel('自動配信', autoSettings.length), current: tab === 'auto', onClick: () => props.onTabChange('auto') },
          { label: countLabel('コラム', columnTotal), current: tab === 'columns', onClick: () => props.onTabChange('columns') },
          { label: countLabel('停止中', pausedCount), current: tab === 'paused', onClick: () => props.onTabChange('paused') },
          { label: '送った履歴', current: tab === 'history', onClick: () => props.onTabChange('history') },
        ]}
      />
    </div>
  )

  const kpiPending = loading && kpis === null
  const kpiMissing = props.kpisFailed || tabError ? '読み込めませんでした' : kpiPending ? '読み込んでいます' : emptyValue('unknown')
  const sentDiff = kpis?.sentThisMonth != null && kpis.sentLastMonth != null ? kpis.sentThisMonth - kpis.sentLastMonth : null
  const openDetail = tab === 'history' ? '配信ごとの開封は LINE から取れません' : tab === 'columns' ? 'コラムを開いた割合' : '自動配信は開封を取れません（コラムだけ）'
  const stats = (
    <>
      {!canEdit ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status">閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice></div>
      ) : null}
      <KpiBand data-design="KPIs">
        <KpiCard presentation="band" title="自動配信" icon={<History size={16} aria-hidden="true" />} help="注文・発送・誕生日などのきっかけで送る配信の数です。" value={settingsUnknown ? null : autoSettings.length} unit="件" detail={settingsUnknown ? kpiMissing : `動いている ${enabledCount}・止めている ${pausedCount}`} />
        <KpiCard presentation="band" title="今月送った" icon={<CircleHelp size={16} aria-hidden="true" />} help={`今月（日本時間の月初から）送った通数です。先月 ${num(kpis?.sentLastMonth)}通。配信からの注文 ${num(kpis?.orders)}件・${kpis?.orderAmount == null ? '金額未取得' : polishFormatYen(kpis.orderAmount)}（送信後7日以内）。届かなかった ${num(kpis?.undelivered)}通・友だち解除 ${num(kpis?.unfollowed)}・ブロック ${num(kpis?.blocked)}。`} value={kpis?.sentThisMonth ?? null} unit={kpis?.sentThisMonth == null ? '' : '通'} detail={sentDiff == null ? kpiMissing : `先月より ${sentDiff >= 0 ? '+' : ''}${formatNumber(sentDiff)}`} />
        <KpiCard presentation="band" detailLayout="single" title={tab === 'history' ? '取得不可' : '開封率'} helpLabel={tab === 'history' ? undefined : '開封（コラムを開いた割合）'} icon={<CircleHelp size={16} aria-hidden="true" />} help={tab === 'history' ? '配信ごとの開封は LINE から取れません。' : 'コラムの記事を開いた割合です。自動配信は LINE から一人ずつの開封を取れません。'} value={tab === 'history' ? null : kpis?.openRate ?? null} unit={tab === 'history' || kpis?.openRate == null ? '' : '%'} detail={kpis ? openDetail : kpiMissing} />
        <KpiCard presentation="band" title="コラム" icon={<Undo2 size={16} aria-hidden="true" />} help="外部サイトの記事へつなぐコラムの本数です。" value={columnsUnknown ? null : columnTotal} unit="本" detail={columnsUnknown ? kpiMissing : `公開中 ${publishedCount}・下書き ${columns.length - publishedCount}`} />
      </KpiBand>
    </>
  )

  return (
    <ListPage
      skeleton
      boardId={BOARD[tab]}
      headingSize="regular"
      title="NEN配信"
      help="ネットショップの注文や誕生日に合わせて、決まったメッセージやコラムを自動で送ります。"
      toolbarSpacing="section"
      explanation={tab === 'columns' ? "コラムは外部サイトの記事へつなぐカードです。書いたあと、一覧の「この内容で予約する」で LINE に配信します。" : tab === 'history' ? "いつ・だれに・何を送ったかの記録です。届かなかったものも、ここで理由が分かります。" : "自動配信は、注文・発送・誕生日などのきっかけで送ります。止めると、そのあとのきっかけでは送りません。"}
      actions={actions}
      tabs={tabs}
      stats={stats}
      overlays={(
        <CouponDrawer
          open={props.couponOpen}
          coupon={props.coupon}
          saving={props.savingCoupon}
          canEdit={canEdit}
          onClose={() => props.onCouponOpenChange(false)}
          onChange={props.onCouponChange}
          onSave={props.onSaveCoupon}
        />
      )}
    >
      {props.notice ? (
        <div className={styles.noticeRow}>
          <Notice tone={props.notice.tone === 'success' ? 'success' : 'danger'} message={props.notice.text} />
        </div>
      ) : null}
      {tab === 'columns' ? (
        <ColumnsTab {...props} canEdit={canEdit} />
      ) : tab === 'history' ? (
        <HistoryTab {...props} canEdit={canEdit} />
      ) : (
        <AutoTab {...props} canEdit={canEdit} autoSettings={autoSettings} sentByKey={sentByKey} pausedOnly={tab === 'paused'} />
      )}
    </ListPage>
  )
}

/* ───────────── 自動配信・停止中 ───────────── */

type AutoFilter = '' | 'follow_up' | 'birthday' | 'off'

function AutoTab(props: NenCampaignsListProps & { canEdit: boolean; autoSettings: NenCampaignSetting[]; sentByKey: Map<string, number>; pausedOnly: boolean }) {
  const router = useRouter()
  const { autoSettings, sentByKey, pausedOnly, canEdit, kpis } = props
  const tabError = props.tabError ?? ''
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<AutoFilter>('filter', '')
  const [saved, setSaved] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [savedOpen, setSavedOpen] = useState(false)
  const [stopTarget, setStopTarget] = useState<NenCampaignSetting | null>(null)
  const scope = useRef({ id: props.accountId, generation: 0 })
  if (scope.current.id !== props.accountId) scope.current = { id: props.accountId, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const currentDataRef = useRef(props.currentAccountData)
  currentDataRef.current = props.currentAccountData
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [stopScope, setStopScope] = useState<{ id: string; generation: number } | null>(null)
  const [stopTried, setStopTried] = useState(false)
  const savedRef = useRef<HTMLSpanElement | null>(null)

  const followUpCount = autoSettings.filter((s) => s.category === 'follow_up').length
  const birthdayCount = autoSettings.filter((s) => s.category === 'birthday').length
  const offCount = autoSettings.filter((s) => !s.isEnabled).length
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return autoSettings
      .filter((setting) => {
        if (pausedOnly && setting.isEnabled) return false
        if (filter === 'follow_up' && setting.category !== 'follow_up') return false
        if (filter === 'birthday' && setting.category !== 'birthday') return false
        if (filter === 'off' && setting.isEnabled) return false
        if (saved && setting.category !== saved) return false
        if (q && !`${setting.label} ${formatCampaignTiming(setting)}`.toLocaleLowerCase().includes(q)) return false
        return true
      })
      // 今月多く送った順（絵の並び）。同じ数は名前順。
      .sort((a, b) => (sentByKey.get(b.campaignKey) ?? 0) - (sentByKey.get(a.campaignKey) ?? 0) || a.label.localeCompare(b.label, 'ja'))
  }, [autoSettings, pausedOnly, filter, saved, query, sentByKey])
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const rows = visible.slice((safePage - 1) * pageSize, safePage * pageSize)
  const filtering = query !== '' || filter !== '' || saved !== ''
  const monthLabel = kpis?.monthLabel ?? ''

  const savedOptions: Array<{ value: string; label: string }> = [
    { value: 'transactional', label: '注文・発送' },
    { value: 'follow_up', label: '注文のあと' },
    { value: 'birthday', label: 'ペットの誕生日' },
  ]

  const menuFor = (setting: NenCampaignSetting): ActionMenuItem[] => {
    const items: ActionMenuItem[] = []
    if (canEdit) items.push({ id: 'edit', label: '編集', external: false, href: `/nen-campaigns/edit?key=${encodeURIComponent(setting.campaignKey)}`, onSelect: () => { router.push(`/nen-campaigns/edit?key=${encodeURIComponent(setting.campaignKey)}`) } })
    items.push({ id: 'preview', label: "配信の文面を見る", onSelect: () => props.onPreviewCampaign(setting.campaignKey) })
    if (canEdit) {
      items.push({ id: 'test', label: 'テスト送信', disabled: props.testing !== null, onSelect: () => props.onTestSend(setting) })
      if (setting.campaignKey === 'birthday_coupon') items.push({ id: 'coupon', label: 'クーポンの決めごと', onSelect: () => props.onCouponOpenChange(true) })
      items.push(setting.isEnabled
        ? { id: 'stop', label: '止める', disabled: props.saving === setting.campaignKey || props.currentAccountData === false, disabledReason: props.currentAccountData === false ? '選択中のLINEアカウントの情報を読み直してください。' : undefined, onSelect: () => { if (!props.accountId || renderedScope !== scope.current || !alive.current || !canEditRef.current || currentDataRef.current === false) return; setStopScope({ id: props.accountId, generation: scope.current.generation }); setStopTried(false); setStopTarget(setting) } }
        : { id: 'start', label: '動かす', disabled: props.saving === setting.campaignKey || props.currentAccountData === false, disabledReason: props.currentAccountData === false ? '選択中のLINEアカウントの情報を読み直してください。' : undefined, onSelect: () => { if (renderedScope !== scope.current || !alive.current || !canEditRef.current || currentDataRef.current === false) return; return props.onToggleSetting(setting) } })
    } else if (setting.campaignKey === 'birthday_coupon') {
      items.push({ id: 'coupon', label: 'クーポンの決めごと', onSelect: () => props.onCouponOpenChange(true) })
    }
    items.push({ id: 'history', label: '送った履歴を見る', onSelect: () => props.onTabChange('history') })
    return items
  }

  return (
    <>

      <div className={styles.toolsRow}>
        <ListToolbar
          search={{ placeholder: '配信名で探す', width: 240, value: query, onChange: (value) => { setQuery(value); setPage(1) } }}
          filters={pausedOnly ? undefined : (
            <SegmentedControl<AutoFilter>
              aria-label="きっかけで絞り込む"
              value={filter}
              onChange={(next) => { setFilter(next); setPage(1) }}
              options={[
                { value: '', label: 'すべて' },
                { value: 'follow_up', label: '注文のあと', count: followUpCount, title: '注文のあとに送る配信だけ出します' },
                { value: 'birthday', label: '誕生日', count: birthdayCount, title: 'ペットの誕生日に送る配信だけ出します' },
                { value: 'off', label: '止めている', count: offCount, title: '止めている配信だけ出します' },
              ]}
            />
          )}
          trailing={(
            <>
              <span ref={savedRef} className={styles.savedBox}>
                <Button type="button" aria-haspopup="menu" aria-expanded={savedOpen} onClick={() => setSavedOpen((current) => !current)}>
                  <Bookmark size={16} aria-hidden="true" />{saved ? savedOptions.find((option) => option.value === saved)?.label : 'よく使う絞り込み'}
                </Button>
                <ActionMenu
                  open={savedOpen}
                  onClose={() => setSavedOpen(false)}
                  anchorRef={savedRef}
                  ariaLabel="よく使う絞り込み"
                  items={[
                    ...savedOptions.map((option) => ({ id: option.value, label: option.label, onSelect: () => { setSaved(option.value); setPage(1); setSavedOpen(false) } })),
                    ...(saved ? [{ id: 'clear', label: '絞り込みを外す', onSelect: () => { setSaved(''); setPage(1); setSavedOpen(false) } }] : []),
                  ]}
                />
              </span>
              <SaveErrorField names={["pageSize","page_size"]}><Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 件表示` }))} /></SaveErrorField>
            </>
          )}
        />
      </div>

      {props.loading && autoSettings.length === 0 && !tabError ? (
        <ListState kind="loading" title="自動配信を読み込んでいます" />
      ) : tabError ? (
        <ListState kind="error" title="自動配信を読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。" onRetry={props.onRetryTab} />
      ) : rows.length === 0 ? (
        filtering ? (
          <ListState kind="empty" title="条件に合う配信はありません" description="検索や絞り込みを外すと、すべて出ます。" action={<Button onClick={() => { setQuery(''); setFilter(''); setSaved(''); setPage(1) }}>条件を外す</Button>} />
        ) : (
          <ListState kind="empty" emptyPreset="readonly" title={pausedOnly ? '止めている配信はありません' : '自動配信はまだありません'} description={pausedOnly ? 'すべての自動配信が動いています。' : '決めごとができると、ここに並びます。'} />
        )
      ) : (
        <>
          <DataTable className={styles.table}>
            <thead>
              <TableHeadRow className={styles.headRow} data-table-layout="columns">
                <Th className={styles.colName}>配信</Th>
                <Th className={styles.colTrigger}>きっかけ</Th>
                <Th className={styles.colTarget}>対象</Th>
                <Th className={styles.colSent}>{monthLabel ? `${monthLabel} 送信` : '今月 送信'}</Th>
                <Th className={styles.colOrders}>注文</Th>
                <Th className={styles.colState}>状態</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {rows.map((setting) => {
                const sent = sentByKey.get(setting.campaignKey)
                const timing = formatCampaignTiming(setting)
                const audience = formatCampaignAudience(setting)
                return (
                  <Tr data-row-id={setting.campaignKey} key={setting.campaignKey} className={styles.row} data-table-layout="columns" detailKey="campaign" onOpen={() => props.onPreviewCampaign(props.previewCampaignKey === setting.campaignKey ? null : setting.campaignKey)}>
                    <Td className={styles.colName}>
                      {canEdit ? (
                        <RowNameLink href={`/nen-campaigns/edit?key=${encodeURIComponent(setting.campaignKey)}`} className={styles.name} title={setting.title} ><TruncatedText value={String(setting.label ?? '')} /></RowNameLink>
                      ) : (
                        <button type="button" className={styles.name} title={setting.label}  onClick={() => props.onPreviewCampaign(setting.campaignKey)}>{setting.label}</button>
                      )}
                    </Td>
                    <Td className={styles.colTrigger}><span className={styles.cell} title={timing}>{timing}</span></Td>
                    <Td className={styles.colTarget}><span className={styles.cell} title={audience}>{audience}</span></Td>
                    <Td className={styles.colSent}><span className={styles.num}>{sent == null ? emptyValue('unknown') : formatNumber(sent)}</span></Td>
                    <Td className={styles.colOrders}><span className={styles.num} title="配信からの注文は配信ごとに取れていません">{emptyValue('unknown')}</span></Td>
                    <Td className={styles.colState}>{props.saving === setting.campaignKey ? <Pill tone="off">切り替え中</Pill> : setting.isEnabled ? <Pill tone="ok">有効</Pill> : <Pill tone="off">停止中</Pill>}</Td>
                    <Td className={styles.colMenu}><RowMenu subject={setting.label} items={menuFor(setting)} /></Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
          <Pager total={visible.length} page={safePage} size={pageSize} onPage={setPage} />
          <p className={styles.hint}>{canEdit ? '行の「…」から 編集・テスト送信・止める・送った履歴を見る。' : '行の「…」から 中身・送った履歴を見る。'}</p>
        </>
      )}
      <ConfirmDialog open={stopTarget !== null && stopScope?.generation === scope.current.generation} title={`「${stopTarget?.label ?? ''}」を止めますか？`}
        description="止めると、そのあとの注文・発送・誕生日などのきっかけでは、この自動配信を送りません。すでに送った配信は取り消されません。"
        confirmLabel="止める" destructive busy={Boolean(stopTarget && props.saving === stopTarget.campaignKey)}
        error={stopTried && props.notice?.tone === 'error' ? props.notice.text : undefined} onSuccess={() => setStopTarget(null)} onCancel={() => setStopTarget(null)} onConfirm={() => { if (!stopTarget || !stopScope || !alive.current || !canEditRef.current || currentDataRef.current === false || stopScope.generation !== scope.current.generation) return; setStopTried(true); return props.onToggleSetting(stopTarget) }} >{stopScope ? <OperationTargetSummary accounts={[{ id: stopScope.id }]} /> : null}</ConfirmDialog>
      <CampaignPreviewDrawer {...props} canEdit={canEdit} />
    </>
  )
}

/** 配信の中身（行の「…」→ 中身を見る）。お客様ごとの情報は見本に置き換える。 */
function CampaignPreviewDrawer(props: NenCampaignsListProps & { canEdit: boolean }) {
  const setting = props.previewCampaignKey ? props.settings.find((item) => item.campaignKey === props.previewCampaignKey) ?? null : null
  return (
    <Drawer
      width="narrow"
      open={setting !== null}
      title={setting ? `${setting.label}の中身` : '配信の中身'}
      description="お客様ごとの情報は見本に置き換えています。"
      onClose={() => props.onPreviewCampaign(null)}
      actions={{ primary: (setting ? <Button type="button" variant="primary" disabled={!props.testFriendId || props.testing === setting.campaignKey} busy={props.testing === setting.campaignKey} busyLabel="送信中…" onClick={() => props.onTestSend(setting)}>自分にテストを送る</Button> : null),
    menuItems: [], primaryAllowed: props.canEdit }}
    >
<DetailContent>
<DetailField label="テスト送信先"><TestRecipientPicker canEdit={props.canEdit} friends={props.friends} value={props.testFriendId} onChange={props.onTestFriendChange} accountId={props.accountId} /></DetailField>
{setting ? <>
  <DetailField label="送るタイミング">{formatCampaignTiming(setting)}</DetailField>
  <DetailField label="送り先">{formatCampaignAudience(setting)}</DetailField>
  <DetailSection title="届く見本">
    <DetailField label="題">{replaceCampaignSamples(setting.title)}</DetailField>
    <DetailField label="本文" multiline>{replaceCampaignSamples(setting.bodyText)}</DetailField>
    {setting.buttonLabel ? <DetailField label="ボタン">{setting.buttonLabel}</DetailField> : null}
  </DetailSection>
  <p className={styles.muted}>テスト送信は「設定 › アカウント › テスト送信先」に登録した、友だち追加中の人にだけ送ります。</p>
</> : null}
</DetailContent>
</Drawer>
  )
}

/** テスト送信先。登録した人だけを候補にし、いなければ登録先へ案内する。 */
function TestRecipientPicker({ friends, value, onChange, accountId, canEdit = true }: { canEdit?: boolean; friends: FriendOption[]; value: string; onChange: (id: string) => void; accountId: string | null }) {
  const role = useStaffRole()
  if (friends.length === 0) {
    return (
      <span className={styles.muted}>
        テスト送信先が未登録です
        {accountId ? <> <Link className={styles.link} href={`/accounts/detail?id=${encodeURIComponent(accountId)}`}>テスト送信先を登録する</Link></> : null}
      </span>
    )
  }
  return <SaveErrorField names={["value"]}><EntitySelect aria-label="テスト送信先" disabled={!canEdit} lockedReason={!canEdit && role !== null ? lockReason(false) : undefined} width={220} valuePrefix="送り先：" value={value} onChange={next => { if (canEdit) onChange(next) }} options={friends.map((friend) => ({ ...entityOptionMetadata(friend), value: friend.id, label: friend.displayName || '名前未取得' }))} /></SaveErrorField>
}

/* ───────────── 誕生日クーポンの決めごと ───────────── */

function CouponDrawer({ open, coupon, saving, canEdit, onClose, onChange, onSave }: {
  open: boolean
  coupon: NenCoupon
  saving: boolean
  canEdit: boolean
  onClose: () => void
  onChange: (coupon: NenCoupon) => void
  onSave: () => void
}) {
  const fields = useFieldValidation([
    ...(!Number.isInteger(coupon.discountAmount) || coupon.discountAmount < 1 || coupon.discountAmount > 100000
      ? [{ id: 'coupon-discount', message: '割引の額は1〜100,000円の整数で入力してください。' }] : []),
    ...(!Number.isInteger(coupon.validityDays) || coupon.validityDays < 1 || coupon.validityDays > 365
      ? [{ id: 'coupon-days', message: '使える日数は1〜365日の整数で入力してください。' }] : []),
    ...(!/^[A-Z0-9-]{3,10}$/.test(coupon.codePrefix)
      ? [{ id: 'coupon-prefix', message: '半角大文字・数字・-で3〜10文字にしてください。' }] : []),
  ])
  useEffect(() => { if (!open) fields.reset() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const prefix = coupon.codePrefix || 'NENBDAY'
  const leapLabel = coupon.leapYearPolicy === 'mar1' ? '3月1日に送る' : coupon.leapYearPolicy === 'skip' ? 'その年は送らない' : '2月28日に送る'
  // 閲覧のみの人には、押せない入力欄を置かずに値だけ見せる。
  if (!canEdit) {
    return (
      <Drawer
      width="narrow" heightMode="viewport"
        open={open}
        title="誕生日クーポンの決めごと"
        description="誕生日は3日前の10:00に送ります。名前と誕生日は、マイページで登録されたペット情報を使います。"
        onClose={onClose}
        details={[
          { label: 'クーポンを付ける', value: coupon.isEnabled ? '付ける' : '付けない' },
          { label: '特典の名前', value: coupon.benefitLabel || '—' },
          { label: '割引額', value: `${polishFormatYen(coupon.discountAmount || 0)}` },
          { label: '使える日数', value: `${coupon.validityDays || 0}日` },
          { label: 'コードの頭の文字', value: prefix },
          { label: '2月29日生まれの子への平年の扱い', value: leapLabel },
        ]}
      />
    )
  }
  return (
    <Drawer
      width="narrow" heightMode="viewport"
      open={open}
      title="誕生日クーポンの決めごと"
      description="誕生日は3日前の10:00に送ります。名前と誕生日は、マイページで登録されたペット情報を使います。"
      busy={saving}
      onClose={onClose}
      footer={(
        <div className={styles.drawerFoot}>
          <Button type="button" disabled={saving} onClick={onClose}>キャンセル</Button>
          <Button type="button" variant="primary" disabled={saving} busy={saving} busyLabel="保存中…" onClick={() => { if (fields.submit()) onSave() }}><Check size={16} aria-hidden />設定を保存する</Button>
        </div>
      )}
    >
      <div className={styles.couponForm}>
        <div className={styles.couponSwitch}>
          <SaveErrorField names={["isEnabled","coupon.isEnabled","is_enabled","coupon.is_enabled"]}><Toggle checked={coupon.isEnabled} label="クーポンを付ける" onChange={(next) => onChange({ ...coupon, isEnabled: next })} /></SaveErrorField>
          <div className={styles.couponSwitchText}>
            <strong>クーポンを付ける</strong>
            <span>切ると、誕生日のメッセージだけが届きます</span>
          </div>
        </div>
        <Field label="特典の名前"><SaveErrorField names={["benefitLabel","coupon.benefitLabel","benefit_label","coupon.benefit_label"]}><TextField value={coupon.benefitLabel} maxLength={40} onChange={(event) => onChange({ ...coupon, benefitLabel: event.target.value })} /></SaveErrorField></Field>
        <div className={styles.fieldPair}>
          <Field label="割引額（円）"><SaveErrorField names={["discountAmount","coupon.discountAmount","discount_amount","coupon.discount_amount"]}><NumberInput unit="円" {...fields.bind('coupon-discount')} type="number" min={1} max={100000} inputMode="numeric" value={coupon.discountAmount} onChange={(event) => onChange({ ...coupon, discountAmount: Number(event.target.value) })} /></SaveErrorField>
<FieldError id="coupon-discount-error">{fields.error('coupon-discount')}</FieldError></Field>
          <Field label="使える日数"><SaveErrorField names={["validityDays","coupon.validityDays","validity_days","coupon.validity_days"]}><NumberInput {...fields.bind('coupon-days')} type="number" min={1} max={365} inputMode="numeric" value={coupon.validityDays} onChange={(event) => onChange({ ...coupon, validityDays: Number(event.target.value) })} /></SaveErrorField>
<FieldError id="coupon-days-error">{fields.error('coupon-days')}</FieldError></Field>
        </div>
        <Field label="コードの頭の文字（10文字まで・大文字）"><SaveErrorField names={["codePrefix","coupon.codePrefix","code_prefix","coupon.code_prefix"]}><TextField {...fields.bind('coupon-prefix')} value={coupon.codePrefix} maxLength={10} title="半角大文字・数字・- で3〜10文字" onChange={(event) => onChange({ ...coupon, codePrefix: event.target.value.toUpperCase() })} /></SaveErrorField>
<FieldError id="coupon-prefix-error">{fields.error('coupon-prefix')}</FieldError></Field>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>2月29日生まれの子への平年の扱い</span>
          <SaveErrorField names={["leapYearPolicy","coupon.leapYearPolicy","leap_year_policy","coupon.leap_year_policy"]}><Select
            aria-label="2月29日生まれの子への平年の扱い"
            size="full"
            value={coupon.leapYearPolicy}
            onChange={(value) => onChange({ ...coupon, leapYearPolicy: value === 'mar1' || value === 'skip' ? value : 'feb28' })}
            options={[{ value: 'feb28', label: '2月28日に送る' }, { value: 'mar1', label: '3月1日に送る' }, { value: 'skip', label: 'その年は送らない' }]}
          /></SaveErrorField>
        </div>
        <div className={styles.sample}>
          <span className={styles.sampleLabel}>届く見本</span>
          <strong className={styles.sampleTitle}>{`${coupon.benefitLabel || 'お誕生日クーポン'} ${polishFormatYen(coupon.discountAmount || 0)}引き`}</strong>
          <span className={styles.sampleCode}>{`コード ${prefix}-1234・使える日数 ${coupon.validityDays || 0}日`}</span>
        </div>
        <p className={styles.muted}>クーポンが使われた記録は「コンバージョン」で確認できます。</p>
      </div>
    </Drawer>
  )
}

/* ───────────── コラム ───────────── */

type ColumnFilter = '' | 'published' | 'draft' | 'category'

function columnBadge(column: NenColumn, sent: number | null) {
  if (column.deliveryStatus === 'sent') return <Pill tone="ok">{sent == null ? '送信済み' : `送信済み ${formatNumber(sent)}`}</Pill>
  if (column.deliveryStatus === 'scheduled') return <Pill tone="info">予約中</Pill>
  if (column.deliveryStatus === 'queued') return <Pill tone="info">配信待ち</Pill>
  if (column.deliveryStatus === 'draft' && column.deliveryAt) return <Pill tone="off">未配信・{jstDateTime(column.deliveryAt)} に出したい</Pill>
  return <Pill tone="off">送っていない</Pill>
}

function ColumnsTab(props: NenCampaignsListProps & { canEdit: boolean }) {
  const itemHref = useListItemHref()
  const { columns, columnMetrics, canEdit } = props
  const tabError = props.tabError ?? ''
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<ColumnFilter>('filter', '')
  const [category, setCategory] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewColumn = columns.find((column) => column.id === previewId) ?? null
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [savedOpen, setSavedOpen] = useState(false)
  const [stopTarget, setStopTarget] = useState<{ setting: NenCampaignSetting; accountId: string; generation: number } | null>(null)
  const [stopTried, setStopTried] = useState(false)
  const scope = useRef({ id: props.accountId, generation: 0 })
  if (scope.current.id !== props.accountId) scope.current = { id: props.accountId, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const currentDataRef = useRef(props.currentAccountData)
  currentDataRef.current = props.currentAccountData
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const savedRef = useRef<HTMLSpanElement | null>(null)

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const column of columns) {
      const key = column.category?.trim() || '未分類'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [columns])
  const topCategory = categories[0] ?? null
  const columnSetting = props.settings.find((setting) => setting.campaignKey === 'column')
  const publishedCount = columns.filter((c) => c.publishedAt != null).length
  const metricById = useMemo(() => new Map((columnMetrics?.columns ?? []).map((row) => [row.id, row])), [columnMetrics])

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return columns.filter((column) => {
      if (filter === 'published' && column.publishedAt == null) return false
      if (filter === 'draft' && column.publishedAt != null) return false
      const cat = column.category?.trim() || '未分類'
      if (filter === 'category' && topCategory && cat !== topCategory[0]) return false
      if (category && cat !== category) return false
      if (q && !`${column.title} ${column.excerpt} ${column.category ?? ''}`.toLocaleLowerCase().includes(q)) return false
      return true
    })
  }, [columns, filter, category, topCategory, query])
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const rows = visible.slice((safePage - 1) * pageSize, safePage * pageSize)
  const filtering = query !== '' || filter !== '' || category !== ''

  const menuFor = (column: NenColumn): ActionMenuItem[] => canEdit ? [
    { id: 'reserve', label: 'この内容で予約する', onSelect: () => props.onSelectColumn(column.id) },
    { id: 'duplicate', label: '複製', disabled: props.duplicatingColumnId === column.id, onSelect: () => props.onDuplicateColumn(column) },
    { id: 'test', label: 'テスト送信', disabled: props.testing !== null, onSelect: () => props.onTestColumn(column) },
    { id: 'preview', label: 'LINEでの見え方', onSelect: () => setPreviewId(column.id) },
  ] : [
    { id: 'open', label: "配信の文面を見る", onSelect: () => props.onSelectColumn(column.id) },
    { id: 'preview', label: 'LINEでの見え方', onSelect: () => setPreviewId(column.id) },
  ]

  return (
    <div className={styles.inset}>

      <div className={styles.toolsRow}>
        <ListToolbar
          search={{ placeholder: 'コラムを探す', width: 240, value: query, onChange: (value) => { setQuery(value); setPage(1) } }}
          filters={(
            <SegmentedControl<ColumnFilter>
              aria-label="コラムを絞り込む"
              value={filter}
              onChange={(next) => { setFilter(next); setPage(1) }}
              options={[
                { value: '', label: 'すべて' },
                { value: 'published', label: '公開中', count: publishedCount },
                { value: 'draft', label: '下書き', count: columns.length - publishedCount },
                ...(topCategory ? [{ value: 'category' as const, label: topCategory[0], count: topCategory[1] }] : []),
              ]}
            />
          )}
          trailing={(
            <>
              <span ref={savedRef} className={styles.savedBox}>
                <Button type="button" aria-haspopup="menu" aria-expanded={savedOpen} onClick={() => setSavedOpen((current) => !current)}>
                  <Bookmark size={16} aria-hidden="true" />{category || 'よく使う絞り込み'}
                </Button>
                <ActionMenu
                  open={savedOpen}
                  onClose={() => setSavedOpen(false)}
                  anchorRef={savedRef}
                  ariaLabel="よく使う絞り込み"
                  items={[
                    ...categories.map(([name, count]) => ({ id: name, label: `${name} ${count}`, onSelect: () => { setCategory(name); setPage(1); setSavedOpen(false) } })),
                    ...(category ? [{ id: 'clear', label: '絞り込みを外す', onSelect: () => { setCategory(''); setPage(1); setSavedOpen(false) } }] : []),
                    ...(canEdit && columnSetting ? [{ id: 'toggle-column', label: columnSetting.isEnabled ? 'コラム配信を止める' : 'コラム配信を動かす', disabled: props.saving === columnSetting.campaignKey || props.currentAccountData === false, disabledReason: props.currentAccountData === false ? '選択中のLINEアカウントの情報を読み直してください。' : undefined, onSelect: () => { if (!props.accountId || renderedScope !== scope.current || !alive.current || !canEditRef.current || currentDataRef.current === false) return; if (columnSetting.isEnabled) { setStopTried(false); setStopTarget({ setting: columnSetting, accountId: props.accountId, generation: scope.current.generation }) } else void props.onToggleSetting(columnSetting); setSavedOpen(false) } }] : []),
                  ]}
                />
              </span>
              <SaveErrorField names={["pageSize","page_size"]}><Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 件表示` }))} /></SaveErrorField>
            </>
          )}
        />
      </div>

      {props.loading && columns.length === 0 && !tabError ? (
        <ListState kind="loading" title="コラムを読み込んでいます" />
      ) : tabError ? (
        <ListState kind="error" title="コラムを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。" onRetry={props.onRetryTab} />
      ) : rows.length === 0 ? (
        filtering ? (
          <ListState kind="empty" title="条件に合うコラムはありません" description="検索や絞り込みを外すと、すべて出ます。" action={<Button onClick={() => { setQuery(''); setFilter(''); setCategory(''); setPage(1) }}>条件を外す</Button>} />
        ) : (
          <ListState kind="empty" emptyPreset="readonly" title="コラムはまだありません" description={canEdit ? '右上の「コラムを書く」から下書きを作ると、ここに並びます。' : 'コラムが書かれると、ここに並びます。'} />
        )
      ) : (
        <>
          <DataTable className={styles.table}>
            <thead>
              <TableHeadRow className={styles.headRow} data-table-layout="columns">
                <Th className={styles.colName}>コラム</Th>
                <Th className={styles.colCategory}>分類</Th>
                <Th className={styles.colDate}>公開日</Th>
                <Th className={styles.colLine}>LINE 配信</Th>
                <Th className={styles.colViews}>閲覧</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {rows.map((column) => {
                const metric = metricById.get(column.id)
                const views = metric?.articleOpened.value
                const draft = column.publishedAt == null
                return (
                  <Tr data-row-id={column.id} key={column.id} className={styles.row} data-table-layout="columns" selected={props.selectedColumnId === column.id} detailKey="column" onOpen={() => props.onSelectColumn(props.selectedColumnId === column.id ? null : column.id)}>
                    <Td className={styles.colName}>
                      <span className={styles.nameStack}>
                        <RowNameLink onOpen={() => props.onSelectColumn(column.id)} href={itemHref('column', column.id, { tab: 'columns' })} className={styles.name} title={column.title}>{column.title}</RowNameLink>

                      </span>
                    </Td>
                    <Td className={styles.colCategory}><span className={styles.cell}>{column.category?.trim() || '未分類'}</span></Td>
                    <Td className={styles.colDate}><span className={styles.cell}>{column.publishedAt ? jstMonthDay(column.publishedAt) : column.deliveryAt ? `${jstMonthDay(column.deliveryAt)} 予定` : emptyValue('unknown')}</span></Td>
                    <Td className={styles.colLine}>{columnBadge(column, metric?.sent ?? null)}</Td>
                    <Td className={styles.colViews}><span className={styles.num}>{views == null ? emptyValue('unknown') : formatNumber(views)}</span></Td>
                    <Td className={styles.colMenu}><RowMenu subject={column.title} items={menuFor(column)} /></Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
          <ListPagePagination>
            <Pagination page={safePage} pageCount={Math.max(1, Math.ceil(visible.length / pageSize))} onPageChange={setPage}
              range={{ total: visible.length, first: (safePage - 1) * pageSize + 1, last: Math.min(visible.length, safePage * pageSize) }} />
          </ListPagePagination>
          {props.columnsTotal != null && props.columnsTotal > columns.length ? (
            <div className={styles.noteRow}>
              {/* WEB231：検索は読み込んだ分の中だけで探す。続きを読み込めるようにし、検索を勧めない。 */}
              <Notice
                tone="warn"
                message={`コラムは${formatNumber(props.columnsTotal)}本ありますが、${columns.length}本までしか読み込んでいません。検索・絞り込みは読み込んだ分の中で探します。`}
                action={props.onLoadMoreColumns ? <LoadMoreColumnsButton onLoadMore={props.onLoadMoreColumns} /> : undefined}
              />
            </div>
          ) : null}
          <p className={styles.hint}>{canEdit ? '行の「…」から この内容で予約する・複製・テスト送信。' : '行の「…」から 中身を見る。'}</p>
        </>
      )}
      <SelectedColumn {...props} />
      <ConfirmDialog open={stopTarget !== null && stopTarget.generation === scope.current.generation} title="コラム配信を止めますか？" description="止めるとコラムの配信を送れません。すでに送った配信は取り消されません。" confirmLabel="止める" destructive busy={Boolean(stopTarget && props.saving === stopTarget.setting.campaignKey)} error={stopTried && props.notice?.tone === 'error' ? props.notice.text : undefined} onCancel={() => setStopTarget(null)} onSuccess={() => setStopTarget(null)} onConfirm={() => { if (!stopTarget || !alive.current || !canEditRef.current || currentDataRef.current === false || stopTarget.generation !== scope.current.generation) return; setStopTried(true); return props.onToggleSetting(stopTarget.setting) }}>{stopTarget ? <OperationTargetSummary accounts={[{ id: stopTarget.accountId }]} /> : null}</ConfirmDialog>
      <Dialog open={previewColumn !== null} title="コラムのLINEでの見え方" onCancel={() => setPreviewId(null)}>
        {previewColumn ? <ColumnPreview column={previewColumn} introText={props.selectedColumnId === previewColumn.id ? props.introDraft : previewColumn.introText} buttonLabel={columnSetting?.buttonLabel ?? 'コラムを読む'} /> : null}
      </Dialog>
      {columnSetting?.isEnabled === false && !props.selectedColumnId ? <Notice tone="warn" message="コラムの配信が停止中のため、いまは送れません。" /> : null}
    </div>
  )
}

/** WEB231：コラムの続きを読み込むボタン。読んでいる間は押せない。失敗は理由を出す。 */
function LoadMoreColumnsButton({ onLoadMore }: { onLoadMore: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <Button type="button" disabled={busy} busy={busy} onClick={() => {
        setBusy(true)
        setFailed(false)
        void onLoadMore().catch(() => setFailed(true)).finally(() => setBusy(false))
      }}>
        続きを読み込む
      </Button>
      {failed ? <span role="alert">続きを読み込めませんでした。</span> : null}
    </>
  )
}

/** 選んだコラム（表の下）。LINE に届く紹介文と、送る相手・時刻を決める。予約は確認の窓を挟む。 */
function SelectedColumn(props: NenCampaignsListProps & { canEdit: boolean }) {
  const { columns, selectedColumnId, plan, audienceCount, introDraft, canEdit } = props
  const selected = columns.find((column) => column.id === selectedColumnId) ?? null
  const scopeKey = JSON.stringify([props.accountId, selectedColumnId])
  const scope = useRef({ key: scopeKey, generation: 0 })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 }
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const columnSetting = props.settings.find((setting) => setting.campaignKey === 'column')
  const viewKey = JSON.stringify([props.accountId, selected, introDraft, columnSetting])
  const viewScope = useRef({ key: viewKey })
  if (viewScope.current.key !== viewKey) viewScope.current = { key: viewKey }
  const [confirm, setConfirm] = useState<{ column: NenColumn; scheduledAt?: string; accountId: string; generation: number; view: object; dialog: object; preview: NenColumnDeliveryPreview } | null>(null)
  const [deliverTried, setDeliverTried] = useState(false)
  const dialogScope = useRef<object>({})
  const deliveryLock = useRef(false)
  const [delivering, setDelivering] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const previewLock = useRef(false)
  const [previewError, setPreviewError] = useState('')
  if (!selected) return null
  const scheduledIso = plan.when === 'schedule' ? publishedAtIso(plan.scheduledAt) : null
  const schedulePast = plan.when === 'schedule' && isPastScheduledAt(plan.scheduledAt)
  const scheduleInvalid = plan.when === 'schedule' && (!scheduledIso || schedulePast)
  const columnEnabled = props.settings.some((setting) => setting.campaignKey === 'column' && setting.isEnabled)
  const audience = `${selected.targetMode === 'tag' ? 'タグで絞り込み' : '友だち 全員'}（${num(audienceCount)} 人）`

  return (
    <Card variant="panel" aria-label={`選んだコラム：${selected.title}`}>
      <h2 className={styles.selectTitle}>{`選んだコラム：${selected.title}`}</h2>
      <p className={styles.selectDescription}>LINE に届くカードと、送る相手・時刻を決めます。</p>
      <div className={styles.selectGrid}>
        <div className={styles.selectFields}>
          <Field label="LINE に出る紹介文">
            <SaveErrorField names={["introDraft","intro_draft"]}><TextArea size="single-row" rows={1} aria-label="LINE に出る紹介文" value={introDraft} maxLength={1500} readOnly={!canEdit} onChange={(event) => props.onIntroChange(event.target.value)} /></SaveErrorField>
          </Field>
          {canEdit ? (
            <span className={styles.buttonRow}>
              <Button type="button" disabled={introDraft === selected.introText || props.savingColumnId === selected.id || !introDraft.trim()} busy={props.savingColumnId === selected.id} busyLabel="保存中…" onClick={() => props.onSaveIntro(selected)}>紹介文を保存する</Button>
              <Button type="button" disabled={props.duplicatingColumnId === selected.id} onClick={() => props.onDuplicateColumn(selected)} busy={props.duplicatingColumnId === selected.id} busyLabel="複製しています"><Copy size={16} aria-hidden="true" />同じ形で書く</Button>
            </span>
          ) : null}
        </div>
        <div className={styles.selectFields}>
          <Field label="だれに" help="送る相手はコラムを作るときに決めます。友だち解除・ブロックの人には送られません。">
            <SaveErrorField names={["audience"]}><TextField aria-label="送る相手" value={audience} readOnly /></SaveErrorField>
          </Field>
          {canEdit ? (
            <>
              <span className={styles.fieldLabel}>いつ</span>
              <span className={styles.radioRow} role="radiogroup" aria-label="いつ送るか">
                <SaveErrorField names={["nen-deliver-when-v8","when","plan.when"]}><Radio name="nen-deliver-when-v8" checked={plan.when === 'now'} onChange={() => props.onPlanChange({ ...plan, when: 'now' })}>今すぐ</Radio></SaveErrorField>
                <SaveErrorField names={["nen-deliver-when-v8","when","plan.when"]}><Radio name="nen-deliver-when-v8" checked={plan.when === 'schedule'} onChange={() => props.onPlanChange({ ...plan, when: 'schedule' })}>日時を予約</Radio></SaveErrorField>
              </span>
              {plan.when === 'schedule' ? (
                <Field label="送る日時">
                  <SaveErrorField names={["scheduledAt","plan.scheduledAt","scheduled_at","plan.scheduled_at"]}><DateTimeField aria-label="予約日時（日本時間）" value={plan.scheduledAt} invalid={scheduleInvalid} onChange={(value) => props.onPlanChange({ ...plan, scheduledAt: value })} /></SaveErrorField>
                  {schedulePast ? <span className={styles.error} role="alert">予約日時が過去になっています。いまより先の日時を選んでください。</span> : null}
                </Field>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {!columnEnabled ? <p className={styles.muted}>コラムの配信が停止中のため、いまは送れません。</p> : null}
      {canEdit ? (
        <div className={styles.selectFoot}>
          <TestRecipientPicker friends={props.friends} value={props.testFriendId} onChange={props.onTestFriendChange} accountId={props.accountId} />
          <Button type="button" disabled={!props.testFriendId || props.testing !== null} busy={props.testing === selected.id} busyLabel="送信中…" onClick={() => props.onTestColumn(selected)}><Send size={16} aria-hidden="true" />自分にテストを送る</Button>
          <Button type="button" variant="primary" disabled={!columnEnabled || scheduleInvalid || props.currentAccountData === false || previewBusy} disabledReason={props.currentAccountData === false ? '選択中のLINEアカウントの情報を読み直してください。' : undefined} onClick={async () => {
            if (!props.accountId || !canEditRef.current || props.currentAccountData === false || previewLock.current) return
            if (introDraft !== selected.introText) { setPreviewError('紹介文を保存してから確認してください。'); return }
            const view = viewScope.current, generation = scope.current.generation, accountId = props.accountId
            previewLock.current = true; setPreviewBusy(true); setPreviewError('')
            try {
              const preview = await props.onPreviewColumn(selected)
              if (!alive.current || !canEditRef.current || viewScope.current !== view || scope.current.generation !== generation) return
              const col = preview.column
              if (!Number.isSafeInteger(preview.recipientCount) || preview.recipientCount < 0 || !/^[a-f0-9]{64}$/.test(preview.confirmationToken) || !Array.isArray(preview.messages) || preview.messages.length !== 2 || preview.messages[0]?.type !== 'text' || typeof preview.messages[0].text !== 'string' || preview.messages[1]?.type !== 'flex' || !preview.messages[1].contents || !col || !columnSetting || col.id !== selected.id || col.title !== selected.title || col.excerpt !== selected.excerpt || col.introText !== selected.introText || col.articleUrl !== selected.articleUrl || col.imageUrl !== selected.imageUrl || col.targetMode !== selected.targetMode || col.targetTagId !== selected.targetTagId || col.updatedAt !== selected.updatedAt || preview.campaign?.updatedAt !== columnSetting.updatedAt || preview.campaign?.buttonLabel !== columnSetting.buttonLabel) { setPreviewError('配信内容が変わりました。画面を読み直してください。'); return }
              dialogScope.current = {}; setDeliverTried(false); setConfirm({ column: { ...selected }, scheduledAt: scheduledIso ?? undefined, accountId, generation, view, dialog: dialogScope.current, preview })
            } catch { if (alive.current && viewScope.current === view) setPreviewError('配信内容と対象を確認できませんでした。読み直してください。') }
            finally { previewLock.current = false; if (alive.current) setPreviewBusy(false) }
          }}>配信を予約する</Button>
        </div>
      ) : null}
      <FieldError id="campaign-preview-error">{previewError}</FieldError>
      <ConfirmDialog
        open={confirm !== null && confirm.generation === scope.current.generation && confirm.view === viewScope.current}
        title={confirm?.scheduledAt ? `「${confirm.column.title}」を配信予約しますか？` : `「${confirm?.column.title ?? ''}」を今すぐ配信しますか？`}
        description={confirm?.scheduledAt
          ? `${jstDateTime(confirm.scheduledAt)}（日本時間）に、${num(confirm.preview.recipientCount)} 人の友だちへ送ります。`
          : `すぐに配信待ちに入り、${num(confirm?.preview.recipientCount ?? 0)} 人の友だちへ送られます。`}
        confirmLabel={confirm?.scheduledAt ? '予約する' : '送る'}
        busy={delivering} error={deliverTried && props.notice?.tone === 'error' ? props.notice.text : undefined} onSuccess={() => { if (confirm?.dialog === dialogScope.current) { dialogScope.current = {}; setConfirm(null) } }} onConfirm={async () => { if (!confirm || !alive.current || !canEditRef.current || deliveryLock.current || confirm.generation !== scope.current.generation || confirm.view !== viewScope.current || confirm.dialog !== dialogScope.current) return false; deliveryLock.current = true; setDelivering(true); setDeliverTried(true); try { return await props.onDeliverColumn(confirm.column, confirm.scheduledAt, { recipientCount: confirm.preview.recipientCount, confirmationToken: confirm.preview.confirmationToken }) } finally { deliveryLock.current = false; if (alive.current) setDelivering(false) } }}
        onCancel={() => { if (confirm?.dialog === dialogScope.current) { dialogScope.current = {}; setConfirm(null) } }}
      >{confirm ? <><OperationTargetSummary accounts={[{ id: confirm.accountId }]} /><LinePreview fit>{confirm.preview.messages.map((message, index) => message.type === 'text' ? <LinePreviewMessage key={index} accountName="NEN" avatar={null} time="">{message.text}</LinePreviewMessage> : <LinePreviewFlex key={index} content={JSON.stringify(message.contents)} />)}</LinePreview></> : null}</ConfirmDialog>
    </Card>
  )
}

/* ───────────── 送った履歴 ───────────── */

type HistoryFilter = 'all' | 'sent' | 'pending' | 'failed' | 'skipped'

function historyStatus(filter: HistoryFilter): string | undefined {
  if (filter === 'all') return undefined
  if (filter === 'pending') return 'pending,processing'
  return filter
}

function HistoryTab(props: NenCampaignsListProps & { canEdit: boolean }) {
  const { deliveryList, deliveryDetail, canEdit } = props
  const tabError = props.tabError ?? ''
  const [query, setQuery] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<HistoryFilter>('filter', 'all')
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [retryFocusId, setRetryFocusId] = useState<string | null>(null)
  const shown = deliveryList?.deliveries ?? []
  const summary = deliveryList?.summary
  const cursor = Number(deliveryList?.pagination.cursor ?? 0)
  const limit = deliveryList?.pagination.limit ?? 20
  const total = deliveryList?.pagination.total ?? 0
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])

  const changeQuery = (value: string) => {
    setQuery(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    // 履歴の検索はサーバ全体へ効く。打つたびに呼ばず、手が止まってから1回。
    searchTimer.current = setTimeout(() => props.onChangeDeliveryView(historyStatus(filter), undefined, value.trim()), 400)
  }
  const page = Math.floor(cursor / limit) + 1
  const pageCount = Math.max(1, Math.ceil(total / limit))

  return (
    <div className={styles.inset}>

      <div className={styles.toolsRow}>
        <ListToolbar
          search={{ placeholder: '友だち・配信の名前で探す', width: 240, value: query, onChange: changeQuery }}
          filters={(
            <div role="group" aria-label="送った結果で絞り込む" className={styles.chips}>
              <SegmentedControl<HistoryFilter>
                aria-label="送った結果で絞り込む"
                value={filter}
                onChange={(next) => { setFilter(next); props.onChangeDeliveryView(historyStatus(next), undefined, query.trim()) }}
                options={[
                  { value: 'all', label: 'すべて' },
                  { value: 'sent', label: '送りました', count: summary ? formatNumber(summary.sent) : emptyValue('unknown') },
                  { value: 'pending', label: 'これから', count: summary ? formatNumber(summary.pending + summary.processing) : emptyValue('unknown') },
                  { value: 'failed', label: '届きませんでした', count: summary ? formatNumber(summary.failed) : emptyValue('unknown') },
                  { value: 'skipped', label: '送りませんでした', count: summary ? formatNumber(summary.skipped) : emptyValue('unknown') },
                ]}
              />
            </div>
          )}
          trailing={<span className={styles.muted}>送った日が新しい順</span>}
        />
      </div>

      {props.loading && !deliveryList && !tabError ? (
        <ListState kind="loading" title="送った履歴を読み込んでいます" />
      ) : tabError ? (
        <ListState kind="error" title="送った履歴を読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。登録した内容は消えていません。" onRetry={props.onRetryTab} />
      ) : shown.length === 0 ? (
        filter !== 'all' || query ? (
          <ListState kind="empty" emptyPreset="readonly" title="条件に合う履歴はありません" description="検索語や絞り込みを変えてください。" action={<Button onClick={() => { setQuery(''); setFilter('all'); props.onChangeDeliveryView(undefined, undefined, '') }}>検索と絞り込みを解除</Button>} />
        ) : (
          <ListState kind="empty" emptyPreset="readonly" title="送った履歴はまだありません" description="配信が予約されると、送信前からここに記録が並びます。" />
        )
      ) : (
        <>
          <DataTable className={styles.table}>
            <thead>
              <TableHeadRow className={styles.headRow} data-table-layout="columns">
                <Th className={styles.colWhen}>いつ・だれに</Th>
                <Th className={styles.colName}>配信</Th>
                <Th className={styles.colResult}>状態</Th>
                <Th className={styles.colCause}>きっかけ</Th>
                <Th className={styles.colViews}>開封</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {shown.map((delivery) => {
                const open = deliveryDetail?.id === delivery.id
                const retryable = canEdit && canRetryDelivery(delivery)
                const items: ActionMenuItem[] = [
                  { id: 'detail', label: open ? '中身を閉じる' : '中身を見る', onSelect: () => { setRetryFocusId(null); props.onShowDelivery(delivery.id) } },
                  ...(retryable ? [{ id: 'retry', label: '再送待ちへ戻す', onSelect: () => { setRetryFocusId(delivery.id); if (!open) props.onShowDelivery(delivery.id) } }] : []),
                ]
                const who = `${delivery.friendName || '名前未取得'}・${delivery.lineAccountName}`
                const tone = delivery.status === 'sent' ? 'ok' : delivery.status === 'failed' ? 'danger' : delivery.status === 'pending' || delivery.status === 'processing' ? 'info' : 'off'
                return (
                  <Fragment key={delivery.id}>
                    <Tr className={styles.row} data-table-layout="columns">
                      <Td className={styles.colWhen}>
                        <span className={styles.nameStack}>
                          <span className={styles.cellStrong}>{jstDateTime(delivery.sentAt || delivery.scheduledAt)}</span>
                          <span className={styles.sub} title={who}>{who}</span>
                        </span>
                      </Td>
                      <Td className={styles.colName}><span className={styles.cell} title={delivery.label}>{delivery.label}</span></Td>
                      <Td className={styles.colResult}>
                        <span className={styles.nameStack}>
                          <Pill tone={tone}>{statusLabel[delivery.status] ?? '状態を確認できません'}</Pill>
                          {delivery.unmetReason ? <span className={styles.subDanger} title={delivery.unmetReason}>{delivery.unmetReason}</span> : null}
                        </span>
                      </Td>
                      <Td className={styles.colCause}><span className={styles.cell}>{deliveryTriggerLabel(delivery.campaignKey)}</span></Td>
                      <Td className={styles.colViews}><span className={styles.num} title={delivery.reaction.reason}>取得不可</span></Td>
                      <Td className={styles.colMenu}><RowMenu subject={delivery.label} items={items} /></Td>
                    </Tr>
                    {open && deliveryDetail ? (
                      <tr className={styles.detailRow}>
                        <td colSpan={6}>
                          <div className={styles.detailBox}>
                            <span className={styles.muted}>{deliveryDetail.trigger}</span>
                            <strong className={styles.sampleTitle}>{deliveryDetail.content.title || deliveryDetail.label}</strong>
                            <span className={styles.sampleText}>{deliveryDetail.content.bodyText || deliveryDetail.content.reason}</span>
                            {deliveryDetail.content.buttonLabel ? <span className={styles.sampleText}>▶ {deliveryDetail.content.buttonLabel}</span> : null}
                            {retryable ? (
                              <Field label="再送する理由（500文字まで）"><SaveErrorField names={["reasons"]}><TextArea value={reasons[delivery.id] ?? ''} rows={3} maxLength={500} autoFocus={retryFocusId === delivery.id} onChange={(event) => setReasons((current) => ({ ...current, [delivery.id]: event.target.value }))} /></SaveErrorField>
<span className={styles.buttonRow}>
                                  <Button type="button" variant="primary" disabled={!(reasons[delivery.id] ?? '').trim()} onClick={() => props.onRetryDelivery(delivery.id, delivery.version, reasons[delivery.id] ?? '')}>再送待ちへ戻す</Button>
                                </span></Field>
                            ) : delivery.status === 'skipped' ? (
                              <span className={styles.muted}>{skippedNoRetryNote[delivery.unmetReasonCode ?? ''] ?? 'この記録は再送できません。'}</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </DataTable>
          <ListPagePagination>
            <Pagination page={page} pageCount={pageCount}
              onPageChange={(next) => props.onChangeDeliveryView(historyStatus(filter), String(Math.max(0, (next - 1) * limit)), query.trim())}
              range={{ total, first: cursor + 1, last: Math.min(total, cursor + shown.length) }} />
          </ListPagePagination>
          <p className={styles.hint}>{canEdit ? '行の「…」から 中身を見る・再送待ちへ戻す。' : '行の「…」から 中身を見る。'}</p>
        </>
      )}
    </div>
  )
}
