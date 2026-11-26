'use client'

/*
 * ★V8 運用状態 › セキュリティの見張り（Pencil Bsc2d）。
 *
 * 不審な操作の増加（ログインの失敗・書き出し・権限の変更など）を、5分ごとに集計した「未対応の異常」の一覧。
 * 口：securityMonitorApi（一覧・確かめた・解決した）。契約は docs/security/SECURITY-MONITOR-CONTRACT.md。
 * 個人情報・店名・本文は口が返さない。画面にも出さない。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { SecurityAlert, SecurityAlertsResponse } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState, { ListEmptyMessage } from '@/components/shared/list-state'
import { notifySaved } from '@/components/shared/toast'
import { isSaveConflict, SaveConflictBand } from '@/components/shared/save-conflict'
import Notice from '@/components/shared/notice'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import { ApiError } from '@/lib/api'
import { securityMonitorApi } from '@/lib/api/helpers/security-monitor'
import { RowActions } from '@/components/shared/row-actions'
import { formatOperationDate } from '@/lib/operation-status'
import { onlyWhenVisible } from '@/lib/visible-polling'
import { formatNumber } from '@/lib/format'
import styles from './security-monitor.module.css'

/** 見張りが最後に完了してからこれ以上たったら、見張りそのものの故障を疑う（契約：直近15分に完了記録がある＝動いている）。 */
const MONITOR_LATE_MS = 15 * 60 * 1000
const REFRESH_MS = 5 * 60 * 1000

const NOTIFICATION_LABEL: Record<SecurityAlert['notification'], string> = {
  sent: '通知済み',
  pending: '通知の再送待ち',
  unconfigured: '通知先が未設定',
}

const STATUS: Record<Exclude<SecurityAlert['status'], 'resolved'>, { label: string; tone: StatusBadgeTone }> = {
  open: { label: '未対応', tone: 'danger' },
  acknowledged: { label: '確かめた', tone: 'warning' },
}

type MonitorView = { tone: StatusBadgeTone; label: string; late: boolean }

function monitorView(monitor: SecurityAlertsResponse['data']['monitor'], now: number): MonitorView {
  const completed = monitor.lastCompletedAt ? Date.parse(monitor.lastCompletedAt) : NaN
  const late = Number.isNaN(completed) || now - completed >= MONITOR_LATE_MS
  if (monitor.status === 'failed') return { tone: 'danger', label: '見張りが失敗しています', late: true }
  if (monitor.status === 'unknown' || Number.isNaN(completed)) return { tone: 'neutral', label: 'まだ確認できていません', late: true }
  if (monitor.status === 'stale' || late) return { tone: 'warning', label: '見張りが止まっているかもしれません', late: true }
  return { tone: 'success', label: '見張りは動いています', late: false }
}

type Pending = { alert: SecurityAlert; action: 'acknowledge' | 'resolve' }

export function SecurityMonitorPanel({ accountId, canOperate }: { accountId: string | null; canOperate: boolean }) {
  if (!accountId) return <ListState kind="empty" title="アカウントを選んでください" description="上のアカウントの切り替えから、確認するアカウントを選んでください。" />
  // Switching accounts also discards the old confirmation and in-flight callbacks.
  return <SecurityMonitorContent key={accountId} accountId={accountId} canOperate={canOperate} />
}

