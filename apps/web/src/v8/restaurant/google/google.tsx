'use client'
import type { GoogleNav } from './navigation-types'
export type { GoogleNav } from './navigation-types'

import { useGooglePermission } from './use-google-permission'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { emitGuideSignal } from '@/v8/onboarding/public/guide-signal/index'
import { useAccount } from '@/contexts/account-context'
import { ApiError } from '@/lib/api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import ListState from '@/components/shared/list-state'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

import { Tabs } from '@/components/shared/tabs'
import { restaurantGoogleApi, type GoogleConnectionData, type GooglePostKind } from '@/lib/restaurant-google-api'
import { BoundaryBanner, RestaurantPage } from '@/v8/restaurant/common-a/public/frame/index'
import { errorMessage } from './format'
import { ReviewDraft, ReviewsBoard } from './reviews'
import { PostEditor, PostConfirm, PostsBoard, type MediaUploadHelpers } from './posts'
import PerformanceBoard from './performance'
import ProfileBoard from './profile'
import { ChangeConfirmScreen } from './profile-confirm'
import { HistoryScreen } from './profile-history'
import { ProfileEditScreen } from './profile-edit'
import HoursPage from './hours'
import GoogleConnectionSettings from './settings'
import styles from './google.module.css'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 Googleビジネス（Pencil：口コミ ・返信を作る ・投稿 ・投稿を作る ・
 * パフォーマンス ・プロフィール ）。
 *
 * 板の頭（題・説明）→ 検証環境の帯 → タブ（口コミ・投稿・パフォーマンス・プロフィール）
 * → タブの中身。受け付ける URL は今の画面と同じ（?tab=・?view=・?id=・?kind=・?google=）。
 * 営業時間・確認・履歴・編集も共通の V8 部品で出す。動きは BEHAVIOR.md。
 */

export type { MediaUploadHelpers } from './posts'

export const TAB_LABELS = { reviews: '口コミ', posts: '投稿', hours: '営業時間', performance: 'パフォーマンス', profile: 'プロフィール' } as const
export type GoogleTab = keyof typeof TAB_LABELS

/** 口コミの一覧の帯だけ、返信が実際に Google に届くことを知らせる。 */
/**
 * 板の頭の「？」に入れる説明。画面の中（タブの下・表の下）に説明の行や注記の箱は置かない。
 * 口コミだけは「Googleへ送ると『反映確認中』になる」までを書く。
 */
const HELP_BASE = 'Google の口コミ・投稿・営業時間を、店舗ごとに管理します。'
const TAB_HELP: Record<GoogleTab, string> = {
  reviews: `${HELP_BASE}返信文は手で書くか、AIで下書きを作れます。Googleへ送ると「反映確認中」になり、反映されると「返信済み」になります。`,
  posts: `${HELP_BASE}投稿は Google に出す最新情報・イベント・特典・お知らせです。行の「…」から、中身を見る・Google から削除・Instagram へもう一度送るができます。削除は元に戻せません（確認の窓が出ます）。Instagram が失敗した投稿は再送でき、Google への公開はそのまま残ります。時刻はすべて日本時間（Asia/Tokyo）です。`,
  performance: `${HELP_BASE}Google の検索・地図でどれだけ見られたかを出します。数字は Google ビジネス プロフィールの集計です（前日までの分。2〜3日遅れることがあります）。`,
  profile: HELP_BASE,
  hours: HELP_BASE,
}

const REVIEWS_BANNER_NOTE = 'Google への返信は、つないだ設定で実際に Google に届きます。送れない設定のときは送信ボタンを出しません'

