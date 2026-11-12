'use client'

import { scrollMotion } from '@/components/shared/overlay-utils'
import { flushListUrlState, useListUrlValue } from '@/components/shared/list-url-state';
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { notifySaved, notifyToast } from '@/components/shared/toast';
import { useSearchParams } from 'next/navigation';


import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Gift, ImageIcon, Minus, Plus, QrCode, Stamp } from 'lucide-react';
import { VISIT_STAMP_DEFAULT_COLOR, visitStampDarkInk } from '@line-crm/shared';
import type { VisitStampCard, VisitStampEntryPage, VisitStampMultiplier, VisitStampReward, VisitStampSettings } from '@line-crm/shared';
import { PageFrame, PageHeading } from '@/components/templates/page-frame';
import { DetailColumns } from '@/components/templates/detail-columns';
import { StaffQr, StorefrontQr } from './qr'
import tpl from '@/components/templates/page-templates.module.css'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import MediaSlot from '@/components/shared/media-slot'
import ColorWell from '@/components/shared/color-well'
import Combobox from '@/components/shared/combobox'
import HelpTip from '@/components/shared/help-tip'
import { FieldError, Field } from '@/components/shared/form-controls';
import IconButton from '@/components/shared/icon-button'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import { ListToolbarRow, ListToolbarEnd } from '@/components/shared/list-toolbar'
import Radio from '@/components/shared/radio'
import { RowActions } from '@/components/shared/row-actions';
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import StickyBar from '@/components/shared/sticky-bar'
import { Tabs } from '@/components/shared/tabs';
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { TextArea, TextField } from '@/components/shared/text-field';
import { usePageTitle } from '@/components/shell/page-chrome';
import { useAccount } from '@/contexts/account-context';
import { api, describeSaveFailure } from '@/lib/api';
import { canManageRole, useStaffRole } from '@/lib/staff-role';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import { visitStampsApi } from '@/lib/visit-stamps-api';
import { MANUAL_REASONS, STACKING_ORDERS, type ManualReason, defaultSettings, previewExpiry, friendLabel, friendNames, historyRows, manualReasonText, multiplierDetail, multiplierName, previewSlots, rankDetail, rewardNote, settingsIssue, settingsRangeIssues, type StampSettingField, shortDateTime, slotCount, sortedRewards, stackedCap, withSlotCount } from './display';
import { BonusDialog, MultiplierDialog, PhotoDialog, PinDialog, RankDialog, ReasonDialog, RewardDialog, StoresDialog } from './dialogs';
import { withHonorific } from '@line-crm/shared'
import HistoryTable from './history-table'
import styles from './visit-stamps.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format';
import TruncatedText from '@/components/shared/truncated-text'
import { withPermissionFailure } from '@/components/shared/api-error-message';
import { emptyValue } from '@/components/shared/empty-value';
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import ImageFrame from '@/components/shared/image-frame'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Toggle from '@/components/shared/toggle'

/*
 * ★V8 来店スタンプ（G-8a〜a3）。マイル（オンライン・特定の動き）とは別のスタンプカード。
 *
 * 共通のタブでカードの設定／紙のカードの移行／記録を切り替える。
 * 記録は左、店で手入力は右。設定の下書きはタブを切り替えても保持する。
 * ①② は下書きで、下の帯の［保存する］でまとめて保存する。③・店で手入力・④の取り消しは、その場で口を呼ぶ。
 * 呼ぶ口は visit-stamps-api（Codex の API-7）だけ。動き・権限は BEHAVIOR.md。
 */

type PaperRow = { id: string; card_id?: string; line_account_id?: string | null; friend_id: string; photo_url: string; stamps: number; status: string; created_at?: string }
type FriendLite = { id: string; displayName?: string | null; metadata?: Record<string, unknown> | null }

const SLOT_OPTIONS = [5, 6, 8, 10, 12, 15, 20, 30].map((n) => ({ value: String(n), label: `${n} 個` }))
const EXPIRY_OPTIONS = Array.from({ length: 120 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}か月` }))
const REMINDER_OPTIONS = [
  { value: 'day_before', label: '前日' }, { value: 'three_days_before', label: '3日前' }, { value: 'week_before', label: '1週間前' },
  { value: 'two_weeks_before', label: '2週間前' }, { value: 'month_before', label: '1か月前' }, { value: 'none', label: '知らせない' },
]
const CAP_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10, 20].map((n) => ({ value: String(n), label: `1回 ${n} 個まで` }))
const STAMP_TABS = [
  { key: 'settings', label: 'カードの設定', board: 'fpPlW' },
  { key: 'paper', label: '紙のカードの移行', board: 'byCFU' },
  { key: 'history', label: '押した・使った記録', board: 'NVN1Y' },
] as const

/* 口の日本語の理由があればそれ。英語の内部文（API error など）は出さず、運用者の言葉にする。 */
const message = (caught: unknown, fallback: string) => {
  const text = withPermissionFailure(caught, describeSaveFailure(caught), 'store')
  return /[ぁ-んァ-ヶ一-龠]/u.test(text) ? text : fallback
}

/** 紙のカードの写真の ID（非公開の置き場の URL の末尾）。公開の https の古い写真は null。 */
export function paperPhotoId(url: string): string | null {
  const hit = /\/paper-photos\/([^/?#]+)/.exec(url)
  return hit ? decodeURIComponent(hit[1]) : null
}

/** 写真を担当店舗の権限で読んで、画面で見られる URL にする（非公開の写真）。古い公開の URL はそのまま。 */
function usePhotoUrl(accountId: string | null, url: string | null | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const id = url ? paperPhotoId(url) : null
  useEffect(() => {
    if (!accountId || !id) { setObjectUrl(null); return }
    let live = true
    let made: string | null = null
    void visitStampsApi.paperPhoto(accountId, id)
      .then((blob) => { if (!live) return; made = URL.createObjectURL(blob); setObjectUrl(made) })
      .catch(() => { if (live) setObjectUrl(null) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [accountId, id])
  if (!url) return null
  return id ? objectUrl : /^https:\/\//.test(url) ? url : null
}

function PaperThumb({ accountId, url }: { accountId: string | null; url: string }) {
  const src = usePhotoUrl(accountId, url)
  return src ? <img width={96} height={96} src={src} alt="" /> : <ImageIcon size={16} aria-hidden="true" />
}
const newRequestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`)

function SectionTitle({ children, help, extra }: { children: string; help: string; extra?: React.ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <h3 className={styles.sectionTitle}>{children}</h3>
      <HelpTip label={`${children}の説明`}>{help}</HelpTip>
      {extra ? <><span className={styles.grow} aria-hidden="true" />{extra}</> : null}
    </div>
  )
}