function SecurityMonitorContent({ accountId, canOperate }: { accountId: string; canOperate: boolean }) {
  const [data, setData] = useState<SecurityAlertsResponse['data'] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionConflict, setActionConflict] = useState(false)
  const generation = useRef(0)
  const active = useRef(true)
  const request = useRef<Promise<void> | null>(null)
  const mutation = useRef(false)
  const invalidate = useCallback(() => { generation.current++; request.current = null }, [])

  const load = useCallback((silent = false): Promise<void> => {
    if (request.current) return request.current
    const mine = ++generation.current
    if (!silent) { setData(null); setError(null) }
    setNow(Date.now())
    const next = (async () => {
      try {
        const res = await securityMonitorApi.list(accountId, offset)
        if (!active.current || mine !== generation.current) return
        setData(res.data); setError(null); setNow(Date.now())
      } catch (caught) {
        if (!active.current || mine !== generation.current) return
        // Poll failures must not leave an old green monitor displayed as current.
        setError(caught)
      }
    })()
    request.current = next
    void next.finally(() => { if (request.current === next) request.current = null })
    return next
  }, [accountId, offset])

  useEffect(() => {
    active.current = true
    return () => { active.current = false; invalidate() }
  }, [invalidate])
  useEffect(() => { if (!canOperate) setPending(null) }, [canOperate])
  useEffect(() => {
    void load()
    const refresh = onlyWhenVisible(() => {
      setNow(Date.now())
      if (!mutation.current) void load(true)
    })
    const timer = window.setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      invalidate()
    }
  }, [load, invalidate])

  const run = async () => {
    if (!pending || !canOperate || mutation.current) return
    mutation.current = true
    setBusyId(pending.alert.id); setActionError(''); setActionConflict(false)
    try {
      const call = pending.action === 'acknowledge' ? securityMonitorApi.acknowledge : securityMonitorApi.resolve
      const response = await call(pending.alert.id, pending.alert.version, accountId)
      if (!active.current) return
      if (!response.success) throw new Error('update failed')
      notifySaved(pending.action === 'acknowledge' ? '異常を確かめたことを記録しました。' : '異常を解決済みにしました。')
      setPending(null)
      invalidate()
      void load(true)
      return true
    } catch (caught) {
      if (!active.current) return
      // Keep the failed confirmation and its input. A conflict blocks its old version until the operator closes it and reviews the latest record.
      setActionConflict(caught instanceof ApiError && isSaveConflict(caught))
      setActionError(caught instanceof ApiError && isSaveConflict(caught)
        ? 'ほかの人が先に更新しました。最新の記録を確認してから、もう一度操作してください。'
        : caught instanceof ApiError && caught.status === 403
          ? 'この操作をする権限がありません。'
          : '更新できませんでした。もう一度お試しください。')
      invalidate()
      void load(true)
      return false
    } finally { mutation.current = false; if (active.current) setBusyId(null) }
  }

  if (error) return <ListState kind="error" error={error} onRetry={() => void load()} />
  if (!data) return <ListState kind="loading" />

  const view = monitorView(data.monitor, now)
  const hasNext = data.offset + data.items.length < data.total

  return (
    <div className={styles.panel}>
      <Card surface="muted" layout="horizontal" contentPadding="var(--tpl-sb-hc-banner-pad)" gap="var(--tpl-sb-ec-gap)" aria-label="見張りの状態">
        <ShieldCheck className={styles.monitorIcon} aria-hidden="true" />
        <CardHeader title={<StatusBadge tone={view.tone}>{view.label}</StatusBadge>} meta={<>最後に完了した時刻（日本時間）：{data.monitor.lastCompletedAt ? formatOperationDate(data.monitor.lastCompletedAt) : '未取得'}。5分ごとに、直近 {formatNumber(data.windowMinutes)} 分の操作を数えています。</>} />
      </Card>

      {view.late ? (
        <Notice tone="danger" role="alert">
          {data.monitor.status === 'failed' ? '見張りの処理が失敗しています。最新の異常を確認できていない可能性があります。' : '見張りの最後の完了が15分以上前か、まだ確認できていません。見張りそのものが止まっている可能性があります。'}この間は、異常があっても一覧に出ません。時間をおいても直らないときは、運営へ連絡してください。
        </Notice>
      ) : null}
      {!data.configurationValid ? (
        <Notice tone="warn">基準の設定が正しくないため、初期の基準で見張っています。設定を確かめてください。</Notice>
      ) : null}
      {actionError ? actionConflict
        ? <SaveConflictBand title={actionError} description="一覧を最新の記録へ読み直しました。対象の状態を確かめてから操作してください。" onReload={() => void load(true)} />
        : <Notice tone="danger" role="alert">{actionError}</Notice> : null}

      <section aria-labelledby="security-alerts-heading" className={styles.listSection}>
        <h2 id="security-alerts-heading" className={styles.heading}>未対応の異常 <span className={styles.count}>{formatNumber(data.total)} 件</span></h2>
        {data.items.length === 0 ? (
          <ListEmptyMessage>
            見張りの記録では、未対応の異常はありません。見張るのはログインの失敗・書き出し・権限の変更など、記録に残る操作だけです。位置の変化や外部サービスの鍵の操作は、別の手順で確かめます。
          </ListEmptyMessage>
        ) : (
          <GridTable label="未対応の異常" framed={false} design={{ columns: 'minmax(0, 1fr) 64px 120px 120px 80px 44px', gap: 'var(--tpl-sb-ec-gap)', rowPadding: 'var(--tpl-sb-hc-row-pad)', headPadding: 'var(--tpl-sb-ec-head-pad)', fontSize: 'var(--tpl-sb-band-text)', headFontSize: 'var(--tpl-sb-row-sub)', headLineHeight: 'var(--tpl-sb-row-sub-lh)', headBackground: 'var(--color-surface-pearl)' }}>
            <div role="rowgroup">
              <GridHeadRow>
                <GridCell role="columnheader">種類</GridCell>
                <GridCell role="columnheader">件数</GridCell>
                <GridCell role="columnheader"><TruncatedText value="最後に検知（日本時間）" /></GridCell>
                <GridCell role="columnheader">通知</GridCell>
                <GridCell role="columnheader">状態</GridCell>
                <GridCell role="columnheader">{canOperate ? '操作' : ''}</GridCell>
              </GridHeadRow>
            </div>
            <div role="rowgroup">
              {data.items.filter((item): item is SecurityAlert & { status: 'open' | 'acknowledged' } => item.status !== 'resolved').map((item) => (
                <GridRow key={item.id}>
                  <GridCell role="cell" className={styles.stack}>
                    <span className={styles.main} title={item.summary}><TruncatedText value={item.summary} /></span>
                    <span className={styles.sub}>初回：{formatOperationDate(item.firstDetectedAt)}</span>
                  </GridCell>
                  <GridCell role="cell" className={styles.num}>{formatNumber(item.count)}<span className={styles.sub}>基準 {formatNumber(item.threshold)}</span></GridCell>
                  <GridCell role="cell"><TruncatedText value={formatOperationDate(item.lastDetectedAt)} /></GridCell>
                  <GridCell role="cell"><TruncatedText value={NOTIFICATION_LABEL[item.notification]} /></GridCell>
                  <GridCell role="cell"><StatusBadge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</StatusBadge></GridCell>
                  <GridCell role="cell" className={styles.actions}>
                    {canOperate ? <>
                      <RowActions subjectName={item.summary} menuItems={[
                        ...(item.status === 'open' ? [{ id: 'acknowledge', label: '確かめた', disabled: busyId !== null, onSelect: () => { setActionError(''); setActionConflict(false); setPending({ alert: item, action: 'acknowledge' }) } }] : []),
                        { id: 'resolve', label: '解決した', disabled: busyId !== null, onSelect: () => { setActionError(''); setActionConflict(false); setPending({ alert: item, action: 'resolve' }) } },
                      ]} />
                    </> : null}
                  </GridCell>
                </GridRow>
              ))}
            </div>
          </GridTable>
        )}
        {data.offset > 0 || hasNext ? (
          <div className={styles.pager}>
            <Button size="compact" disabled={data.offset === 0 || busyId !== null} onClick={() => setOffset(Math.max(0, data.offset - data.limit))}>前の{formatNumber(data.limit)}件</Button>
            <span>{`${formatNumber(data.offset + 1)}〜${formatNumber(data.offset + data.items.length)}件 / ${formatNumber(data.total)}件`}</span>
            <Button size="compact" disabled={!hasNext || busyId !== null} onClick={() => setOffset(data.offset + data.limit)}>次の{formatNumber(data.limit)}件</Button>
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        open={canOperate && pending !== null}
        title={pending?.action === 'resolve' ? 'この異常を解決済みにしますか？' : 'この異常を確かめたことにしますか？'}
        description={pending?.action === 'resolve'
          ? '原因と対処を確かめてから押してください。静かになっても自動では解決になりません。解決のあとに同じ操作が基準を超えると、もう一度知らせます。'
          : '確かめた記録を残します。解決したことにはなりません。'}
        confirmLabel={pending?.action === 'resolve' ? '解決した' : '確かめた'}
        busy={busyId !== null}
        error={actionError || undefined} confirmDisabled={actionConflict} confirmDisabledReason="閉じて最新の記録を確認してください。" onSuccess={() => setPending(null)} onConfirm={() => run()}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}
