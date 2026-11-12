'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarDays, Download, FileText, Info, RotateCcw, Send } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import CopyTextButton from '@/components/shared/copy-text-button'
import { downloadCsv } from '@/components/shared/csv-download'
import { jstDate } from '@/lib/jst-datetime'
import HelpTip from '@/components/shared/help-tip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import TruncatedText from '@/components/shared/truncated-text'
import { RowMenu } from '@/components/shared/row-actions'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { ActionCell, DataTable, RowNameLink, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifySaved, notifyToast } from '@/components/shared/toast'
import { emptyValue } from '@/components/shared/empty-value'
import { formatListTimestamp, formatYen, formatNumber } from '@/lib/format'
import { ApiError } from '@/lib/api'
import { bookingPaymentAdminApi, isNotReadyError, type PaymentRecord, type PaymentRecordsPage } from '@/lib/api/helpers/booking-payment-admin'
import { PAYMENT_STATUS, paymentBadge } from '@/components/shared/payment-status'
import StatusBadge from '@/components/shared/status-badge'
import TestModeNote from '@/components/shared/test-mode-note'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { RefundDialog, type RefundInput } from '@/components/shared/booking-confirm-dialogs'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'

/** 読み取りAPIが返す操作した人と理由。未取得は値を作らずに表示する。 */
type PaymentRecordWithActor = PaymentRecord & { actorLabel?: string | null }
import styles from './payments.module.css'
import { withHonorific } from '@line-crm/shared'

/* お支払いの記録（FY8HC）。返金は 2 段の確かめ（確かめの窓 → 金額を入れる）。 */

const TABLE_LAYOUT = { headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-card)', padding: '0 var(--polish-space-section)', bodyTextSize: 'var(--polish-text-body)', collapseScope: 'page' as const }
const STATUS_FILTER = [
  { value: '', label: 'すべて' },
  { value: 'pending', label: `${PAYMENT_STATUS.unpaid.label}` },
  { value: 'paid', label: `${PAYMENT_STATUS.paid.label}` },
  { value: 'refunded', label: `${PAYMENT_STATUS.refunded.label}` },
  { value: 'expired', label: `${PAYMENT_STATUS.expired.label}` },
  { value: 'onsite', label: 'お店で払う' },
]
const METHOD_FILTER = [
  { value: '', label: 'すべて' },
  { value: 'online', label: 'オンライン' },
  { value: 'onsite', label: '店頭' },
]
const PERIOD_FILTER = [
  { value: 'month', label: '今月' },
  { value: '7d', label: '過去7日' },
  { value: '30d', label: '過去30日' },
  { value: '90d', label: '過去90日' },
]

type Load = { state: 'loading' } | { state: 'ready'; page: PaymentRecordsPage } | { state: 'not-ready' } | { state: 'error' }

