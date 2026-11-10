'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowRight, Check, Link2, RefreshCw } from 'lucide-react'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import StatusBadge from '@/components/shared/status-badge'
import { GOOGLE_CONNECTION_STATUS, INSTAGRAM_CONNECTION_STATUS } from '@/lib/status-labels'
import { RowActions } from '@/components/shared/row-actions'
import { usePageTitle, usePageCrumbs } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { restaurantGoogleApi, type GoogleConnectionData } from '@/lib/restaurant-google-api'
import { GoogleConnectionSettings } from '@/v8/restaurant/google'
import { api } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import styles from './sns.module.css'
import { formatDate, formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'


/**
 * ★V8-B 設定 › SNS 連携（`YINmJ` 未接続 ／ `DFnll` Instagram 接続済み、2026-10-07 利用者承認）。
 *
 * Googleビジネスと Instagram を1列のカードで縦に並べる。
 * Instagram は「Instagram にログインして接続」だけで繋がる（ページを選ぶ段は無い）。
 * 繋ぐ目的は Googleビジネスの投稿を Instagram へ同時に出すこと。
 */

/* lucide には Instagram の印が無いので、写真の印（Camera）を使う。 */

const IG_CAPABILITIES = ['DM を受信箱で読む・返す', '投稿へのコメントに返す', '投稿を予約する', 'プロフィールのリンクを LINE の友だち追加へ向ける']

/** 戻り先（`/settings/sns?instagram=…`）で出す案内。Worker の折り返しが付ける。 */
const FLASH: Record<string, { tone: 'success' | 'danger'; text: string }> = {
  connected: { tone: 'success', text: 'Instagram とつながりました。Googleビジネスの投稿を Instagram にも出せます。' },
  failed: { tone: 'danger', text: 'Instagram とつなげませんでした。ビジネスアカウント（またはクリエイターアカウント）でログインして、もう一度お試しください。' },
}
const ACCOUNT_OTHER_ORGANIZATION = { tone: 'danger', text: 'このInstagramは別の統括で使用されています。統括の管理者に確認してください。' } as const

const GOOGLE_FLASH: Record<string, { tone: 'success' | 'warn' | 'danger'; text: string }> = {
  connected: { tone: 'success', text: 'Googleアカウントを接続しました。口コミを取得します。' },
  reconnected: { tone: 'success', text: 'Googleアカウントを再接続しました。' },
  select_location: { tone: 'warn', text: 'このLINEアカウントに接続する店舗を1つ選んでください。' },
  'error:invalid_state': { tone: 'danger', text: '認可の確認に失敗しました。もう一度「接続する」からやり直してください。' },
  'error:denied': { tone: 'danger', text: 'Googleでの許可が取り消されました。接続は変更していません。' },
  'error:no_locations': { tone: 'danger', text: 'このGoogleアカウントで管理できる店舗が見つかりませんでした。店舗を管理しているGoogleアカウントでログインしてください。' },
  'error:oauth_not_configured': { tone: 'danger', text: 'この環境にはGoogle接続の設定がありません。' },
  'error:no_permission': { tone: 'danger', text: 'Googleの許可画面で「ビジネス情報の管理」を許可して、もう一度接続してください。' },
}

export default function SnsSettingsPage() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('SNS 連携')
  usePageCrumbs([{ label: '設定', href: '/settings' }])
  const router = useRouter()
  const searchParams = useSearchParams()
  const { selectedAccountId, setSelectedAccountId, accounts } = useAccount()
  const role = useStaffRole()
  const canManage = canManageRole(role)

  const [google, setGoogle] = useState<GoogleConnectionData | null>(null)
  const [googleError, setGoogleError] = useState<unknown>(null)
  const [instagram, setInstagram] = useState<InstagramConnectionStatus | null>(null)
  const [instagramError, setInstagramError] = useState<unknown>(null)
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const [confirm, setConfirm] = useState<'instagram' | null>(null)
  const [confirmAccountId, setConfirmAccountId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const returnedAccountId = searchParams.get('account_id')
  const accountId = returnedAccountId && accounts.some((account) => account.id === returnedAccountId) ? returnedAccountId : selectedAccountId
  const accountScope = useRef({ id: accountId })
  if (accountScope.current.id !== accountId) accountScope.current = { id: accountId }
  const renderedAccountScope = accountScope.current
  const confirmScope = useRef(accountScope.current)
  const flash = searchParams.get('instagram') === 'failed' && searchParams.get('instagram_code') === 'instagram_account_other_organization'
    ? ACCOUNT_OTHER_ORGANIZATION
    : FLASH[searchParams.get('instagram') ?? ''] ?? null
  const googleFlash = GOOGLE_FLASH[searchParams.get('google') ?? ''] ?? (searchParams.has('google') ? { tone: 'danger' as const, text: 'Googleとの接続に失敗しました。もう一度お試しください。' } : null)

  useEffect(() => {
    if (!returnedAccountId || accountId !== returnedAccountId) return
    if (selectedAccountId !== returnedAccountId) { setSelectedAccountId(returnedAccountId); return }
    const next = new URLSearchParams(searchParams.toString())
    next.delete('account_id')
    router.replace(`/settings/sns${next.toString() ? `?${next.toString()}` : ''}`, { scroll: false })
  }, [accountId, returnedAccountId, selectedAccountId, setSelectedAccountId, searchParams, router])

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    if (!accountId) { setLoadedAccountId(null); return }
    await Promise.all([
      restaurantGoogleApi.connection(accountId)
        .then((res) => { if (version === loadVersion.current) { setGoogle(res); setGoogleError(null) } })
        .catch((caught) => { if (version === loadVersion.current) { setGoogle(null); setGoogleError(caught) } }),
      api.instagram.connection(accountId)
        .then((res) => {
          if (version !== loadVersion.current) return
          // 返事は成功でも中身の形が違うことがある。読み込み中のまま止めず、失敗の表示を出す。
          if (!res.success || !res.data?.state) { setInstagram(null); setInstagramError(new Error(res.success ? 'Instagram の接続の状態を読み取れませんでした。' : res.error)); return }
          setInstagram(res.data)
          setInstagramError(null)
        })
        .catch((caught) => { if (version === loadVersion.current) { setInstagram(null); setInstagramError(caught) } }),
    ])
    if (version === loadVersion.current) setLoadedAccountId(accountId)
  }, [accountId])

  useEffect(() => { void load() }, [load])

  const visibleGoogle = loadedAccountId === accountId ? google : null
  const visibleGoogleError = loadedAccountId === accountId ? googleError : null
  const visibleInstagram = loadedAccountId === accountId ? instagram : null
  const visibleInstagramError = loadedAccountId === accountId ? instagramError : null
  const googleStatus = visibleGoogle?.connection.status ?? null
  const igState = visibleInstagram?.state ?? null
  const igConnection = visibleInstagram?.connection ?? null
  const disconnectTicket = useRef<{ scope: typeof renderedAccountScope; version: number; instagramId: string } | null>(null)
  if (disconnectTicket.current && (disconnectTicket.current.scope !== accountScope.current || !canManage || disconnectTicket.current.version !== igConnection?.version || disconnectTicket.current.instagramId !== igConnection?.instagramId)) disconnectTicket.current = null
  const renderedDisconnectTicket = disconnectTicket.current

  const connectInstagram = async () => {
    if (!accountId) return
    setBusy(true)
    setActionError('')
    try {
      const res = await api.instagram.start(accountId)
      if (!res.success) throw new Error(res.error)
      window.location.href = res.data.url
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setBusy(false)
      { if (!fieldFailure)
      setActionError('Instagram のログイン画面を開けませんでした。もう一度お試しください。') }
    }
  }

  const checkInstagram = async () => {
    if (!accountId) return
    setBusy(true)
    setActionError('')
    try {
      await api.instagram.refresh(accountId)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('接続を確かめられませんでした。もう一度お試しください。') }
    } finally {
      setBusy(false)
    }
  }

  const runDisconnect = async () => {
    if (!renderedDisconnectTicket || renderedDisconnectTicket !== disconnectTicket.current || !canManage || !accountId || confirmAccountId !== accountId || renderedAccountScope !== accountScope.current || confirmScope.current !== renderedAccountScope || loadedAccountId !== accountId) return
    setBusy(true)
    setActionError('')
    try {
      await api.instagram.disconnect(accountId, renderedDisconnectTicket.version)
      setConfirm(null)
      await load()
      return true
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('Instagram の接続を解除できませんでした。もう一度お試しください。') }
      return false
    } finally {
      setBusy(false)
    }
  }

  const googleBadgeInfo = visibleGoogleError || !visibleGoogle ? null : GOOGLE_CONNECTION_STATUS[visibleGoogle.connection.status] ?? GOOGLE_CONNECTION_STATUS.disconnected
  const igStatus = igState ? INSTAGRAM_CONNECTION_STATUS[igState] : null
  const googleLocation = visibleGoogle?.connection.locationTitle ?? visibleGoogle?.store.name ?? null

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="settings" boardId="y3GGTs">
      <PageHeading
        headingSize="compact"
        title="SNS 連携"
        help="Googleビジネスや Instagram とつないで、お店の情報をまとめて発信します。"
      />
      <div className={styles.body}>
        {role !== null && !canManage ? <ReadOnlyNotice /> : null}
        {flash ? (
          <Notice tone={flash.tone} role="status" onClose={() => router.replace('/settings/sns', { scroll: false })}>
            {flash.text}
          </Notice>
        ) : null}
        {googleFlash && visibleGoogle?.connection.status !== 'pending_location' ? (
          <Notice tone={googleFlash.tone} role="status" onClose={() => router.replace('/settings/sns', { scroll: false })}>{googleFlash.text}</Notice>
        ) : null}
        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}

        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="sns-google-title">
          <div className={styles.cardHead}>
            <span className={styles.mark} aria-hidden>G</span>
            <h2 id="sns-google-title" className={styles.cardTitle}>Google ビジネス</h2>
            <span className={styles.rowSpacer} />
            {googleBadgeInfo ? <StatusBadge tone={googleBadgeInfo.tone} size="compact">{googleBadgeInfo.label}</StatusBadge> : null}
          </div>
          {!accountId ? (
            <ListState kind="empty" title="LINEアカウントを選んでください" description="画面右上で接続先のLINEアカウントを選んでください。" />
          ) : visibleGoogleError ? (
            <ListState kind="error" error={visibleGoogleError} onRetry={() => void load()} />
          ) : !visibleGoogle ? (
            <ListState kind="loading" />
          ) : (
            <>
              {googleStatus !== 'disconnected' && googleStatus !== 'pending_location' ? <CustomerInfoRows
                rows={[
                  { label: '店舗', value: googleLocation ?? '—' },
                  { label: '最後に取り込んだ日時', value: formatDate(visibleGoogle.connection.lastSyncedAt, { style: 'detail', fallback: '—' }) },
                  { label: '口コミ', value: visibleGoogle.summary.storedCount > 0 ? `${formatNumber(visibleGoogle.summary.storedCount)}件・未返信 ${formatNumber(visibleGoogle.summary.unrepliedCount)}件` : '—' },
                  { label: '投稿', value: visibleGoogle.summary.postsAttentionCount > 0 ? `要対応 ${formatNumber(visibleGoogle.summary.postsAttentionCount)}件` : '—' },
                ]}
              /> : null}
              {googleStatus !== 'disconnected' && googleStatus !== 'pending_location' ? <div className={styles.links}>
                <Link className={styles.link} href="/restaurant-test/google?tab=reviews">口コミへ<ArrowRight size={16} aria-hidden /></Link>
                <Link className={styles.link} href="/restaurant-test/google?tab=posts">投稿へ<ArrowRight size={16} aria-hidden /></Link>
                <Link className={styles.link} href="/restaurant-test/google?tab=profile">プロフィールへ<ArrowRight size={16} aria-hidden /></Link>
              </div> : null}
              <GoogleConnectionSettings key={accountId} accountId={accountId} data={visibleGoogle} onChanged={() => { void load() }} />
            </>
          )}
        </Card>

        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="sns-instagram-title">
          <div className={styles.cardHead}>
            <span className={styles.mark} aria-hidden>IG</span>
            <h2 id="sns-instagram-title" className={styles.cardTitle}>Instagram</h2>
            <span className={styles.rowSpacer} />
            {igStatus ? <StatusBadge tone={igStatus.tone} size="compact">{igStatus.label}</StatusBadge> : null}
            {(igState === 'connected' || igState === 'expired') && canManage ? (
              <RowActions menuAppearance="box" menuSize="row" subjectName="Instagram の連携"
                destructiveItem={{ id: 'disconnect', label: '接続を解除する', onSelect: () => { if (!igConnection || !Number.isSafeInteger(igConnection.version) || igConnection.version < 1) return; disconnectTicket.current = { scope: accountScope.current, version: igConnection.version, instagramId: igConnection.instagramId }; setActionError(''); confirmScope.current = accountScope.current; setConfirmAccountId(accountId); setConfirm('instagram') } }} />
            ) : null}
          </div>
          {!accountId ? (
            <ListState kind="empty" title="LINEアカウントを選んでください" description="画面右上で接続先のLINEアカウントを選んでください。" />
          ) : visibleInstagramError ? (
            <ListState kind="error" error={visibleInstagramError} onRetry={() => void load()} />
          ) : !igState ? (
            <ListState kind="loading" />
          ) : (
            <>
              {igState === 'connected' && igConnection ? (
                <CustomerInfoRows
                  rows={[{
                    label: '接続しているアカウント',
                    value: igConnection.username ? `@${igConnection.username}（ビジネス）` : igConnection.pageName || emptyValue('unknown'),
                  }]}
                />
              ) : null}
              <p className={styles.listTitle}>{igState === 'connected' ? 'できること' : 'つなぐとできること'}</p>
              <ul className={styles.checks}>
                {IG_CAPABILITIES.map((text) => <li key={text}><Check size={16} aria-hidden />{text}</li>)}
              </ul>
              {igState === 'unconfigured' ? (
                <p className={styles.note}>この環境には Instagram 接続の設定がありません。</p>
              ) : null}
              {canManage && igState !== 'unconfigured' ? (
                <div className={styles.actions}>
                  {igState === 'connected' ? (
                    <Button variant="secondary" onClick={() => void checkInstagram()} disabled={busy} busy={Boolean(busy)} busyLabel="処理中…">
                      <RefreshCw size={16} aria-hidden />
                      接続を確かめる
                    </Button>
                  ) : (
                    <>
                      <Button variant="primary" onClick={() => void connectInstagram()} disabled={busy} busy={Boolean(busy)} busyLabel="処理中…">
                        <Link2 size={16} aria-hidden />
                        接続する
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
              {canManage && igState !== 'connected' && igState !== 'unconfigured' ? <p className={styles.note}>Instagram のビジネスアカウント（またはクリエイターアカウント）でログインしてください。個人のアカウントは接続できません。</p> : null}
            </>
          )}
        </Card>

      </div>

      <ConfirmDialog
        open={confirm === 'instagram' && renderedDisconnectTicket !== null && confirmAccountId === accountId && accountId !== null && confirmScope.current === accountScope.current}
        destructive
        title="Instagram の接続を解除しますか？"
        description="解除すると、Googleビジネスの投稿を Instagram へ同時に出せなくなります。あとでもう一度つなぎ直せます。"
        confirmLabel="解除する"
        busy={busy}
        error={actionError || undefined} onSuccess={() => { disconnectTicket.current = null; setConfirm(null) }} onConfirm={() => runDisconnect()}
        onCancel={() => { disconnectTicket.current = null; setConfirm(null) }}
      ><OperationTargetSummary accounts={[{ id: confirmAccountId ?? '' }]} externalTarget={{ label: 'Instagram', name: igConnection?.username ? `@${igConnection.username}` : null }} /></ConfirmDialog>
    </PageFrame></SaveErrorScope>
  )
}