function VisitStampsScreen() {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const params = useSearchParams()
  const rawTab = params.get('tab')
  const tab = STAMP_TABS.find(t => t.key === rawTab)?.key ?? (params.get('friend') && !rawTab ? 'history' : 'settings')
  const selectTab = (key: typeof STAMP_TABS[number]['key']) => {
    flushListUrlState()
    const url = new URL(window.location.href)
    url.searchParams.set('tab', key)
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false })
  }
  usePageTitle('来店スタンプ')
  const [qrOpen,setQrOpen]=useState(false)
  const { selectedAccountId, accounts } = useAccount()
  const role = useStaffRole()
  /* 役割が分かるまでは出す（最後の守りはサーバの 403）。閲覧のみ（viewer）には変える操作を置かない。 */
  const canManage = canManageRole(role)
  const canStamp = canManageRole(role) || role === 'staff'
  const confirmScope = useRef({ selectedAccountId, role, epoch: 0 })
  if (confirmScope.current.selectedAccountId !== selectedAccountId || confirmScope.current.role !== role) confirmScope.current = { selectedAccountId, role, epoch: confirmScope.current.epoch + 1 }

  const [cards, setCards] = useState<VisitStampCard[] | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  useEffect(()=>setQrOpen(false),[selectedAccountId])
  const card = useMemo(() => (cards ?? []).find((c) => selectedAccountId && c.accountIds.includes(selectedAccountId)) ?? (cards ?? [])[0] ?? null, [cards, selectedAccountId])

  const [name, setName] = useState('')
  const [settings, setSettings] = useState<VisitStampSettings>(defaultSettings)
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [draftReady, setDraftReady] = useState(false)
  const [initialDraft, setInitialDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [slotConfirmation, setSlotConfirmation] = useState<string | null>(null)
  useEffect(() => { setSlotConfirmation(null) }, [selectedAccountId])
  const [imageBusy, setImageBusy] = useState(false)
  const [issue, setIssue] = useState<{ field: StampSettingField; message: string } | null>(null)
  const rangeIssues = settingsRangeIssues(settings)
  const fieldMessage = (field: StampSettingField) => field === 'receiptBonus' || field === 'intervalHours' ? rangeIssues[field] ?? (issue?.field === field ? issue.message : undefined) : issue?.field === field ? issue.message : undefined
  const fieldProps = (field: StampSettingField) => ({ id: `stamp-${field}`, invalid: Boolean(fieldMessage(field)), 'aria-describedby': fieldMessage(field) ? `stamp-${field}-error` : undefined })
  const fieldError = (field: StampSettingField) => <FieldError id={`stamp-${field}-error`}>{fieldMessage(field) ?? null}</FieldError>
  useEffect(() => {
    if (!issue) return
    const input = document.getElementById(`stamp-${issue.field}`)
    input?.focus()
    input?.scrollIntoView?.({ block: 'center', behavior: scrollMotion() })
  }, [issue])
  const uploadImage = async (file: File) => {
    if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 3 * 1024 * 1024 || !file.size) { notifyToast('背景画像はJPG・PNG、3MBまでです。', { tone: 'error' }); return }
    setImageBusy(true)
    try { const res = await api.uploads.image(file); if (!res.success) throw new Error('背景画像を預けられませんでした。'); setSettings(s => ({ ...s, backgroundImageUrl: res.data.url })) }
    catch (e) {
      const fieldFailure = saveErrors.capture(e)
 { if (!fieldFailure) notifyToast(message(e, '背景画像を預けられませんでした。'), { tone: 'error' }) } }
    finally { setImageBusy(false) }
  }

  const resetDraft = useCallback((c: VisitStampCard | null) => {
    setIssue(null)
    const next = { name: c?.name ?? '来店スタンプカード', settings: c?.settings ?? defaultSettings(), accountIds: c?.accountIds ?? (selectedAccountId ? [selectedAccountId] : []) }
    setName(next.name)
    setSettings(next.settings)
    setAccountIds(next.accountIds)
    setInitialDraft(JSON.stringify(next))
    setDraftReady(true)
  }, [selectedAccountId])

  const loadCards = useCallback(async () => {
    try {
      const res = await visitStampsApi.cards()
      setCards(res.data); setLoadError(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
 { if (!fieldFailure) setLoadError(caught) }
  }
  }, [saveErrors])
  useEffect(() => { setDraftReady(false) }, [selectedAccountId])
  useEffect(() => { void loadCards() }, [loadCards])
  useEffect(() => { if (cards) resetDraft(card) }, [cards, card, resetDraft])

  const dirty = useMemo(() => {
    // 一覧の読込前は初期値が空で、比較対象のカードもまだ無い。読込中に
    // 「保存していない変更」を出さない。
    if (!cards || !draftReady) return false
    const base = card ? { name: card.name, settings: card.settings, accountIds: card.accountIds } : null
    return !base || JSON.stringify(base) !== JSON.stringify({ name, settings, accountIds })
  }, [cards, draftReady, card, name, settings, accountIds])

  const hasUnsavedChanges = !!cards && draftReady && initialDraft !== null && initialDraft !== JSON.stringify({ name, settings, accountIds })

  /* ①② の下書きを保存せずに離れるときは確かめる（保存できる人だけ。閲覧のみは変えられない）。 */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: canManage && hasUnsavedChanges,
    busy: saving,
    samePage: destination => destination.pathname === '/visit-stamps',
  })

  const saveConflict = useSaveConflict<VisitStampCard>({
    contextKey: JSON.stringify([selectedAccountId, card?.id]),
    fetchLatest: async () => {
      if (!card) return null
      const response = await visitStampsApi.cards()
      return response.data.find(next => next.id === card.id) ?? null
    },
    reload: async () => {
      const response = await visitStampsApi.cards()
      setCards(response.data)
      resetDraft(response.data.find(next => next.id === card?.id) ?? null)
      saveConflict.clear()
    },
  })

  const save = async () => {
    const problem = settingsIssue(name, settings) ?? (settings.completion === 'next_card' && !nextCards.some(c => c.id === settings.nextCardId) ? { field: 'nextCardId' as const, message: '同じ店舗の有効な次のカードを選んでください。' } : null)
    if (problem) { setIssue(problem); return }
    setIssue(null)
    if (!accountIds.length) { setStoresOpen(true); return }
    setSaving(true)
    try {
      const body = { name: name.trim(), accountIds, settings, active: card?.active ?? true, expectedVersion: card?.version ?? 0 }
      if (card) await visitStampsApi.save(card.id, body)
      else await visitStampsApi.create(body)
      saveConflict.clear()
      notifySaved('来店スタンプの設定を保存しました。')
      await loadCards()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);


      const conflict = (caught as { status?: number })?.status === 409
      if (conflict) saveConflict.mark()
      else if (!fieldFailure) notifyToast(message(caught, '保存できませんでした。'), { tone: 'error' })
    } finally { setSaving(false) }
  }

  /* ── 友だち・担当者の名前 ── */
  const [friends, setFriends] = useState<FriendLite[]>([])
  const [friendCache, setFriendCache] = useState<Record<string, FriendLite>>({})
  const [staff, setStaff] = useState<Array<{ id: string; name: string; role: string }>>([])
  useEffect(() => {
    if (!selectedAccountId) return
    let live = true
    void api.friends.list({ accountId: selectedAccountId, limit: 200, includeTags: false })
      .then((res) => { if (live && res.success) setFriends(res.data.items as FriendLite[]) })
      .catch(() => {})
    return () => { live = false }
  }, [selectedAccountId])
  useEffect(() => {
    let live = true
    void api.staff.list().then((res) => { if (live && res.success) setStaff(res.data.map((s) => ({ id: s.id, name: s.name, role: s.role }))) }).catch(() => {})
    return () => { live = false }
  }, [])
  const staffName = useCallback((id: string) => staff.find((s) => s.id === id)?.name, [staff])
  const friendById = useCallback((id: string): FriendLite | undefined => friends.find((f) => f.id === id) ?? friendCache[id], [friendCache, friends])

  /* ── ③ 紙のカードの申請 ── */
  const [paper, setPaper] = useState<PaperRow[] | null>(null)
  const [paperError, setPaperError] = useState<unknown>(null)
  const paperRequest = useRef(0)
  const paperEpoch = useRef(-1)
  const loadPaper = useCallback(async () => {
    const request = ++paperRequest.current
    const epoch = confirmScope.current.epoch
    setPaper(null)
    setPaperError(null)
    if (!selectedAccountId) return
    try {
      const res = await visitStampsApi.paperRequests(selectedAccountId)
      if (request !== paperRequest.current || epoch !== confirmScope.current.epoch) return
      paperEpoch.current = epoch
      setPaper(res.data as PaperRow[]); setPaperError(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);
 if (request === paperRequest.current && epoch === confirmScope.current.epoch) { if (!fieldFailure) setPaperError(caught) }
  }
  }, [selectedAccountId, role, saveErrors])
  useEffect(() => {
    void loadPaper();

    return () => { paperRequest.current++ }
  }, [loadPaper])
  /* 一覧に名前が無い友だちだけ、1人ずつ読む（申請は多くても 200 件）。 */
  /* ④ 店全体の押した・使った記録（期間・友だち・種類で絞れる口。ここは新しい順に全部）。 */
  const [log, setLog] = useState<VisitStampEntryPage | null>(null)
  const [logError, setLogError] = useState<unknown>(null)
  const [logPage, setLogPage] = useListUrlValue('logPage', 1)
  const [logPageSize, setLogPageSize] = useListUrlValue('logPageSize', 20)
  const logRequest = useRef(0)
  const logEpoch = useRef(-1)
  const loadLog = useCallback(async () => {
    const request = ++logRequest.current
    const epoch = confirmScope.current.epoch
    setLog(null)
    setLogError(null)
    if (!selectedAccountId) return
    try {
      const res = await visitStampsApi.entries({ accountId: selectedAccountId, page: logPage, pageSize: logPageSize })
      if (request !== logRequest.current || epoch !== confirmScope.current.epoch) return
      logEpoch.current = epoch
      const lastPage = Math.max(1, Math.ceil(res.data.total / logPageSize))
      if (logPage > lastPage) { setLogPage(lastPage); return }
      setLog(res.data); setLogError(null)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);
 if (request === logRequest.current && epoch === confirmScope.current.epoch) { if (!fieldFailure) setLogError(caught) } }
  }, [selectedAccountId, role, logPage, logPageSize, saveErrors])
  useEffect(() => { setLogPage(1) }, [selectedAccountId])
  useEffect(() => {
    void loadLog()
    return () => { logRequest.current++ }
  }, [loadLog])

  useEffect(() => {
    const missing = [...new Set([...(paper ?? []).map((p) => p.friend_id), ...(log?.items ?? []).map((e) => e.friendId)])].filter((id) => !friendById(id))
    if (!missing.length) return
    let live = true
    void Promise.allSettled(missing.slice(0, 50).map((id) => api.friends.get(id, { includeSubmissions: false }))).then((results) => {
      if (!live) return
      const add: Record<string, FriendLite> = {}
      results.forEach((r) => { if (r.status === 'fulfilled' && r.value.success) { const f = r.value.data as FriendLite; add[f.id] = f } })
      setFriendCache((prev) => ({ ...prev, ...add }))
    })
    return () => { live = false }
  }, [paper, log, friendById])

  const [busy, setBusy] = useState('')
  const [rejecting, setRejecting] = useState<{ row: PaperRow; epoch: number; accountId: string | null; friendName: string | null } | null>(null)
  const [dialogError, setDialogError] = useState('')
  const [photo, setPhoto] = useState<PaperRow | null>(null)
  const review = async (row: PaperRow, action: 'approve' | 'reject', reason: string) => {
    setBusy(row.id); setDialogError('')
    try {
      await visitStampsApi.reviewPaper(row.id, action, reason)
      notifyToast(action === 'approve' ? `${row.stamps} 個をカードに足しました。お客さまに LINE でお知らせします。` : '申請を却下しました。')
      setRejecting(null)
      await loadPaper()
      await loadLog()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);


      const text = message(caught, action === 'approve' ? '承認できませんでした。' : '却下できませんでした。');

      if (action === 'reject') { if (!fieldFailure) setDialogError(text); } else notifyToast(text, { tone: 'error' })
      await loadPaper()
    } finally { setBusy('') }
  }

  /* ── 店で手入力 ── */
  const [friendId, setFriendId] = useState('')
  const [count, setCount] = useState(1)
  const [reason, setReason] = useState<ManualReason>('paper')
  const [memo, setMemo] = useState('')
  const [manualExpanded, setManualExpanded] = useState(false)
  const grantRequest = useRef(newRequestId())
  /* 友だちの詳細などから ?friend=<友だちID> で開くと、その人を選んだ状態で始める。 */
  useEffect(() => {
    const id = params.get('friend')
    if (id) setFriendId(id)
  }, [params])
  useEffect(() => {
    if (!friendId || friendById(friendId)) return
    let live = true
    void api.friends.get(friendId, { includeSubmissions: false }).then((res) => {
      if (live && res.success) setFriendCache((prev) => ({ ...prev, [friendId]: res.data as FriendLite }))
    }).catch(() => {})
    return () => { live = false }
  }, [friendId, friendById])
  const grant = async () => {
    if (!card || !selectedAccountId || !friendId) return
    setBusy('grant')
    try {
      await visitStampsApi.grant(card.id, {
        accountId: selectedAccountId, friendId, count, reason: manualReasonText(reason, memo),
        requestId: grantRequest.current, source: reason === 'paper' ? 'paper' : 'manual',
      })
      grantRequest.current = newRequestId()
      notifyToast(`${polishFormatNumber(count)} 個 押しました。`)
      setCount(1); setMemo('')
      await loadLog()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      notifyToast(message(caught, '押印を足せませんでした。'), { tone: 'error' }) }
    } finally { setBusy('') }
  }

  /* ── ④ の行（取り消しは元の行にまとめる） ── */
  const rows = useMemo(() => historyRows(log?.items ?? [], staffName), [log, staffName])
  const [reversing, setReversing] = useState<{ id: string; epoch: number; accountId: string | null; friendName: string | null } | null>(null)
  const reverse = async (entryId: string, why: string) => {
    setBusy(entryId); setDialogError('')
    try {
      await visitStampsApi.reverse(entryId, why)
      notifyToast('記録を取り消しました。')
      setReversing(null)
      await loadLog()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
 { if (!fieldFailure) setDialogError(message(caught, '取り消せませんでした。')) } } finally { setBusy('') }
  }

  /* ── 下書きを変える窓 ── */
  const [rewardEdit, setRewardEdit] = useState<VisitStampReward | 'new' | null>(null)
  const [multEdit, setMultEdit] = useState<number | 'new' | null>(null)
  const [bonusOpen, setBonusOpen] = useState(false)
  const [rankOpen, setRankOpen] = useState(false)
  const [storesOpen, setStoresOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [pinBusy, setPinBusy] = useState(false)
  const set = (patch: Partial<VisitStampSettings>) => { setIssue(null); setSettings((s) => ({ ...s, ...patch })) }

  const savePin = async (staffId: string, pin: string) => {
    if (!selectedAccountId) return
    setPinBusy(true); setDialogError('')
    try {
      await visitStampsApi.setPin(staffId, selectedAccountId, pin)
      notifySaved(`${staffName(staffId) ?? '店員'}さんの暗証番号を保存しました。`)
      setPinOpen(false)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
 { if (!fieldFailure) setDialogError(message(caught, '暗証番号を保存できませんでした。')) } } finally { setPinBusy(false) }
  }

  const photoUrl = usePhotoUrl(selectedAccountId, photo?.photo_url)

  if (loadError && cards === null) {
    return <SaveErrorScope errors={saveErrors}><PageFrame kind="visit-stamps" boardId={STAMP_TABS.find(t => t.key === tab)?.board}><PageHeading headingSize="regular" title="来店スタンプ" /><ListState kind="error" error={loadError} onRetry={() => void loadCards()} /></PageFrame></SaveErrorScope>
  }
  if (cards === null) {
    return <SaveErrorScope errors={saveErrors}><PageFrame kind="visit-stamps" boardId={STAMP_TABS.find(t => t.key === tab)?.board}><PageHeading headingSize="regular" title="来店スタンプ" /><ListState kind="loading" /></PageFrame></SaveErrorScope>
  }

  const ro = !canManage
  const filled = Math.min(3, slotCount(settings))
  const expiryBasis = settings.expiryBasis ?? (settings.expiryMonths === null ? 'none' : 'last_visit')
  const nextCards = (cards ?? []).filter(c => c.id !== card?.id && c.active && accountIds.every(a => c.accountIds.includes(a)))
  const interval = settings.stampInterval ?? { mode: 'none' as const }
  const cardColor = settings.backgroundColor ?? VISIT_STAMP_DEFAULT_COLOR
  const logTotal = log?.total ?? 0
  const logPages = Math.max(1, Math.ceil(logTotal / logPageSize))
  const friendOptions = [...friends, ...Object.values(friendCache).filter((f) => !friends.some((x) => x.id === f.id))].map((f) => ({ value: f.id, label: friendLabel(f) }))
  const selectedFriend = friendById(friendId)
  const stampable = canStamp && !!card

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="visit-stamps" boardId={STAMP_TABS.find(t => t.key === tab)?.board} hasFooter={canManage && tab === 'settings'}>
      <PageHeading
        headingSize="regular"
        title="来店スタンプ"
        actions={stampable&&selectedAccountId&&card?.accountIds.includes(selectedAccountId)?<Button variant="primary" onClick={()=>setQrOpen(true)}><QrCode size={16} aria-hidden="true"/>QR を出す</Button>:undefined}
        help="お店に来たお客さまへ押すスタンプカードです。マイル（オンラインでの動きにたまるもの）とは別に数えます。決まった数がたまると特典を使えます。特典はお客さまの LINE の画面を店員に見せ、店員が暗証番号を打つと使用済みになります。"
      />
      <div className={tpl.tabs} data-template-region="tabs">
        <Tabs label="来店スタンプの表示" items={STAMP_TABS.map(item => ({
          id: `visit-stamp-tab-${item.key}`,
          controls: `visit-stamp-panel-${item.key}`,
          label: item.label,
          current: tab === item.key,
          count: item.key === 'paper' && paper !== null ? paper.filter(row => row.status === 'pending').length : undefined,
          countTone: item.key === 'paper' && paper?.some(row => row.status === 'pending') ? 'warning' : undefined,
          onClick: () => selectTab(item.key),
        }))} />
      </div>
      {role === 'viewer' ? <div className={tpl.notice}><ReadOnlyNotice >閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice></div> : null}
      <div className={tpl.split} data-template-region="body" role="tabpanel" id={`visit-stamp-panel-${tab}`} aria-labelledby={`visit-stamp-tab-${tab}`}>
        <div className={styles.body}>
          {tab === 'settings' ? (
            <div className={styles.pair}>
              {/* ① カードの設定 */}
              <section className={styles.card} aria-label="① カードの設定">
                <SectionTitle extra={canManage ? <RowActions subjectName="カードの設定" menuItems={[
                  { id: 'stores', label: '押せる店を選ぶ', onSelect: () => setStoresOpen(true) },
                  { id: 'pin', label: '店員の暗証番号', onSelect: () => { setDialogError(''); setPinOpen(true) } },
                ]} /> : undefined} help="カードの名前・マスの数・期限と、何個で何を渡すか（特典）を決めます。マスの数と特典の個数は別々に決めます（特典はマスの数以下）。特典を使うと、その個数だけスタンプが減ります。">① カードの設定</SectionTitle>
                <Field label="カードの名前"><SaveErrorField names={["name","issue"]}><TextField {...fieldProps('name')} value={name} onChange={(e) => { setIssue(null); setName(e.target.value) }} readOnly={ro} maxLength={100} /></SaveErrorField>
{fieldError('name')}</Field>
                <div className={styles.field}>
                  <span className={styles.label}>カードの見た目 <HelpTip label="カードの見た目の説明">画像があるときは画像を使います。色は文字の下地です。</HelpTip></span>
                  <div className={styles.appearance}>
                    <div className={styles.imageSlot}>
                      <SaveErrorField names={["backgroundImageUrl","settings.backgroundImageUrl","background_image_url","settings.background_image_url"]}><ImageFrame
                        title="背景画像を追加"
                        previewAlt="背景画像"
                        value={settings.backgroundImageUrl || null}
                        accept="image/jpeg,image/png"
                        maxBytes={3 * 1024 * 1024}
                        busy={imageBusy}
                        readOnly={ro}
                        onFile={(file) => void uploadImage(file)}
                        onRemove={() => set({ backgroundImageUrl: null })}
                      /></SaveErrorField>
                    </div>
                    <div className={styles.colorField}>
                      <span className={styles.label}>色</span>
                      {ro ? <span className={styles.colorSwatch} style={{ backgroundColor: cardColor }} aria-label={`カードの色 ${cardColor}`} /> : <ColorWell value={cardColor} allowAlpha={false} allowClear={false} onChange={v => { if(v) set({ backgroundColor: v }) }} />}
                    </div>
                  </div>
                </div>
                <div className={styles.expiryRow}>
                  <div className={styles.field}>
                    <span className={styles.label}>マスの数</span>
                    <SaveErrorField names={["settings"]}><Select aria-label="マスの数" size="full" disabled={ro} value={String(slotCount(settings))} onChange={(v) => setSettings((s) => withSlotCount(s, Number(v)))}
                      options={SLOT_OPTIONS.some((o) => o.value === String(slotCount(settings))) ? SLOT_OPTIONS : [...SLOT_OPTIONS, { value: String(slotCount(settings)), label: `${slotCount(settings)} 個` }]} /></SaveErrorField>
                  </div>
                  <div className={`${styles.field} ${styles.fieldGrow}`}>
                    <span className={styles.label}>有効期限</span>
                    <SaveErrorField names={["expiryBasis","expiry_basis"]}><Select aria-label="有効期限の起点" size="full" disabled={ro} value={expiryBasis} onChange={v => set({ expiryBasis: v as VisitStampSettings['expiryBasis'], expiryMonths: v === 'none' ? null : settings.expiryMonths ?? 6 })}
                      options={[{ value: 'last_visit', label: '最後の来店から' }, { value: 'first_visit', label: '最初の来店から' }, { value: 'none', label: '設定しない' }]} /></SaveErrorField>
                  </div>
                  {expiryBasis !== 'none' ? <div className={styles.expiryLength}><SaveErrorField names={["expiryMonths","settings.expiryMonths","expiry_months","settings.expiry_months"]}><Select aria-label="有効期限の長さ" size="full" disabled={ro} value={String(settings.expiryMonths)} onChange={v => set({ expiryMonths: Number(v) })} options={EXPIRY_OPTIONS} /></SaveErrorField></div> : null}
                </div>
                <div className={styles.row2}>
                  <div className={styles.field}>
                    <span className={styles.label}>期限の前に知らせる <HelpTip label="期限のお知らせの説明">同じ期限のお知らせは1回だけLINEで送ります。</HelpTip></span>
                    {expiryBasis === 'none' ? <span className={styles.sub}>期限を設定すると選べます</span> : <SaveErrorField names={["expiryReminder","settings.expiryReminder","expiry_reminder","settings.expiry_reminder"]}><Select aria-label="期限の前に知らせる" size="full" disabled={ro} value={settings.expiryReminder ?? 'none'} onChange={v => set({ expiryReminder: v as VisitStampSettings['expiryReminder'] })} options={REMINDER_OPTIONS} /></SaveErrorField>}
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label}>ゴールしたら <HelpTip label="ゴールしたらの説明">ゴールの特典を使うと、次のカードを受け取れます。選んだカードの名前が欄に出ます（絵 fpPlW）。</HelpTip></span>
                    <SaveErrorField names={["nextCardId","settings.nextCardId","next_card_id","settings.next_card_id"]}><EntitySelect id="stamp-nextCardId" error={issue?.field === 'nextCardId' ? issue.message : undefined} aria-label="ゴールしたら" size="full" disabled={ro} value={settings.completion === 'next_card' ? settings.nextCardId ?? 'repeat' : 'repeat'}
                      onChange={v => set({ completion: v === 'repeat' ? 'repeat' : 'next_card', nextCardId: v === 'repeat' ? null : v })}
                      options={[{ value: 'repeat', label: '同じカードをもう一度' }, ...nextCards.map(c => ({ ...entityOptionMetadata(c), value: c.id, label: c.name })), ...(settings.completion === 'next_card' && settings.nextCardId && !nextCards.some(c => c.id === settings.nextCardId) ? [{ value: settings.nextCardId, label: '次のカードを選び直してください', disabled: true }] : [])]} /></SaveErrorField>
                  </div>
                </div>
                <span className={styles.label}>特典</span>
                <div id="stamp-rewards" tabIndex={-1} className={styles.rewards}>
                  {sortedRewards(settings.rewards).map((reward) => (
                    <div key={reward.id} className={styles.reward}>
                      <span className={styles.count}>{reward.stamps} 個</span>
                      <span className={styles.texts}>
                        <span className={styles.name} ><TruncatedText value={String(reward.name ?? '')} /></span>
                        <span className={styles.sub}>{rewardNote(reward, settings)}</span>
                      </span>
                      {ro ? null : (
                        <RowActions subjectName={reward.name} menuItems={[{ id: 'edit', label: '特典を変える', onSelect: () => setRewardEdit(reward) }]}
                          destructiveItem={settings.rewards.length > 1 ? { id: 'delete', label: '特典を消す', onSelect: () => set({ rewards: settings.rewards.filter((r) => r.id !== reward.id) }) } : undefined} />
                      )}
                    </div>
                  ))}
                </div>
                {fieldError('rewards')}
                {ro || settings.rewards.length >= 20 ? null : (
                  <span className={styles.addLine}><Button variant="text" onClick={() => setRewardEdit('new')}><Plus size={16} aria-hidden="true" />特典を足す</Button></span>
                )}
                <Field label="使い方の説明（お客さまに見える）"><SaveErrorField names={["instructions","settings.instructions"]}><TextArea {...fieldProps('instructions')} compact aria-label="使い方の説明" rows={2} readOnly={ro} value={settings.instructions ?? ''} onChange={e => { if([...e.target.value].length <= 500) set({ instructions: e.target.value }) }} /></SaveErrorField>
{fieldError('instructions')}
<span className={styles.counter}>{`${[...(settings.instructions ?? '')].length} / 500`}</span></Field>
                <div className={styles.preview} aria-label="お客さまの見え方">
                  <span className={styles.previewLabel}>お客さまの見え方</span>
                  <div className={styles.customerCard} style={{ backgroundColor: cardColor, color: visitStampDarkInk(cardColor) ? 'var(--color-ink)' : 'var(--color-canvas)' }}>
                    {settings.backgroundImageUrl ? <img width={400} height={250} className={styles.cardImage} src={settings.backgroundImageUrl} alt="" /> : null}
                    <div className={styles.customerCardContent}>
                      <div className={styles.cardTitle} style={settings.backgroundImageUrl ? { backgroundColor: cardColor } : undefined}>
                        <span ><TruncatedText value={String(name ?? '')} /></span><span>{`${filled} / ${slotCount(settings)}`}</span>
                      </div>
                      <div className={styles.slots}>
                        {previewSlots(settings, filled).map(slot => <span key={slot.n} className={`${styles.slot} ${slot.state === 'done' ? styles.slotDone : ''}`} aria-label={slot.state === 'done' ? `${slot.n} 個目 済み` : slot.state === 'reward' ? `${slot.n} 個目 特典` : `${slot.n} 個目`}>
                          {slot.state === 'done' ? <Check size={16} aria-hidden="true" /> : slot.state === 'reward' ? <Gift size={16} aria-hidden="true" /> : slot.n}
                        </span>)}
                      </div>
                      {settings.instructions ? <p className={styles.cardInstructions} style={settings.backgroundImageUrl ? { backgroundColor: cardColor } : undefined}>{settings.instructions}</p> : null}
                      <span className={styles.cardExpiry} style={settings.backgroundImageUrl ? { backgroundColor: cardColor } : undefined}>{previewExpiry(settings.expiryMonths, expiryBasis)}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* ② たまる決まり */}
              <section className={`${styles.card} ${styles.cardRules}`} aria-label="② たまる決まり">
                <SectionTitle help="来店1回ごとか、会計の金額ごとかを選びます。倍率は 曜日・時間・期間 で決め、いくつも当たるときはかけ合わせます。会員ランクは当たる中でいちばん高い倍率だけを使います。1回の上限は倍率の前、重ねたときの上限は倍率と初回ボーナスを重ねたあとにかかります。止めた倍率は使いません。">② たまる決まり</SectionTitle>
                <div className={styles.radio} role="radiogroup" aria-label="たまり方">
                  <SaveErrorField names={["stamp-mode","mode","settings.mode"]}><Radio name="stamp-mode" checked={settings.mode === 'visit'} disabled={ro} onChange={() => set({ mode: 'visit' })}>来店 1回で 1個</Radio></SaveErrorField>
                  <SaveErrorField names={["stamp-mode","mode","settings.mode"]}><Radio name="stamp-mode" checked={settings.mode === 'amount'} disabled={ro} onChange={() => set({ mode: 'amount' })}>会計の金額で</Radio></SaveErrorField>
                </div>
                {settings.mode === 'amount' ? (
                  <div className={`${styles.row2} ${styles.amount}`}>
                    <Field label="何円ごとに 1個"><NumberInput numericText {...fieldProps('amountUnit')} unit="円" value={polishFormatNumber(settings.amountUnit)} readOnly={ro} inputMode="numeric"
                        onChange={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, '')); set({ amountUnit: Number.isFinite(n) ? n : 0 }) }} />
{fieldError('amountUnit')}</Field>
                    <Field label="1回の上限"><NumberInput numericText {...fieldProps('maxPerVisit')} unit="個" value={settings.maxPerVisit} readOnly={ro} inputMode="numeric"
                        onChange={(e) => { const n = Number(e.target.value.replace(/[^\d]/g, '')); set({ maxPerVisit: Number.isFinite(n) ? n : 0 }) }} />
{fieldError('maxPerVisit')}</Field>
                  </div>
                ) : null}
                <div className={styles.field}>
                  <span className={styles.label}>たまる間隔の制限 <HelpTip label="たまる間隔の制限の説明">台帳の来店と手入力にはカードの制限がかかります。店頭のQRは同じ日に1回までです。店員のQR・紙からの移行と取り消しにはかかりません。</HelpTip></span>
                  <div className={styles.radio} role="radiogroup" aria-label="たまる間隔の制限">
                    <SaveErrorField names={["stamp-interval","mode","interval.mode"]}><Radio name="stamp-interval" checked={interval.mode === 'same_day'} disabled={ro} onChange={() => set({ stampInterval: { mode: 'same_day' } })}>同じ日は1回まで（0時で戻る）</Radio></SaveErrorField>
                    <div className={styles.hoursRow}>
                      <SaveErrorField names={["stamp-interval","mode","interval.mode"]}><Radio name="stamp-interval" checked={interval.mode === 'hours'} disabled={ro} onChange={() => set({ stampInterval: { mode: 'hours', hours: interval.hours ?? 3 } })}>前の押印から</Radio></SaveErrorField>
                      <SaveErrorField names={["hours","interval.hours"]}><NumberInput {...fieldProps('intervalHours')} note={false} aria-label="押印をあける時間" type="number" min={1} max={23} value={interval.hours ?? 3} readOnly={ro} onChange={e => set({ stampInterval: { mode: 'hours', hours: Number(e.target.value) } })} /></SaveErrorField>
                      <span className={styles.plain}>時間あける（1〜23）</span>
                    </div>
                    {fieldError('intervalHours')}
                    <SaveErrorField names={["stamp-interval","mode","interval.mode"]}><Radio name="stamp-interval" checked={interval.mode === 'none'} disabled={ro} onChange={() => set({ stampInterval: { mode: 'none' } })}>制限しない</Radio></SaveErrorField>
                  </div>
                </div>
                <span className={styles.label}>倍率・ボーナス</span>
                {settings.multipliers.map((m, i) => (
                  <div key={i} className={styles.switchRow}>
                    {/* 切る＝止める（消さない）。消すのは「…」から。 */}
                    <SaveErrorField names={[`multipliers.${i}.active`,"active","m.active"]}><Toggle checked={m.active !== false} label={`${multiplierName(m)}を使う`} disabled={ro} onChange={ro ? () => {} : (on) => set({ multipliers: settings.multipliers.map((x, k) => (k === i ? { ...x, active: on } : x)) })} /></SaveErrorField>
                    <span className={styles.texts}>
                      <span className={styles.name}>{multiplierName(m)}</span>
                      <span className={styles.sub} title={multiplierDetail(m)}>{m.active === false ? `止めています・${multiplierDetail(m)}` : multiplierDetail(m)}</span>
                    </span>
                    {ro ? null : <RowActions subjectName={multiplierName(m)} menuItems={[{ id: 'edit', label: '倍率を変える', onSelect: () => setMultEdit(i) }]}
                      destructiveItem={{ id: 'delete', label: '倍率を消す', onSelect: () => set({ multipliers: settings.multipliers.filter((_, k) => k !== i) }) }} />}
                  </div>
                ))}
                <div className={styles.switchRow}>
                  <SaveErrorField names={["firstVisitBonus","settings.firstVisitBonus","first_visit_bonus","settings.first_visit_bonus"]}><Toggle checked={settings.firstVisitBonus > 0} label="初回来店ボーナスを使う" disabled={ro} onChange={ro ? () => {} : (on) => set({ firstVisitBonus: on ? 1 : 0 })} /></SaveErrorField>
                  <span className={styles.texts}>
                    <span className={styles.name}>初回来店ボーナス</span>
                    <span className={styles.sub}>{settings.firstVisitBonus > 0 ? `はじめての来店で +${settings.firstVisitBonus} 個` : 'はじめての来店で多めに押します'}</span>
                  </span>
                  {ro ? null : <RowActions subjectName="初回来店ボーナス" menuItems={[{ id: 'edit', label: '個数を変える', onSelect: () => setBonusOpen(true) }]} />}
                </div>
                <div className={styles.switchRow}>
                  <SaveErrorField names={["length","settings.rankMultipliers.length","rankMultipliers.length","rankOpen","settings.rank_multipliers.length","rank_multipliers.length","rank_open"]}><Toggle checked={settings.rankMultipliers.length > 0} label="会員ランクの倍率を使う" disabled={ro} onChange={ro ? () => {} : (on) => (on ? setRankOpen(true) : set({ rankMultipliers: [] }))} /></SaveErrorField>
                  <span className={styles.texts}>
                    <span className={styles.name}>会員ランクの倍率</span>
                    <span className={styles.sub} title={rankDetail(settings)}>{rankDetail(settings)}</span>
                  </span>
                  {ro ? null : <RowActions subjectName="会員ランクの倍率" menuItems={[{ id: 'edit', label: 'ランクと倍率を変える', onSelect: () => setRankOpen(true) }]} />}
                </div>
                <div className={styles.receiptRow}>
                  <span className={styles.texts}>
                    <span className={styles.name}>カードを受け取った時のボーナス</span>
                    <span className={styles.sub}>友だちがカードを受け取った時に押す数（0〜50）</span>
                  </span>
                  <SaveErrorField names={["receiptBonus","settings.receiptBonus","receipt_bonus","settings.receipt_bonus"]}><NumberInput leadingAdornment={<Plus size={16} aria-hidden="true" />} unit="個" note={false} {...fieldProps('receiptBonus')} aria-label="カードを受け取った時のボーナス" type="number" min={0} max={50} readOnly={ro} value={settings.receiptBonus ?? 0} onChange={e => set({ receiptBonus: Number(e.target.value) })} /></SaveErrorField>
                </div>
                {fieldError('receiptBonus')}
                <div className={`${styles.row2} ${styles.stacking}`}>
                  <div className={styles.field}>
                    <span className={styles.label}>重ねたときの順番</span>
                    {/* 初回ボーナスを倍率の前に足すか後に足すか（口の stackingOrder）。倍率どうしはかけ合わせ、ランクはいちばん高い倍率だけ。 */}
                    <SaveErrorField names={["stackingOrder","settings.stackingOrder","stacking_order","settings.stacking_order"]}><Select aria-label="重ねたときの順番" size="full" disabled={ro} value={settings.stackingOrder ?? 'bonus_then_multipliers'}
                      onChange={(v) => set({ stackingOrder: v as VisitStampSettings['stackingOrder'] })} options={STACKING_ORDERS.map((o) => ({ value: o.value, label: o.label }))} /></SaveErrorField>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.label}>重ねたときの上限</span>
                    <SaveErrorField names={["settings"]}><Select aria-label="重ねたときの上限" size="full" disabled={ro} value={String(stackedCap(settings))} onChange={(v) => set({ maxStackedStamps: Number(v) })}
                      options={CAP_OPTIONS.some((o) => o.value === String(stackedCap(settings))) ? CAP_OPTIONS : [...CAP_OPTIONS, { value: String(stackedCap(settings)), label: `1回 ${stackedCap(settings)} 個まで` }]} /></SaveErrorField>
                  </div>
                </div>
                {ro || settings.multipliers.length >= 20 ? null : (
                  <span className={styles.addLine}><Button variant="text" onClick={() => setMultEdit('new')}><Plus size={16} aria-hidden="true" />倍率を足す</Button></span>
                )}
                  {card&&selectedAccountId&&card.accountIds.includes(selectedAccountId)?<StorefrontQr key={card.id+":"+card.version+":"+selectedAccountId} card={card} accountId={selectedAccountId} shop={accounts.find(a=>a.id===selectedAccountId)?.displayName??card.name} canManage={canManage}/>:null}
              </section>
            </div>

          ) : null}
          {tab === 'paper' ? (
            <Card as="section" variant="form" className={styles.section} aria-label="紙のカードからの移行の申請">
              <SectionTitle help="お客さまが LINE から送った紙のスタンプカードの写真です。写真の押印数を確かめて［承認］すると、その数をカードに足します。承認は1回だけで、同じ申請を2回は足しません。">紙のカードからの移行の申請</SectionTitle>
              {paperError && paper === null ? <ListState kind="error" error={paperError} onRetry={() => void loadPaper()} />
                : paper === null ? <ListState kind="loading" />
                  : paper.length === 0 ? <p className={styles.empty}>まだ申請はありません。お客さまが LINE の来店スタンプから［紙のカードを移す］を押すと、ここに出ます。</p>
                    : (
                      <DataTable className={styles.table} data-design="visit-stamp-paper" columnSizing="controls">
                        <thead>
                          <TableHeadRow className={styles.headRow}>
                            <Th className={styles.colPhoto}>写真</Th>
                            <Th grow>お客さま</Th>
                            <Th className={styles.colStamps}>押印数</Th>
                            <Th className={styles.colDate}>申請日</Th>
                            <Th className={styles.colState}>状態・操作</Th>
                          </TableHeadRow>
                        </thead>
                        <tbody>
                          {paper.map((row) => {
                            const f = friendById(row.friend_id)
                            const names = f ? friendNames(f) : { name: '友だち', line: null }
                            return (
                              <Tr key={row.id} className={`${styles.row} ${styles.paperLine}`} data-row-id={row.id}>
                                <Td className={styles.colPhoto}>
                                  <button type="button" className={styles.thumb} onClick={() => setPhoto(row)} aria-label={`${withHonorific(names.name)}の写真を大きく見る`}>
                                    <PaperThumb accountId={selectedAccountId} url={row.photo_url} />
                                  </button>
                                </Td>
                                <Td grow>
                                  <span className={styles.texts}>
                                    <span className={styles.name} ><TruncatedText value={String(names.name ?? '')} /></span>
                                    {names.line ? <span className={styles.sub}>{`LINE：${names.line}`}</span> : null}
                                  </span>
                                </Td>
                                <Td className={styles.colStamps}><span className={styles.strong}>{row.stamps} 個</span></Td>
                                <Td className={styles.colDate}><span className={styles.muted}>{row.created_at ? shortDateTime(row.created_at) : emptyValue('unknown')}</span></Td>
                                <Td className={styles.colState}>
                                  <span className={styles.actions}>
                                    <StatusBadge tone={row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'neutral' : 'warning'}>
                                      {row.status === 'approved' ? '承認済み' : row.status === 'rejected' ? '却下' : '確認待ち'}
                                    </StatusBadge>
                                    <span className={styles.grow} aria-hidden="true" />
                                    {row.status === 'pending' && canStamp ? (
                                      <>
                                        {/* 109: 承認は主（右）、却下は赤い文字だけ。並びは［却下］［承認］。 */}
                                        <Button size="compact" variant="text" textTone="danger" disabled={!!busy} onClick={() => { if (paperEpoch.current !== confirmScope.current.epoch) return; setDialogError(''); const friend = friendById(row.friend_id); setRejecting({ row, epoch: confirmScope.current.epoch, accountId: row.line_account_id ?? null, friendName: friend ? friendLabel(friend) : null }) }}>却下</Button>
                                        <Button size="compact" variant="primary" disabled={!!busy} onClick={() => void review(row, 'approve', '紙のカードの写真を確認しました')} aria-label={`${withHonorific(names.name)}の ${row.stamps}個を承認`} busy={Boolean(busy)} busyLabel="処理中…"><Check size={16} aria-hidden="true" />承認</Button>
                                      </>
                                    ) : null}
                                    <RowActions subjectName={`${withHonorific(names.name)}の申請`} menuItems={[
                                      { id: 'photo', label: '写真を大きく見る', onSelect: () => setPhoto(row) },
                                      { id: 'friend', label: '友だちの詳細を開く', external: false, href: `/friends/detail?id=${encodeURIComponent(row.friend_id)}`, onSelect: () => { router.push(`/friends/detail?id=${encodeURIComponent(row.friend_id)}`) } },
                                    ]} />
                                  </span>
                                </Td>
                              </Tr>
                            )
                          })}
                        </tbody>
                      </DataTable>
                    )}
            </Card>

          ) : null}
          {tab === 'history' ? (
            <HistoryColumns canStamp={canStamp} expanded={manualExpanded} onExpandedChange={setManualExpanded}>
              {/* 押した・使った記録 */}
              <Card as="section" variant="form" className={styles.section} aria-label="押した・使った記録">
                <SectionTitle
                  help="この店で押した・使った記録です（共通のカードでも、この店で押した・使ったものだけ）。来店・会計で自動で押したもの、店で足したもの、紙のカードから移したもの、特典で使ったものが新しい順に並びます。まちがいは「…」から取り消せます（取り消しも記録に残ります）。"
                >押した・使った記録</SectionTitle>
                {log ? (
                  <ListToolbarRow>
                    <ListToolbarEnd>
                      <SaveErrorField names={["logPageSize","pageSize","log_page_size"]}><Select aria-label="記録の表示件数" value={String(logPageSize)} onChange={v => { setLogPageSize(Number(v)); setLogPage(1) }}
                      options={[10, 20, 50].map(n => ({ value: String(n), label: `${n} 件ずつ` }))} /></SaveErrorField>
                    </ListToolbarEnd>
                  </ListToolbarRow>
                ) : null}
                {logError && log === null ? <ListState kind="error" error={logError} onRetry={() => void loadLog()} />
                  : log === null ? <ListState kind="loading" />
                    : rows.length === 0 ? <p className={styles.empty}>この店の記録はまだありません。来店・会計で押したり、店で手入力したりすると、ここに出ます。</p>
                        : (
                          <HistoryTable rows={rows} canManage={canManage}
                            friendName={id => { const friend = friendById(id); return friend ? friendNames(friend).name : '友だち' }}
                            onOpenFriend={id => router.push(`/friends/detail?id=${encodeURIComponent(id)}`)}
                            onReverse={id => { const entry = log?.items.find(item => item.id === id); if (!entry || logEpoch.current !== confirmScope.current.epoch) return; const friend = friendById(entry.friendId); setDialogError(''); setReversing({ id: entry.id, epoch: confirmScope.current.epoch, accountId: entry.accountId ?? null, friendName: friend ? friendLabel(friend) : null }) }} />
                        )}
                {log ? (
                  <Pagination page={logPage} pageCount={logPages} onPageChange={setLogPage} ariaLabel="記録のページ送り"
                    range={{ total: log.total, first: logTotal ? (logPage - 1) * logPageSize + 1 : 0, last: Math.min(logPage * logPageSize, logTotal) }} />
                ) : null}
              </Card>
              {canStamp ? (
                <section className={styles.side} aria-label="店で手入力">
                  <h3 className={styles.sectionTitle}>店で手入力</h3>
                  {!card ? <p className={styles.sub}>カードを保存すると、店で押せるようになります。</p> : null}
                  <div className={styles.field}>
                    <span className={styles.label}>友だち</span>
                    <SaveErrorField names={["friendId","friend_id"]} key={selectedFriend ? `f-${friendId}` : 'none'}><EntitySelect clearable size="full" key={selectedFriend ? `f-${friendId}` : 'none'} aria-label="友だちを探す" placeholder="名前で探す" value={friendId} onChange={(v) => { setFriendId(v) }} options={friendOptions}
                      disabled={!card} noun="友だち" /></SaveErrorField>
                  </div>
                  {stampable ? (
                    <>
                      <div className={styles.field}>
                        <span className={styles.label}>押印数</span>
                        <span className={styles.stepper}>
                          <IconButton aria-label="1個へらす" disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}><Minus size={16} aria-hidden="true" /></IconButton>
                          <span className={styles.stepValue} aria-live="polite">{`＋${polishFormatNumber(count)} 個`}</span>
                          <IconButton aria-label="1個ふやす" disabled={count >= 100} onClick={() => setCount((c) => Math.min(100, c + 1))}><Plus size={16} aria-hidden="true" /></IconButton>
                        </span>
                      </div>
                      <div className={styles.field}>
                        <span className={styles.label}>理由</span>
                        <SaveErrorField names={["reason"]}><Select aria-label="理由" size="full" value={reason} onChange={(v) => setReason(v as ManualReason)} options={MANUAL_REASONS.map((r) => ({ value: r.value, label: r.label }))} /></SaveErrorField>
                      </div>
                      <Field label="メモ"><SaveErrorField names={["memo"]}><TextField value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} placeholder="例：レシートを確認済み" /></SaveErrorField></Field>
                      <span className={styles.addLine}>
                        <Button disabled={!friendId || busy === 'grant'} onClick={() => void grant()} title={friendId ? undefined : '先に友だちを選んでください'} busy={Boolean(busy === 'grant')} busyLabel="処理中…"><Stamp size={16} aria-hidden="true" />押印を足す</Button>
                      </span>
                    </>
              ) : null}
            </section>
              ) : null}
            </HistoryColumns>
          ) : null}
        </div>
      </div>
      {canManage && tab === 'settings' ? (
        <div className={tpl.footer} data-template-region="footer">
          <StickyBar
            status={hasUnsavedChanges ? '保存していない変更があります' : cards !== null && draftReady && !card ? 'まだ公開していません' : undefined}
            actions={(
              <>
                <Button disabled={saving || imageBusy} disabledReason={saving ? '保存しています' : imageBusy ? '画像を登録しています' : undefined} onClick={() => resetDraft(card)}>キャンセル</Button>
                <Button variant="primary" disabled={!dirty || saving || imageBusy} disabledReason={imageBusy ? '画像を登録しています' : !dirty ? '変更していません' : undefined} onClick={() => {
                  if (card?.active && slotCount(card.settings) !== slotCount(settings)) setSlotConfirmation(JSON.stringify([selectedAccountId, card.id, card.version, name, settings, accountIds]))
                  else void save()
                }} busy={Boolean(saving)} busyLabel="処理中…"><Check size={16} aria-hidden="true" />保存する</Button>
              </>
            )}
          />
        </div>
      ) : null}

      {qrOpen&&card&&selectedAccountId?<StaffQr key={card.id+":"+card.version} card={card} accountId={selectedAccountId} shop={accounts.find(a=>a.id===selectedAccountId)?.displayName??card.name} onClose={()=>setQrOpen(false)}/>:null}
      <RewardDialog open={rewardEdit !== null} reward={rewardEdit === 'new' ? null : rewardEdit} onClose={() => setRewardEdit(null)}
        onSave={(reward) => { set({ rewards: rewardEdit === 'new' ? [...settings.rewards, reward] : settings.rewards.map((r) => (r.id === reward.id ? reward : r)) }); setRewardEdit(null) }} />
      <MultiplierDialog open={multEdit !== null} multiplier={typeof multEdit === 'number' ? settings.multipliers[multEdit] ?? null : null} onClose={() => setMultEdit(null)}
        onSave={(m: VisitStampMultiplier) => { set({ multipliers: multEdit === 'new' ? [...settings.multipliers, m] : settings.multipliers.map((x, k) => (k === multEdit ? m : x)) }); setMultEdit(null) }} />
      <BonusDialog open={bonusOpen} value={settings.firstVisitBonus} onClose={() => setBonusOpen(false)} onSave={(n) => { set({ firstVisitBonus: n }); setBonusOpen(false) }} />
      <RankDialog open={rankOpen} settings={settings} onClose={() => setRankOpen(false)} onSave={(rankMultipliers) => { set({ rankMultipliers }); setRankOpen(false) }} />
      <StoresDialog open={storesOpen} accounts={accounts.map((a) => ({ id: a.id, name: a.displayName || a.name }))} value={accountIds} onClose={() => setStoresOpen(false)} onSave={(ids) => { setAccountIds(ids); setStoresOpen(false) }} />
      <PinDialog open={pinOpen} staff={staff.filter((s) => s.role !== 'viewer')} busy={pinBusy} error={dialogError || undefined} onClose={() => setPinOpen(false)} onSave={(id, pin) => void savePin(id, pin)} />
      <ReasonDialog open={!!rejecting && rejecting.epoch === confirmScope.current.epoch && canStamp} target={rejecting ? { accountId: rejecting.accountId, accountName: accounts.find(a => a.id === rejecting.accountId)?.name, friendName: rejecting.friendName } : undefined} title="申請を却下する" description="却下するとカードには足しません。お客さまはもう一度申請できます。" confirmLabel="却下する" busy={!!busy} error={dialogError || undefined}
        onClose={() => setRejecting(null)} onConfirm={(why) => { if (rejecting && rejecting.epoch === confirmScope.current.epoch && canStamp) void review(rejecting.row, 'reject', why) }} />
      <ReasonDialog open={!!reversing && reversing.epoch === confirmScope.current.epoch && canManage} target={reversing ? { accountId: reversing.accountId, accountName: accounts.find(a => a.id === reversing.accountId)?.name, friendName: reversing.friendName } : undefined} title="記録を取り消す" description="スタンプの数を元に戻します。取り消したことも記録に残ります。" confirmLabel="取り消す" busy={!!busy} error={dialogError || undefined}
        onClose={() => setReversing(null)} onConfirm={(why) => { if (reversing && reversing.epoch === confirmScope.current.epoch && canManage) void reverse(reversing.id, why) }} />
      {saveConflict.conflict ? <SaveConflictBand title="ほかの人が来店スタンプを先に保存しました" compareBusy={saveConflict.compareBusy} onCompare={saveConflict.compare} onReload={saveConflict.reloadLatest} /> : null}
      <SaveConflictCompareDialog open={saveConflict.compareOpen} busy={saveConflict.compareBusy} error={saveConflict.compareError} onCancel={saveConflict.closeCompare} onReload={saveConflict.reloadLatest} lines={saveConflict.latest ? [{ text: `名前：入力 ${name} ／ 最新 ${saveConflict.latest.name}` }, { text: `設定：入力 ${JSON.stringify(settings)} ／ 最新 ${JSON.stringify(saveConflict.latest.settings)}` }, { text: `店舗：入力 ${accountIds.join('・')} ／ 最新 ${saveConflict.latest.accountIds.join('・')}` }] : null} />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="保存していないカードの設定" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <ConfirmDialog open={slotConfirmation !== null && !!card && card.active && slotConfirmation === JSON.stringify([selectedAccountId, card.id, card.version, name, settings, accountIds])} title="マスの数を変更しますか？" description="お客さまのカードのマス表示が変わります。マスより多い個数を必要とする特典は、新しいマスの数に合わせて変わります。" warning confirmLabel="変更して保存する" confirmDisabled={!canManage || saving || imageBusy} onCancel={() => setSlotConfirmation(null)} onConfirm={() => {
        if (!canManage || saving || imageBusy || !card || slotConfirmation !== JSON.stringify([selectedAccountId, card.id, card.version, name, settings, accountIds])) return
        setSlotConfirmation(null)
        void save()
      }} />
      <PhotoDialog url={photoUrl} name={photo ? friendNames(friendById(photo.friend_id) ?? { displayName: '友だち' }).name : ''} onClose={() => setPhoto(null)} />
    </PageFrame></SaveErrorScope>
  )
}

/** 閲覧のみでは補助欄も、その欄を開く操作も置かない。 */
function HistoryColumns({ canStamp, expanded, onExpandedChange, children }: {
  canStamp: boolean; expanded: boolean; onExpandedChange: (expanded: boolean) => void; children: [React.ReactNode, React.ReactNode]
}) {
  return canStamp ? <DetailColumns presentation="card" asideLabel="店で手入力" expanded={expanded} onExpandedChange={onExpandedChange} aside={children[1]}>{children[0]}</DetailColumns> : children[0]
}

export default function VisitStampsV8() {
  return <Suspense fallback={<ListState kind="loading" />}><VisitStampsScreen /></Suspense>
}
