'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ArrowRight, Check, Plus, RefreshCw } from 'lucide-react'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { GOOGLE_CONNECTION_STATUS, INSTAGRAM_CONNECTION_STATUS } from '@/lib/status-labels'
import { usePageTitle, usePageCrumbs } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { restaurantGoogleApi, type GoogleConnectionData } from '@/lib/restaurant-google-api'
import { GoogleConnectionSettings } from '@/v8/restaurant/google'
import { api } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import styles from './sns.module.css'
import { formatDate, formatNumber } from '@/lib/format'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import SnsConnectionList from './connection-list'
import { GoogleMark, InstagramMark } from './brand-marks'
import {
  googleSlots,
  instagramSlots,
  planAddition,
  planRemoval,
  serviceCardTitle,
  slotCountText,
  SNS_DEFAULT_CONTRACTED,
  SNS_SLOT_UNIT_YEN,
  type SnsAdditionPlan,
  type SnsConnectionView,
  type SnsRemovalPlan,
  type SnsService,
  type SnsServiceSlots,
  type SnsSlotBilling,
  type SnsSlotsView,
} from './connection-slots'
import { SnsSlotAdditionDialog, SnsSlotQuoteDialog, SnsSlotRemovalDialog } from './slot-dialogs'

/**
 * 設定 › SNS 連携の画面。承認デザイン（設定SNS連携 複数接続 第1段 v7）の F1〜F8。
 * Googleビジネスと Instagram を1列のカードで縦に並べ、カードごとに接続を複数積む。
 *
 * 決まり：
 * - 契約枠の中の追加は料金の確認を挟まず認可画面へ進む。枠を超える追加は画面内で料金を
 *   確認してから進む。11個目からは個別見積もり（要件 §4-1）。判定は connection-slots が持つ。
 * - 閲覧しかできない人にも操作を消さず、押せない理由を添えて置く（AGENTS.md §15・F8）。
 * - 札の言葉と色は status-labels の表だけを読む。画面では言葉を作らない。
 * - 金額の文字は共通の料金表（SNS_SLOT_UNIT_YEN）から作り、画面に数字を直書きしない。
 */

/** カードの「できること」。承認デザイン F1・F7 の文言。 */
const CAPABILITIES: Record<SnsService, string[]> = {
  googleBusiness: ['口コミに返信できます', 'お知らせやキャンペーンを投稿できます', '営業時間やプロフィールを取り込めます'],
  instagram: ['DM を受信箱で読んで返せます', 'Googleビジネスの投稿を Instagram にも同時に出せます'],
}

/** 権限が足りないときに操作へ添える理由（F8）。 */
const LOCKED_REASON = 'オーナーか管理者だけが接続を変更できます'

/**
 * 請求の段（無料期間か支払い中か・月次期間の残り日数）を返す API はまだ無い（要件 §6「課金」は別の担当）。
 * 日付と残り日数はサーバーの値だけを使う決まりなので、画面で作らず「分からない」として扱い、
 * 枠を超える追加だけを押せない状態にする（connection-slots の `billing-unknown`）。
 */
const BILLING: SnsSlotBilling | null = null

/** 枠を超える追加を止めるときの理由。 */
const BILLING_UNKNOWN_REASON = '追加の料金を確かめられないため、いまは枠を超える追加ができません。しばらくしてからもう一度お試しください。'

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

