'use client'

import OperationTargetSummary from '@/components/shared/operation-target-summary'


import Toggle from '@/components/shared/toggle';
import { FolderDotName } from '@/components/shared/folder-dot'
import { notifySaved } from '@/components/shared/toast'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Link2, MessageCircle, Plus } from 'lucide-react'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { PageFooter } from '@/components/templates/page-footer'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SectionHeader from '@/components/shared/section-header'
import Select from '@/components/shared/select'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import Checkbox from '@/components/shared/checkbox'
import Radio from '@/components/shared/radio'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { RowActions } from '@/components/shared/row-actions'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { ApiError, describeSaveFailure, fetchApi } from '@/lib/api'
import { restaurantTestApi, type RestaurantMembership } from '@/lib/restaurant-test-api'
import type { RestaurantCloseNotificationSettings } from '@line-crm/shared'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import styles from './screen.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import TextLink from '@/components/shared/text-link'
import { EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { formatNumber } from '@/lib/format'
import { useBookingMediaStoreSelection } from './use-store-selection'

/*
 * ★V8 予約サイト・グルメ媒体（提案 E-4 `aSmph`。設定の中の1画面）。
 *
 * 店ごと×媒体ごとに「店舗ページの URL」「管理画面（ログイン）の URL」（https だけ）を持ち、
 * 他のサイトの枠を閉じる知らせを出す媒体（closeOnBooking）を選ぶ。予約を受けないグルメ媒体も足せる。
 * LINE 予約を他のサイトに貼る URL と貼り付け用のコードは、口が `available:false` を返すあいだ
 * 「まだ使えません」の案内だけを出し、コピーしない（決まりで「準備中」とは書かない）。
 * 保存した URL は「今日のお店」の右の列と「枠を閉じる知らせ」の［管理画面を開く ↗］に使われる。
 * 動きは BEHAVIOR.md。
 */

export type MediaRow = {
  code: string
  name: string
  acceptsReservations: boolean
  pageUrl: string | null
  loginUrl: string | null
  closeOnBooking: boolean
  version: number
}

type ChannelState = { code: string; status?: string; daysWithoutReceipt?: number | null; receiveMethod?: string }

/** https だけ。ID・パスワード入りの URL は断る（口と同じ条件）。空は「消す」。 */
export function checkHttpsUrl(value: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const text = value.trim()
  if (!text) return { ok: true, value: null }
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return { ok: false, message: 'https:// で始まる URL を入れてください' }
    if (url.username || url.password) return { ok: false, message: 'ID やパスワードの入った URL は保存できません' }
    return { ok: true, value: url.href }
  } catch {
    return { ok: false, message: 'URL の形を確かめてください（https:// から）' }
  }
}

/** 表に出す URL（https:// と末尾を省き、↗ を付ける）。 */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '')
}

/** 予約メールの取り込みの札。グルメ媒体（予約を受けない）は「取り込まない」。 */
export function importBadge(row: Pick<MediaRow, 'acceptsReservations' | 'code'>, channel: ChannelState | undefined): { label: string; tone: StatusBadgeTone } {
  if (!row.acceptsReservations) return { label: '取り込まない', tone: 'neutral' }
  /* Google の予約はメールではなく Google ビジネスの連携で入る。 */
  if (row.code === 'google') return { label: 'Google ビジネスと連携', tone: 'info' }
  if (!channel) return { label: '未設定', tone: 'neutral' }
  if (channel.status === 'receiving') return { label: '取り込み中', tone: 'success' }
  if (channel.status === 'not_receiving') return { label: `${channel.daysWithoutReceipt ?? 0}日届いていません`, tone: 'warning' }
  return { label: '未設定', tone: 'neutral' }
}

/** グルメ媒体のコード（gourmet_ で始まる英小文字・数字）。名前からは作れないので時刻から作る。 */
export function gourmetCode(now = Date.now()): string {
  return `gourmet_${now.toString(36)}`
}

type NoticeSettings = Pick<RestaurantCloseNotificationSettings, 'notifyReopen' | 'recipientMode' | 'membershipIds' | 'version'>

/** 知らせる相手の見え方。選んだスタッフは名前を「・」でつなぎ人数を添える。 */
export function recipientText(settings: Pick<NoticeSettings, 'recipientMode' | 'membershipIds'>, members: Array<Pick<RestaurantMembership, 'id' | 'staff_name'>>): string {
  if (settings.recipientMode === 'manager') return '店長'
  if (settings.recipientMode === 'selected') {
    const names = settings.membershipIds.map((id) => members.find((m) => m.id === id)?.staff_name).filter((name): name is string => !!name)
    return names.length > 0 ? `${names.join('・')}（${formatNumber(names.length)} 人）` : `選んだスタッフ（${formatNumber(settings.membershipIds.length)} 人）`
  }
  return '当日の責任者（いなければ店長）'
}

