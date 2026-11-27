'use client'

import CopyTextButton from '@/components/shared/copy-text-button'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Copy, GitBranch, QrCode } from 'lucide-react'
import type { EntryRoute } from '@line-crm/shared'
import { api, type DashboardOverview } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import SectionHeader from './head'
import QrDialog from '@/components/dashboard/qr-dialog'
import styles from './dashboard.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import ListState from '@/components/shared/list-state'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * 友だち追加リンク（ 段C）。動きは 管理画面 の FriendAddLinkCard と同じ：
 * - 経路は選択中アカウントの有効なものだけ（DASH-09）
 * - QR の表示は URL に残す（`?qr=base` / `?qr=<経路ID>`）
 * - コピーに失敗したら黙らず、欄から選べることを伝える（DASH-29）
 * 閲覧のみの人には「経路を分けて発行」（作る操作）を出さない。
 */
export function FriendAddLink({ officialProfileUrl, visualQa, canManage, dialogOnly = false }: {
  officialProfileUrl: string | null | undefined
  visualQa?: DashboardOverview['visualQa']
  canManage: boolean
  dialogOnly?: boolean
}) {
  const { selectedAccount, selectedAccountId } = useAccount()
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [routesSnapshot, setRoutesSnapshot] = useState<{ accountId: string; items: EntryRoute[] | null; error: boolean } | null>(null)
  const currentRoutes = routesSnapshot?.accountId === selectedAccountId ? routesSnapshot : null
  const routes = currentRoutes?.items ?? null
  const routesError = currentRoutes?.error ?? false
  const [routesRetry, setRoutesRetry] = useState(0)
  const [routeId, setRouteId] = useState('')
  const qrParam = params.get('qr')
  const [showQr, setShowQr] = useState(() => qrParam !== null)
  const [qrRouteId, setQrRouteId] = useState(() => (qrParam !== null && qrParam !== 'base' ? qrParam : ''))
  useEffect(() => {
    setShowQr(qrParam !== null)
    setQrRouteId(qrParam !== null && qrParam !== 'base' ? qrParam : '')
  }, [qrParam])
  const writeQr = (value: string | null) => {
    setShowQr(value !== null)
    setQrRouteId(value !== null && value !== 'base' ? value : '')
    const next = new URLSearchParams(params.toString())
    if (value === null) next.delete('qr')
    else next.set('qr', value)
    const text = next.toString()
    samePageUrl.replace(text ? `/?${text}` : '/')
  }

  useEffect(() => {
    let cancelled = false
    setRoutesSnapshot(null)
    setRouteId('')
    if (!selectedAccountId) return () => { cancelled = true }
    void api.entryRoutes.list(selectedAccountId)
      .then((res) => {
        if (!res.success) throw new Error('routes_unavailable')
        if (!Array.isArray(res.data) || res.data.some((route) => !route || typeof route.id !== 'string' || typeof route.name !== 'string' || typeof route.refCode !== 'string' || typeof route.isActive !== 'boolean')) throw new Error('invalid_routes')
        if (!cancelled) setRoutesSnapshot({ accountId: selectedAccountId, items: res.data.filter((route) => route.isActive), error: false })
      })
      .catch(() => { if (!cancelled) setRoutesSnapshot({ accountId: selectedAccountId, items: null, error: true }) })
    return () => { cancelled = true }
  }, [selectedAccountId, routesRetry])

  const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '')
  const baseLink = visualQa?.friendAddUrl ?? (selectedAccount
    ? `${base}/auth/line?account=${encodeURIComponent(selectedAccount.channelId)}`
    : `${base}/auth/line`)
  const route = (routes ?? []).find((entry) => entry.id === routeId)
  const link = route ? `${base}/r/${route.refCode}` : baseLink
  const dialog = <QrDialog
    key={selectedAccountId}
    open={showQr && Boolean(selectedAccountId && selectedAccount)}
    onClose={() => writeQr(null)}
    accountName={selectedAccount?.displayName ?? 'LINE公式アカウント'}
    officialProfileUrl={visualQa?.officialProfileUrl ?? officialProfileUrl}
    accountBasicId={selectedAccount?.basicId ?? null}
    baseLink={baseLink}
    initialRouteId={showQr ? qrRouteId : routeId}
    onRouteIdChange={(id) => writeQr(id || 'base')}
    routes={routes ?? []}
    routesPending={routes === null}
    routesError={routesError}
    onRetryRoutes={() => setRoutesRetry(value => value + 1)}
    visualReferenceQr={visualQa?.referenceQr ?? false}
  />
  if (dialogOnly) return dialog

  return (
    <>
      <SectionHeader
        title="友だち追加リンク"
        help="このURLから追加された友だちは、流入元を記録して計測できます。"
        helpLabel="友だち追加リンクの説明"
      />
      <div className={styles.linkRow}>
        {routesError ? <ListState kind="error" title="経路を読み込めませんでした" onRetry={() => setRoutesRetry((value) => value + 1)} /> : null}
        <span className={styles.linkKey}>発行中</span>
        <span className={styles.routeSelect}>
          <SaveErrorField names={["routeId","route_id"]}><EntitySelect
            value={routeId || '__base_url__'}
            onChange={(value) => setRouteId(value === '__base_url__' ? '' : value)}
            aria-label="発行中の追加URL"
            disabled={routes === null}
            options={[
              { value: '__base_url__', label: '基本の追加URL', color: 'var(--tpl-picker-selected-dot)' },
              ...(routes ?? []).map((entry) => ({ ...entityOptionMetadata(entry), value: entry.id, label: entry.name })),
            ]}
          /></SaveErrorField>
        </span>
        <span className={styles.spacer} />
        {canManage ? (
          <Button href="/inflow-links"><GitBranch size={16} aria-hidden="true" />経路を分けて発行</Button>
        ) : null}
      </div>
      <div className={styles.linkRow}>
        <SaveErrorField names={["link"]}><SharedTextField
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="友だち追加リンク"
          className={styles.urlField}
        /></SaveErrorField>
        <CopyTextButton value={link} label="コピーする" icon={<Copy size={16} aria-hidden="true" />} variant="secondary" aria-label="友だち追加URLをコピー" />
        <Button type="button" onClick={() => writeQr(routeId || 'base')}>
          <QrCode size={16} aria-hidden="true" />QRを表示
        </Button>
      </div>
      {copyState === 'failed' ? (
        <p role="alert" className={styles.alert}>コピーできませんでした。上のURL欄を選択してコピーしてください。</p>
      ) : null}
      {dialog}
    </>
  )
}
