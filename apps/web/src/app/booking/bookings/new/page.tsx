'use client'
import { normalizePhone, phoneProblem, withHonorific } from '@line-crm/shared'

import { usePermissionAccess } from '@/lib/use-feature-access'
import { loadStaffIdentity } from '@/lib/staff-role'
import { formatNumber } from '@/lib/format'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import { PageHeading } from '@/components/templates/page-frame';
import DateField from '@/components/shared/date-field';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from '@/contexts/account-context';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import Button from '@/components/shared/button';
import MenuPortal from '@/components/shared/menu-portal';
import Notice from '@/components/shared/notice';
import Select from '@/components/shared/select';
import StickyBar from '@/components/shared/sticky-bar';
import LinePreview from '@/components/shared/line-preview';
import { api, ApiError, bookingApi, type BookingAvailabilitySlot, type BookingConflictAlternatives, type BookingCustomerContext, type BookingMenu, type BookingMenuStaff, type BookingCustomerSummary, type FriendListItem, type ProxyBookingResult } from '@/lib/api';
import { describeApiFailure, isForbidden, isForbiddenOrRateLimited, loadFailureNotice } from '@/components/shared/api-error-message';
import { formatDateTime, formatDay, formatTime } from '@/lib/format';
import { Card, NotificationToggle, RelatedLinks } from "./page-gap-parts"
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
import { useAccountStyle } from '@/hooks/use-account-style'
import { bookingWords } from '@/v8/booking-bookings/words'
type Step = 'input' | 'confirm' | 'done' | 'conflict'

/**
 * N-400: 再読み込みで入力が消えないよう、アカウント別に sessionStorage へ
 * 置く下書きの形。友だちは表示に使う最小限（id と表示名）だけを持つ。
 * 完了・破棄で消す。別タブを汚さないよう sessionStorage（タブ単位）を使う。
 */
interface ProxyBookingDraft {
  phoneCustomer: boolean
  customerName: string
  customerPhone: string
  petName: string
  friend: { id: string; displayName: string } | null
  customer: BookingCustomerSummary | null
  customerSavedInput?: { name: string; phone: string; pet: string } | null
  menuId: string
  staffId: string
  date: string
  time: string
  customerNote: string
  notification: {
    send_line_confirmation: boolean
    day_before: boolean
    hours_before: boolean
  }
}

const DRAFT_KEY_PREFIX = 'booking:new-draft:'

/**
 * R14: 下書きに「書きかけ」と呼べる中身があるか。全部が初期値なら
 * 保存しない（破棄直後の空書き込みを残さない）。復元時も同じ物差しで、
 * 空の下書きには復元バナーを出さない。
 */
function draftHasContent(value: {
  phoneCustomer: boolean
  customerName: string
  customerPhone: string
  petName: string
  friend: { id: string } | null
  customer: { id: string } | null
  menuId: string
  staffId: string
  date: string
  time: string
  customerNote: string
  notification: { send_line_confirmation: boolean; day_before: boolean; hours_before: boolean }
}): boolean {
  return (
    value.phoneCustomer ||
    value.customerName !== '' || value.customerPhone !== '' || value.petName !== '' ||
    value.friend != null || value.customer != null ||
    value.menuId !== '' || value.staffId !== '' || value.date !== '' || value.time !== '' ||
    value.customerNote !== '' ||
    !value.notification.send_line_confirmation || !value.notification.day_before || !value.notification.hours_before
  )
}

const NODE_BY_STEP: Record<Step, string> = {
  input: 'cpdDi',
  confirm: 'GFDqW',
  done: 'GfceK',
  conflict: 'Lg8ff',
}

