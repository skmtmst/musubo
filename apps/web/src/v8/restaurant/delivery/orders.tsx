'use client'

/*
 * ★V8 デリバリー受注・注文一覧（板 `kDQHr`）。
 *
 * 画面は受け取った数と状態を出すだけにする。送信・状態の進みは親（delivery.tsx）が持つ。
 * 急ぎ度の判定はWorker側だけで行い、ここには結果と理由の文しか来ない（仕組みの名前は出さない）。
 */

import { Banknote, Clock, History, ShoppingBag, Timer, Zap, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import BulkBar from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListToolbar from '@/components/shared/list-toolbar'
import { PREPARING_WORD } from '@/components/shared/preparing-dialog'
import Pagination from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import { RowMenu } from '@/components/shared/row-actions'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, TableStateRow, Td, Th, Tr } from '@/components/shared/table'
import { Tabs, type TabItem } from '@/components/shared/tabs'
import TruncatedText from '@/components/shared/truncated-text'
import {
  DELIVERY_SERVICE_LABELS,
  type DeliveryConnectionStatus,
  type DeliveryIntakeStatus,
  type DeliveryOrderStatus,
  type DeliveryOrderSummary,
  type DeliveryOrderTab,
  type DeliveryOrdersData,
  type DeliveryService,
  type DeliveryServiceState,
  type DeliveryUrgency,
} from '@/lib/restaurant-delivery-api'
import {
  DASH,
  SERVICE_TONES,
  formatClock,
  formatElapsed,
  formatOrderNumber,
  formatYen,
  urgencyLabel,
} from './format'
import styles from './delivery.module.css'
import { intakeActionReason } from './intake-access'

const CONNECTION_LABELS: Record<DeliveryConnectionStatus, string> = {
  connected: '接続済み',
  disconnected: '未接続',
  error: '接続の異常',
}

const CONNECTION_TONES: Record<DeliveryConnectionStatus, StatusBadgeTone> = {
  connected: 'success',
  disconnected: 'neutral',
  error: 'danger',
}

const INTAKE_LABELS: Record<DeliveryIntakeStatus, string> = { open: '受付中', stopped: '停止中' }
/* 絵（kDQHr）の札の地と字。受付中は青（$info-soft/$action）、停止中は灰（$ink-faint）。 */
const INTAKE_TONES: Record<DeliveryIntakeStatus, StatusBadgeTone> = { open: 'info', stopped: 'neutral' }

/* 絵（kDQHr）のサービス印に出す一文字。 */
const SERVICE_MARKS: Record<DeliveryService, string> = {
  ubereats: 'U',
  demaecan: '出',
  rocketnow: 'ロ',
}

/* キャンセル・拒否は色で責めない（起きたことを文字で伝えるだけ）。 */
const STATUS_TONES: Record<DeliveryOrderStatus, StatusBadgeTone> = {
  new: 'info',
  cooking: 'warning',
  ready: 'success',
  handed_over: 'success',
  canceled: 'neutral',
  rejected: 'neutral',
}

const URGENCY_TONES: Record<DeliveryUrgency, StatusBadgeTone> = {
  urgent: 'danger',
  watch: 'warning',
  normal: 'neutral',
}

/*
 * 絵（kDQHr）の急ぎ度の札は色の点ではなく12pxの印＋字。
 * 急ぎは雷（`ATXE5`）、注意は時計（`qtesW`）、ふつうは印なしの字だけ（`C0hA1v`）。
 */
const URGENCY_ICONS: Record<DeliveryUrgency, LucideIcon | null> = {
  urgent: Zap,
  watch: Clock,
  normal: null,
}

/**
 * 急ぎ度の印（絵 `HbgSR`/`O1JQq`/`C0hA1v`）。点は出さず、印＋字にする。
 * 注文の詳細の窓（絵 `hjdqV`）も同じ形なので、そこからも使う。
 *
 * 札そのものは共通の `StatusBadge` が描く。ここは急ぎ度ごとの色と印を
 * 決めて渡すだけの差し込みで、札を自作しているわけではない。2つの画面で
 * 同じ形にするため置き場所は1つに保ち、見張りの「状態の札を自作」と
 * 読み違えない名前にしている。
 */