function sameNotice(a: NoticeSettings, b: NoticeSettings): boolean {
  return a.notifyReopen === b.notifyReopen && a.recipientMode === b.recipientMode && a.membershipIds.join(',') === b.membershipIds.join(',')
}

function sameRow(a: MediaRow, b: MediaRow): boolean {
  return a.pageUrl === b.pageUrl && a.loginUrl === b.loginUrl && a.closeOnBooking === b.closeOnBooking
}

/**
 * WEB005：読み直した行に、まだ保存していない入力を重ねる。入力中の行は
 * 自分の入力と（読み込んだときの）版を残し、ほかの行はサーバーの値にする。
 */
export function mergeReloadedRows(server: MediaRow[], current: MediaRow[], saved: MediaRow[] | null): MediaRow[] {
  return server.map((row) => {
    const mine = current.find((item) => item.code === row.code)
    const before = saved?.find((item) => item.code === row.code)
    return mine && before && !sameRow(before, mine) ? mine : row
  })
}

/** WEB004：1行の保存が通ったら、その行の版だけ進める（入力は残す）。 */
export function withSavedVersion(list: MediaRow[], code: string, version: number): MediaRow[] {
  return list.map((item) => (item.code === code ? { ...item, version } : item))
}

function UrlCell({ url }: { url: string | null }) {
  if (!url) return <EmptyCell />
  return (
    <TextLink external truncate className={styles.url} href={url} title={url}>
      {`${shortUrl(url)}`}
    </TextLink>
  )
}

function isStoreMismatch(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 400 || error.status === 404) && error.code === 'restaurant_store_mismatch'
}

export default function BookingMediaPage() {
  const { selectedAccountId } = useAccount()
  const storeSelection = useBookingMediaStoreSelection(selectedAccountId)
  return <BookingMediaBody key={JSON.stringify([selectedAccountId, storeSelection.id])} storeSelection={storeSelection} />
}