export default function PaymentRecords({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [method, setMethod] = useState('')
  const [period, setPeriod] = useState('month')
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [refundTarget, setRefundTarget] = useState<PaymentRecord | null>(null)
  const refundScope = useRef({ accountId })
  if (refundScope.current.accountId !== accountId) refundScope.current = { accountId }
  const refundOpeningScope = useRef(refundScope.current)
  const refundAttempt = useRef<{ signature: string; key: string } | null>(null)
  const [testMode, setTestMode] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundError, setRefundError] = useState<string | null>(null)
  const preparing = usePreparingDialog()
  const generation = useRef(0)
  const [exporting, setExporting] = useState(false)
  const [linkPreview, setLinkPreview] = useState<{ name: string; url: string | null } | null>(null)

  const reload = useCallback(async () => {
    const mine = ++generation.current
    setLoad({ state: 'loading' })
    try {
      const response = await bookingPaymentAdminApi.records(accountId, { q: query.trim(), status, method, period, limit: 20 })
      if (mine === generation.current) setLoad({ state: 'ready', page: response.data })
    } catch (cause) {
      if (mine === generation.current) setLoad({ state: isNotReadyError(cause) ? 'not-ready' : 'error' })
    }
  }, [accountId, query, status, method, period])

  useEffect(() => { setRefundTarget(null); setRefundError(null); setRefunding(false); refundAttempt.current = null }, [accountId])
  useEffect(() => { void reload() }, [reload])
  /* 試験モードの印（：お金の数が出る所すべて）。 */
  useEffect(() => {
    let alive = true
    void Promise.resolve().then(() => bookingPaymentAdminApi.connection(accountId))
      .then((response) => { if (alive) setTestMode(Boolean(response?.data?.connected && response.data.testMode)) }).catch(() => {})
    return () => { alive = false }
  }, [accountId])

  const summary = load.state === 'ready' ? load.page.summary : null
  const items = load.state === 'ready' ? load.page.items : []

  function menuFor(record: PaymentRecord): ActionMenuItem[] {
    return [
      ...(record.bookingId ? [{ id: 'open', label: '予約を開く', icon: <CalendarDays size={16} aria-hidden="true" />, href: `/booking/bookings?booking=${encodeURIComponent(record.bookingId)}` }] : []),
      ...(canEdit && record.status === 'pending' ? [{ id: 'link', label: '支払いのリンクを送る', icon: <Send size={16} aria-hidden="true" />, onSelect: () => void previewLink(record) }] : []),
      ...(record.receiptUrl ? [{ id: 'receipt', label: '領収書を見る', icon: <FileText size={16} aria-hidden="true" />, href: record.receiptUrl, external: true }] : []),
      ...(canEdit && (record.status === 'paid' || record.status === 'partially_refunded') ? [{ id: 'refund', label: '返金する', tone: 'danger' as const, icon: <RotateCcw size={16} aria-hidden="true" />, onSelect: () => { refundOpeningScope.current = refundScope.current; setRefundError(null); setRefundTarget(record) } }] : []),
    ]
  }

  /* 支払いのリンクは模擬だけ（組3：dryRun。LINE・Stripe へは送らない。sent:false を「送った」と言わない）。 */
  async function previewLink(record: PaymentRecord) {
    try {
      const response = await bookingPaymentAdminApi.previewPaymentLink(accountId, record.id)
      setLinkPreview({ name: record.friendName ?? 'お客さま', url: response.data.checkoutUrl })
    } catch (cause) {
      notifyToast(cause instanceof ApiError && cause.status === 404 ? 'この支払いは、もうリンクを作れません（支払い済み・期限切れ）。'
        : cause instanceof ApiError && cause.status === 409 ? 'この予約は、いまオンラインで払う形ではありません。'
          : 'リンクを作れませんでした。もう一度お試しください。')
    }
  }

  async function exportCsv() {
    setExporting(true)
    try {
      const blob = await bookingPaymentAdminApi.exportCsv(accountId, { q: query.trim(), status, method, period })
      const text = await blob.text()
      downloadCsv(text.startsWith('\uFEFF') ? text : `\uFEFF${text}`, `お支払いの記録-${jstDate(new Date()).replaceAll('-', '')}.csv`)
    } catch (cause) {
      notifyToast(cause instanceof ApiError && cause.status === 413 ? '1万件を超えるため書き出せません。期間や状態で絞ってください。' : 'CSVを書き出せませんでした。もう一度お試しください。')
    } finally {
      setExporting(false)
    }
  }

  // 同じ内容の再試行には同じキーを使い、返金を二重に記録しない。
  async function refund(input: RefundInput) {
    if (!refundTarget || refundOpeningScope.current !== refundScope.current) return
    const operationScope = refundScope.current
    if (refunding || !canEdit) return
    if (!Number.isSafeInteger(refundTarget.confirmationRevision) || (refundTarget.confirmationRevision ?? 0) < 1) {
      setRefundError('支払いの情報を読み直してから、もう一度お試しください。')
      return
    }
    const signature = JSON.stringify([accountId, refundTarget.id, input.amount, input.reason, input.notify])
    if (refundAttempt.current?.signature !== signature) refundAttempt.current = { signature, key: crypto.randomUUID() }
    setRefunding(true)
    setRefundError(null)
    try {
      await bookingPaymentAdminApi.refund(refundTarget.id, {
        amount: input.amount, reason: input.reason, notifyLine: input.notify, idempotencyKey: refundAttempt.current.key, expectedRevision: refundTarget.confirmationRevision ?? undefined,
      })
    } catch (cause) {
      if (operationScope !== refundScope.current) return
      if (isConflictResponse(cause) && cause.code === 'stale_confirmation') {
        setRefundTarget(null)
        refundAttempt.current = null
        void reload()
        notifyToast('支払いの内容が変わりました。一覧を確認して、もう一度操作してください。', { tone: 'error' })
        return
      }
      setRefundError(isConflictResponse(cause) && cause.code === 'simulation_only'
        ? 'この支払いは模擬返金できません。Stripe の管理画面で状態を確認してください。'
        : isConflictResponse(cause) && cause.code === 'refund_idempotency_conflict'
          ? '前の操作と返金内容が異なります。窓を閉じて、もう一度操作してください。'
          : cause instanceof ApiError && cause.status === 409 ? 'この支払いは返金できません。残額と状態を確認してください。'
            : cause instanceof ApiError && cause.status === 403 ? '返金する権限がありません。'
              : '返金できませんでした。Stripe の管理画面で状態を確かめてください。')
      return
    } finally {
      if (operationScope === refundScope.current) setRefunding(false)
    }
    if (operationScope !== refundScope.current) return
    refundAttempt.current = null
    notifySaved(`${withHonorific(refundTarget.friendName ?? 'お客さま', 'さま')}の ${formatYen(input.amount)} の返金を模擬で記録しました。実際の返金・LINE送信はしていません`)
    setRefundTarget(null)
    void reload()
  }

  return (
    <div className={styles.records} data-design="PaymentRecords">
      <div className={styles.recordsHead}>
        <h2 className={styles.recordsTitle}>お支払いの記録<HelpTip label="お支払いの記録の数え方">入金は今月に支払いが済んだ合計、返金は今月に返金した合計です。期限切れの枠は、お支払いを待つ時間を過ぎて取り消した仮の予約です。</HelpTip>{testMode ? <TestModeNote size="compact">{null}</TestModeNote> : null}</h2>
        {load.state === 'ready' ? <Button busy={exporting} onClick={() => void exportCsv()}><Download size={16} aria-hidden="true" />CSVで書き出す</Button> : null}
      </div>

      {load.state === 'not-ready' ? (
        <Notice tone="info" icon={<Info size={16} aria-hidden="true" />}>お支払いの記録は、データの準備が済むと見られます。返金は予約の画面からできます。</Notice>
      ) : (
        <>
          <KpiBand>
            <KpiCard icon={null} title="今月の入金" value={summary?.paidAmount} unit="円" detail={summary ? `${formatNumber(summary.paidCount)} 件` : undefined} loading={load.state === 'loading'} />
            <KpiCard icon={null} title="返金" value={summary?.refundedAmount} unit="円" detail={summary ? `${formatNumber(summary.refundedCount)} 件` : undefined} loading={load.state === 'loading'} />
            <KpiCard icon={null} title={PAYMENT_STATUS.unpaid.label} value={summary?.pendingCount} unit="件" detail="支払いを待って枠を取り置き中" loading={load.state === 'loading'} />
            <KpiCard icon={null} title="期限切れの枠" value={summary?.expiredCount} unit="件" detail={summary ? `${summary.holdMinutes} 分を過ぎた` : undefined} loading={load.state === 'loading'} />
          </KpiBand>
          <div data-template-region="toolbar"><ListToolbar
            search={{ placeholder: '名前・タグ・メモで探す', value: query, onChange: setQuery, width: 260 }}
            filters={<>
              <Select aria-label="状態" label="状態" value={status} onChange={setStatus} options={STATUS_FILTER} />
              <Select aria-label="方法" label="方法" value={method} onChange={setMethod} options={METHOD_FILTER} />
              <Select aria-label="期間" label="期間" value={period} onChange={setPeriod} options={PERIOD_FILTER} />
            </>}
            trailing={<span className={styles.count}>{load.state === 'ready' ? `${load.page.total}件表示` : ''}</span>}
          /></div>
          {load.state === 'loading' ? <ListState kind="loading" title="お支払いの記録を読み込んでいます" />
            : load.state === 'error' ? <ListState kind="error" title="お支払いの記録を表示できませんでした" onRetry={() => void reload()} />
              : items.length === 0 ? <ListState kind="empty" title="この条件のお支払いはありません" description="期間や状態を変えてください。" />
                : (
                  <Card overflow="hidden"><DataTable aria-label="お支払いの記録" columnSizing="content" columnLayout={TABLE_LAYOUT}>
                    <thead><TableHeadRow data-table-layout="columns"><Th truncate>日時</Th><Th grow truncate>お客さま</Th><Th grow truncate>予約</Th><Th align="right" truncate>金額</Th><Th truncate>状態</Th><Th truncate>方法</Th><Th truncate>操作した人・理由</Th><Th showActionLabel>操作</Th></TableHeadRow></thead>
                    <tbody>{items.map((record) => {
                      const actor = (record as PaymentRecordWithActor).actorLabel ?? null
                      const menu = menuFor(record)
                      return (
                        <Tr key={record.id} data-table-layout="columns">
                          <Td><TruncatedText value={formatListTimestamp(record.createdAt)} /></Td>
                          <Td grow>{record.friendId ? <RowNameLink href={`/friends/detail?id=${encodeURIComponent(record.friendId)}`} title={record.friendName ?? ''}>{record.friendName ?? emptyValue('unknown')}</RowNameLink> : <TruncatedText value={record.friendName ?? emptyValue('unknown')} />}</Td>
                          <Td grow><span className={styles.cellStack}><TruncatedText value={record.bookingLabel ?? emptyValue('unknown')} />{record.bookingNote ? <span className={styles.cellSub}>{record.bookingNote}</span> : null}</span></Td>
                          <Td align="right"><TruncatedText value={formatYen(record.amount)} /></Td>
                          <Td>{(() => { const badge = paymentBadge(record.status); return badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : emptyValue('unknown') })()}</Td>
                          <Td><TruncatedText value={record.method === 'online' ? 'カード' : record.method === 'onsite' ? '店頭' : record.method ?? emptyValue('unknown')} /></Td>
                          <Td><TruncatedText value={actor ?? emptyValue('unknown')} /></Td>
                          <ActionCell>{menu.length > 0 ? <RowMenu appearance="box" size="row" label={`${record.friendName ?? 'お支払い'}の操作`} open={openMenu === record.id} onOpenChange={(next) => setOpenMenu(next ? record.id : null)} items={menu} /> : null}</ActionCell>
                        </Tr>
                      )
                    })}</tbody>
                  </DataTable></Card>
                )}
          <p className={styles.footNote}><Info size={16} aria-hidden="true" />返金は確かめの窓のあとに 2 回目の確かめ（金額を入れる）で行います。数え方は「？」の中。</p>
        </>
      )}

      <Dialog open={linkPreview !== null} title="支払いのリンク（試験モード）" description={`${withHonorific(linkPreview?.name ?? '')}用のリンクを作りました。いまは模擬なので、LINE には送っていません。`}
        cancelLabel="閉じる" onCancel={() => setLinkPreview(null)}>
        {linkPreview?.url ? <CopyTextButton value={linkPreview.url} label="リンクをコピー" aria-label="支払いのリンクをコピー" /> : <p className={styles.minor}>リンクはまだ作られていません。</p>}
      </Dialog>
      <RefundDialog open={refundTarget !== null && refundOpeningScope.current === refundScope.current} subtitle={`${withHonorific(refundTarget?.friendName ?? 'お客', 'さま')}・${refundTarget?.bookingLabel ?? ''}`}
        targetSummary={<OperationTargetSummary accounts={[{ id: refundOpeningScope.current.accountId }]} externalTarget={{ label: '返金する支払い', name: refundTarget?.friendName ? `${withHonorific(refundTarget.friendName, 'さま')}・${refundTarget.bookingLabel ?? '予約名を確認できません'}` : undefined }} />}
        paidAmount={Math.max(0, (refundTarget?.amount ?? 0) - (refundTarget?.refundedAmount ?? 0))} testMode={testMode} busy={refunding} error={refundError ?? undefined}
        facts={[{ label: '支払った額', value: `${formatYen(refundTarget?.amount)}（${refundTarget?.method === 'onsite' ? '店頭' : 'カード'}）` }, { label: 'これまでの返金', value: refundTarget?.refundedAmount ? formatYen(refundTarget.refundedAmount) : 'なし' }]}
        destination={refundTarget?.method === 'onsite' ? '店頭' : 'カード'}
        messageFor={(input) => `${withHonorific(refundTarget?.friendName ?? 'お客', 'さま')}　${refundTarget?.bookingLabel ?? ''}のご予約のお支払いのうち ${formatYen(input.amount)} を返金しました。カードへの反映は数日かかることがあります。`}
        onClose={() => { if (!refunding) { setRefundTarget(null); setRefundError(null) } }} onConfirm={(input) => void refund(input)} />
      {preparing.dialog}
    </div>
  )
}