export function UrgencyMark({ urgency }: { urgency: DeliveryUrgency }) {
  const Icon = URGENCY_ICONS[urgency]
  return (
    <StatusBadge tone={URGENCY_TONES[urgency]} size="delivery" dot={false}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      {urgencyLabel(urgency)}
    </StatusBadge>
  )
}

const TAB_LABELS: Record<DeliveryOrderTab, string> = {
  new: '新着',
  cooking: '調理中',
  handed_over: '受け渡し済み',
  all: 'すべて',
}

const TAB_ORDER: DeliveryOrderTab[] = ['new', 'cooking', 'handed_over', 'all']

export function OrderStateTabs({ tab, onTab }: { tab: DeliveryOrderTab; onTab: (tab: DeliveryOrderTab) => void }) {
  return <Tabs label="注文の状態" items={TAB_ORDER.map(value => ({ label: TAB_LABELS[value], current: tab === value, onClick: () => onTab(value) }))} />
}


/** 表の列数（選ぶ・注文番号・サービス・注文内容・金額・経過・急ぎ度・状態・操作）。 */
const COLUMN_COUNT = 9
/** 閲覧のみの人には「選ぶ」の列を出さないので1つ少ない（★V8 2026-10-06）。 */
const COLUMN_COUNT_VIEW_ONLY = COLUMN_COUNT - 1