/** 解除のときに送る版の控え。画面の作り直しや LINEアカウントの切り替えで無効にする。 */
type DisconnectTicket = {
  scope: { id: string | null }
  service: SnsService
  connectionId: string
  version: number | null
  /** Google の版の口。版が無い接続は null（版の確認なしで解除する）。 */
  googleExpected: { expectedConnectionId: string; expectedConfirmationRevision: number } | null
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
  const [addPlan, setAddPlan] = useState<SnsAdditionPlan | null>(null)
  const [removePlan, setRemovePlan] = useState<SnsRemovalPlan | null>(null)
  const [confirmAccountId, setConfirmAccountId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const returnedAccountId = searchParams.get('account_id')
  const accountId = returnedAccountId && accounts.some((account) => account.id === returnedAccountId) ? returnedAccountId : selectedAccountId
  const accountName = accounts.find((account) => account.id === accountId)?.name ?? ''
  /* 飲食店の作りのときだけ、Google カードから口コミ・投稿・プロフィールの画面へ行ける（前からある機能）。 */
  const accountStyle = useAccountStyle(accountId)
  const restaurantStyle = accountStyle.status === 'ready' && accountStyle.data?.style === 'restaurant'
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

  /* 画面が必要とする形（サービスごとの接続と契約枠）へ直す。契約枠を返す API が入るまでは既定値。 */
  const slots: SnsSlotsView = {
    googleBusiness: googleSlots(visibleGoogle, SNS_DEFAULT_CONTRACTED, (iso) => formatDate(iso, { style: 'detail' })),
    instagram: instagramSlots(visibleInstagram, SNS_DEFAULT_CONTRACTED, (iso) => formatDate(iso, { style: 'day' })),
  }
  const canManageGoogle = canManage && (visibleGoogle?.permissions.canManageConnection ?? true)

  const disconnectTicket = useRef<DisconnectTicket | null>(null)
  const ticketConnection = disconnectTicket.current
    ? slots[disconnectTicket.current.service].connections.find((connection) => connection.id === disconnectTicket.current?.connectionId) ?? null
    : null
  if (disconnectTicket.current && (
    disconnectTicket.current.scope !== accountScope.current
    || !canManage
    || !ticketConnection
    || ticketConnection.version !== disconnectTicket.current.version
  )) disconnectTicket.current = null
  const renderedDisconnectTicket = disconnectTicket.current

  /** 認可画面へ進む。Google は店舗（ロケーション）の選択まで Google 側で行う。 */
  const beginConnect = async (service: SnsService) => {
    if (!accountId) return
    setBusy(true)
    setActionError('')
    try {
      if (service === 'googleBusiness') {
        const res = await restaurantGoogleApi.connectStart(accountId)
        window.location.assign(res.authorizeUrl)
        return
      }
      const res = await api.instagram.start(accountId)
      if (!res.success) throw new Error(res.error)
      window.location.href = res.data.url
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setBusy(false)
      if (!fieldFailure) {
        setActionError(service === 'googleBusiness'
          ? 'Google の許可画面を開けませんでした。もう一度お試しください。'
          : 'Instagram のログイン画面を開けませんでした。もう一度お試しください。')
      }
    }
  }

  /**
   * Instagram の接続を確かめ直す（前からある機能・`POST /api/instagram/refresh`）。
   * 認可はやり直さず、今の接続がまだ生きているかをサーバーに確かめて表示を更新する。
   */
  const checkInstagram = async () => {
    if (!accountId) return
    setBusy(true)
    setActionError('')
    try {
      await api.instagram.refresh(accountId)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      if (!fieldFailure) setActionError('接続を確かめられませんでした。もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  /** 1件追加する。契約枠の中はそのまま認可へ、超えるときは画面内の料金確認へ（要件 §4-1）。 */
  const startAddition = (service: SnsService) => {
    if (!accountId) return
    const plan = planAddition(slots, service, BILLING)
    if (plan.kind === 'within-quota') { void beginConnect(service); return }
    if (plan.kind === 'billing-unknown') return
    setActionError('')
    setAddPlan(plan)
  }

  /** 枠を超える追加を押せない状態にする理由。押せるときは何も添えない。 */
  const additionLockedReason = (service: SnsService): string | undefined => {
    if (!canManage) return LOCKED_REASON
    const plan = planAddition(slots, service, BILLING)
    return plan.kind === 'billing-unknown' ? BILLING_UNKNOWN_REASON : undefined
  }

  /** 解除の確認を開く。版を控え、LINEアカウントの切り替えで無効にする。 */
  const askDisconnect = (service: SnsService, connection: SnsConnectionView) => {
    if (!accountId || !canManage) return
    const googleConnection = service === 'googleBusiness' ? visibleGoogle?.connection ?? null : null
    const revision = googleConnection?.confirmationRevision
    disconnectTicket.current = {
      scope: accountScope.current,
      service,
      connectionId: connection.id,
      version: connection.version,
      googleExpected: googleConnection?.id && Number.isSafeInteger(revision) && (revision as number) >= 1
        ? { expectedConnectionId: googleConnection.id, expectedConfirmationRevision: revision as number }
        : null,
    }
    setActionError('')
    confirmScope.current = accountScope.current
    setConfirmAccountId(accountId)
    setRemovePlan(planRemoval(slots, service, connection))
  }

  const runDisconnect = async () => {
    const ticket = renderedDisconnectTicket
    if (!ticket || ticket !== disconnectTicket.current || !canManage || !accountId || confirmAccountId !== accountId || renderedAccountScope !== accountScope.current || confirmScope.current !== renderedAccountScope || loadedAccountId !== accountId) return false
    setBusy(true)
    setActionError('')
    try {
      if (ticket.service === 'instagram') {
        if (ticket.version === null || !Number.isSafeInteger(ticket.version) || ticket.version < 1) {
          setActionError('接続の版を読み取れませんでした。画面を読み込み直してからもう一度お試しください。')
          return false
        }
        await api.instagram.disconnect(accountId, ticket.version)
      } else {
        await restaurantGoogleApi.disconnect(accountId, ticket.googleExpected ?? undefined)
      }
      disconnectTicket.current = null
      setRemovePlan(null)
      await load()
      return true
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      if (!fieldFailure) {
        setActionError(ticket.service === 'googleBusiness'
          ? 'Google ビジネスの接続を解除できませんでした。もう一度お試しください。'
          : 'Instagram の接続を解除できませんでした。もう一度お試しください。')
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const busyId = busy && removePlan ? removePlan.connection.id : null
  const unitYen = `${formatNumber(SNS_SLOT_UNIT_YEN)}円`

  /** 段の頭：公式ロゴ・題・連携の個数・「接続を追加する」。接続が無いときは題の隣に「未接続」の札。 */
  const cardHead = (service: SnsService, serviceSlots: SnsServiceSlots, badge: { label: string; tone: 'success' | 'neutral' | 'danger' } | null, titleId: string) => {
    const connected = serviceSlots.connections.length > 0
    return (
      <div className={styles.cardHead}>
        <span className={styles.mark}>{service === 'googleBusiness' ? <GoogleMark size={22} /> : <InstagramMark size={22} />}</span>
        <h2 id={titleId} className={styles.cardTitle}>{serviceCardTitle(service)}</h2>
        {!connected && badge ? (
          <StatusBadge tone={badge.tone} size="compact" dot={false}>{badge.label}</StatusBadge>
        ) : null}
        <span className={styles.rowSpacer} />
        {connected ? (
          <>
            <span className={styles.count}>{slotCountText(serviceSlots)}</span>
            <span className={styles.addWide}>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => startAddition(service)}
                disabled={busy}
                lockedReason={additionLockedReason(service)}
              >
                <Plus size={16} aria-hidden />
                接続を追加する
              </Button>
            </span>
          </>
        ) : null}
      </div>
    )
  }

  /** 細い画面の「接続を追加する」。一覧の下に幅いっぱいで置く（F2）。 */
  const addNarrow = (service: SnsService) => (
    <div className={styles.addNarrow}>
      <Button
        variant="secondary"
        fullWidth
        onClick={() => startAddition(service)}
        disabled={busy}
        lockedReason={additionLockedReason(service)}
      >
        <Plus size={16} aria-hidden />
        接続を追加する
      </Button>
    </div>
  )

  const capabilities = (service: SnsService, connected: boolean) => (
    <>
      <p className={styles.listTitle}>{connected ? 'できること' : 'つなぐとできること'}</p>
      <ul className={styles.checks}>
        {CAPABILITIES[service].map((text) => <li key={text}><Check size={16} aria-hidden />{text}</li>)}
      </ul>
    </>
  )

  const googleBadge = visibleGoogleError || !visibleGoogle ? null : GOOGLE_CONNECTION_STATUS[visibleGoogle.connection.status] ?? GOOGLE_CONNECTION_STATUS.disconnected
  const igBadge = igState ? INSTAGRAM_CONNECTION_STATUS[igState] : null

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="settings" boardId="y3GGTs">
      <PageHeading
        headingSize="compact"
        title="SNS 連携"
        help="Googleビジネスや Instagram とつないで、お店の情報をまとめて発信します。"
      />
      <div className={styles.body}>
        {role !== null && !canManage ? (
          <ReadOnlyNotice>閲覧のみの権限です。接続の追加・解除・主連携の変更はオーナーか管理者だけができます。</ReadOnlyNotice>
        ) : null}
        {searchParams.get('source') === 'hours' ? <Notice tone="info">営業時間は Google ビジネスの店舗情報を基準にします。Googleアカウントを接続し、店舗を選んでください。</Notice> : null}
        {flash ? (
          <Notice tone={flash.tone} role="status" onClose={() => router.replace('/settings/sns', { scroll: false })}>
            {flash.text}
          </Notice>
        ) : null}
        {googleFlash && googleStatus !== 'pending_location' ? (
          <Notice tone={googleFlash.tone} role="status" onClose={() => router.replace('/settings/sns', { scroll: false })}>{googleFlash.text}</Notice>
        ) : null}
        {actionError && !removePlan && !addPlan ? <Notice tone="danger">{actionError}</Notice> : null}

        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="sns-google-title">
          {cardHead('googleBusiness', slots.googleBusiness, googleBadge, 'sns-google-title')}
          {!accountId ? (
            <ListState kind="empty" title="LINEアカウントを選んでください" description="画面右上で接続先のLINEアカウントを選んでください。" />
          ) : visibleGoogleError ? (
            <ListState kind="error" error={visibleGoogleError} onRetry={() => void load()} />
          ) : !visibleGoogle ? (
            <ListState kind="loading" />
          ) : googleStatus === 'pending_location' ? (
            /* 店舗（ロケーション）を選ぶ段だけは既存の選択の画面をそのまま出す。 */
            <GoogleConnectionSettings key={accountId} accountId={accountId} data={visibleGoogle} onChanged={() => { void load() }} />
          ) : slots.googleBusiness.connections.length ? (
            <>
              <p className={styles.foot}>{`契約済みの枠数までは、そのまま接続を追加できます。枠を超えて追加する場合は料金の確認があります（1枠 月額${unitYen}・税込、無料期間中は0円）。11個目からは個別見積もりです。`}</p>
              <SnsConnectionList
                slots={slots.googleBusiness}
                canManage={canManageGoogle}
                lockedReason={LOCKED_REASON}
                busyId={busyId}
                onReconnect={() => { void beginConnect('googleBusiness') }}
                onDisconnect={(connection) => askDisconnect('googleBusiness', connection)}
                rowLink={(connection) => connection.state === 'connected' && visibleGoogle.connection.locationName ? { href: '/settings/google-hours', label: '営業時間へ' } : null}
              />
              {addNarrow('googleBusiness')}
              {restaurantStyle ? (
                <>
                  {/* 前からある件数の表と移動。店舗名と取り込んだ日時は行の中に出るので、ここでは繰り返さない。 */}
                  <CustomerInfoRows
                    rows={[
                      { label: '口コミ', value: visibleGoogle.summary.storedCount > 0 ? `${formatNumber(visibleGoogle.summary.storedCount)}件・未返信 ${formatNumber(visibleGoogle.summary.unrepliedCount)}件` : '—' },
                      { label: '投稿', value: visibleGoogle.summary.postsAttentionCount > 0 ? `要対応 ${formatNumber(visibleGoogle.summary.postsAttentionCount)}件` : '—' },
                    ]}
                  />
                  <div className={styles.btnRow}>
                    <Link className={styles.link} href="/restaurant-test/google?tab=reviews">口コミへ<ArrowRight size={16} aria-hidden /></Link>
                    <Link className={styles.link} href="/restaurant-test/google?tab=posts">投稿へ<ArrowRight size={16} aria-hidden /></Link>
                    <Link className={styles.link} href="/restaurant-test/google?tab=profile">プロフィールへ<ArrowRight size={16} aria-hidden /></Link>
                  </div>
                </>
              ) : null}
              <p className={styles.foot}>主連携は、営業時間や店舗情報の正本となる接続です。予約枠や営業中の判定にはこの接続の情報を使います。「主連携にする」でいつでも切り替えられます。</p>
              {capabilities('googleBusiness', true)}
            </>
          ) : (
            <>
              <p className={styles.cardSub}>Google アカウントを接続して、投稿する店舗（ロケーション）を選びます。</p>
              {capabilities('googleBusiness', false)}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  onClick={() => startAddition('googleBusiness')}
                  disabled={busy}
                  busy={Boolean(busy)}
                  busyLabel="処理中…"
                  lockedReason={canManageGoogle ? additionLockedReason('googleBusiness') : LOCKED_REASON}
                >
                  <GoogleMark size={18} />
                  Google アカウントを接続する
                </Button>
              </div>
              <p className={styles.foot}>{`契約済みの枠数までは基本料金内で接続できます。枠を超えて追加する場合は追加連携枠（1枠 月額${unitYen}・税込、無料期間中は0円）を使います。11個目からは個別見積もりです。`}</p>
            </>
          )}
        </Card>

        <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="sns-instagram-title">
          {cardHead('instagram', slots.instagram, igBadge, 'sns-instagram-title')}
          {!accountId ? (
            <ListState kind="empty" title="LINEアカウントを選んでください" description="画面右上で接続先のLINEアカウントを選んでください。" />
          ) : visibleInstagramError ? (
            <ListState kind="error" error={visibleInstagramError} onRetry={() => void load()} />
          ) : !igState ? (
            <ListState kind="loading" />
          ) : slots.instagram.connections.length ? (
            <>
              <SnsConnectionList
                slots={slots.instagram}
                canManage={canManage}
                lockedReason={LOCKED_REASON}
                busyId={busyId}
                onReconnect={() => { void beginConnect('instagram') }}
                onDisconnect={(connection) => askDisconnect('instagram', connection)}
              />
              {addNarrow('instagram')}
              {igState === 'connected' ? (
                /* 前からある［接続を確かめる］。閲覧しかできない人にも消さず、理由を添えて置く（F8）。 */
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    onClick={() => void checkInstagram()}
                    disabled={busy}
                    busy={Boolean(busy)}
                    busyLabel="処理中…"
                    lockedReason={canManage ? undefined : LOCKED_REASON}
                  >
                    <RefreshCw size={16} aria-hidden />
                    接続を確かめる
                  </Button>
                </div>
              ) : null}
              {capabilities('instagram', true)}
              <p className={styles.foot}>Instagram のビジネスアカウント（またはクリエイターアカウント）でログインしてください。個人のアカウントは接続できません。</p>
            </>
          ) : igState === 'unconfigured' ? (
            <>
              {capabilities('instagram', false)}
              <p className={styles.note}>この環境には Instagram 接続の設定がありません。</p>
            </>
          ) : (
            <>
              {capabilities('instagram', false)}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  onClick={() => startAddition('instagram')}
                  disabled={busy}
                  busy={Boolean(busy)}
                  busyLabel="処理中…"
                  lockedReason={additionLockedReason('instagram')}
                >
                  <InstagramMark size={18} />
                  Instagram アカウントを接続する
                </Button>
              </div>
              <p className={styles.foot}>Instagram のビジネスアカウント（またはクリエイターアカウント）でログインしてください。個人のアカウントは接続できません。</p>
            </>
          )}
        </Card>

      </div>

      {addPlan?.kind === 'over-quota' ? (
        <SnsSlotAdditionDialog
          plan={addPlan}
          accountName={accountName}
          busy={busy}
          error={actionError || undefined}
          onCancel={() => { setAddPlan(null); setActionError('') }}
          onConfirm={() => { void beginConnect(addPlan.service) }}
        />
      ) : null}

      {addPlan?.kind === 'individual-quote' ? (
        <SnsSlotQuoteDialog
          plan={addPlan}
          slots={slots}
          onCancel={() => setAddPlan(null)}
          onContact={() => { setAddPlan(null); router.push('/support') }}
        />
      ) : null}

      {removePlan && renderedDisconnectTicket && accountId !== null && confirmAccountId === accountId && confirmScope.current === accountScope.current ? (
        <SnsSlotRemovalDialog
          plan={removePlan}
          accountName={accountName}
          nextBillingLabel={null}
          busy={busy}
          error={actionError || undefined}
          onCancel={() => { disconnectTicket.current = null; setRemovePlan(null); setActionError('') }}
          onConfirm={() => { void runDisconnect() }}
        />
      ) : null}
    </PageFrame></SaveErrorScope>
  )
}