function BookingMediaBody({ storeSelection }: { storeSelection: ReturnType<typeof useBookingMediaStoreSelection> }) {
  const saveErrors = useSaveFormErrors()
  usePageTitle('予約サイト・グルメ媒体')
  usePageCrumbs([{ label: '設定', href: '/settings' }])
  /* 絵（aSmph）には設定の中のメニューが無い。この画面だけ出さない（SNS 連携と同じ）。 */
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const canManage = canManageRole(role)

  const { stores, storeId } = storeSelection
  const setStoreId = storeSelection.choose
  const mounted = useRef(true)
  const loadedMedia = useRef(false)
  const loadedNotice = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [saved, setSaved] = useState<MediaRow[] | null>(null)
  const savedRef = useRef<MediaRow[] | null>(null)
  savedRef.current = saved
  /* WEB005：保存していない変更があるまま店舗を変えるときは確かめる。 */
  const [pendingStoreId, setPendingStoreId] = useState<string | null>(null)
  const [rows, setRows] = useState<MediaRow[]>([])
  const [channels, setChannels] = useState<ChannelState[]>([])
  const [loadError, setLoadError] = useState<unknown>(null)
  const [link, setLink] = useState<{ url: string; html: string; available: boolean } | null>(null)
  const [linkError, setLinkError] = useState('')
  const [linkSetupRequired, setLinkSetupRequired] = useState(false)
  const [linkAsked, setLinkAsked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [editing, setEditing] = useState<MediaRow | null>(null)
  const [editPage, setEditPage] = useState('')
  const [editLogin, setEditLogin] = useState('')
  const [editErrors, setEditErrors] = useState<{ page?: string; login?: string }>({})
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addError, setAddError] = useState('')
  const [addNameError, setAddNameError] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  /* キャンセルで席が空いたときの「もう開けてよい」と、知らせる相手（店ごと）。 */
  const [noticeSaved, setNoticeSaved] = useState<NoticeSettings | null>(null)
  const [notice, setNotice] = useState<NoticeSettings | null>(null)
  const [membersError,setMembersError]=useState(false)
  const [membersRetry,setMembersRetry]=useState(0)
  const [members, setMembers] = useState<RestaurantMembership[]>([])
  const [picking, setPicking] = useState<Pick<NoticeSettings, 'recipientMode' | 'membershipIds'> | null>(null)
  const [pickError, setPickError] = useState('')

  /*
   * WEB005：読み直し（媒体を足したあとなど）は、まだ保存していない行の入力を消さない。
   * 入力中の行は自分の入力と版を残し、ほかの行だけサーバーの値にする。
   */
  const load = useCallback(async (options?: { keepEdits?: boolean }) => {
    if (!selectedAccountId || !storeId) return
    try {
      const [links, channelRows] = await Promise.all([
        restaurantTestApi.mediaLinks(selectedAccountId, storeId),
        fetchApi<{ success: true; data: ChannelState[] }>(`/api/restaurant-test/channels?account_id=${encodeURIComponent(selectedAccountId)}&storeId=${encodeURIComponent(storeId)}`)
          .then((res) => res.data),
      ])
      if (!mounted.current) return
      const next = links.data.map((row) => ({
        code: row.code,
        name: row.name,
        acceptsReservations: !!row.acceptsReservations,
        pageUrl: row.pageUrl,
        loginUrl: row.loginUrl,
        closeOnBooking: !!row.closeOnBooking,
        version: row.version,
      }))
      if (options?.keepEdits) {
        setRows((current) => mergeReloadedRows(next, current, savedRef.current))
      } else {
        setRows(next)
      }
      loadedMedia.current = true
      setSaved(next); setChannels(channelRows); setLoadError(null); setConflict(false)
    } catch (caught) {
      if (!mounted.current) return
      if (isStoreMismatch(caught)) await storeSelection.recheckContext()
      if (!mounted.current) return
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setLoadError(caught) }
    }
  }, [selectedAccountId, storeId, saveErrors, storeSelection.recheckContext])
  useEffect(() => { if (!loadedMedia.current) void load() }, [load]);


  const loadNotice = useCallback(async () => {
    if (!selectedAccountId || !storeId) return
    try {
      const res = await restaurantTestApi.closeNotificationSettings(selectedAccountId, storeId)
      if (!mounted.current) return
      loadedNotice.current = true
      const next = { notifyReopen: res.data.notifyReopen, recipientMode: res.data.recipientMode, membershipIds: res.data.membershipIds, version: res.data.version }
      setNoticeSaved(next); setNotice(next)
    } catch (saveFailure) {
      if (!mounted.current) return
      if (isStoreMismatch(saveFailure)) { await storeSelection.recheckContext(); return }
      const fieldFailure = saveErrors.capture(saveFailure)
      setNoticeSaved(null); { if (!fieldFailure) setNotice(null) }
    }
  }, [selectedAccountId, storeId, saveErrors, storeSelection.recheckContext])
  useEffect(() => { if (!loadedNotice.current) void loadNotice() }, [loadNotice])

  /* 選べるスタッフ：この店の担当（店を決めていない人を含む）で、有効な人。 */
  useEffect(() => {
    let current = true
    if (!selectedAccountId || !storeId) return
    void restaurantTestApi.snapshot(selectedAccountId, { limit: 1, offset: 0 })
      .then((res) => { if (current) {setMembersError(false);setMembers(res.data.memberships.filter((m) => m.status === 'active' && (m.store_id === null || m.store_id === storeId)));} })
      .catch(() => { if (current) setMembersError(true) })
    return () => { current = false }
  }, [selectedAccountId, storeId,membersRetry])

  /* 貼り付け用の URL は管理者だけが出せる口（POST）。担当者には案内だけ。 */
  useEffect(() => {
    let current = true
    if (!selectedAccountId || !storeId || role === null || !canManageRole(role)) return
    void restaurantTestApi.reservationLink(selectedAccountId, storeId)
      .then((res) => { if (current) { setLink(res.data); setLinkError(''); setLinkSetupRequired(false) } })
      .catch((caught) => {
        if (!current) return
        setLink(null)
        setLinkSetupRequired(caught instanceof ApiError && caught.status === 503)
        setLinkError(caught instanceof ApiError && caught.status === 503 ? 'お客さま向けの予約ページの設定がまだ無いため、URL を出せません。' : '予約ページの URL を読み込めませんでした。')
      })
    return () => { current = false }
  }, [selectedAccountId, storeId, role])

  const dirty = useMemo(() => {
    if (!saved) return [] as MediaRow[]
    return rows.filter((row) => {
      const before = saved.find((s) => s.code === row.code)
      return !before || !sameRow(before, row)
    })
  }, [rows, saved])

  const noticeDirty = !!notice && !!noticeSaved && !sameNotice(notice, noticeSaved)
  const changes = dirty.length + (noticeDirty ? 1 : 0)

  /* 保存していない変更があるまま離れるときは確かめる。 */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: changes > 0, busy: saving })

  const bookable = rows.filter((row) => row.acceptsReservations)
  const closeOn = bookable.some((row) => row.closeOnBooking)
  const setRow = (code: string, patch: Partial<MediaRow>) => setRows((list) => list.map((row) => (row.code === code ? { ...row, ...patch } : row)))
  const setAllClose = (on: boolean) => setRows((list) => list.map((row) => (row.acceptsReservations ? { ...row, closeOnBooking: on } : row)))

  const openEdit = (row: MediaRow) => {
    setEditing(row); setEditPage(row.pageUrl ?? ''); setEditLogin(row.loginUrl ?? ''); setEditErrors({})
  }
  const applyEdit = () => {
    if (!editing) return
    const page = checkHttpsUrl(editPage)
    const login = checkHttpsUrl(editLogin)
    const errors = { page: !page.ok ? page.message : undefined, login: !login.ok ? login.message : undefined }
    setEditErrors(errors)
    if (!page.ok || !login.ok) {
      const field = document.getElementById(!page.ok ? 'media-page-url' : 'media-login-url')
      field?.focus(); field?.scrollIntoView({ block: 'center' })
      return
    }
    setRow(editing.code, { pageUrl: page.value, loginUrl: login.value })
    setEditing(null)
  }

  const addMedium = async () => {
    const name = addName.trim()
    if (!name) {
      setAddNameError('媒体の名前を入れてください')
      const field = document.getElementById('media-name')
      field?.focus(); field?.scrollIntoView({ block: 'center' })
      return
    }
    setAddNameError('')
    if (!selectedAccountId) return
    setAddBusy(true); setAddError('')
    try {
      await restaurantTestApi.addGourmetMedia(selectedAccountId, { code: gourmetCode(), name })
      setAdding(false); setAddName('')
      notifyToast(`グルメ媒体「${name}」を足しました。URL は行の「…」から入れます`)
      await load({ keepEdits: true })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setAddError(caught instanceof ApiError && caught.status === 409 ? '同じ媒体が登録済みです' : '媒体を足せませんでした。もう一度お試しください') }
    } finally {
      setAddBusy(false)
    }
  }

  const save = async () => {
    if (!selectedAccountId || !storeId || changes === 0) return
    setSaving(true); setSaveError('')
    try {
      for (const row of dirty) {
        const res = await restaurantTestApi.saveMediaLink(selectedAccountId, row.code, {
          storeId, pageUrl: row.pageUrl, loginUrl: row.loginUrl, closeOnBooking: row.acceptsReservations && row.closeOnBooking, expectedVersion: row.version,
        })
        if (!mounted.current) return
        /*
         * WEB004：1行ずつ保存できた分は、その場で新しい版と保存済みの値にする。
         * 途中の行で失敗してやり直したとき、保存できた行を古い版で送り直して 409 にしない。
         * 入力（rows）は消さず、版だけ進める。
         */
        const version = res.data?.version
        if (typeof version === 'number') {
          const savedRow = { ...row, version }
          setRows((list) => withSavedVersion(list, row.code, version))
          setSaved((list) => list ? list.map((item) => (item.code === row.code ? savedRow : item)) : list)
        }
      }
      if (notice && noticeDirty) {
        const res = await restaurantTestApi.saveCloseNotificationSettings(selectedAccountId, {
          storeId, notifyReopen: notice.notifyReopen, recipientMode: notice.recipientMode,
          membershipIds: notice.recipientMode === 'selected' ? notice.membershipIds : [], expectedVersion: notice.version,
        })
        if (!mounted.current) return
        const version = (res as { data?: { version?: number } } | undefined)?.data?.version
        if (typeof version === 'number') {
          const next = { ...notice, version }
          setNotice(next); setNoticeSaved(next)
        }
      }
      notifySaved('予約サイト・グルメ媒体の設定を保存しました')
      await Promise.all([load(), loadNotice()])
    } catch (caught) {
      if (!mounted.current) return
      if (isStoreMismatch(caught)) {
        await storeSelection.recheckContext()
        if (mounted.current) setSaveError('別の画面で表示中の店舗が変わった可能性があります。入力は残しています。店舗を確認してから、もう一度保存してください。')
        return
      }
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) setConflict(true)
      else { if (!fieldFailure) setSaveError(caught instanceof ApiError && caught.status === 400 ? 'URL は https:// で始まるものだけ保存できます。行の「…」から直してください。' : withPermissionFailure(caught, describeSaveFailure(caught), 'store')) }
      /* 途中まで保存できた行があるので、版を読み直す（入力は残す）。 */
    } finally {
      setSaving(false)
    }
  }

  const askLink = () => setLinkAsked(true)


  const navigationLeaveDialog = (<UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="予約サイト・グルメ媒体の変更"
        busy={saving}
        onCancel={() => { if (!saving) cancelLeave() }}
        onConfirm={() => { confirmLeave() }}
      />)
  const storeLeaveDialog = (<UnsavedLeaveDialog
        open={pendingStoreId !== null}
        subject="予約サイト・グルメ媒体の変更"
        description="店舗を切り替えると、保存していない変更が消えます。"
        busy={saving}
        onCancel={() => setPendingStoreId(null)}
        onConfirm={() => { if (pendingStoreId) setStoreId(pendingStoreId); setPendingStoreId(null) }}
      />)
  const storePicker = stores.length > 1 || (!storeSelection.id && stores.length > 0) ? (
    <EntitySelect aria-label="店舗" noun="店舗" placeholder="店舗を選んでください" valuePrefix="店舗：" value={storeSelection.id} disabled={storeSelection.switching} onChange={(value) => { if (value === storeSelection.id) return; if (changes > 0) setPendingStoreId(value); else setStoreId(value) }} options={[...stores.map(store => ({ ...entityOptionMetadata(store), value: store.id, label: store.name, hint: `${store.status === 'paused' ? '一時停止' : '現役'} · ID: ${store.id}` }))]} />
  ) : null
  if (!storeId) {
    const desired = stores.find(store => store.id === storeSelection.id)
    return <><PageFrame kind="settings" boardId="aSmph"><PageHeading headingSize="compact" title="予約サイト・グルメ媒体" actions={storePicker} />
      {storeSelection.status === 'loading' ? <ListState kind="loading" title="店舗を確認しています" />
        : storeSelection.status === 'error' ? <ListState kind="error" title="店舗を読み込めませんでした" error={storeSelection.error} onRetry={storeSelection.refresh} />
        : <>
          {storeSelection.error ? <ListState kind="error" title="表示店舗を確認できませんでした" error={storeSelection.error} onRetry={() => void storeSelection.recheckContext()} /> : null}
          {desired && storeSelection.requiresSwitch ? <Notice tone="warn" action={<Button onClick={() => void storeSelection.switchContext()} busy={storeSelection.switching}>この店舗に切り替えて表示する</Button>}>
            {storeSelection.changedElsewhere ? '別の画面で表示中の店舗が変わりました。' : 'ログイン中の表示店舗と、このアカウントの店舗が違います。'}「{desired.name}」を表示すると、管理画面全体の表示店舗も切り替わります。保存していない入力は残しています。
          </Notice> : !desired ? <ListState kind="empty" title={stores.length ? '店舗を選んでください' : 'このアカウントに関連する店舗がありません'} description={stores.length ? '保管済みを除いた、このアカウントの店舗から選べます。' : '店舗の設定で、現在のLINE公式アカウントとの関連付けを確認してください。'} /> : null}
        </>}
    </PageFrame>{navigationLeaveDialog}{storeLeaveDialog}</>
  }

  let table
  if (loadError && !saved) table = <ListState kind="error" title="媒体を読み込めませんでした" error={loadError} onRetry={() => void load()} />
  else if (!saved) table = <ListState kind="loading" />
  else if (rows.length === 0) table = <p className={styles.text}>媒体がまだありません。右上の［媒体を足す］から足せます。</p>
  else {
    table = (
      <DataTable density="media" className={styles.table} data-design="booking-media">
        <thead>
          <TableHeadRow>
            <Th truncate>媒体</Th>
            <Th truncate>店舗ページの URL</Th>
            <Th truncate>管理画面（ログイン）の URL</Th>
            <Th truncate>予約メールの取り込み</Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {rows.map((row) => {
            const badge = importBadge(row, channels.find((c) => c.code === row.code))
            const changed = dirty.some((d) => d.code === row.code)
            return (
              <Tr key={row.code} data-dirty={changed || undefined}>
                <Td><FolderDotName>
                  <span className={styles.nameCell}>
                    <span className={styles.mark} aria-hidden="true">{row.name.slice(0, 1)}</span>
                    <span className={styles.name} ><TruncatedText value={String(row.name ?? '')} /></span>
                  </span>
                </FolderDotName></Td>
                <Td><UrlCell url={row.pageUrl} /></Td>
                <Td><UrlCell url={row.loginUrl} /></Td>
                <Td>
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                </Td>
                <Td className={styles.colMenu}>
                  {canManage ? (
                    <RowActions
                      subjectName={row.name}
                      menuItems={[
                        { id: 'edit', label: 'URL を変える', onSelect: () => openEdit(row) },
                        ...(row.acceptsReservations ? [{
                          id: 'close',
                          label: row.closeOnBooking ? '枠を閉じる知らせの対象から外す' : '枠を閉じる知らせの対象にする',
                          icon: row.closeOnBooking ? <Check size={16} aria-hidden="true" /> : undefined,
                          onSelect: () => setRow(row.code, { closeOnBooking: !row.closeOnBooking }),
                        }] : []),
                        ...(row.pageUrl ? [{ id: 'open-page', label: '店舗ページを開く', external: true, href: row.pageUrl! }] : []),
                        ...(row.loginUrl ? [{ id: 'open-login', label: '管理画面を開く', external: true, href: row.loginUrl! }] : []),
                      ]}
                    />
                  ) : null}
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    )
  }

  const closeTargets = bookable.filter((row) => row.closeOnBooking).map((row) => row.name)

  return (
    <SaveErrorScope errors={saveErrors}><>
      {membersError?<ListState kind="error" title="知らせるスタッフを読み込めませんでした" onRetry={()=>setMembersRetry(n=>n+1)}/>:null}
      <PageFrame kind="settings" boardId="aSmph" hasFooter={canManage}>
        <PageHeading
          headingSize="compact"
          title="予約サイト・グルメ媒体"
          help="店ごとに、予約サイト・グルメ媒体の店舗ページと管理画面（ログイン）の URL を持ちます。管理画面の URL は「今日のお店」と「枠を閉じる知らせ」の［管理画面を開く］に使います。"
      explanation="他の予約サイトの空き枠は自動で変更しません。LINE や電話で予約が入ったら、他のサイトの同じ時刻の枠を閉じる知らせを出します。"
          actions={(
            <span className={styles.headActions}>
              {storePicker}
              {canManage ? <Button onClick={() => { setAdding(true); setAddName(''); setAddError(''); setAddNameError('') }}><Plus size={16} aria-hidden="true" />媒体を足す</Button> : null}
            </span>
          )}
        />
        <div className={styles.body}>
          {conflict ? (
            <Notice tone="warn" role="alert" action={<Button size="compact" onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button>}>
              ほかの人が先にこの店の媒体の設定を変えました。読み直してから、もう一度変えてください。
            </Notice>
          ) : null}
          {saveError ? <Notice tone="danger" role="alert">{saveError}</Notice> : null}

          <section className={styles.section} aria-label="つないでいる媒体">
            <SectionHeader
              title="つないでいる媒体"
              help="予約サイトは予約メールを取り込み、グルメ媒体（予約を受けない）は URL だけを持ちます。URL は https:// で始まるものだけ保存できます。"
              helpLabel="つないでいる媒体の説明"
            />
            {table}
          </section>

          <section className={styles.section} aria-label="LINE 予約を他のサイトに貼る">
            <SectionHeader
              title="LINE 予約を他のサイトに貼る"
              help="LINE で予約できるページの URL と、ホームページなどに貼るボタンのコードです。"
              helpLabel="LINE 予約を他のサイトに貼るの説明"
            />
            {canManage && linkError ? (
              <Notice tone="danger" message={linkError} action={linkSetupRequired ? (
                <TextLink href={selectedAccountId ? `/accounts/detail?id=${encodeURIComponent(selectedAccountId)}` : '/accounts'}>LINEアカウントの設定を見る</TextLink>
              ) : undefined} actionLayout="stack-on-narrow" />
            ) : null}
            <div className={styles.cards}>
              <Card appearance="outlined" layout="vertical" padding="default" gap="tight" className={styles.card}>
                <p className={styles.cardTitle}>予約ページの URL</p>
                <p className={styles.cardText}>Instagram のプロフィール・Google ビジネスの予約ボタン・ホームページに貼れます</p>
                {canManage ? (
                  <div className={styles.urlRow}>
                    <span className={styles.urlBox} title={link?.url}>{link?.url ?? (linkError ? <EmptyCell /> : '読み込んでいます…')}</span>
                    <CopyTextButton value={link?.url ?? ""} aria-label="予約ページのURLをコピー" disabled={!link} />
                  </div>
                ) : (
                  <p className={styles.cardText}>予約ページの URL は、管理者が確かめられます。</p>
                )}
                {linkAsked && link && !link.available ? (
                  <Notice tone="info" role="status">LINE 予約のページは、まだ使えません。使えるようになったら、ここからコピーして貼れます。</Notice>
                ) : null}
              </Card>
              <Card appearance="outlined" layout="vertical" padding="default" gap="tight" className={styles.card}>
                <p className={styles.cardTitle}>ボタンの見本と貼り付けるコード</p>
                <div className={styles.sampleRow}>
                  <span className={styles.lineButton} aria-hidden="true"><MessageCircle size={16} />LINE で予約する</span>
                  <span className={styles.cardText}>大きさ：標準</span>
                </div>
                {canManage ? (
                  <>
                    <code className={styles.code} title={link?.html}>{link?.html ?? (linkError ? <EmptyCell /> : '読み込んでいます…')}</code>
                    <span className={styles.copyRow}>
                      <CopyTextButton value={link?.html ?? ""} aria-label="コードをコピー" disabled={!link} />
                    </span>
                  </>
                ) : null}
              </Card>
            </div>
          </section>

          <section className={styles.sectionTight} aria-label="他のサイトの枠を閉じる知らせ">
            <SectionHeader
              title="他のサイトの枠を閉じる知らせ"
              help="知らせを出す媒体は、表の行の「…」から1つずつ選べます。下の切り替えは、予約を受ける媒体をまとめてオン・オフします。"
              helpLabel="他のサイトの枠を閉じる知らせの説明"
            />
            <div className={styles.switchRow}>
              {/* 閲覧のみには押せる形のスイッチを置かない。オン・オフは札で見せる。 */}
              {canManage ? (
                <SaveErrorField names={["closeOn","allClose","close_on","all_close"]}><Toggle checked={closeOn} label="LINE・電話で予約が入ったら、他のサイトの枠を閉じる知らせを出す" onChange={(next) => setAllClose(next)} /></SaveErrorField>
              ) : <StatusBadge tone={closeOn ? 'success' : 'neutral'}>{closeOn ? 'オン' : 'オフ'}</StatusBadge>}
              <span className={styles.switchText}>
                <span className={styles.switchTitle}>LINE・電話で予約が入ったら、他のサイトの枠を閉じる知らせを出す</span>
                <span className={styles.switchSub} title={closeTargets.length ? `対象：${closeTargets.join('・')}` : '対象の媒体はありません'}>ダッシュボードの上と「枠を閉じる知らせ」の一覧に出ます</span>
              </span>
            </div>
            <div className={styles.switchRow}>
              {/* オフにすると LINE の知らせだけ止める（管理画面の「もう開けてよい」は残る）。閲覧のみは札。 */}
              {canManage && notice ? (
                <SaveErrorField names={["notifyReopen","notice.notifyReopen","notify_reopen","notice.notify_reopen"]}><Toggle checked={notice.notifyReopen} label="キャンセルで席が空いたら「もう開けてよい」を知らせる" onChange={(next) => setNotice({ ...notice, notifyReopen: next })} /></SaveErrorField>
              ) : <StatusBadge tone={notice?.notifyReopen === false ? 'neutral' : 'success'}>{notice?.notifyReopen === false ? 'オフ' : 'オン'}</StatusBadge>}
              <span className={styles.switchText}>
                <span className={styles.switchTitle}>キャンセルで席が空いたら「もう開けてよい」を知らせる</span>
                {notice?.notifyReopen === false ? <span className={styles.switchSub}>LINE では知らせません。「枠を閉じる知らせ」の一覧には出ます</span> : null}
              </span>
            </div>
            <div className={styles.targetRow}>
              <span className={styles.targetLabel}>知らせる相手</span>
              {canManage && notice ? (
                <Button
                  align="start"
                  className={styles.targetControl}
                  title={recipientText(notice, members)}
                  aria-haspopup="dialog"
                  onClick={() => { setPicking({ recipientMode: notice.recipientMode, membershipIds: notice.membershipIds }); setPickError('') }}
                >
                  {recipientText(notice, members)}
                </Button>
              ) : (
                <span className={styles.targetValue} title={recipientText(notice ?? { recipientMode: 'responsible', membershipIds: [] }, members)}>
                  {recipientText(notice ?? { recipientMode: 'responsible', membershipIds: [] }, members)}
                </span>
              )}
              <span className={styles.cardText}>管理画面とスタッフの LINE に届きます</span>
            </div>
          </section>
        </div>
        {canManage && (changes > 0 || saving) ? (
          <PageFooter
              actions={(
                <>
                  <Button onClick={() => { if (saved) setRows(saved); if (noticeSaved) setNotice(noticeSaved); setSaveError('') }} disabled={saving}>キャンセル</Button>
                  <Button variant="primary" onClick={() => void save()} busy={saving} busyLabel="保存中…" disabled={changes === 0 || saving} title={changes === 0 ? '変えた所がありません' : undefined}>
                    <Check size={16} aria-hidden="true" />保存する
                  </Button>
                </>
              )}
              status={changes > 0 ? <span aria-live="polite">{dirty.length > 0 ? `変えた媒体 ${formatNumber(dirty.length)} 件${noticeDirty ? '・知らせの設定' : ''}（まだ保存していません）` : '知らせの設定を変えました（まだ保存していません）'}</span> : undefined}
          />
        ) : null}
      </PageFrame>

      {navigationLeaveDialog}
      {storeLeaveDialog}

      <Dialog
        open={!!editing}
        title={editing ? `${editing.name}の URL` : 'URL'}
        headerIcon={<Link2 />}
        description="https:// で始まる URL を入れます。空にすると消えます。保存は画面の下の［保存する］で行います。"
        confirmLabel="変える"
        onConfirm={applyEdit}
        onCancel={() => setEditing(null)}
      >
        <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: storeId, name: stores.find(store => store.id === storeId)?.name }} />
        <div className={styles.dialogFields}>
          <Field label="店舗ページの URL" htmlFor="media-page-url" error={editErrors.page}>
            <SaveErrorField names={["editPage","edit_page"]}><TextField id="media-page-url" value={editPage} onChange={(event) => { setEditPage(event.target.value); setEditErrors((errors) => ({ ...errors, page: undefined })) }} placeholder="https://" inputMode="url" /></SaveErrorField>
          </Field>
          <Field label="管理画面（ログイン）の URL" htmlFor="media-login-url" error={editErrors.login}>
            <SaveErrorField names={["editLogin","edit_login"]}><TextField id="media-login-url" value={editLogin} onChange={(event) => { setEditLogin(event.target.value); setEditErrors((errors) => ({ ...errors, login: undefined })) }} placeholder="https://" inputMode="url" /></SaveErrorField>
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={picking !== null}
        title="知らせる相手"
        description="キャンセルで席が空いたときの「もう開けてよい」を、誰の LINE に知らせるかを選びます。保存は画面の下の［保存する］で行います。"
        confirmLabel="決める"
        onConfirm={() => {
          if (!picking || !notice) return
          if (picking.recipientMode === 'selected' && picking.membershipIds.length === 0) { setPickError('知らせるスタッフを1人以上選んでください'); return }
          setNotice({ ...notice, recipientMode: picking.recipientMode, membershipIds: picking.recipientMode === 'selected' ? picking.membershipIds : [] })
          setPicking(null)
        }}
        onCancel={() => setPicking(null)}
        error={pickError || undefined}
      >
        <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} store={{ id: storeId, name: stores.find(store => store.id === storeId)?.name }} />
        {picking ? (
          <div className={styles.dialogFields} role="radiogroup" aria-label="知らせる相手">
            <SaveErrorField names={["close-notice-recipient","recipientMode","picking.recipientMode","picking"]}><Radio name="close-notice-recipient" checked={picking.recipientMode === 'responsible'} onChange={() => setPicking({ ...picking, recipientMode: 'responsible' })}>当日の責任者（いなければ店長）</Radio></SaveErrorField>
            <SaveErrorField names={["close-notice-recipient","recipientMode","picking.recipientMode","picking"]}><Radio name="close-notice-recipient" checked={picking.recipientMode === 'manager'} onChange={() => setPicking({ ...picking, recipientMode: 'manager' })}>店長</Radio></SaveErrorField>
            <SaveErrorField names={["close-notice-recipient","recipientMode","picking.recipientMode","picking"]}><Radio name="close-notice-recipient" checked={picking.recipientMode === 'selected'} onChange={() => setPicking({ ...picking, recipientMode: 'selected' })}>スタッフを選ぶ</Radio></SaveErrorField>
            {picking.recipientMode === 'selected' ? (
              members.length > 0 ? (
                <div className={styles.memberPicks}>
                  {members.map((m, saveFieldIndex) => (
                    <SaveErrorField names={[`members.${saveFieldIndex}.id`,"id","m.id","picking"]} key={m.id}><Checkbox
                      key={m.id}
                      checked={picking.membershipIds.includes(m.id)}
                      onCheckedChange={(on) => setPicking({ ...picking, membershipIds: on ? [...picking.membershipIds, m.id] : picking.membershipIds.filter((id) => id !== m.id) })}
                      description={m.line_uid ? undefined : 'LINE とつないでいません（管理画面で確かめます）'}
                    >
                      {m.staff_name}
                    </Checkbox></SaveErrorField>
                  ))}
                </div>
              ) : <p className={styles.cardText}>この店の担当のスタッフがいません。組織・権限で足せます。</p>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={adding}
        title="媒体を足す"
        description="予約を受けないグルメ媒体（口コミ・紹介のサイトなど）を足します。予約メールは取り込みません。予約サイトは、予約メールを取り込むと自動で現れます。足したら行の「…」から URL を入れます。"
        confirmLabel="足す"
        busy={addBusy}
        confirmDisabled={!addName.trim()}
        confirmDisabledReason="媒体の名前を入れてください"
        onConfirm={() => addMedium()}
        onCancel={() => setAdding(false)}
        error={addError || undefined}
      >
        <Field label="媒体の名前" htmlFor="media-name" required error={addNameError}>
          <SaveErrorField names={["addName","add_name"]}><TextField id="media-name" value={addName} onChange={(event) => { setAddName(event.target.value); setAddNameError('') }} placeholder="例：OZmall" maxLength={100} /></SaveErrorField>
        </Field>
      </Dialog>
    </></SaveErrorScope>
  )
}