function GoogleInner({ mediaUpload }: { mediaUpload?: MediaUploadHelpers }) {
  const saveErrors = useSaveFormErrors()
  const { allowed: canEdit, known } = useGooglePermission()
  usePageTitle('Googleビジネス')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const samePageUrl = useSamePageUrl()
  const searchParams = useSearchParams()
  const guide = useSharedGuide()?.guide
  const guidingHours = guide?.phase === 'active' && guide.stepKey === 'hours'
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectFailure, setConnectFailure] = useState('')
  const { selectedAccountId, setSelectedAccountId, accounts, loading: accountLoading } = useAccount()
  const returnedAccount = searchParams.get('account_id')
  const switchingToReturnedAccount = Boolean(searchParams.get('tab') === 'hours' && searchParams.has('google') &&
    returnedAccount && returnedAccount !== selectedAccountId && accounts.some(account => account.id === returnedAccount))
  useEffect(() => {
    if (switchingToReturnedAccount && returnedAccount) setSelectedAccountId(returnedAccount)
  }, [switchingToReturnedAccount, returnedAccount, setSelectedAccountId])
  const [data, setData] = useState<GoogleConnectionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current
    if (!selectedAccountId || switchingToReturnedAccount) { setData(null); setLoading(switchingToReturnedAccount); return }
    setLoading(true)
    setError('')
    try {
      const connection = await restaurantGoogleApi.connection(selectedAccountId)
      if (currentRequest === requestId.current) setData(connection)
    } catch (err) {
      if (currentRequest !== requestId.current) return
      const fieldFailure = saveErrors.capture(err)
      setData(null)
      { if (!fieldFailure)

      setError(err instanceof ApiError && err.status === 404
        ? 'このLINEアカウントには店舗が紐付いていません。先に店舗管理でLINEアカウントを割り当ててください。'
        : errorMessage(err, 'Googleビジネスの状態を読み込めませんでした。'))
    }
    } finally {
      if (currentRequest === requestId.current) setLoading(false)
    }
  }, [selectedAccountId, saveErrors, switchingToReturnedAccount])

  useEffect(() => { void load(); return () => { requestId.current++ } }, [load])

  // 旧ブックマークと旧OAuth戻り先は、接続操作のあるSNS連携へ案内する。
  useEffect(() => {
    if (searchParams.get('tab') !== 'settings' && (!searchParams.has('google') || searchParams.get('tab') === 'hours')) return
    const next = new URLSearchParams()
    for (const key of ['google', 'account_id']) {
      const value = searchParams.get(key)
      if (value) next.set(key, value)
    }
    samePageUrl.replace(`/settings/sns${next.toString() ? `?${next.toString()}` : ''}`)
  }, [samePageUrl, searchParams])

  const go = useCallback<GoogleNav>((params) => {
    const next = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value) next.set(key, value)
    samePageUrl.push(`/restaurant-test/google${next.toString() ? `?${next.toString()}` : ''}`)
  }, [samePageUrl])

  const connected = data?.connection.status === 'connected' || data?.connection.status === 'expired' || data?.connection.status === 'no_permission'
  const requestedTab = searchParams.get('tab') as GoogleTab | null
  const tab: GoogleTab = requestedTab === 'profile' && searchParams.get('view') === 'hours' ? 'hours' : requestedTab && requestedTab in TAB_LABELS ? requestedTab : 'reviews'
  const hoursConnected = data?.connection.status === 'connected' && Boolean(data.connection.locationName)
  useEffect(() => {
    if (!guidingHours && tab === 'hours' && selectedAccountId && !accountLoading && !loading && !error && data && !hoursConnected)
      samePageUrl.replace('/settings/sns?source=hours')
  }, [guidingHours, tab, selectedAccountId, accountLoading, loading, error, data, hoursConnected, samePageUrl])
  useEffect(() => {
    if (!guidingHours || tab !== 'hours' || !hoursConnected || loading || data?.store.lineAccountId !== selectedAccountId) return
    const frame = requestAnimationFrame(() => emitGuideSignal('hours.googleConnect'))
    return () => cancelAnimationFrame(frame)
  }, [guidingHours, guide?.procedureIndex, tab, hoursConnected, loading, data, selectedAccountId])
  const { allowed: canManage } = useGooglePermission('manager')
  const connect = async (accountId: string) => {
    if (connectBusy || !canManage || !data?.permissions.canManageConnection) return
    setConnectBusy(true)
    setConnectFailure('')
    try {
      const response = await restaurantGoogleApi.connectStart(accountId, 'hours')
      window.location.assign(response.authorizeUrl)
    } catch (cause) {
      if (!saveErrors.capture(cause)) {
        setConnectFailure(errorMessage(cause, 'Googleの許可画面を開けませんでした。もう一度お試しください。'))
      }
      setConnectBusy(false)
    }
  }
  const view = searchParams.get('view')
  const id = searchParams.get('id')
  const kindParam = searchParams.get('kind')
  const postKind: GooglePostKind = kindParam === 'event' ? 'event' : kindParam === 'offer' ? 'offer' : 'standard'
  const draftOpen = tab === 'reviews' && view === 'draft' && Boolean(id)
  const postsView = tab === 'posts' ? (view === 'new' || view === 'edit' || view === 'confirm' ? view : 'list') : null

  /* 子板の印（撮影と見張りの試験が読む）。 */
  const boardId = draftOpen ? 'x9HIR'
    : tab === 'posts' ? (postsView === 'list' ? 'Cfed0' : 'T1j2Sw')
      : tab === 'hours' ? 'tYbl8'
      : tab === 'performance' ? 'SrmVs'
        : tab === 'profile' ? 'JUTGz'
          : 'j0Wcg'

  const googleTabs = <Tabs
          actions={tab === 'hours' && data?.connection.locationMapsUrl ? <Button variant="text" size="compact" href={data.connection.locationMapsUrl} external>Google マップで見る</Button> : undefined}
          size="compact"
          spacing={boardId === 'j0Wcg' ? 'compact' : undefined}
          label="Googleビジネスの機能"
          items={(Object.keys(TAB_LABELS) as GoogleTab[]).map((key) => {
            const count = !connected ? 0 : key === 'reviews' ? data!.summary.storedCount : key === 'posts' ? data!.summary.postsAttentionCount : 0
            return {
              label: count ? `${TAB_LABELS[key]} ${count}` : TAB_LABELS[key],
              current: tab === key,
              onClick: () => requestUnsavedAction(() => samePageUrl.replace(`/restaurant-test/google?tab=${key}`)),
            }
          })}
        />

  const body = (() => {
    if (accountLoading || loading) return <div className={styles.stateBox}><ListState kind="loading" title="Googleビジネスを読み込んでいます" /></div>
    if (!selectedAccountId) {
      return <div className={styles.stateBox}><ListState kind="empty" title="LINE公式アカウントを選んでください" description={accounts.length ? '上のバーで店舗のLINEアカウントを選ぶと表示します。' : '先にLINE公式アカウントを登録してください。'} /></div>
    }
    if (error || !data) return <ListState kind="error" title="Googleビジネスを表示できませんでした" description={error} onRetry={() => void load()} />
    const accountId = selectedAccountId
    if (guidingHours && tab === 'hours' && data.connection.status === 'pending_location') return <>
      <Card className={styles.guideConnection} layout="vertical" gap="normal" padding="spacious">
        <GoogleConnectionSettings key={accountId} accountId={accountId} data={data} onChanged={() => void load()} connectSource="hours" />
      </Card>
    </>
    if (guidingHours && tab === 'hours' && !hoursConnected) return <>
      <Card className={styles.guideConnection} layout="vertical" gap="normal" padding="spacious">
        <CardHeader size="stacked" title="Googleビジネスプロフィールとつなぐ" />
        <p className={styles.guideText}>お店のGoogleアカウントとつなぐと、営業時間がここに取り込まれ、予約枠の計算に使われます。口コミの確認・返信もできるようになります。</p>
        {connectFailure || searchParams.get('google')?.startsWith('error:') ? <Notice tone="danger">{connectFailure || 'Googleに接続できませんでした。もう一度お試しください。'}</Notice> : null}
        {canManage && data.permissions.canManageConnection && data.oauthConfigured
          ? <div><Button data-guide-anchor="hours.googleConnect" variant="primary" onClick={() => void connect(accountId)} busy={connectBusy} busyLabel="Google に移動しています…" disabled={connectBusy}>Googleアカウントとつなぐ</Button></div>
          : <Notice tone="warn">{canManage && data.permissions.canManageConnection ? 'Google接続の設定を管理者にご確認ください。' : '管理者にGoogleビジネスの接続を依頼してください。'}</Notice>}
      </Card>
    </>
    if (!connected) return <ListState kind="empty" title="Googleビジネスは未接続です" description="設定のSNS連携からGoogleアカウントを接続してください。" action={<Link href="/settings/sns">SNS連携を開く</Link>} />
    return (
      <>
        {draftOpen && id ? (
          <ReviewDraft key={id} accountId={accountId} reviewId={id} data={data} go={go} onPublished={() => { void load() }} />
        ) : postsView === 'new' || postsView === 'edit' ? (
          <PostEditor key={`${postsView}-${id ?? ''}-${postKind}`} accountId={accountId} kind={postKind} postId={postsView === 'edit' ? id : null} go={go} mediaUpload={mediaUpload} adjustTarget={searchParams.get('adjust') === 'google' || searchParams.get('adjust') === 'instagram' ? searchParams.get('adjust') as 'google' | 'instagram' : undefined} />
        ) : postsView === 'confirm' && id ? (
          <PostConfirm key={id} accountId={accountId} id={id} go={go} />
        ) : postsView ? (
          <PostsBoard accountId={accountId} go={go} store={data.store.lineAccountId === accountId ? data.store : undefined} googleLocation={data.store.lineAccountId === accountId ? data.connection.locationTitle : undefined} connection={data.store.lineAccountId === accountId ? data.connection : undefined} onConnectionReloaded={latest => setData(previous => previous?.store.lineAccountId === accountId ? latest : previous)} />
        ) : tab === 'performance' ? (
          <PerformanceBoard accountId={accountId} />
        ) : tab === 'profile' && view === 'confirm' && id ? (
          <ChangeConfirmScreen key={`${accountId}-${id}`} accountId={accountId} ids={id.split(',').filter(Boolean)} go={go} />
        ) : tab === 'profile' && view === 'history' ? (
          <HistoryScreen key={`${accountId}-${searchParams.get('result') ?? ''}`} accountId={accountId} initialResult={(['all', 'applied', 'pending', 'failed'] as const).find((value) => value === searchParams.get('result'))} go={go} />
        ) : tab === 'profile' && view === 'edit' ? (
          <ProfileEditScreen key={accountId} accountId={accountId} go={go} />
        ) : tab === 'profile' ? (
          <ProfileBoard accountId={accountId} go={go} />
        ) : (
          <ReviewsBoard accountId={accountId} data={data} go={go} onSynced={() => { void load() }} />
        )}
      </>
    )
  })()


  return (
    <SaveErrorScope errors={saveErrors}><div data-google-hours-page={tab === 'hours' ? '' : undefined}><RestaurantPage
      boardId={boardId}
      title="Googleビジネス"
      description={draftOpen ? HELP_BASE : TAB_HELP[tab]}
    >
      <div className={styles.noticeStack} data-google-notices>
        {tab !== 'hours' && !accountLoading && !loading && !error && Boolean(data) && known && !(tab === 'profile' ? canManage : canEdit)
          ? <ReadOnlyNotice need={tab === 'profile' ? 'manager' : 'feature'} /> : null}
        <BoundaryBanner note={boardId === 'j0Wcg' ? REVIEWS_BANNER_NOTE : undefined} noteAlways={boardId === 'j0Wcg'} />
      </div>
      {googleTabs}
      {tab === 'hours' && hoursConnected && selectedAccountId && !loading && !accountLoading && !error
        ? <HoursPage key={selectedAccountId} accountId={selectedAccountId} tabs={null} embedded initialMode={searchParams.get('mode')} initialDate={searchParams.get('date')} />
        : body}
    </RestaurantPage></div></SaveErrorScope>
  )
}

export default function GoogleV8({ mediaUpload }: { mediaUpload?: MediaUploadHelpers }) {
  return (
    <Suspense fallback={<RestaurantPage boardId="j0Wcg" title="Googleビジネス" description={HELP_BASE}>
      <BoundaryBanner note={REVIEWS_BANNER_NOTE} noteAlways />
      <Tabs size="compact" spacing="compact" label="Googleビジネスの機能" items={(Object.keys(TAB_LABELS) as GoogleTab[]).map(key => ({ label: TAB_LABELS[key], current: key === 'reviews', onClick: () => {} }))} />
      <ListState kind="loading" title="Googleビジネスを読み込んでいます" />
    </RestaurantPage>}>
      <GoogleInner mediaUpload={mediaUpload} />
    </Suspense>
  )
}