// 候補の instant 契約。サーバは各枠へ店舗 timezone と offset 付き instant を
// 付ける。表示も送信も、壁時刻を組み立て直さずこの instant だけを使う。
//
// 以前は startUtc が無いときに、日付と時刻を JST 固定のずれで読み直して
// いた。これは店舗が JST のときだけ正しい。America/New_York の 10:00 を
// 9 時間進んだ場所として読むと前日 21:00 の instant になり、休業日・
// 営業時間外・Google の予定を迂回した予約を送ってしまう。その退路は
// 残さず、読めない候補は使わない（fail-closed）。
function slotInstant(slot?: { startUtc?: string | null } | null): string | null {
  const raw = slot?.startUtc
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function dateLabel(startUtc: string, timeZone = 'Asia/Tokyo'): string {
  if (!startUtc) return '—'
  return formatDateTime(startUtc, '—', undefined, timeZone)
}

function timeRangeLabel(
  startUtc: string, minutes: number, timeZone = 'Asia/Tokyo', endUtc?: string | null,
): string {
  if (!startUtc) return '—'
  const startsAt = new Date(startUtc)
  const endsAt = endUtc ? new Date(endUtc) : new Date(startsAt.getTime() + minutes * 60_000)
  return `${dateLabel(startUtc, timeZone)} 〜 ${formatTime(endsAt, '—', timeZone)}`
}

function phoneDigitsError(phone: string): string | null {
  return phoneProblem(phone) || null
}

function scheduleLabel(value: string, timeZone = 'Asia/Tokyo'): string {
  return formatDateTime(value, '—', undefined, timeZone)
}

function operationStatusLabel(status: string): string {
  return ({
    queued: '処理中', succeeded: '完了', skipped: '設定なし', retry_wait: '再試行中',
    permanent_failed: '失敗', cancelled: '取消済み',
  } as Record<string, string>)[status] ?? status
}

export default function NewProxyBookingPage() {
  const { selectedAccountId } = useAccount()
  /* 題は予約管理のボタンと同じ言葉（TM-V20：面談・教室は言い換え）。 */
  const accountStyle = useAccountStyle(selectedAccountId)
  const createTitle = bookingWords(accountStyle.status === 'ready' ? accountStyle.data?.style : null).create
  /* パンくずは上の帯だけ（板の中の2つ目のパンくずは置かない）。 */
  usePageTitle(createTitle)
  usePageCrumbs([{ label: '予約管理', href: '/booking/bookings' }])
  const [step, setStep] = useState<Step>('input')
  const [menus, setMenus] = useState<BookingMenu[]>([])
  const [staff, setStaff] = useState<BookingMenuStaff[]>([])
  const [slots, setSlots] = useState<BookingAvailabilitySlot[]>([])
  // 空き枠を実際に取り終えたか。URL・下書きの時刻指定は、到着前の空配列で
  // 捨てないようこの旗を見てから判断する。
  const [slotsReady, setSlotsReady] = useState(false)
  const [friends, setFriends] = useState<FriendListItem[]>([])
  const [friendQuery, setFriendQuery] = useState('')
  const [friendSuggestOpen, setFriendSuggestOpen] = useState(false)
  const friendInputRef = useRef<HTMLInputElement>(null)
  const [friend, setFriend] = useState<FriendListItem | null>(null)
  const [customer, setCustomer] = useState<BookingCustomerSummary | null>(null)
  // R147: 台帳を作ったときの入力値。入力へ戻って直した値と違うときは、
  // 保存済みの表示・使い回しをせず、確定時に作り直す。
  const customerSavedInput = useRef<{ name: string; phone: string; pet: string } | null>(null)
  const [phoneCustomer, setPhoneCustomer] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [petName, setPetName] = useState('')
  const [menuId, setMenuId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [customerNote, setCustomerNote] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  // R559: 電話客の台帳作成のキー。予約本体のキーから派生させ、確定操作の
  // 再送では同じ台帳が返るようにする（冪等表の主キーで予約とぶつけない）。
  const customerIdempotencyKey = useRef('')
  const [result, setResult] = useState<ProxyBookingResult | null>(null)
  const [customerContext, setCustomerContext] = useState<BookingCustomerContext | null>(null)
  const [conflictAlternatives, setConflictAlternatives] = useState<BookingConflictAlternatives | null>(null)
  // 確認へ進む直前に読み直した枠。ここから先の表示・送信はこれだけを使う。
  const [confirmedSlot, setConfirmedSlot] = useState<BookingAvailabilitySlot | null>(null)
  const [reminderPreview, setReminderPreview] = useState<Array<{ kind: 'day_before' | 'hours_before'; scheduledAt: string }>>([])
  // N-391: 予約ごとに選べる通知の可否。LINEと結びついた予約だけ意味を持つ。
  const [notification, setNotification] = useState({
    send_line_confirmation: true,
    day_before: true,
    hours_before: true,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const slotRequest = useRef(0)
  // N-401: 閲覧のみの人には予約を入れる操作を出さない。読み込めるまでは隠す。
  const canOperate = usePermissionAccess('/booking/bookings')
  // 権限を読み終わるまで案内バナーも出さない（操作できる人へ一瞬見せない）。
  const [staffResolved, setStaffResolved] = useState(false)
  useEffect(() => {
    let active = true
    void loadStaffIdentity()
      .catch(() => {})
      .finally(() => { if (active) setStaffResolved(true) })
    return () => { active = false }
  }, [])
  // N-399/N-400: URL 指定・下書きの「担当者・時刻」は、担当一覧や空き枠が
  // 届いてから存在を確かめて選ぶ。到着を待つ分だけこの ref に預ける。
  const pendingSelect = useRef<{ staffId?: string; staffName?: string; date?: string; time?: string }>({})
  const restoredAccount = useRef<string | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)

  const selectionKey = [selectedAccountId ?? '', friend?.id ?? (phoneCustomer ? [customerName.trim(), normalizePhone(customerPhone), petName.trim()].join('|') : customer?.id ?? ''), menuId, staffId, date, time].join('\u001f')
  const latestSelectionKey = useRef(selectionKey)
  latestSelectionKey.current = selectionKey

  const menu = menus.find((item) => item.id === menuId) ?? null
  const selectedStaff = staff.find((item) => item.id === staffId) ?? null
  // R147: 保存後に入力を直したときは、保存済みの名前を見せない。
  // 下書き復元などで保存時の値が分からないときは、保存済みを信じる。
  const savedMatchesInput = customer == null
    || (customerSavedInput.current?.name === customerName.trim()
      && customerSavedInput.current?.phone === normalizePhone(customerPhone)
      && customerSavedInput.current?.pet === petName.trim())
  const customerLabel = friend?.displayName
    ?? (customer && savedMatchesInput ? customer.display_name : (customerName.trim() || 'お客様'))
  // 確認画面の電話・ペットも同じ約束。直した値は入力欄の値を出す。
  const customerPhoneLast4 = friend
    ? null
    : customer && savedMatchesInput
      ? customer.phone_last4
      : (customerPhone.replace(/\D/g, '').slice(-4) || '—')
  const customerPetLabel = friend
    ? null
    : customer && savedMatchesInput
      ? (customer.pet_name ?? '未入力')
      : (petName.trim() || '未入力')
  const selectedSlot = slots.find((item) => item.date === date && item.start === time) ?? null
  // 確認済みの枠があればそれを優先する。入力画面で見えた古い instant を
  // 確認・完了・競合の画面へ持ち越さない。
  const activeSlot = confirmedSlot ?? selectedSlot
  const slotTimeZone = activeSlot?.timeZone ?? 'Asia/Tokyo'
  const slotStartIso = slotInstant(activeSlot) ?? ''
  const slotEndIso = activeSlot?.endUtc ?? null
  const occupiedMinutes = activeSlot?.startUtc && activeSlot?.endUtc
    ? (new Date(activeSlot.endUtc).getTime() - new Date(activeSlot.startUtc).getTime()) / 60_000
    : selectedStaff?.duration_minutes ?? 0
  const confirmationOperation = result?.operations.find((item) => item.kind === 'confirmation_line') ?? null
  const automaticOperations = result?.operations.filter((item) => ['conversion', 'mileage', 'automation'].includes(item.kind)) ?? []
  // N-390: LINEと結びついているか。友だち選択か、台帳上で連携済みの顧客か。
  // 新しく作る電話客（customer 未保存）は必ず未連携。
  const isLineLinked = friend != null || customer?.is_line_linked === true

  function resetForm() {
    setStep('input')
    setFriend(null)
    setCustomer(null)
    customerSavedInput.current = null
    setPhoneCustomer(false)
    setCustomerName('')
    setCustomerPhone('')
    setPetName('')
    setFriendQuery('')
    setMenuId('')
    setStaffId('')
    setDate('')
    setTime('')
    // R14: 「お客様からの要望」も破棄の対象。前の予約のメモを
    // 次の予約へ持ち越さない（アカウント切替も同じ関数を通る）。
    setCustomerNote('')
    // 確認済みの枠も捨てる。古い instant が次の確定に乗らないようにする。
    setConfirmedSlot(null)
    setResult(null)
    setCustomerContext(null)
    setConflictAlternatives(null)
    setReminderPreview([])
    setNotification({ send_line_confirmation: true, day_before: true, hours_before: true })
    setIdempotencyKey('')
    customerIdempotencyKey.current = ''
    setLoading(false)
    setError('')
    pendingSelect.current = {}
  }

  useEffect(() => {
    resetForm()
    setDraftRestored(false)
    // アカウントが確定した最初の1回だけ下書きとURL指定を読む。それ以降の
    // 入力途中に再読み込みしても同じ下書きが戻る。別アカウントに切り替えた
    // ときはそのアカウントの下書きを読む（前のアカウントの入力は持ち越さない）。
    if (!selectedAccountId || restoredAccount.current === selectedAccountId) return
    restoredAccount.current = selectedAccountId
    // N-400: 書きかけの下書きを戻す。壊れた JSON は捨てて初期状態で始める。
    try {
      const raw = window.sessionStorage.getItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`)
      if (raw) {
        const draft = JSON.parse(raw) as Partial<ProxyBookingDraft>
        const notification = draft.notification && typeof draft.notification === 'object'
          ? {
            send_line_confirmation: draft.notification.send_line_confirmation !== false,
            day_before: draft.notification.day_before !== false,
            hours_before: draft.notification.hours_before !== false,
          }
          : { send_line_confirmation: true, day_before: true, hours_before: true }
        if (draftHasContent({
          phoneCustomer: draft.phoneCustomer === true,
          customerName: typeof draft.customerName === 'string' ? draft.customerName : '',
          customerPhone: typeof draft.customerPhone === 'string' ? draft.customerPhone : '',
          petName: typeof draft.petName === 'string' ? draft.petName : '',
          friend: draft.friend?.id ? { id: draft.friend.id } : null,
          customer: draft.customer?.id ? { id: draft.customer.id } : null,
          menuId: typeof draft.menuId === 'string' ? draft.menuId : '',
          staffId: typeof draft.staffId === 'string' ? draft.staffId : '',
          date: typeof draft.date === 'string' ? draft.date : '',
          time: typeof draft.time === 'string' ? draft.time : '',
          customerNote: typeof draft.customerNote === 'string' ? draft.customerNote : '',
          notification,
        })) {
          if (draft.friend?.id) setFriend({ id: draft.friend.id, displayName: String(draft.friend.displayName ?? '') } as FriendListItem)
          if (draft.customer?.id) {
            setCustomer(draft.customer as BookingCustomerSummary)
            customerSavedInput.current = draft.customerSavedInput ?? {
              name: draft.customer.display_name, phone: typeof draft.customerPhone === 'string' ? normalizePhone(draft.customerPhone) : '', pet: draft.customer.pet_name ?? '',
            }
          }
          setPhoneCustomer(draft.phoneCustomer === true)
          setCustomerName(typeof draft.customerName === 'string' ? draft.customerName : '')
          setCustomerPhone(typeof draft.customerPhone === 'string' ? draft.customerPhone : '')
          setPetName(typeof draft.petName === 'string' ? draft.petName : '')
          setMenuId(typeof draft.menuId === 'string' ? draft.menuId : '')
          setDate(typeof draft.date === 'string' ? draft.date : '')
          setCustomerNote(typeof draft.customerNote === 'string' ? draft.customerNote : '')
          setNotification(notification)
          // 担当・時刻は一覧の到着後に存在を確かめてから選ぶ。
          pendingSelect.current = {
            staffId: typeof draft.staffId === 'string' && draft.staffId ? draft.staffId : undefined,
            date: typeof draft.date === 'string' ? draft.date : undefined,
            time: typeof draft.time === 'string' ? draft.time : undefined,
          }
          setDraftRestored(true)
        } else {
          // 空の下書き（破棄直後の残りなど）は捨て、復元バナーは出さない。
          try { window.sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`) } catch { /* noop */ }
        }
      }
    } catch {
      // 壊れた下書きは捨てる
    }
    // N-399: カレンダーの空きセルから来たURL指定は下書きより優先する。
    const params = new URLSearchParams(window.location.search)
    const paramDate = params.get('date')
    const paramTime = params.get('time')
    const paramStaff = params.get('staff')
    const paramStaffId = params.get('staffId')
    const paramMenu = params.get('menu') ?? params.get('menu_id')
    if (paramDate && /^\d{4}-\d{2}-\d{2}$/.test(paramDate)) {
      setDate(paramDate)
      pendingSelect.current.date = paramDate
    }
    if (paramMenu) setMenuId(paramMenu)
    if (paramStaffId) {
      pendingSelect.current.staffId = paramStaffId
      delete pendingSelect.current.staffName
    } else if (paramStaff) {
      pendingSelect.current.staffName = paramStaff
      delete pendingSelect.current.staffId
    }
    if (paramTime && /^\d{2}:\d{2}$/.test(paramTime)) pendingSelect.current.time = paramTime
  }, [selectedAccountId])

  // N-399/N-400: メニューを選ぶと担当者一覧が届く。下書き・URLの担当が
  // 一覧にあれば選び直す。台帳は担当ID、既存カレンダーは担当名で照合する。
  useEffect(() => {
    const pending = pendingSelect.current
    if (pending.staffId) {
      if (staff.some((item) => item.id === pending.staffId)) {
        setStaffId(pending.staffId)
        delete pending.staffId
      } else if (staff.length > 0) {
        delete pending.staffId
      }
    } else if (pending.staffName) {
      const match = staff.find((item) => item.display_name === pending.staffName)
      if (match) {
        setStaffId(match.id)
        delete pending.staffName
      } else if (staff.length > 0) {
        // 一覧が届いたのに居ない担当名（改名・非担当）は捨てる。
        // 空の一覧は「まだ届いていない」だけなので残す。
        delete pending.staffName
      }
    }
  }, [staff])

  // N-399/N-400: 空き枠が届いたら、指定の開始時刻が実際に取れるときだけ選ぶ。
  // 取れない時刻（埋まった・営業時間外）は黙って捨て、選び直しに委ねる。
  // slotsReady が立つ前の空配列は「まだ読み込み中」なので時刻指定を捨てない。
  useEffect(() => {
    const pending = pendingSelect.current
    if (!pending.time || pending.date !== date || !slotsReady) return
    if (slots.some((slot) => slot.date === date && slot.start === pending.time)) {
      setTime(pending.time)
    }
    delete pending.time
  }, [slots, slotsReady, date])

  // N-400: 入力中の内容をアカウント別に sessionStorage へ書く。
  // 完了・破棄で消す。書き込みに失敗しても入力自体は止めない。
  // R14: 全部が初期値のときは「書きかけ」が無いので書かず、残りを消す。
  // 破棄直後の空書き込みが残ると、開き直したときに復元バナーが出てしまう。
  useEffect(() => {
    if (!selectedAccountId || step === 'done') return
    const draft: ProxyBookingDraft = {
      phoneCustomer,
      customerName,
      customerPhone,
      petName,
      friend: friend ? { id: friend.id, displayName: friend.displayName } : null,
      customer,
      customerSavedInput: customerSavedInput.current,
      menuId,
      staffId,
      date,
      time,
      customerNote,
      notification,
    }
    try {
      if (draftHasContent(draft)) {
        window.sessionStorage.setItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`, JSON.stringify(draft))
      } else {
        window.sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`)
      }
    } catch {
      // 容量超過などは無視する
    }
  }, [selectedAccountId, step, phoneCustomer, customerName, customerPhone, petName, friend, customer, menuId, staffId, date, time, customerNote, notification])

  function discardDraft() {
    if (selectedAccountId) {
      try { window.sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`) } catch { /* noop */ }
    }
    setDraftRestored(false)
    resetForm()
  }

  // 選択（アカウント・客・メニュー・担当・日時）が変わったら、確認済みの
  // 枠を捨てる。前の選択の instant がそのまま次の確定に乗ると、画面の
  // 表示と送る時刻がずれる。
  useEffect(() => {
    setConfirmedSlot(null)
  }, [selectionKey])

  useEffect(() => {
    // どちらの客かを先に束ねる(点検#516軽5)。`customer!` の断言では、将来の分岐変更でnullが紛れ込む。
    const target = friend ? { friendId: friend.id } : customer ? { bookingCustomerId: customer.id } : null
    if (!selectedAccountId || !target) {
      setCustomerContext(null)
      return
    }
    let active = true
    void bookingApi.getCustomerContext(selectedAccountId, target)
      .then((response) => { if (active) setCustomerContext(response.customer) })
      .catch(() => { if (active) setCustomerContext(null) })
    return () => { active = false }
  }, [selectedAccountId, friend, customer])

  // R534: メニュー取得専用の失敗保持。403は権限案内で再試行なし、
  // 429は混雑の待ち案内で再試行あり、それ以外は同じ条件で取り直せる。
  const [menusLoadError, setMenusLoadError] = useState<unknown>(null)
  const menuGeneration = useRef(0)
  const menuAccount = useRef(selectedAccountId)
  menuAccount.current = selectedAccountId
  const loadMenus = useCallback(async () => {
    const generation = ++menuGeneration.current
    const current = () => generation === menuGeneration.current && menuAccount.current === selectedAccountId
    setMenus([])
    if (!selectedAccountId) {
      setMenus([])
      return
    }
    setMenusLoadError(null)
    try {
      const response = await bookingApi.listMenus(selectedAccountId)
      if (!current()) return
      setMenus(response.menus.filter((item) => item.is_active === 1))
    } catch (caught) {
      if (!current()) return
      setMenusLoadError(caught)
      setError(isForbiddenOrRateLimited(caught) ? loadFailureNotice(caught, '予約メニュー') : '予約メニューを読み込めませんでした')
    }
  }, [selectedAccountId])

  useEffect(() => {
    void loadMenus()
    return () => { menuGeneration.current += 1 }
  }, [loadMenus])

  useEffect(() => {
    setStaffId('')
    setTime('')
    setSlots([])
    if (!selectedAccountId || !menuId) {
      setStaff([])
      return
    }
    let active = true
    void bookingApi.listMenuStaff(selectedAccountId, menuId)
      .then((response) => {
        if (active) setStaff(response.staff)
      })
      .catch(() => {
        if (active) setError('担当者を読み込めませんでした')
      })
    return () => { active = false }
  }, [selectedAccountId, menuId])

  const loadSlots = useCallback(async () => {
    const requestId = ++slotRequest.current
    if (!selectedAccountId || !menuId || !staffId || !date) {
      setSlots([])
      setSlotsReady(false)
      return
    }
    setLoading(true)
    setError('')
    // 取り直し中は前回の枠で時刻指定を判定しないよう一度落とす。
    setSlotsReady(false)
    try {
      const response = await bookingApi.getAvailability(selectedAccountId, {
        menuId, staffId, from: date, to: date,
      })
      if (requestId === slotRequest.current) {
        setSlots(response.by_staff.find((item) => item.staff_id === staffId)?.slots ?? [])
        setSlotsReady(true)
      }
    } catch {
      if (requestId === slotRequest.current) {
        setSlots([])
        // 読み込み自体は終わったので「指定時刻は取れない」として捨てる側に回す。
        setSlotsReady(true)
        setError('空き時間を確認できませんでした。時間をおいて、もう一度お試しください。')
      }
    } finally {
      if (requestId === slotRequest.current) setLoading(false)
    }
  }, [selectedAccountId, menuId, staffId, date])

  useEffect(() => {
    setTime('')
    void loadSlots()
  }, [loadSlots])

  useEffect(() => {
    const query = friendQuery.trim()
    if (!selectedAccountId || query.length < 2 || friend) {
      setFriends([])
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      void api.friends.list({ accountId: selectedAccountId, search: query, limit: 20 })
        .then((response) => {
          if (active && response.success) {
            setFriends(response.data.items)
            setFriendSuggestOpen(response.data.items.length > 0)
          }
        })
        .catch(() => {
          if (active) setError('友だちを検索できませんでした。時間をおいて、もう一度お試しください。')
        })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [selectedAccountId, friendQuery, friend])

  const validation = useMemo(() => {
    if (!selectedAccountId) return 'LINEアカウントを選択してください'
    if (!friend && !customer && !phoneCustomer) return '予約するお客様を選択してください'
    // R147: 台帳は確定時に作るため、入力の要否は保存の有無で変えない。
    // 保存後に直した値もここで確かめる。
    if (phoneCustomer && (!customerName.trim() || !customerPhone.trim())) return '電話客の名前と電話番号を入力してください'
    if (phoneCustomer && customerPhone.trim()) {
      const phoneError = phoneDigitsError(customerPhone)
      if (phoneError) return phoneError
    }
    if (!menu) return '予約メニューを選択してください'
    if (!selectedStaff) return '担当者を選択してください'
    if (!date || !time) return '空いている日時を選択してください'
    return null
  }, [selectedAccountId, friend, customer, phoneCustomer, customerName, customerPhone, menu, selectedStaff, date, time])

  // R147: 電話客の台帳保存は「登録を確定する」ときだけ行う。確認へ進む
  // 時点で作ると、入力へ戻って直した名前・電話・ペット名が確認と予約へ
  // 反映されない（保存済み顧客をそのまま使い続けるため）。確定直前に
  // その時点の入力値で1件だけ作るので、二重作成も起きない。
  async function ensureCustomerForBooking(requestKey: string): Promise<BookingCustomerSummary | null> {
    if (!phoneCustomer) return customer
    // 保存済みと入力が同じなら作り直さない（連打・続けてもう1件で二重にしない）。
    if (customer && (
      customerSavedInput.current != null && (customerSavedInput.current?.name === customerName.trim()
        && customerSavedInput.current?.phone === normalizePhone(customerPhone)
        && customerSavedInput.current?.pet === petName.trim())
    )) return customer
    if (!selectedAccountId) return null
    // R559: 応答消失後の再送で台帳を二重作成しないよう、確定操作ごとの
    // キー（予約本体のキーから派生）で送る。
    const snapshot = { name: customerName.trim(), phone: normalizePhone(customerPhone), pet: petName.trim() }
    const response = await bookingApi.createCustomer(selectedAccountId, {
      display_name: snapshot.name, phone: snapshot.phone, pet_name: snapshot.pet || undefined,
    }, customerIdempotencyKey.current || undefined)
    if (latestSelectionKey.current !== requestKey) return null
    customerSavedInput.current = snapshot
    setCustomer(response.customer)
    return response.customer
  }

  async function review() {
    if (validation) {
      setError(validation)
      return
    }
    if (!selectedAccountId || !menu || !selectedStaff || !date || !time) return
    // R147: 確認へ進むときは台帳を作らない。入力へ戻って直した値が
    // 次の確認にそのまま出る。台帳は確定時に作る。
    if (!friend && !phoneCustomer) { setError('予約するお客様を選択してください'); return }
    // R147: 台帳は確定時に作るため、ここでは友だち以外は空キーで束ねる。
    const requestKey = selectionKey
    setLoading(true)
    setError('')
    try {
      // 入力時に見えた空き枠は、確認へ進むまでに別の予約で埋まることがある。
      // 確認画面へ進む直前に同じ口を読み直し、古い空き枠を確定候補にしない。
      const latest = await bookingApi.getAvailability(selectedAccountId, {
        menuId: menu.id,
        staffId: selectedStaff.id,
        from: date,
        to: date,
      })
      if (latestSelectionKey.current !== requestKey) return
      // 読み直した結果の枠そのものを持つ。「空いていた」だけを見て古い
      // instant を送ると、店舗タイムゾーンや夏時間の切替をまたいだとき
      // 別の瞬間の予約になる。
      const available = latest.by_staff
        .find((item) => item.staff_id === selectedStaff.id)
        ?.slots.find((slot) => slot.date === date && slot.start === time) ?? null
      if (!available) {
        const staleStartIso = slotInstant(selectedSlot)
        const alternatives = staleStartIso
          ? await bookingApi.getAlternatives(selectedAccountId, {
            menuId: menu.id,
            staffId: selectedStaff.id,
            startsAt: staleStartIso,
          })
          : null
        if (latestSelectionKey.current !== requestKey) return
        setConfirmedSlot(null)
        setConflictAlternatives(alternatives)
        setStep('conflict')
        setError('選んだ時間は、ほかの予約で埋まりました')
        return
      }
      // 開始 instant を受け取れない枠は確定させない（fail-closed）。
      const freshStartIso = slotInstant(available)
      if (!freshStartIso) {
        setConfirmedSlot(null)
        setError('この時間の開始時刻を受け取れませんでした。時間を選び直してください。')
        return
      }
      const preview = await bookingApi.previewReminders(selectedAccountId, freshStartIso)
      if (latestSelectionKey.current !== requestKey) return
      setConfirmedSlot(available)
      setReminderPreview(preview.reminders)
      // R559: 確認ごとに予約と台帳のキーを1組だけ発行する。再送時は同じ組で送る。
      const freshKey = crypto.randomUUID()
      setIdempotencyKey(freshKey)
      customerIdempotencyKey.current = `${freshKey}:customer`
      setStep('confirm')
    } catch {
      if (latestSelectionKey.current !== requestKey) return
      setError('空き時間を再確認できませんでした。状態を読み直して、もう一度お試しください。')
    } finally {
      if (latestSelectionKey.current === requestKey) setLoading(false)
    }
  }

  // 二重押しで電話客の台帳が2件できないよう、確定処理の重なりを抑える。
  const bookingBusy = useRef(false)
  async function createBooking() {
    if (bookingBusy.current) return
    if (!selectedAccountId || !menu || !selectedStaff || !date || !time) return
    if (!friend && !phoneCustomer) return
    // 空キーで送ると400になる(点検#516軽5)。無ければここで作る。
    const key = idempotencyKey || crypto.randomUUID()
    if (!idempotencyKey) setIdempotencyKey(key)
    // 送るのは確認直前に読み直した枠の instant だけ。無ければ送らない。
    const startsAtIso = slotInstant(confirmedSlot)
    if (!startsAtIso) {
      setError('確認した開始時刻が見つかりません。日時を選び直してください。')
      return
    }
    bookingBusy.current = true
    const requestKey = selectionKey
    setLoading(true)
    setError('')
    try {
      // R147: 電話客の台帳はこの確定の直前に作る。確認→入力に戻る→直す→
      // 再確認の往復では作らないので、直した名前・電話・ペット名がそのまま
      // 台帳と予約へ入る。保存済みと同じ入力なら作り直さない。
      let bookingCustomer: BookingCustomerSummary | null = null
      if (phoneCustomer) {
        try {
          // R559: 台帳の作成はこの確定操作のキーで束ねる。再送時は同じ
          // 顧客が返り、台帳は1件のまま予約はその顧客IDを使う。
          // 確認を経ずに来たときだけ、ここで組を作る。
          if (!customerIdempotencyKey.current) customerIdempotencyKey.current = `${key}:customer`
          bookingCustomer = await ensureCustomerForBooking(requestKey)
        } catch {
          if (latestSelectionKey.current !== requestKey) return
          setError('電話客の情報を保存できませんでした。名前と電話番号を確認してください。')
          return
        }
      } else {
        bookingCustomer = customer
      }
      const customerPart = friend ? { friend_id: friend.id } : bookingCustomer ? { booking_customer_id: bookingCustomer.id } : null
      if (!customerPart) { setError('予約するお客様を選択してください'); return }
      if (latestSelectionKey.current !== requestKey) return
      const created = await bookingApi.createProxyBooking(selectedAccountId, {
        ...customerPart,
        menu_id: menu.id,
        staff_id: selectedStaff.id,
        starts_at: startsAtIso,
        customer_note: customerNote.trim() || undefined,
        // N-391: 選んだ通知可否を予約へ固定する。未連携は明示的に全OFFで
        // 送る（指定を残すと「実は送れない予約」が分からなくなる）。
        notification_policy: isLineLinked
          ? notification
          : { send_line_confirmation: false, day_before: false, hours_before: false },
      }, key)
      if (latestSelectionKey.current !== requestKey) return
      setResult(created)
      setCustomerContext(created.customer_context)
      // N-400: 入った予約の下書きは消す。残すと次回「書きかけ」として
      // 同じ予約が戻り、二重に入れる事故になる。
      try { window.sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${selectedAccountId}`) } catch { /* noop */ }
      setDraftRestored(false)
      setStep('done')
    } catch (cause) {
      if (latestSelectionKey.current !== requestKey) return
      if (
        cause instanceof ApiError
        && (cause.code === 'slot_conflict' || cause.code === 'slot_not_available')
      ) {
        setConflictAlternatives(cause.data as BookingConflictAlternatives | null)
        setStep('conflict')
        setError('選んだ時間は、ほかの予約で埋まりました')
      } else if (cause instanceof ApiError) {
        setError(describeApiFailure(cause, '予約の登録', { forbidden: '予約を入れられるのは、予約の操作権限を持つ人だけです。' }))
      } else {
        setError('予約を登録できませんでした。状態を確認して、もう一度お試しください。')
      }
    } finally {
      bookingBusy.current = false
      if (latestSelectionKey.current === requestKey) setLoading(false)
    }
  }

  async function recoverConflict() {
    setStep('input')
    setTime('')
    setConfirmedSlot(null)
    setConflictAlternatives(null)
    await loadSlots()
  }

  return (
    <div data-design-node={`${NODE_BY_STEP[step]} If9Mh`} className="space-y-4 pb-24">
      <div><PageHeading title={createTitle} /></div>

      {error && step !== 'conflict' && (
        <Notice
          tone="danger"
          message={error}
          onClose={() => setError('')}
          action={menusLoadError && !isForbidden(menusLoadError) ? (
            <Button type="button" onClick={() => { setError(''); void loadMenus() }}>
              もう一度読み込む
            </Button>
          ) : undefined}
        />
      )}

      {staffResolved && !canOperate ? (
        <Notice tone="warn" message="予約を入れられるのは、予約の操作権限を持つ人だけです。閲覧のみの権限では操作ボタンは出ません。" />
      ) : null}

      {draftRestored && step === 'input' ? (
        <div className="border-hairline bg-canvas-sunken text-ink-secondary rounded-card flex flex-wrap items-center justify-between gap-2 border px-4 py-2 text-xs">
          <span>書きかけの入力を戻しました。</span>
          <button type="button" onClick={discardDraft} className="text-action font-semibold">
            破棄して最初から入れ直す
          </button>
        </div>
      ) : null}

      {step === 'input' && (
        <div data-design="Body" className="grid gap-4 xl:flex">
          <div className="min-w-0 flex-1 space-y-4">
            <Card title="だれの予約ですか" note="LINEの友だちなら、名前で探して結びつけてください。LINE未連携の電話客も登録できます。">
              <div className="mb-3 flex gap-2">
                <Button className="text-xs" variant={!phoneCustomer ? 'primary' : 'secondary'} onClick={() => { setPhoneCustomer(false); setCustomer(null) }}>LINEの友だち</Button>
                <Button className="text-xs" variant={phoneCustomer ? 'primary' : 'secondary'} onClick={() => { setPhoneCustomer(true); setFriend(null) }}>LINE未連携の電話客</Button>
              </div>
              {phoneCustomer ? (
                <div className="space-y-2">
                  <SharedTextField aria-label="電話客の名前" value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="お客様の名前" className="border-hairline rounded-control w-full border px-3 py-2 text-sm" />
                  <SharedTextField aria-label="電話客の電話番号" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="電話番号" className="border-hairline rounded-control w-full border px-3 py-2 text-sm" />
                  <SharedTextField aria-label="電話客のペット名" value={petName} onChange={(event) => setPetName(event.target.value)} placeholder="ペットの名前（任意）" className="border-hairline rounded-control w-full border px-3 py-2 text-sm" />
                  {customer && savedMatchesInput ? <p className="text-success text-xs">顧客台帳に保存済み（電話末尾 {customer.phone_last4}）</p> : <p className="text-ink-faint text-xs">「この内容で予約を入れる」を押すと顧客台帳へ保存します。入力へ戻って直せます。</p>}
                </div>
              ) : friend ? (
                <div className="border-hairline bg-canvas-sunken flex items-center justify-between rounded-control border px-3 py-3">
                  <div>
                    <p className="text-ink text-sm font-medium">{friend.displayName}</p>
                    <p className="text-ink-faint mt-1 text-xs">LINE連携済み</p>
                  </div>
                  <button type="button" className="text-action text-sm" onClick={() => {
                    setFriend(null)
                    setFriendQuery('')
                  }}>選び直す</button>
                </div>
              ) : (
                <div className="relative">
                  <SharedTextField
                    ref={friendInputRef}
                    value={friendQuery}
                    onChange={(event) => {
                      setFriendQuery(event.target.value)
                      setFriendSuggestOpen(true)
                    }}
                    placeholder="名前・電話番号で探す"
                    className="border-hairline rounded-control w-full border px-3 py-2 text-sm"
                  />
                  <MenuPortal
                    open={friendSuggestOpen && friends.length > 0}
                    align="start"
                    matchWidth
                    getAnchor={() => friendInputRef.current}
                    onClose={() => setFriendSuggestOpen(false)}
                  >
                    <div
                      className="border-hairline bg-canvas max-h-64 divide-y divide-hairline overflow-y-auto rounded-control border shadow-float"
                      // 最上層では absolute 指定を無効にする（位置は器が決める）。
                      style={{ position: 'static', width: '100%' }}
                    >
                      {friends.map((item) => (
                        <button key={item.id} type="button" onClick={() => {
                          setFriend(item)
                          setFriendQuery(item.displayName)
                          setFriendSuggestOpen(false)
                        }} className="hover:bg-canvas-sunken block w-full px-3 py-2 text-left text-sm">
                          {item.displayName}
                        </button>
                      ))}
                    </div>
                  </MenuPortal>
                </div>
              )}
              {!phoneCustomer ? <p className="text-ink-faint mt-2 text-xs">別の友だちへ推測で結び付けず、選んだ相手だけに予約を記録します。</p> : null}
              <p className="text-ink-faint mt-2 text-xs">この方について入力した情報は、予約と顧客台帳に残ります。</p>
            </Card>

            <Card title="いつ・何を">
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="予約メニュー">
                  <EntitySelect kind="booking_menu"
                    aria-label="予約メニュー"
                    value={menuId}
                    onChange={setMenuId}
                    options={[{ value: '', label: '選択してください' }, ...menus.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.name }))]}
                    size="full"
                  />
                </Field>
                <Field label="スタッフ">
                  <EntitySelect
                    aria-label="スタッフ"
                    value={staffId}
                    onChange={setStaffId}
                    options={[{ value: '', label: '選択してください' }, ...staff.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: item.display_name }))]}
                    disabled={!menuId}
                    size="full"
                  />
                </Field>
                <Field label="日付">
                  <DateField name="date" value={date} onChange={setDate} aria-label="日付" />
                </Field>
                <Field label="空いている時間">
                  <Select
                    aria-label="空いている時間"
                    value={time}
                    onChange={setTime}
                    options={[
                      { value: '', label: loading ? '確認中です' : '選択してください' },
                      ...slots.map((slot) => ({ value: slot.start, label: `${slot.start}〜${slot.end}` })),
                    ]}
                    disabled={!date || loading}
                    size="full"
                  />
                </Field>
              </div>
              {date && time && selectedStaff && menu ? (
                <Notice tone="success" className="mt-3">
                  {dateLabel(slotStartIso, slotTimeZone)} は空いています。{selectedStaff.duration_minutes}分のメニューです。
                </Notice>
              ) : null}
            </Card>

            <Card title="お客様からの要望">
              <SharedTextArea aria-label="お客様からの要望" value={customerNote} onChange={(event) => setCustomerNote(event.target.value)} rows={4} className="border-hairline rounded-control w-full border px-3 py-2 text-sm" placeholder="予約時に確認した内容を入力" />
            </Card>

            <Card title="お客様に何を送りますか" note="LINEと結びついている方には、予約後の案内を送ります。送らない選択もできます。">
              {isLineLinked || (!phoneCustomer && !friend) ? (
                <div className="space-y-3">
                  <NotificationToggle
                    checked={notification.send_line_confirmation}
                    onChange={(checked) => setNotification((prev) => ({ ...prev, send_line_confirmation: checked }))}
                    title="予約を受け付けたことを、いますぐLINEに送る"
                    detail="日時・メニュー・担当を書いた案内が届きます。"
                  />
                  <NotificationToggle
                    checked={notification.day_before}
                    onChange={(checked) => setNotification((prev) => ({ ...prev, day_before: checked }))}
                    title="前日に思い出してもらう"
                    detail="予約設定から計算した時刻に送ります。"
                  />
                  <NotificationToggle
                    checked={notification.hours_before}
                    onChange={(checked) => setNotification((prev) => ({ ...prev, hours_before: checked }))}
                    title="当日のお知らせを送る"
                    detail="開始まで十分な時間がある場合だけ送ります。"
                  />
                </div>
              ) : (
                // N-390: LINEと結びつかない電話客には送信UIを見せない。
                <p className="text-ink-faint text-sm">
                  LINEと結びついていないため、自動のお知らせは届きません。
                  連絡は電話などで直接行ってください。
                </p>
              )}
            </Card>
          </div>

          <div data-design="Right" className="w-full space-y-4 xl:flex-none" style={{ maxWidth: 390 }}>
            <Card title={friend ? `${withHonorific(friend.displayName)}にはこう届きます` : 'お客様にはこう届きます'}>
              {phoneCustomer && !isLineLinked ? (
                // N-390: 未連携の電話客へLINEプレビューを見せると
                // 「送れる」と誤解させる。実態をそのまま伝える。
                <p className="text-ink-faint rounded-card bg-canvas-sunken p-4 text-sm">
                  LINEと結びついていないため、LINEのお知らせは届きません。
                </p>
              ) : (
                <LinePreview>
                  <div className="rounded-card bg-canvas p-4 text-sm leading-6">
                    <p>{withHonorific(friend?.displayName ?? 'お客様', 'さま')}</p>
                    <p className="font-semibold">ご予約を承りました。</p>
                    <p className="mt-3">{slotStartIso ? dateLabel(slotStartIso, slotTimeZone) : '日時を選ぶと表示されます'}</p>
                    <p>{menu?.name ?? 'メニューを選ぶと表示されます'} ／ 担当 {selectedStaff?.display_name ?? '—'}</p>
                  </div>
                </LinePreview>
              )}
            </Card>
            <Card title="この方について">
              {customerContext ? (
                <div className="space-y-2 text-xs">
                  <p><strong className={customerContext.isLineLinked ? 'text-success' : 'text-warning'}>{customerContext.isLineLinked ? 'LINEと結びついています' : 'LINE未連携の電話客です'}</strong></p>
                  <p><span className="text-ink-faint">電話</span>　{customerContext.phone ?? '登録なし'}</p>
                  <p><span className="text-ink-faint">ペット</span>　{customerContext.petName ?? '登録なし'}</p>
                  <p><span className="text-ink-faint">これまでの予約</span>　{formatNumber(customerContext.recentBookings.length)}件</p>
                  <p><span className="text-ink-faint">前回の申し送り</span>　{customerContext.previousHandover ?? 'ありません'}</p>
                  {customerContext.tags.length > 0 ? <p><span className="text-ink-faint">タグ</span>　{customerContext.tags.map((tag) => tag.name).join('、')}</p> : null}
                </div>
              ) : <p className="text-ink-faint text-xs">友だちを選ぶと、連絡方法と来店履歴を確認できます。</p>}
            </Card>
            <Card title="つながる先">
              <div className="text-ink-secondary space-y-2 text-xs">
                <p>→ 予約管理　入れたあとの台帳</p>
                <p>→ 予約設定　メニューと空き枠</p>
                <p>→ リマインダ　前日・当日のお知らせ</p>
                <p>→ 友だち　顧客カルテに残ります</p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {step === 'confirm' && (friend || customer || phoneCustomer) && menu && selectedStaff && (
        <div data-design="Body" className="grid gap-4 xl:grid-cols-4">
          <div data-design="Left" className="min-w-0 space-y-4 xl:col-span-3">
            <Card title="だれの予約か">
              <Summary label="お客様" value={customerLabel} />
              <Summary label="電話番号" value={friend ? '友だち情報欄で確認' : `末尾 ${customerPhoneLast4 ?? '—'}`} />
              <Summary label="ペットの名前" value={customerPetLabel ?? '未入力'} />
              <Summary label="LINEとの結びつき" value={isLineLinked ? '結びついています' : '未連携の電話客'} />
            </Card>
            <Card title="いつ・何を">
              <Summary label="日時" value={timeRangeLabel(slotStartIso, occupiedMinutes, slotTimeZone, slotEndIso)} />
              <Summary label="メニュー" value={`${menu.name}（${occupiedMinutes}分）`} />
              <Summary label="担当" value={selectedStaff.display_name} />
              <Summary label="お客様からのご希望" value={customerNote.trim() || '記入なし'} />
            </Card>
            <Card title="お客様に送るもの">
              {!isLineLinked ? (
                <p className="text-ink-faint text-sm">
                  LINEと結びついていないため、自動のお知らせは届きません。
                </p>
              ) : (
                <>
                  {notification.send_line_confirmation ? (
                    <NoticeRow title="いますぐ LINE に送る" detail="日時・メニュー・担当を書いた案内が届きます" />
                  ) : null}
                  {reminderPreview
                    .filter((reminder) => notification[reminder.kind === 'day_before' ? 'day_before' : 'hours_before'])
                    .map((reminder) => (
                      <NoticeRow key={reminder.kind} title={`${scheduleLabel(reminder.scheduledAt, slotTimeZone)} に思い出してもらう`} detail="予約設定から計算した実際の送信予定です" />
                    ))}
                  {!notification.send_line_confirmation
                    && reminderPreview.filter((r) => notification[r.kind === 'day_before' ? 'day_before' : 'hours_before']).length === 0 ? (
                      <p className="text-ink-faint text-xs">
                        お知らせはすべて送らない設定です。登録だけを行います。
                      </p>
                    ) : null}
                </>
              )}
            </Card>
            <Notice tone="success" data-booking-slot-check="available">
              この日時は、確認画面を開く直前に空きを再確認しました。
            </Notice>
          </div>
          <aside data-design="Right" className="space-y-4">
            <Card title={`${withHonorific(customerLabel)}にはこう届きます`} note="送る前に、文面をそのまま確かめられます。">
              <BookingConfirmPreview friendName={customerLabel} menuName={menu.name} staffName={selectedStaff.display_name} timeZone={slotTimeZone} startUtc={slotStartIso} deliveryStatus={isLineLinked && notification.send_line_confirmation ? 'not_sent' : 'not_applicable'} />
            </Card>
            <WarningCard title="気をつけること" lines={['LINEと結びついていない方には、自動のお知らせは届きません', 'あとで時間を変えたときは、もう一度お知らせを送ってください']} />
            <RelatedLinks includeConversion={false} />
          </aside>
        </div>
      )}

      {step === 'conflict' && (friend || customer || phoneCustomer) && menu && selectedStaff && (
        <>
          <Notice
            tone="danger"
            action={<Button onClick={() => void recoverConflict()}>空いている時間を選び直す</Button>}
          >
            <p className="text-sm font-semibold">{dateLabel(slotStartIso, slotTimeZone)} は {selectedStaff.display_name} がふさがっています</p>
            <p className="mt-1 text-xs">
              {conflictAlternatives
                ? `${scheduleLabel(conflictAlternatives.conflict.from, slotTimeZone)}〜${scheduleLabel(conflictAlternatives.conflict.to, slotTimeZone)}に${formatNumber(conflictAlternatives.conflict.count)}件重なっています（${conflictAlternatives.conflict.source === 'internal_booking' ? '店内予約' : conflictAlternatives.conflict.source === 'google_calendar' ? 'Google予定' : '受付時間外'}）。`
                : ''}
              時間か担当を変えてください。
            </p>
          </Notice>
          <div data-design="Body" className="grid gap-4 xl:grid-cols-4">
            <div data-design="Left" className="min-w-0 space-y-4 xl:col-span-3">
              <Card title="だれの予約か"><Summary label="お客様" value={customerLabel} /><Summary label="LINEとの結びつき" value={isLineLinked ? '結びついています' : '未連携の電話客'} /></Card>
              <Card title="いつ・何を" note="時間が重なっています。右の空いている時間から選べます。">
                <Summary label="メニュー" value={`${menu.name}（${occupiedMinutes}分）`} />
                <Summary label="日付" value={formatDay(slotStartIso, '—', undefined, slotTimeZone)} />
                <Summary label="時刻" value={time} />
                <Summary label="担当" value={selectedStaff.display_name} />
                <p className="text-danger mt-3 text-xs">選んだ時間は、ほかの予約で埋まりました。</p>
              </Card>
              <Card title="お客様に何を送りますか" note={isLineLinked ? '登録すると、選んだお知らせを送ります。' : 'LINE未連携のため、自動のお知らせは届きません。'}>
                {isLineLinked && notification.send_line_confirmation ? <NoticeRow title="予約を受け付けたことを、いますぐLINEに送る" detail="日時・メニュー・担当を書いた案内が届きます" /> : null}
                {isLineLinked && (notification.day_before || notification.hours_before) ? <NoticeRow title="開始前に思い出してもらう" detail="選んだお知らせを送ります" /> : null}
              </Card>
            </div>
            <aside data-design="Right" className="space-y-4">
              <Card title="空いている時間" note={`${selectedStaff.display_name}の ${date || '選択日'} で、続けて取れるところです。`}>
                <div className="space-y-2">
                  {(conflictAlternatives?.nearbySlots ?? slots.filter((slot) => slot.date === date && slot.start !== time).slice(0, 3)).map((slot) => <div key={slot.start} className="border-hairline flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0"><span className="text-sm font-semibold">{slot.start} 〜 {slot.end}</span><Button onClick={() => { setTime(slot.start); setStep('input'); setConflictAlternatives(null); setError('') }}>この時間に変える</Button></div>)}
                </div>
              </Card>
              <Card title="ほかの担当なら入れられます">
                {conflictAlternatives?.alternateStaff.length ? (
                  <div className="space-y-2">{conflictAlternatives.alternateStaff.map((candidate) => (
                    <div key={candidate.staffId} className="border-hairline flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
                      <span className="text-sm font-semibold">{candidate.displayName}　{candidate.slot.start}〜{candidate.slot.end}</span>
                      <Button onClick={() => { pendingSelect.current = { staffId: candidate.staffId, date: candidate.slot.date, time: candidate.slot.start }; setStaffId(candidate.staffId); setTime(''); setStep('input'); setConflictAlternatives(null); setError('') }}>この担当に変える</Button>
                    </div>
                  ))}</div>
                ) : <p className="text-ink-faint text-xs">同じ時刻に空いている別担当はいません。</p>}
              </Card>
              <WarningCard title="気をつけること" lines={['重なったまま予約を入れることはできません', '入力したお客様・メニュー・担当・要望は残っています']} />
              <RelatedLinks includeConversion={false} />
            </aside>
          </div>
        </>
      )}

      {step === 'done' && result && (friend || customer || phoneCustomer) && menu && selectedStaff && (
        <>
          <section className="bg-action-soft text-action rounded-card px-4 py-3 text-xs font-semibold">
            {timeRangeLabel(slotStartIso, occupiedMinutes, slotTimeZone, slotEndIso)} の枠を押さえました。{isLineLinked && result.reminders.length > 0 ? 'お知らせは、下に表示する予定で自動送信します。' : '自動のお知らせの予定はありません。'}
          </section>
          <div data-design="Body" className="grid gap-4 xl:grid-cols-4">
            <div data-design="Left" className="min-w-0 space-y-4 xl:col-span-3">
              <Card title="入れた予約">
                <Summary label="お客様" value={customerLabel} />
                <Summary label="日時" value={timeRangeLabel(slotStartIso, occupiedMinutes, slotTimeZone, slotEndIso)} />
                <Summary label="メニュー" value={`${menu.name}（${occupiedMinutes}分）`} />
                <Summary label="担当" value={selectedStaff.display_name} />
                <Summary label="受けかた" value="電話（代理で入力）" />
                <Summary label="予約ID" value={result.booking_id} />
                <Summary label="Googleカレンダー" value={result.calendar_sync === 'synced' ? '反映済み' : result.calendar_sync === 'failed' ? '反映に失敗' : result.calendar_sync === 'pending' ? '確認中' : '未設定'} />
              </Card>
              <Card title="このあと自動で動くもの">
                <NoticeRow
                  title={`予約確認LINE: ${confirmationOperation ? operationStatusLabel(confirmationOperation.status) : result.line_notification === 'not_applicable' ? '送信しない' : '処理中'}`}
                  detail={confirmationOperation?.status === 'permanent_failed' ? '送信に失敗しました。予約詳細から確認してください' : '送信結果と開封状況は受信箱から確認できます'}
                />
                {result.reminders.map((reminder) => <NoticeRow key={reminder.id} title={`${scheduleLabel(reminder.scheduled_at, slotTimeZone)} にお知らせ`} detail={`リマインダ: ${reminder.status === 'pending' ? '送信予定' : reminder.status}`} />)}
                <Summary label="リマインダの時刻" value={result.reminders.map((item) => scheduleLabel(item.scheduled_at, slotTimeZone)).join(' ／ ') || '今後の送信予定はありません'} />
                {automaticOperations.map((operation) => <Summary key={operation.id} label={operation.kind === 'conversion' ? '成果' : operation.kind === 'mileage' ? 'マイル' : '自動化'} value={operationStatusLabel(operation.status)} />)}
                <Summary label="予約台帳" value="1件追加（電話で受けた予約も同じ台帳へ記録します）" />
              </Card>
              <Card title="次にすること">
                <div className="flex flex-wrap gap-2"><Button variant="primary" href="/booking/bookings">今日の台帳を見る</Button><Button href={`/booking/bookings/detail?id=${encodeURIComponent(result.booking_id)}`}>この予約の詳細を見る</Button><Button onClick={() => { setStep('input'); setResult(null); setTime(''); setIdempotencyKey(''); customerIdempotencyKey.current = '' }}>続けてもう1件入れる</Button></div>
              </Card>
            </div>
            <aside data-design="Right" className="space-y-4">
              <Card title="お客様に届くもの" note="案内処理の実績と同じ状態を表示しています。"><BookingConfirmPreview friendName={customerLabel} menuName={menu.name} staffName={selectedStaff.display_name} timeZone={slotTimeZone} startUtc={slotStartIso} deliveryStatus={!isLineLinked || !notification.send_line_confirmation ? 'not_applicable' : confirmationOperation?.status ?? result.line_notification} /></Card>
              <RelatedLinks includeConversion />
            </aside>
          </div>
        </>
      )}

      {/* N-401: 閲覧のみの人には確認・登録の操作バーを出さない */}
      {canOperate && (step === 'input' || step === 'confirm' || step === 'conflict') && (
        <StickyBar
          status={step === 'input' ? 'まだ入っていません。保存すると台帳に並び、お客様にもお知らせします。' : step === 'confirm' ? 'まだ入っていません。「予約を入れる」を押すと台帳に並びます。' : '直すところがあります。時間を選び直すまで台帳には入りません。'}
          actions={(
            <>
              {(step === 'confirm' || step === 'conflict') && <Button onClick={() => { setStep('input'); setError('') }}>入力に戻る</Button>}
              {step === 'confirm' && friend && confirmedSlot ? <Button href={`/booking/bookings?${new URLSearchParams({ series: 'new', seriesAt: slotInstant(confirmedSlot) ?? '', seriesMenu: menuId, seriesStaff: staffId, seriesFriend: friend.id, seriesName: friend.displayName ?? '', seriesTimeZone: slotTimeZone })}`}>繰り返して入れる</Button> : null}
              {step === 'input' ? (
                <Button variant="primary" disabled={loading} data-qa-open="GFDqW" onClick={() => void review()} busy={loading} busyLabel="空きを再確認しています">予約内容を確認する
                </Button>
              ) : step === 'confirm' ? (
                <Button variant="primary" disabled={loading} data-qa-open="GfceK" onClick={() => void createBooking()} busy={loading} busyLabel="登録中です">この内容で予約を入れる
                </Button>
              ) : <Button variant="primary" disabled>この内容で予約を入れる</Button>}
            </>
          )}
        />
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-ink-secondary block text-xs"><span className="mb-1.5 block font-medium">{label}</span>{children}</label>
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="border-hairline grid gap-3 border-b py-2 text-sm last:border-b-0" style={{ gridTemplateColumns: '140px minmax(0, 1fr)' }}><span className="text-ink-faint">{label}</span><span className="text-ink">{value}</span></div>
}

function NoticeRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-3 flex gap-3 last:mb-0">
      <span className="text-success font-bold">✓</span>
      <div><p className="text-ink text-sm font-medium">{title}</p><p className="text-ink-faint mt-0.5 text-xs">{detail}</p></div>
    </div>
  )
}

