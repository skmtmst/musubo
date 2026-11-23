'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SecurityAlert } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { api, ApiError } from '@/lib/api'
import { securityMonitorApi } from '@/lib/api/helpers/security-monitor'
import { formatOperationDate } from '@/lib/operation-status'
import styles from './security-monitor.module.css'

/** Platform billing alerts are never loaded through the tenant-scoped endpoint. */
export function BillingRetryPanel({ canManage, sessionReady, impersonating }: { canManage: boolean; sessionReady: boolean; impersonating: boolean }) {
  const [platform, setPlatform] = useState(false)
  const [alerts, setAlerts] = useState<SecurityAlert[] | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<SecurityAlert | null>(null)
  const [busy, setBusy] = useState(false)
  const retryLock = useRef(false)
  const mounted = useRef(false)
  const loadSequence = useRef(0)
  const lockedReason = !sessionReady ? '権限を確認しています。' : impersonating ? '代理ログイン中は操作できません。' : !canManage ? '閲覧のみのため操作できません。' : undefined

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const matches: SecurityAlert[] = []
      let offset = 0
      for (;;) {
        const result = await securityMonitorApi.list(undefined, offset)
        if (!mounted.current || sequence !== loadSequence.current) return
        matches.push(...result.data.items.filter(item => item.ruleKey === 'stripe_external_effect_review' && item.status !== 'resolved'))
        offset += result.data.items.length
        if (offset >= result.data.total || result.data.items.length === 0) break
      }
      if (mounted.current && sequence === loadSequence.current) { setAlerts(matches); setError('') }
    } catch { if (mounted.current && sequence === loadSequence.current) setError('安全監視を読み込めませんでした。もう一度お試しください。') }
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    void Promise.resolve().then(() => api.auth.session()).then(result => {
      if (!active || !result.success || !result.data.platformAdmin) return
      setPlatform(true)
      void load()
    }).catch(() => { if (active) setPlatform(false) })
    return () => { active = false; mounted.current = false; loadSequence.current++ }
  }, [load])

  useEffect(() => { if (lockedReason) setPending(null) }, [lockedReason])
  const retry = async () => {
    if (!pending || lockedReason || retryLock.current) return false
    retryLock.current = true
    setBusy(true); setError('')
    try {
      await securityMonitorApi.retryBilling(pending.id, pending.version)
      if (mounted.current) { setPending(null); await load() }
      return true
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.code === 'BILLING_RETRY_BUSY' ? 'ほかの人が処理しています。' : '再処理できませんでした。最新の記録を確認して、もう一度お試しください。')
      return false
    } finally { retryLock.current = false; if (mounted.current) setBusy(false) }
  }

  if (!platform) return null
  return <Card contentPadding="var(--tpl-sb-hc-banner-pad)">
    <section className={styles.listSection} aria-label="安全監視の要確認">
      <h2 className={styles.heading}>安全監視：要確認一覧</h2>
      <p className={styles.sub}>決済の処理結果を確認できなかった通知です。必要に応じて再処理してください。</p>
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      {alerts === null ? <p className={styles.sub}>読み込み中…</p> : alerts.length === 0 ? <p className={styles.sub}>要確認の通知はありません。</p> :
        <GridTable label="安全監視の要確認一覧" framed={false} design={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) 120px 80px 132px', gap: 'var(--tpl-sb-ec-gap)', rowPadding: 'var(--tpl-sb-hc-row-pad)', fontSize: 'var(--tpl-sb-band-text)', headFontSize: 'var(--tpl-sb-row-sub)', headBackground: 'var(--color-surface-pearl)' }}>
          <div role="rowgroup"><GridHeadRow><GridCell role="columnheader">項目</GridCell><GridCell role="columnheader">詳細</GridCell><GridCell role="columnheader">最後の確認</GridCell><GridCell role="columnheader">判定</GridCell><GridCell role="columnheader">操作</GridCell></GridHeadRow></div>
          <div role="rowgroup">{alerts.map(alert => <GridRow key={alert.id}>
            <GridCell role="cell"><StatusBadge tone="caution">要確認</StatusBadge> 決済の通知</GridCell>
            <GridCell role="cell"><TruncatedText value={alert.summary} /></GridCell>
            <GridCell role="cell"><TruncatedText value={formatOperationDate(alert.lastDetectedAt)} /></GridCell>
            <GridCell role="cell"><StatusBadge tone="caution">要確認</StatusBadge></GridCell>
            <GridCell role="cell"><Button variant="secondary" textTone="accent" size="compact" type="button" lockedReason={lockedReason} disabled={busy} onClick={() => setPending(alert)}>再処理する</Button></GridCell>
          </GridRow>)}</div>
        </GridTable>}

    </section>
    <ConfirmDialog open={pending !== null && !lockedReason} title="再処理しますか？" description="Stripe通知を再処理し、記録を更新することがあります。" confirmLabel="再処理する" error={pending ? error || undefined : undefined} busy={busy} onCancel={() => setPending(null)} onConfirm={retry} onSuccess={() => setPending(null)} />
  </Card>
}