/** 数を推測しない。取れないときは「—」にする（D021/D024）。0 は 0 のまま出す。 */
function countText(value: number | null | undefined, unit = '件'): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}${unit}` : DASH
}

/** 増減の札。取れないときは札を出さない。 */
function signedCount(value: number | null | undefined, unit: string): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value === 0) return `±0${unit}`
  return `${value > 0 ? '+' : '-'}${Math.abs(value)}${unit}`
}

function signedPercent(value: number | null | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value === 0) return '±0%'
  return `${value > 0 ? '+' : '-'}${Math.abs(value)}%`
}

/*
 * 絵（yrLKt）の増減は色付きの札。点は無い。取れないときは札を出さない。
 * 札は共通の `StatusBadge` が描き、ここは文と色を渡すだけの小さな関数。
 */
function deltaMark(text: string | undefined, tone: StatusBadgeTone) {
  if (!text) return undefined
  return (
    <StatusBadge tone={tone} size="compact" dot={false}>
      {text}
    </StatusBadge>
  )
}

function ServiceCard({
  state,
  canManage,
  busy,
  onStop,
  onResume,
  uberConnectionStatus,
  intakeDisabledReason,
  unavailable = false,
}: {
  unavailable?: boolean
  state: DeliveryServiceState
  uberConnectionStatus: DeliveryConnectionStatus | null
  intakeDisabledReason?: string
  canManage: boolean
  busy: boolean
  onStop: (service: DeliveryService) => void
  onResume: (service: DeliveryService) => void
}) {
  const label = state.label || DELIVERY_SERVICE_LABELS[state.service]
  const preparing = state.service === 'ubereats'
  const connectionStatus = unavailable ? null : preparing ? uberConnectionStatus : state.connectionStatus
  const stopped = state.intakeStatus === 'stopped'
  const actionReason = unavailable ? '読み込み中です' : intakeDisabledReason ?? intakeActionReason(state, stopped ? 'resume' : 'stop')
  /* 絵（kDQHr）の札は1行。いつまで止めているかは札の説明に入れ、行を増やさない。 */
  const stopNote = stopped && state.stopUntil ? `${formatClock(state.stopUntil)} まで停止` : undefined
  /* 数は推測しない。取れないときは「—」で、単位も出さない（D021/D024）。 */
  const hasCount = typeof state.todayCount === 'number' && Number.isFinite(state.todayCount)
  return (
    <Card appearance="outlined" layout="vertical" gap="tight" className={styles.serviceCard} aria-label={unavailable ? undefined : label}>
      {/* 1段目：印・名前・操作。2段目：札・数。狭い幅でも札と数が重ならないよう、2段に分ける。 */}
      <div className={styles.serviceTop}>
        <span className={styles.serviceMark} aria-hidden="true">
          {SERVICE_MARKS[state.service]}
        </span>
        <span className={styles.serviceName}>{label}</span>
        <span className={styles.spacer} />
        {canManage ? (
          stopped ? (
            <Button
              size="compact"
              textTone="accent"
              disabled={Boolean(actionReason) || busy}
              disabledReason={actionReason}
              busy={busy}
              busyLabel=""
              doneLabel=""
              aria-label={`${label}の受付を再開`}
              onClick={() => onResume(state.service)}
            >
              再開
            </Button>
          ) : (
            <Button
              size="compact"
              textTone="danger"
              disabled={Boolean(actionReason) || busy}
              disabledReason={actionReason}
              aria-label={`${label}の受付を止める`}
              onClick={() => onStop(state.service)}
            >
              止める
            </Button>
          )
        ) : null}
      </div>
      <div className={styles.serviceBottom}>
        <span className={styles.serviceBadges}>
          <StatusBadge tone={connectionStatus ? CONNECTION_TONES[connectionStatus] : 'neutral'} size="delivery">
            {connectionStatus ? CONNECTION_LABELS[connectionStatus] : '接続未確認'}
          </StatusBadge>
          {!unavailable && (preparing || connectionStatus === 'connected') ? <span title={preparing ? undefined : stopNote}>
            <StatusBadge tone={preparing ? 'neutral' : INTAKE_TONES[state.intakeStatus]} size="delivery">
              {preparing ? PREPARING_WORD : INTAKE_LABELS[state.intakeStatus]}
            </StatusBadge>
          </span> : null}
        </span>
        <span className={styles.spacer} />
        <div className={styles.serviceStat}>
          <span className={styles.serviceCount}>
            {hasCount ? state.todayCount : DASH}
            {hasCount ? <span className={styles.serviceCountUnit}>件</span> : null}
          </span>
          <span className={styles.serviceCaption}>本日の注文</span>
        </div>
      </div>
    </Card>
  )
}

function OrderRow({
  order,
  nowMs,
  busy,
  canManage,
  uberOrderActionsEnabled,
  checked,
  selectable,
  onToggleSelect,
  onOpen,
  onAccept,
  onReject,
  onReady,
  onHandOver,
}: {
  order: DeliveryOrderSummary
  nowMs: number
  busy: boolean
  canManage: boolean
  uberOrderActionsEnabled: boolean
  /** まとめて受け付ける相手として選んでいるか。 */
  checked: boolean
  /** 新着だけ選べる（受け付けたあとの注文はまとめて受け付けられない）。 */
  selectable: boolean
  onToggleSelect: (id: string, checked: boolean) => void
  onOpen: (id: string) => void
  onAccept: (order: DeliveryOrderSummary) => void
  onReject: (order: DeliveryOrderSummary) => void
  onReady: (order: DeliveryOrderSummary) => void
  onHandOver: (order: DeliveryOrderSummary) => void
}) {
  const preparing = order.service === 'ubereats' && !uberOrderActionsEnabled
  const [menuOpen, setMenuOpen] = useState(false)
  /* 行の右端：主な操作は1つだけボタン、残りは「…」（共通の ActionCell。オーナー決定 ）。 */
  const openItem = { id: 'open', label: '詳細を見る', onSelect: () => onOpen(order.id) }
  return (
    <Tr selected={canManage && checked} data-table-layout="columns">
      {/* 閲覧のみの人には「選ぶ」を押せない形で置かずに列ごと出さない（★V8 2026-10-06）。 */}
      {canManage ? (
        <Td>
          <Checkbox
            aria-label={`注文${order.orderNumber}を選ぶ`}
            checked={checked}
            disabled={!selectable || busy}
            onCheckedChange={(next) => onToggleSelect(order.id, next)}
          />
        </Td>
      ) : null}
      <Td>
        <Button
          variant="text" textTone="ink"
          size="inline"
          className={styles.orderNumberButton}
          aria-label={`注文${order.orderNumber}の詳細`}
          onClick={() => onOpen(order.id)}
        >
          {formatOrderNumber(order.orderNumber)}
        </Button>
      </Td>
      <Td>
        {/* サービス札（kDQHr `jrPce` ほか）は点なしの丸い札。状態札とは違い点を出さない。 */}
        <StatusBadge tone={SERVICE_TONES[order.service]} size="compact" dot={false}>
          {order.serviceLabel || DELIVERY_SERVICE_LABELS[order.service]}
        </StatusBadge>
      </Td>
      <Td grow>
        <TruncatedText value={order.itemSummary || DASH} />
      </Td>
      <Td align="right" data-list-number>
        <span className={styles.amount}>{formatYen(order.totalAmount)}</span>
      </Td>
      {/* 経過は狭い幅（白い板が 1100 未満）では畳む。急ぎ度の札が同じ知らせを持つ。 */}
      <Td data-list-number collapseAt="narrow">
        <span className={styles.elapsed}>{formatElapsed(order.receivedAt, nowMs)}</span>
      </Td>
      <Td>
        {/* 一覧は印だけ。理由の文は幅を押し広げるので注文の詳細（hjdqV）で出す。 */}
        <span className={styles.urgencyCell} title={order.urgencyReason || undefined}>
          <UrgencyMark urgency={order.urgency} />
        </span>
      </Td>
      <Td>
        <StatusBadge tone={STATUS_TONES[order.status]} size="delivery">
          {order.statusLabel || DASH}
        </StatusBadge>
      </Td>
      <ActionCell>
        <span className={styles.rowActions}>
          {order.status === 'new' && canManage ? (
            <>
              <Button
                variant="primary"
                size="compact"
                busy={busy}
                disabled={preparing}
                title={preparing ? PREPARING_WORD : undefined}
                busyLabel="受付中"
                doneLabel="受付済"
                aria-label={`注文${order.orderNumber}を受け付ける`}
                onClick={() => onAccept(order)}
              >
                受け付ける
              </Button>
              <RowMenu
                size="row"
                label={`注文${order.orderNumber}のその他の操作`}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={[openItem, { id: 'reject', label: '断る', disabled: busy || preparing, onSelect: () => onReject(order) }]}
              />
            </>
          ) : (order.status === 'cooking' || order.status === 'ready') && canManage ? (
            <>
              <Button
                size="compact"
                textTone="accent"
                busy={busy}
                disabled={preparing}
                title={preparing ? PREPARING_WORD : undefined}
                busyLabel="変更中"
                doneLabel={order.status === 'cooking' ? '準備済' : '受渡済'}
                aria-label={order.status === 'cooking'
                  ? `注文${order.orderNumber}を準備完了にする`
                  : `注文${order.orderNumber}を受け渡し済みにする`}
                onClick={() => order.status === 'cooking' ? onReady(order) : onHandOver(order)}
              >
                {order.status === 'cooking' ? '準備完了にする' : '受け渡し済みにする'}
              </Button>
              <RowMenu
                size="row"
                label={`注文${order.orderNumber}のその他の操作`}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={[openItem]}
              />
            </>
          ) : (
            <RowMenu
              size="row"
              label={`注文${order.orderNumber}のその他の操作`}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={[openItem]}
            />
          )}
        </span>
      </ActionCell>
    </Tr>
  )
}

export interface OrdersBoardProps {
  data: DeliveryOrdersData
  uberConnectionStatus: DeliveryConnectionStatus | null
  /** 見せているページ（1から）と1ページの件数（10・20・50）。 */
  page: number
  perPage: number
  /** 送信中の注文（二重送信を防ぐため、その行のボタンだけ回す）。 */
  busyOrderId: string | null
  /** 受付の再開を送っているサービス。 */
  busyService: DeliveryService | null
  canManage: boolean
  uberOrderActionsEnabled: boolean
  intakeDisabledReason?: string
  nowMs: number
  /** まとめて受け付ける相手として選んでいる注文の id。 */
  selected: string[]
  /** まとめて受け付けている間。 */
  bulkBusy: boolean
  onToggleSelect: (id: string, checked: boolean) => void
  onToggleSelectAll: (checked: boolean) => void
  /** 選んだ新着注文をまとめて受け付ける。 */
  onBulkAccept: () => void
  onTab: (tab: DeliveryOrderTab) => void
  /** 数の帯の「…」をやめた行き先。注文履歴・売上（OzHLO）へは道具の段のボタンから行く。 */
  onOpenHistory: () => void
  onOpenOrder: (id: string) => void
  onAccept: (order: DeliveryOrderSummary) => void
  onReject: (order: DeliveryOrderSummary) => void
  onReady: (order: DeliveryOrderSummary) => void
  onHandOver: (order: DeliveryOrderSummary) => void
  onStopService: (service: DeliveryService) => void
  onResumeService: (service: DeliveryService) => void
  onPage: (page: number) => void
  onPerPage: (perPage: number) => void
}

export function DeliveryOverview({ data, uberConnectionStatus, intakeDisabledReason, canManage, busyService, onStopService, onResumeService }: Pick<OrdersBoardProps, 'uberConnectionStatus' | 'intakeDisabledReason' | 'canManage' | 'busyService' | 'onStopService' | 'onResumeService'> & { data: DeliveryOrdersData | null }) {
  const kpis = data?.kpis
  const services = data?.services ?? (['ubereats', 'demaecan', 'rocketnow'] as DeliveryService[]).map(service => ({ service, label: DELIVERY_SERVICE_LABELS[service], connectionStatus: 'disconnected' as const, intakeStatus: 'open' as const, stopUntil: null, todayCount: Number.NaN, todayAmount: Number.NaN }))
  return <>
      <div className={styles.serviceRow}>
        {services.map((state) => (
          <ServiceCard
            unavailable={!data}
            key={state.service}
            intakeDisabledReason={intakeDisabledReason}
            state={state}
            uberConnectionStatus={uberConnectionStatus}
            canManage={canManage}
            busy={busyService === state.service}
            onStop={onStopService}
            onResume={onResumeService}
          />
        ))}
      </div>

      <KpiBand>
        <KpiCard
          presentation="cell"
          title="本日の注文"
          icon={<ShoppingBag size={16} />}
          value={kpis?.todayCount ?? null}
          unit="件"
          delta={deltaMark(signedCount(kpis?.todayCountDelta, '件'), 'success')}
          detail={`受け渡し済み ${countText(kpis?.handedOverCount)}`}
        />
        <KpiCard
          presentation="cell"
          title="本日の売上"
          icon={<Banknote size={16} />}
          value={kpis?.todaySales ?? null}
          unit=""
          valueText={formatYen(kpis?.todaySales)}
          delta={deltaMark(signedPercent(kpis?.todaySalesDeltaPercent), 'success')}
          detail={`平均単価 ${formatYen(kpis?.averageAmount)}`}
        />
        <KpiCard
          presentation="cell"
          title="急ぎ対応"
          icon={<Zap size={16} />}
          value={kpis?.urgentCount ?? null}
          unit="件"
          delta={deltaMark((kpis?.urgentCount ?? 0) > 0 ? '要対応' : undefined, 'danger')}
          detail="待ち時間と注文内容から自動判定"
        />
        <KpiCard
          presentation="cell"
          title="平均準備時間"
          icon={<Timer size={16} />}
          value={kpis?.averagePrepMinutes ?? null}
          unit="分"
          delta={deltaMark(signedCount(kpis?.averagePrepMinutesDelta, '分'), 'success')}
          detail="目標 15分以内"
        />
      </KpiBand>

  </>
}

export default function OrdersBoard({
  data,
  uberConnectionStatus,
  page,
  perPage,
  busyOrderId,
  busyService,
  canManage,
  uberOrderActionsEnabled,
  intakeDisabledReason,
  nowMs,
  selected,
  bulkBusy,
  onToggleSelect,
  onToggleSelectAll,
  onBulkAccept,
  onTab,
  onOpenHistory,
  onOpenOrder,
  onAccept,
  onReject,
  onReady,
  onHandOver,
  onStopService,
  onResumeService,
  onPage,
  onPerPage,
}: OrdersBoardProps) {
  const total = data.tabCounts[data.tab]
  const pageCount = Math.max(1, Math.ceil(data.orders.length / perPage))
  const currentPage = Math.min(page, pageCount)
  const firstIndex = (currentPage - 1) * perPage
  const visible = data.orders.slice(firstIndex, firstIndex + perPage)
  /*
   * 「まとめて受け付ける」は新着だけを相手にする。
   * まとめ送りの口はWorkerに無いので、親が1件ずつ順に送る（絵の操作は変えない）。
   */
  const selectedSet = new Set(selected)
  const selectableIds = visible.filter((order) => order.status === 'new' && order.service !== 'ubereats').map((order) => order.id)
  const checkedCount = selectableIds.filter((id) => selectedSet.has(id)).length
  const allChecked = selectableIds.length > 0 && checkedCount === selectableIds.length
  const someChecked = checkedCount > 0 && !allChecked
  const tabs: TabItem[] = TAB_ORDER.map((tab) => ({
    id: `delivery-tab-${tab}`,
    label: TAB_LABELS[tab],
    count: data.tabCounts[tab],
    countTone: tab === 'new' && data.tabCounts.new > 0 ? ('warning' as const) : undefined,
    current: data.tab === tab,
    onClick: () => onTab(tab),
  }))

  return (
    <>
      <DeliveryOverview data={data} uberConnectionStatus={uberConnectionStatus} intakeDisabledReason={intakeDisabledReason} canManage={canManage} busyService={busyService} onStopService={onStopService} onResumeService={onResumeService} />

      <Tabs items={tabs} label="注文の状態" />

      <ListToolbar
        filters={(
          <Button onClick={onOpenHistory}>
            <History size={16} aria-hidden="true" />
            注文履歴・売上
          </Button>
        )}
        trailing={<PageSizeSelect value={perPage} onChange={onPerPage} />}
      />

      <Card overflow="hidden"><DataTable density="reviews" columnSizing="content" data-design="kDQHr" label="デリバリーの注文一覧"><thead>
        <TableHeadRow data-table-layout="columns">
          {canManage ? (
            <Th>
              <Checkbox
                aria-label="新着の注文をすべて選ぶ"
                checked={allChecked}
                indeterminate={someChecked}
                disabled={selectableIds.length === 0 || bulkBusy}
                onCheckedChange={onToggleSelectAll}
              />
            </Th>
          ) : null}
          <Th>注文番号</Th>
          <Th>サービス</Th>
          <Th grow>注文内容</Th>
          <Th align="right">金額</Th>
          <Th collapseAt="narrow">経過</Th>
          <Th>急ぎ度</Th>
          <Th>状態</Th>
          <Th><span className="sr-only">操作</span></Th>
        </TableHeadRow></thead><tbody>
        {visible.length === 0 ? (
          <TableStateRow
            colSpan={canManage ? COLUMN_COUNT : COLUMN_COUNT_VIEW_ONLY}
            kind="empty"
            title={data.tab === 'all' ? '注文はまだありません' : 'この状態の注文はありません'}
            description="新しい注文が届くと、ここに表示されます。"
          />
        ) : (
          visible.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              nowMs={nowMs}
              busy={busyOrderId === order.id || bulkBusy}
              canManage={canManage}
              uberOrderActionsEnabled={uberOrderActionsEnabled}
              checked={selectedSet.has(order.id)}
              selectable={canManage && order.status === 'new' && order.service !== 'ubereats'}
              onToggleSelect={onToggleSelect}
              onOpen={onOpenOrder}
              onAccept={onAccept}
              onReject={onReject}
              onReady={onReady}
              onHandOver={onHandOver}
            />
          ))
        )}
      </tbody></DataTable></Card>

      {/* 閲覧のみの人は選べないので、まとめての帯は出さない。選んだ数の帯は共通の一括バー。 */}
      {canManage ? (
        <BulkBar count={checkedCount} unit="件" onClear={() => onToggleSelectAll(false)}>
          <Button variant="primary" busy={bulkBusy} busyLabel="受付中…" disabled={bulkBusy} onClick={onBulkAccept}>
            まとめて受け付ける
          </Button>
        </BulkBar>
      ) : null}

      {data.orders.length > 0 ? (
        <Pagination
          page={currentPage}
          pageCount={pageCount}
          onPageChange={onPage}
          summary={`${countText(total)}中 ${firstIndex + 1}〜${firstIndex + visible.length}件を表示`}
        />
      ) : null}
    </>
  )
}