function BookingConfirmPreview({ friendName, menuName, staffName, timeZone, startUtc, deliveryStatus }: {
  friendName: string
  menuName: string
  staffName: string
  timeZone?: string
  startUtc: string
  deliveryStatus: string
}) {
  const deliveryLabel = deliveryStatus === 'succeeded' ? '送信済み・開封状況は受信箱で確認できます'
    : deliveryStatus === 'queued' ? '送信処理中です'
      : deliveryStatus === 'scheduled' ? '送信予定です'
        : deliveryStatus === 'permanent_failed' || deliveryStatus === 'failed' ? '送信に失敗しました'
          : deliveryStatus === 'not_applicable' ? 'LINE未連携のため送信しません'
            : '「予約を入れる」を押すと、すぐに届きます'
  return (
    <>
    {/* 送信の状態は動く情報なので、枠の外に見えるまま残す（? には入れない）。 */}
    <p className="text-ink-secondary mb-2 text-center text-xs">{deliveryLabel}</p>
    <LinePreview>
      <div className="bg-canvas rounded-card p-4 text-sm leading-6">
        <p>{withHonorific(friendName, 'さま')}</p>
        <p>{dateLabel(startUtc, timeZone)} から、{menuName}をお受けしました。</p>
        <p>担当は{staffName}です。ご来店をお待ちしています。</p>
        <Button href="/booking/bookings" variant="primary" className="mt-3 w-full">予約内容を確認する</Button>
      </div>
    </LinePreview>
    </>
  )
}

function WarningCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Notice tone="warn" heading={<> <h2>{title}</h2> </>}>

      <ul className="mt-3 space-y-2 text-xs">{lines.map((line) => <li key={line}>・{line}</li>)}</ul>
    </Notice>
  )
}
