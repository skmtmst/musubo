'use client'

import { storedStringList } from '@/lib/stored-json'
import Toggle from '@/components/shared/toggle'
import { createPageReturnHref } from '@/components/shared/create-page'
import { notifySaved, notifyToast } from '@/components/shared/toast'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import Combobox from '@/components/shared/combobox'
import Select from '@/components/shared/select'
import { CreatePage } from '@/components/templates/create-page'
import PreviewLauncher from '@/components/templates/preview-launcher'
import { Pencil, Smartphone, Upload } from 'lucide-react'
import CheckCard from '@/components/shared/check-card'
import { useMenuPayment } from '@/v8/booking-payments/public/menu-payment/index'
import { BookingMenuPaymentCard, useMenuDeposit } from '@/v8/booking-payments/public/menu-deposit/index'
import { MeetingModeCard, useMenuMeeting, type MeetingMode } from './meeting-mode'
import ListState from '@/components/shared/list-state'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useAccount } from '@/contexts/account-context'
import { usePermissionAccess } from '@/lib/use-feature-access'
import { useBookingEdit } from './lib/edit-permission'
import { classifyApiFailure, describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { formatNumber } from '@/lib/format'
import { api, ApiError, bookingApi, type BookingMenu, type BookingMenuWrite, type BookingResource, type BookingSettings, type BookingStaff, type StaffMenuMatrix } from '@/lib/api'
import type { Tag } from '@line-crm/shared'
import { bookingMenuBufferError, bookingMenuDurationError, bookingMenuError, bookingMenuNameError } from './lib/menu-validation'
import MenuVersionHistory from './menu-version-history'
import { LiffPhoneMenuStep } from './liff-phone'
import shell from './settings.module.css'
import styles from './menu-form.module.css'
import { PageFrame, PageContent } from '@/components/templates/page-frame'
import { Field } from '@/components/shared/form-controls'
import { TextField, AffixedTextField } from '@/components/shared/text-field'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import Card, { CardHeader } from '@/components/shared/card'
import type { FormRequirement } from '@/lib/form-requirement'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { EntityPickerField } from '@/components/shared/entity-picker'
import Notice from '@/components/shared/notice'
import { AudienceSection, audienceVisibility, type AudienceMode } from './audience-section'
import { CustomerBookingCard, useMenuCustomerBooking } from './customer-booking'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import type { FriendListItem } from '@/lib/api'
import HelpTip from '@/components/shared/help-tip'
import { isSaveConflict } from '@/components/shared/api-error-message'

/**
 * ★V8「予約メニューを作る」（板 ・競合時 ）。
 *
 * 左に5つの段（中身・担当・きまり・受け方・受けたとき・設備・支払い）、
 * 右に本物そっくりのお客さまの予約画面。作っているメニューが写しの
 * 先頭に選ばれた状態で出るので、入力しながら見え方を確かめられる。
 *
 * `?menu=<id>` が付いていると編集になる。保存は 管理画面 と同じ契約：
 *   作る … createMenu（何度押しても増えないよう試行ごとの一意キー）
 *        → 担当ごとに staff_menus を PUT → 設備を PUT
 *   直す … updateMenu（版つき PUT）→ 変わった担当だけ PUT → 設備を PUT
 * 409 は板  の帯を出し、「違いを比べる」「最新を読み込んで続ける」
 * 「比べてから保存」で扱う（いきなり上書きしない）。
 */

function resourceSignature(ids: Iterable<string>, quantities: Record<string, string>) {
  return JSON.stringify([...ids].sort().map((id) => [id, quantities[id] ?? '1']))
}

type LoadStatus = 'loading' | 'ready' | 'error'

/** 作りかけ／直しかけのメニューを、写し側へ渡す形にする。 */
const menuNameRequirement: FormRequirement<unknown> = { required: true, check: bookingMenuNameError }
const menuDurationRequirement: FormRequirement<unknown> = { required: true, check: bookingMenuDurationError }

type DraftMenu = Pick<
  BookingMenu,
  'id' | 'name' | 'category_label' | 'description' | 'duration_minutes' | 'base_price' | 'price_mode' | 'sort_order' | 'is_active' | 'auto_tag_id'
>

function conflictTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 編集中身の読み込み待ちの骨組み（本物と同じ段の形。読み上げは呼び出し側の aria-busy で1回だけ）。 */
function MenuFormSkeleton() {
  return (
    <div aria-hidden="true">
      <header className={shell.boardHead} data-design="Head">
        <Skeleton width={64} height={16} />
        <Skeleton width={200} height={22} />
        <Skeleton width={260} height={14} />
      </header>
      <div className={shell.body} data-design="Body">
        <div className={shell.main}>
          {[0, 1, 2].map((section) => (
            <section key={section} className={shell.section}>
              <div className={shell.sectionHead}>
                <Skeleton width={120} height={18} />
              </div>
              <div className={styles.fieldGrid}>
                <Skeleton width="100%" height={32} />
                <Skeleton width="100%" height={32} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 札の並びの読み込み待ちの骨組み（担当・設備の本物と同じ高さの札3枚）。 */
function ChipRowSkeleton() {
  return (
    <span className={`${styles.chipRow} mt-3`} aria-hidden="true">
      <Skeleton width={120} height={32} />
      <Skeleton width={96} height={32} />
      <Skeleton width={136} height={32} />
    </span>
  )
}

function cutoffStoreLabel(settings: BookingSettings | null): string {
  if (!settings) return 'お店のきまり'
  return `お店のきまり（${settings.cutoffMinutesBefore / 60}時間前）`
}

function cancelStoreLabel(settings: BookingSettings | null): string {
  if (!settings) return 'お店のきまり'
  const minutes = settings.cancelDeadlineMinutesBefore
  if (minutes === 1440) return 'お店のきまり（前日まで）'
  return `お店のきまり（${minutes / 60}時間前）`
}

export default function MenuFormV8() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('menu')
  const { selectedAccountId, selectedAccount } = useAccount()
  const workerBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const previewUrl = selectedAccount?.liffId
    ? `${workerBase}/o?liffId=${encodeURIComponent(selectedAccount.liffId)}&page=salon-book`
    : null

  const canEdit = useBookingEdit('/booking/menus')
  const canManageResources = usePermissionAccess('booking.settings')

  /* ---- 読み込むデータ ---- */
  const [menus, setMenus] = useState<BookingMenu[]>([])
  const [menusStatus, setMenusStatus] = useState<LoadStatus>('loading')
  const [staff, setStaff] = useState<BookingStaff[]>([])
  const [staffStatus, setStaffStatus] = useState<LoadStatus>('loading')
  const [staffError, setStaffError] = useState<unknown>(null)
  const [settings, setSettings] = useState<BookingSettings | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [resources, setResources] = useState<BookingResource[]>([])
  const [resourcesStatus, setResourcesStatus] = useState<LoadStatus>('loading')
  const [bookingMileage, setBookingMileage] = useState<number | null>(null)
  const [mileageStatus, setMileageStatus] = useState<LoadStatus>('loading')

  /* ---- 編集対象 ---- */
  const [editTarget, setEditTarget] = useState<BookingMenu | null>(null)
  const [editStatus, setEditStatus] = useState<LoadStatus>(editId ? 'loading' : 'ready')
  const [editError, setEditError] = useState<string | null>(null)

  /* ---- 入力 ---- */
  const [name, setName] = useState('')
  const [categoryLabel, setCategoryLabel] = useState('')
  const [categoryNew, setCategoryNew] = useState('')
  const [categoryPicking, setCategoryPicking] = useState(false)
  const [description, setDescription] = useState('')
  const [durationMinutes, setDurationMinutes] = useState('60')
  const [basePrice, setBasePrice] = useState('')
  const [concurrentCapacity, setConcurrentCapacity] = useState('1')
  const [bufferAfterMinutes, setBufferAfterMinutes] = useState('0')
  const [assigned, setAssigned] = useState<Set<string>>(new Set())
  const [noAssign, setNoAssign] = useState(false)
  const [ownRules, setOwnRules] = useState(false)
  const [windowDays, setWindowDays] = useState('')
  const [cutoffHours, setCutoffHours] = useState('')
  const [cancelDeadlineHours, setCancelDeadlineHours] = useState('')
  const [askQuestion, setAskQuestion] = useState(false)
  const [intakeQuestion, setIntakeQuestion] = useState('')
  const [autoTagId, setAutoTagId] = useState<string | null>(null)
  /* タグ条件は管理者だけが変更し、読み取りの列名と保存時の項目名を区別する。 */
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('all')
  const [audienceTagIds, setAudienceTagIds] = useState<string[]>([])
  const [previewFriendId, setPreviewFriendId] = useState('')
  const [previewFriends, setPreviewFriends] = useState<FriendListItem[]>([])
  const canEditAudience = canManageRole(useStaffRole())
  /* お客さまの予約のしかた（B4・B5）。変えられるのは見せる相手と同じくオーナー・管理者だけ。 */
  const customerBooking = useMenuCustomerBooking(canEditAudience)
  const loadCustomerBooking = customerBooking.load
  const [resourceIds, setResourceIds] = useState<Set<string>>(new Set())
  const [resourceQuantities, setResourceQuantities] = useState<Record<string, string>>({})
  const [resourceSaving, setResourceSaving] = useState(false)
  const [resourceMessage, setResourceMessage] = useState<string | null>(null)
  const resourceSubmitRef = useRef<number | null>(null)

  /* ---- 保存・競合 ---- */
  const [saving, setSaving] = useState<null | 'draft' | 'publish' | 'conflict'>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /* 欄を離れたときに出す1欄ずつの直し方（文は保存時と同じ）。 */
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; duration?: string; buffer?: string; staff?: string }>({})
  const formRef = useRef<HTMLDivElement>(null)
  const focusInvalid = useRef(false)
  useEffect(() => {
    if (!focusInvalid.current) return
    focusInvalid.current = false
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    field?.focus(); field?.scrollIntoView?.({ block: 'center' })
  }, [fieldErrors])

  const [conflict, setConflict] = useState<{ name: string; author: string | null; at: string | null; version: number } | null>(null)
  const [comparing, setComparing] = useState(false)
  /** 作成済みなのに後工程が残っている（DEEP-16）。再押しても作り直さない。 */
  const [createdMenuNeedingFollowUp, setCreatedMenuNeedingFollowUp] = useState<{
    menuId: string
    remainingStaffIds: string[]
    resourcesPending: boolean
  } | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())

  const generationRef = useRef(0)
  /* 409 の帯。保存は下の帯から押すので、出たら帯まで戻して見せる（押した場所のままだと気づかない）。 */
  const conflictRef = useRef<HTMLDivElement | null>(null)
  /** 読み込み直後の入力の形。これと違ったら「直しかけ」とみなす（破棄確認用）。 */
  const baselineRef = useRef('')

  const fillFrom = useCallback((menu: BookingMenu, matrices: Record<string, StaffMenuMatrix[]>, staffList: BookingStaff[]) => {
    setName(menu.name)
    setCategoryLabel(menu.category_label ?? '')
    setCategoryPicking(false)
    setCategoryNew('')
    setDescription(menu.description ?? '')
    setDurationMinutes(String(menu.duration_minutes))
    setBasePrice(menu.price_mode === 'inquiry' ? '' : String(menu.base_price))
    setConcurrentCapacity(String(menu.concurrent_capacity ?? 1))
    setBufferAfterMinutes(String(menu.buffer_after_minutes ?? 0))
    const own = menu.booking_window_days != null || menu.cutoff_hours_before != null || menu.cancel_deadline_hours_before != null
    setOwnRules(own)
    setWindowDays(menu.booking_window_days != null ? String(menu.booking_window_days) : '')
    setCutoffHours(menu.cutoff_hours_before != null ? String(menu.cutoff_hours_before) : '')
    setCancelDeadlineHours(menu.cancel_deadline_hours_before != null ? String(menu.cancel_deadline_hours_before) : '')
    setAskQuestion(Boolean(menu.intake_question))
    setIntakeQuestion(menu.intake_question ?? '')
    setAutoTagId(menu.auto_tag_id)
    {
      const wide = menu as BookingMenu & { audience_mode?: AudienceMode; audience_tag_ids_json?: string | null }
      setAudienceMode(wide.audience_mode ?? 'all')
      setAudienceTagIds(storedStringList(wide.audience_tag_ids_json))
    }
    loadCustomerBooking(menu)
    setResourceIds(new Set((menu.assigned_resources ?? []).map((item) => item.resourceId)))
    setResourceQuantities(Object.fromEntries((menu.assigned_resources ?? []).map((item) => [item.resourceId, String(item.quantity)])))
    const ids = new Set<string>()
    for (const [staffId, matrix] of Object.entries(matrices)) {
      if (matrix.some((row) => row.menu_id === menu.id && row.is_offered)) ids.add(staffId)
    }
    setAssigned(ids)
    const optionalHit = [...ids].some((id) => staffList.find((person) => person.id === id)?.is_designation_optional === 1)
    setNoAssign(optionalHit)
    baselineRef.current = JSON.stringify([
      menu.name, menu.category_label ?? '', menu.description ?? '', String(menu.duration_minutes),
      menu.price_mode === 'inquiry' ? '' : String(menu.base_price), String(menu.concurrent_capacity ?? 1),
      String(menu.buffer_after_minutes ?? 0), own,
      // WEB064：入力欄と同じ文字の形でそろえる（数のままだと開いた直後から「直しかけ」になる）。
      menu.booking_window_days != null ? String(menu.booking_window_days) : '',
      menu.cutoff_hours_before != null ? String(menu.cutoff_hours_before) : '',
      menu.cancel_deadline_hours_before != null ? String(menu.cancel_deadline_hours_before) : '',
      Boolean(menu.intake_question), menu.intake_question ?? '', menu.auto_tag_id,
      [...ids].sort().join(','), resourceSignature((menu.assigned_resources ?? []).map((item) => item.resourceId), Object.fromEntries((menu.assigned_resources ?? []).map((item) => [item.resourceId, String(item.quantity)]))),
      optionalHit,
    ])
  }, [loadCustomerBooking])

  const loadAll = useCallback(async () => {
    if (!selectedAccountId) {
      setMenusStatus('ready')
      setStaffStatus('ready')
      setEditStatus('ready')
      setResourcesStatus('ready')
      return
    }
    const generation = ++generationRef.current
    const alive = () => generationRef.current === generation
    setMenusStatus('loading')
    setStaffStatus('loading')
    setStaffError(null)
    setEditStatus(editId ? 'loading' : 'ready')
    setEditError(null)
    setResourcesStatus('loading')

    const [menusResult, staffResult, settingsResult, resourcesResult, matricesResult] = await Promise.allSettled([
      bookingApi.listMenus(selectedAccountId),
      bookingApi.listStaff(selectedAccountId),
      bookingApi.getSettings(selectedAccountId),
      bookingApi.listResources(selectedAccountId),
      bookingApi.listStaffMenusBulk(selectedAccountId),
    ])
    if (!alive()) return

    const list = menusResult.status === 'fulfilled' ? (menusResult.value.menus ?? []) : []
    setMenus(list)
    setMenusStatus(menusResult.status === 'fulfilled' ? 'ready' : 'error')

    if (staffResult.status === 'fulfilled') {
      setStaff(staffResult.value.staff)
      setStaffStatus('ready')
    } else {
      setStaff([])
      setStaffStatus('error')
      setStaffError(staffResult.reason)
    }
    if (settingsResult.status === 'fulfilled' && settingsResult.value.success) {
      setSettings(settingsResult.value.data)
    } else {
      setSettings(null)
    }
    if (resourcesResult.status === 'fulfilled') {
      setResources(resourcesResult.value.data.resources)
      setResourcesStatus('ready')
    } else {
      setResourcesStatus('error')
    }

    if (editId) {
      const target = list.find((menu) => menu.id === editId) ?? null
      if (!target) {
        setEditStatus('error')
        setEditError(menusResult.status === 'fulfilled'
          ? 'このメニューは見つかりませんでした。消されたか、別のアカウントのものです。'
          : bookingErrorText(menusResult.reason, '読み込み'))
      } else if (matricesResult.status === 'rejected' || staffResult.status === 'rejected') {
        setEditStatus('error')
        setEditError('担当を読み込めませんでした。もう一度読み込んでください。')
      } else {
        const matrices: Record<string, StaffMenuMatrix[]> = {}
        if (matricesResult.status === 'fulfilled') {
          for (const entry of matricesResult.value.staff) matrices[entry.staff_id] = entry.matrix
        }
        const staffList = staffResult.status === 'fulfilled' ? staffResult.value.staff : []
        setEditTarget(target)
        fillFrom(target, matrices, staffList)
        setEditStatus('ready')
      }
    }
  }, [selectedAccountId, editId, fillFrom])

  useEffect(() => {
    void loadAll()
    return () => { generationRef.current += 1 }
  }, [loadAll])

  /* タグ候補（このアカウントの有効なものだけ）。失敗してもタグなし保存は止めない。 */
  const [tagStatus, setTagStatus] = useState<LoadStatus>('loading')
  useEffect(() => {
    let cancelled = false
    setTagStatus('loading')
    api.tags
      .list(selectedAccountId ? { accountId: selectedAccountId } : undefined)
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setTags(res.data)
          setTagStatus('ready')
        } else {
          setTagStatus('error')
        }
      })
      .catch(() => { if (!cancelled) setTagStatus('error') })
    return () => { cancelled = true }
  }, [selectedAccountId])


  /* 予約時のマイル（お店全体の付与ルールの読み出しだけ。メニューごとの口は無い） */
  useEffect(() => {
    let alive = true
    api.mileage.rules()
      .then((response) => {
        if (!alive) return
        if (!response.success) { setMileageStatus('error'); return }
        const rule = response.data.find((item) => item.eventType === 'booking_created' && item.isActive)
        setBookingMileage(rule?.amount ?? null)
        setMileageStatus('ready')
      })
      .catch(() => { if (alive) { setBookingMileage(null); setMileageStatus('error') } })
    return () => { alive = false }
  }, [])

  /* アカウントを変えたら別の作成試行にする（R535）。前アカウントの選択も残さない。 */
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID())
    setCreatedMenuNeedingFollowUp(null)
    setConflict(null)
    setComparing(false)
    setAssigned(new Set())
    setResourceIds(new Set())
    setResourceQuantities({})
    setResourceSaving(false)
    setResourceMessage(null)
    setAutoTagId(null)
    setAudienceMode('all'); setAudienceTagIds([]); setPreviewFriendId('')
    loadCustomerBooking(null)
    setNoAssign(false)
  }, [selectedAccountId, loadCustomerBooking])

  /* ---- 導出 ---- */
  const categoryOptions = useMemo(() => {
    const existing = [...new Set(menus.map((menu) => menu.category_label).filter((c): c is string => Boolean(c)))]
    return [
      { value: '', label: '未分類' },
      ...existing.map((label) => ({ value: label, label })),
      { value: '__new__', label: '新しい分類を入力…' },
    ]
  }, [menus])

  /* 一覧の口はアカウントで絞って返し、lineAccountId は定義詳細でしか返らない。
     値が無いタグはこのアカウントのものとして扱う（以前は全部はじいて「タグがありません」になっていた）。 */
  const tagCandidates = tags.filter(
    (tag) => (tag.lineAccountId == null || tag.lineAccountId === selectedAccountId) && tag.status !== 'archived',
  )
  const unavailableTag = tagStatus === 'ready' && autoTagId !== null && !tagCandidates.some((tag) => tag.id === autoTagId)
  const unavailableTagName = tags.find((tag) => tag.id === autoTagId)?.name ?? '設定されていたタグ'

  const assignedIds = [...assigned].filter((id) => staff.some((person) => person.id === id))
  const activeResources = resources.filter((item) => item.isActive || resourceIds.has(item.id))
  const resourceChoices = [...activeResources, ...(editTarget?.assigned_resources ?? [])
    .filter((item) => !resources.some((candidate) => candidate.id === item.resourceId))
    .map((item) => ({ id: item.resourceId, name: item.name, isActive: false }))]

  const effectiveCategory = categoryPicking ? categoryNew.trim() : categoryLabel.trim()
  const draftMenu: DraftMenu = {
    id: editTarget?.id ?? '__draft__',
    name: name.trim() || 'メニュー名',
    category_label: effectiveCategory || null,
    description: description.trim() || null,
    duration_minutes: Number(durationMinutes) || 0,
    base_price: Number(basePrice) || 0,
    price_mode: basePrice.trim() === '' ? 'inquiry' : Number(basePrice) === 0 ? 'free' : 'fixed',
    sort_order: -1,
    is_active: 1,
    auto_tag_id: autoTagId,
  }

  /* 「この人で見る」：選んだ友だちに、作りかけのメニューが見えるか（タグで限定したとき）。 */
  const hiddenMenuFields = (() => {
    const friend = previewFriends.find((item) => item.id === previewFriendId)
    if (!friend) return null
    const verdict = audienceVisibility(audienceMode, audienceTagIds, friend.tags.map((tag) => tag.id), (id) => tags.find((tag) => tag.id === id)?.name ?? '選んだタグ')
    return verdict.visible ? null : { name: friend.displayName, reason: verdict.reason }
  })()

  /*
   * 直しかけ判定：読み込んだ時点（作成なら初期値）と違ったら確認を挟む。
   * baseline は fillFrom で版ごと取り直す。
   */
  const currentSignature = JSON.stringify([
    name, effectiveCategory, description, durationMinutes, basePrice, concurrentCapacity,
    bufferAfterMinutes, ownRules, windowDays, cutoffHours, cancelDeadlineHours,
    askQuestion, intakeQuestion, autoTagId,
    [...assigned].sort().join(','), resourceSignature(resourceIds, resourceQuantities), noAssign,
  ])
  /* お支払い（いつもの方法／このメニューだけ変える）。メニューを保存したあとに口へ書く。 */
  const payment = useMenuPayment('booking', selectedAccountId, editTarget?.id ?? null)
  /* デポジット（B1・CnV1I）と会い方・会議の URL（B7・ELruS）。どちらもメニューを保存したあとに口へ書く。 */
  const deposit = useMenuDeposit(selectedAccountId, editTarget?.id ?? null)
  const meeting = useMenuMeeting(selectedAccountId, editTarget?.id ?? null, ((editTarget as (BookingMenu & { meeting_mode?: MeetingMode | null }) | null)?.meeting_mode) ?? null)
  const dirty = payment.dirty || deposit.dirty || meeting.dirty || customerBooking.dirty || baselineRef.current !== '' && baselineRef.current !== currentSignature ||
    (baselineRef.current === '' && Boolean(
      name || effectiveCategory || description || durationMinutes !== '60' ||
      bufferAfterMinutes !== '0' || basePrice || concurrentCapacity !== '1' ||
      windowDays || cutoffHours || cancelDeadlineHours || intakeQuestion ||
      assigned.size > 0 || autoTagId || resourceIds.size > 0
    ))
  const { leaveTarget, confirmLeave, cancelLeave, guarded } = useUnsavedGuard({ dirty })

  usePageTitle(editTarget ? '予約メニューを直す' : '予約メニューを作る')
  usePageCrumbs([
    { label: '予約', href: '/booking/bookings' },
    { label: '予約設定', href: '/booking/menus' },
  ])

  function toggleAssigned(id: string) {
    setAssigned((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * 「指名なし」でも受ける … このメニューを「指名なし枠に入る」スタッフへ
   * 割り当てることのまとめ操作。API にメニュー側の口は無いので、
   * is_designation_optional が立つ担当のチェックを揃える形で表す。
   */
  function toggleNoAssign(next: boolean) {
    setNoAssign(next)
    setAssigned((current) => {
      const updated = new Set(current)
      for (const person of staff) {
        if (!person.is_active || person.is_designation_optional !== 1) continue
        if (next) updated.add(person.id)
        else updated.delete(person.id)
      }
      return updated
    })
  }

  /** 設備の欄（札＋変える）で選び直した結果。足した設備は必要数 1 から。 */
  function pickResources(ids: string[]) {
    if (editTarget && (!canManageResources || resourceSaving || saving)) return
    setResourceMessage(null)
    const added = ids.filter((id) => !resourceIds.has(id))
    if (added.length) setResourceQuantities((current) => ({ ...current, ...Object.fromEntries(added.map((id) => [id, '1'])) }))
    setResourceIds(new Set(ids))
  }

  function audienceChanged(): boolean {
    if (!canEditAudience) return false
    if (!editTarget) return audienceMode !== 'all'
    const saved = editTarget as BookingMenu & { audience_mode?: AudienceMode; audience_tag_ids_json?: string | null }
    if (audienceMode !== (saved.audience_mode ?? 'all')) return true
    if (audienceMode === 'all') return false
    const signature = (ids: string[]) => JSON.stringify([...new Set(ids)].sort())
    return signature(audienceTagIds) !== signature(storedStringList(saved.audience_tag_ids_json))
  }

  function validate(): string | null {
    if (!selectedAccountId) return '先に上部でLINEアカウントを選んでください'
    if (staffStatus === 'loading') return '担当スタッフを読み込んでいます。読み込みが終わってから保存してください'
    if (staffStatus === 'error') return '担当スタッフを読み込めませんでした。読み直してから保存してください'
    if (audienceChanged() && audienceMode !== 'all' && audienceTagIds.length === 0) return '見せる相手のタグを1つ以上選んでください。'
    if (customerBooking.error) return customerBooking.error
    if ([...resourceIds].some((id) => !Number.isInteger(Number(resourceQuantities[id] ?? '1')) || Number(resourceQuantities[id] ?? '1') < 1 || Number(resourceQuantities[id] ?? '1') > 1000)) return '必要数は1〜1000の整数で入力してください。'
    return bookingMenuError({
      name,
      durationMinutes,
      bufferAfterMinutes,
      sortOrder: 0,
      assignedStaffCount: assignedIds.length,
    })
  }

  /** 担当の割り当てを staff_menus へ流す。失敗した担当のIDを返す。 */
  async function writeStaffAssignments(menuId: string, staffIds: string[]): Promise<string[]> {
    const matrixByStaff = new Map<string, StaffMenuMatrix[]>()
    const failed: string[] = []
    try {
      const bulk = await bookingApi.listStaffMenusBulk(selectedAccountId!)
      for (const entry of bulk.staff) matrixByStaff.set(entry.staff_id, entry.matrix)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // 一括取得が失敗したときも、各担当の取得から続けられる。
    }
    await Promise.all(staffIds.filter((id) => !matrixByStaff.has(id)).map(async (staffId) => {
      try {
        const { matrix } = await bookingApi.getStaffMenus(selectedAccountId!, staffId)
        matrixByStaff.set(staffId, matrix)
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        failed.push(staffId)
      }
    }))
    await Promise.all(
      staffIds.filter((id) => !failed.includes(id)).map(async (staffId) => {
        try {
          const matrix = matrixByStaff.get(staffId) ?? []
          const rows = matrix.some((row) => row.menu_id === menuId)
            ? matrix
            : [...matrix, { menu_id: menuId, is_offered: 1, override_duration_minutes: null, override_price: null }]
          await bookingApi.putStaffMenus(
            selectedAccountId!,
            staffId,
            rows.map((row) => ({
              menu_id: row.menu_id,
              is_offered: row.menu_id === menuId ? true : Boolean(row.is_offered),
              override_duration_minutes: row.override_duration_minutes ?? null,
              override_price: row.override_price ?? null,
            })),
          )
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          failed.push(staffId)
        }
      }),
    );

    return failed
  }

  /** 編集時: いままで付いていた担当でチェックを外した人の is_offered を落とす。 */
  async function removeStaffAssignments(menuId: string): Promise<string[]> {
    const removed = [...(editTarget?.assigned_staff ?? []).map((person) => person.id)]
      .filter((id) => !assigned.has(id) && staff.some((person) => person.id === id))
    const failed: string[] = []
    await Promise.all(removed.map(async (staffId) => {
      try {
        const { matrix } = await bookingApi.getStaffMenus(selectedAccountId!, staffId)
        await bookingApi.putStaffMenus(
          selectedAccountId!,
          staffId,
          matrix.map((row) => ({
            menu_id: row.menu_id,
            is_offered: row.menu_id === menuId ? false : Boolean(row.is_offered),
            override_duration_minutes: row.override_duration_minutes ?? null,
            override_price: row.override_price ?? null,
          })),
        )
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        failed.push(staffId)
      }
    }));

    return failed
  }

  async function writeResources(menuId: string, expectedVersion: number): Promise<number> {
    const selected = [...resourceIds].map((resourceId) => ({ resourceId, quantity: Number(resourceQuantities[resourceId] ?? '1') }))
    const before = resourceSignature((editTarget?.assigned_resources ?? []).map((item) => item.resourceId), Object.fromEntries((editTarget?.assigned_resources ?? []).map((item) => [item.resourceId, String(item.quantity)])))
    const after = resourceSignature(resourceIds, resourceQuantities)
    if (before === after && editTarget) return expectedVersion
    const response = await bookingApi.saveMenuResources(selectedAccountId!, menuId, {
      expectedVersion,
      resources: selected,
    })
    return response.data.version
  }

  // 旧編集窓の設備だけの保存を維持する。他の入力・担当は保存しない。
  async function submitResources() {
    const generation = generationRef.current
    if (resourceSubmitRef.current === generation || saving || !canManageResources || !selectedAccountId || !editTarget) return
    const expectedVersion = editTarget.version
    if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
      setResourceMessage('最新のメニュー情報を読み直してから、もう一度お試しください。')
      return
    }
    const selected = [...resourceIds].map((resourceId) => ({ resourceId, quantity: Number(resourceQuantities[resourceId] ?? '1') }))
    if (selected.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000)) {
      setResourceMessage('必要数は1〜1000の整数で入力してください。')
      return
    }
    const signature = resourceSignature(resourceIds, resourceQuantities)
    resourceSubmitRef.current = generation
    setResourceSaving(true)
    setResourceMessage(null)
    try {
      const response = await bookingApi.saveMenuResources(selectedAccountId, editTarget.id, { expectedVersion: Number(expectedVersion), resources: selected })
      if (generationRef.current !== generation) return
      const assignedResources = selected.map((item) => {
        const candidate = resources.find((resource) => resource.id === item.resourceId)
          ?? editTarget.assigned_resources?.find((resource) => resource.resourceId === item.resourceId)
        return {
          menuId: editTarget.id, resourceId: item.resourceId, name: candidate?.name ?? '不明な設備',
          type: candidate?.type ?? '', capacity: candidate?.capacity ?? item.quantity, quantity: item.quantity,
          isActive: candidate?.isActive ?? false,
          warning: candidate?.isActive ? null : 'resource_inactive' as const,
        }
      })
      setEditTarget((current) => current && ({ ...current, version: response.data.version, assigned_resources: assignedResources }))
      // 設備だけを保存しても、名前などの未保存の変更は残す。
      if (baselineRef.current) {
        const baseline = JSON.parse(baselineRef.current) as unknown[]
        baseline[15] = signature
        baselineRef.current = JSON.stringify(baseline)
      }
      setResourceMessage('設備の割当を保存しました。新しい予約枠から反映されます。')
    } catch (error) {
      if (generationRef.current !== generation) return
      const fieldFailure = saveErrors.capture(error)
      if (!fieldFailure) setResourceMessage(isSaveConflict(error)
        ? 'ほかの担当者が先に保存しました。最新の内容を読み直してください。'
        : '設備の割当を保存できませんでした。入力は残っています。もう一度お試しください。')
    } finally {
      if (resourceSubmitRef.current === generation) resourceSubmitRef.current = null
      if (generationRef.current === generation) setResourceSaving(false)
    }
  }

  function menuBody(publish: boolean): BookingMenuWrite {
    return {
      name: name.trim(),
      category_label: effectiveCategory || null,
      description: description.trim() || null,
      duration_minutes: Number(durationMinutes),
      buffer_after_minutes: Number(bufferAfterMinutes) || 0,
      base_price: Number(basePrice) || 0,
      price_mode: basePrice.trim() === '' ? 'inquiry' : Number(basePrice) === 0 ? 'free' : 'fixed',
      concurrent_capacity: Number(concurrentCapacity) || 1,
      booking_window_days: ownRules && windowDays ? Number(windowDays) : null,
      cutoff_hours_before: ownRules && cutoffHours ? Number(cutoffHours) : null,
      cancel_deadline_hours_before: ownRules && cancelDeadlineHours ? Number(cancelDeadlineHours) : null,
      intake_question: askQuestion ? intakeQuestion.trim() || null : null,
      auto_tag_id: autoTagId,
      is_active: publish ? 1 : 0,
      ...(audienceChanged() ? { audienceMode, audienceTagIds: audienceMode === 'all' ? [] : audienceTagIds } : {}),
      ...(customerBooking.body() as Partial<BookingMenu>),
    }
  }

  useEffect(() => {
    if (conflict) conflictRef.current?.scrollIntoView?.({ block: 'center' })
  }, [conflict])

  /** 409のとき：最新の版と直した人を読み、帯に出す。 */
  async function openConflict(menuId: string) {
    try {
      const [menusNow, versionsNow] = await Promise.all([
        bookingApi.listMenus(selectedAccountId!),
        bookingApi.listMenuVersions(selectedAccountId!, menuId),
      ])
      const latestMenu = menusNow.menus.find((menu) => menu.id === menuId) ?? null
      const latest = versionsNow.versions?.[0]
      setConflict({
        name: latestMenu?.name ?? name.trim() ?? 'メニュー',
        author: latest?.author ?? null,
        at: latest?.at ?? null,
        version: latestMenu?.version ?? 0,
      })
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      setConflict({ name: name.trim() || 'メニュー', author: null, at: null, version: 0 })
    }
  }

  async function save(publish: boolean, overwrite = false) {
    if (!selectedAccountId || saving || resourceSubmitRef.current === generationRef.current) return
    setSaveError(null)
    const validationError = validate()
    if (validationError) {
      focusInvalid.current = true
      const nameError = menuNameRequirement.check(name)
      const durationError = menuDurationRequirement.check(durationMinutes)
      const bufferError = bookingMenuBufferError(bufferAfterMinutes)
      const staffError = staffStatus === 'ready' && assignedIds.length === 0 ? '担当できる人を1人以上選んでください。' : null
      setSaveError(nameError || durationError || bufferError || staffError ? null : validationError)
      setFieldErrors({
        ...(nameError !== null ? { name: nameError } : {}),
        ...(durationError !== null ? { duration: durationError } : {}),
        ...(bufferError !== null ? { buffer: bufferError } : {}),
        ...(staffError ? { staff: staffError } : {}),
      })
      return
    }
    setFieldErrors({})
    setSaving(conflict ? 'conflict' : publish ? 'publish' : 'draft')
    try {
      let menuId: string | null = editTarget?.id ?? createdMenuNeedingFollowUp?.menuId ?? null
      let version = 0

      if (menuId == null) {
        const res = await bookingApi.createMenu(selectedAccountId, menuBody(publish), idempotencyKey)
        menuId = res.id
        setCreatedMenuNeedingFollowUp({ menuId, remainingStaffIds: assignedIds, resourcesPending: resourceIds.size > 0 })
      } else if (createdMenuNeedingFollowUp && !editTarget) {
        /*
         * WEB062：作れたメニューの続き（担当・設備）だけをやり直す。メニューそのものは
         * 作ったとき（公開・下書きの選択も）のまま。版の無い「直す」へ進めて 409 にしたり、
         * 公開を黙って下書きへ戻したりしない。版は下でいまの版を取り直す。
         */
      } else {
        /* 編集。競合からの上書きのときは読み直した最新版を使う。 */
        const expectedVersion = overwrite && conflict ? conflict.version : editTarget?.version
        if (typeof expectedVersion !== 'number' || expectedVersion < 1) {
          throw new ApiError(409, 'version_conflict', 'version_conflict')
        }
        try {
          const res = await bookingApi.updateMenu(selectedAccountId, menuId, expectedVersion, menuBody(editTarget?.is_active === 1))
          version = res.version
        } catch (e) {
          saveErrors.capture(e);

          if (e instanceof ApiError && e.status === 409) {
            await openConflict(menuId)
            setSaving(null);

            return
          }
          throw e
        }
      }

      /* 作成直後は版を取り直す（createMenu は id しか返さない）。 */
      if (!version) {
        const fresh = await bookingApi.listMenus(selectedAccountId)
        version = fresh.menus.find((menu) => menu.id === menuId)?.version ?? 0
      }

      /* 担当。作成済みの再開なら残っている人だけ。 */
      const pendingStaffIds = createdMenuNeedingFollowUp
        ? createdMenuNeedingFollowUp.remainingStaffIds.filter((id) => assigned.has(id))
        : assignedIds
      const failedStaff = await writeStaffAssignments(menuId, pendingStaffIds)
      if (editTarget && !createdMenuNeedingFollowUp) {
        failedStaff.push(...await removeStaffAssignments(menuId))
      }

      /* 設備（選んだときだけ）。 */
      // WEB063：設備は「選んだときだけ」ではなく、前と変わったときに保存する（全部外したときも）。
      const resourcesChanged = editTarget
        ? resourceSignature((editTarget.assigned_resources ?? []).map((item) => item.resourceId), Object.fromEntries((editTarget.assigned_resources ?? []).map((item) => [item.resourceId, String(item.quantity)]))) !== resourceSignature(resourceIds, resourceQuantities)
        : resourceIds.size > 0
      let resourcesPending = createdMenuNeedingFollowUp?.resourcesPending ?? resourcesChanged
      if (resourcesPending && version >= 1) {
        try {
          version = await writeResources(menuId, version)
          resourcesPending = false
        } catch (e) {
          saveErrors.capture(e);

          if (e instanceof ApiError && e.status === 409) {
            const fresh = await bookingApi.listMenus(selectedAccountId)
            version = fresh.menus.find((menu) => menu.id === menuId)?.version ?? version
            try {
              version = await writeResources(menuId, version)
              resourcesPending = false
            } catch (saveFailure) {
              saveErrors.capture(saveFailure)
              /* 残ったまま帯に出す */
            }
          }
        }
      }

      if (failedStaff.length > 0 || resourcesPending) {
        setCreatedMenuNeedingFollowUp({ menuId, remainingStaffIds: failedStaff, resourcesPending })
        throw new Error('メニューは保存されましたが、一部の担当・設備を保存できませんでした。もう一度押すと残りだけをやり直します。')
      }
      try {
        await payment.save(menuId)
        await deposit.save(menuId)
        version = await meeting.save(menuId, version)
      } catch (paymentFailure) {
        saveErrors.capture(paymentFailure)
        throw new Error('メニューは保存されましたが、お支払いの方法・会い方を保存できませんでした。もう一度押してください。')
      }
      setCreatedMenuNeedingFollowUp(null)
      customerBooking.markSaved()
      notifySaved(editTarget ? 'メニューを保存しました' : publish ? 'メニューを公開しました' : '下書きを保存しました')
      if (editTarget) {
        const fresh = await bookingApi.listMenus(selectedAccountId)
        const updated = fresh.menus.find((menu) => menu.id === menuId)
        if (updated) setEditTarget(updated)
        else setEditTarget({ ...editTarget, version })
        baselineRef.current = currentSignature
      } else { router.push(createPageReturnHref('/booking/menus', menuId)) }
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && (e.code === 'tag_not_found' || e.code === 'invalid_audience_tags')) {
        { if (!fieldFailure)
        setSaveError('選んだタグは利用できないため保存できませんでした。タグを選び直してください。') }
      } else if (e instanceof ApiError && e.status === 409) {
        if (editTarget ?? createdMenuNeedingFollowUp) {
          await openConflict(editTarget?.id ?? createdMenuNeedingFollowUp!.menuId)
        } else {
          { if (!fieldFailure)
          setSaveError(bookingErrorText(e, '保存'))
        }
      }
      } else {
        { if (!fieldFailure)
        setSaveError(describeApiFailure(e, '予約メニューの保存')) }
      }
    } finally {
      setSaving(null)
    }
  }

  /** 「最新を読み込んで続ける」：最新の中身で入力を置き直す。 */
  async function reloadLatest() {
    const menuId = editTarget?.id ?? createdMenuNeedingFollowUp?.menuId
    if (!menuId || !selectedAccountId) return
    try {
      const fresh = await bookingApi.listMenus(selectedAccountId)
      const target = fresh.menus.find((menu) => menu.id === menuId)
      if (!target) {
        setEditError('このメニューは見つかりませんでした。消されたか、別のアカウントのものです。')
        return
      }
      const bulk = await bookingApi.listStaffMenusBulk(selectedAccountId)
      const matrices: Record<string, StaffMenuMatrix[]> = {}
      if (bulk) for (const entry of bulk.staff) matrices[entry.staff_id] = entry.matrix
      setEditTarget(target)
      fillFrom(target, matrices, staff)
      setConflict(null)
      setSaveError(null)
      notifyToast('最新の内容を読み込みました')
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)
      setSaveError(bookingErrorText(e, '読み込み')) }
    }
  }

  if (!canEdit) {
    return (
      <SaveErrorScope errors={saveErrors}><PageFrame kind="create" boardId="QqER7" elementRef={formRef}>
        <PageContent>
          <ListState
            kind="error"
            title="予約メニューの変更権限がありません"
            description={permissionDeniedMessage('store')}
          />
        </PageContent>
      </PageFrame></SaveErrorScope>
    )
  }

  if (editId && editStatus === 'loading') {
    return (
      <SaveErrorScope errors={saveErrors}><PageFrame kind="create" boardId="QqER7">
        <span className="sr-only" role="status">メニューを読み込んでいます</span>
        <DelayedSkeleton loading skeleton={<MenuFormSkeleton />} />
      </PageFrame></SaveErrorScope>
    )
  }
  if (editId && editStatus === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}><PageFrame kind="create" boardId="QqER7" elementRef={formRef}>
        <PageContent>
          <ListState kind="error" description={editError ?? '読み込めませんでした。'} onRetry={() => void loadAll()} />
        </PageContent>
      </PageFrame></SaveErrorScope>
    )
  }

  const primaryLabel = conflict
    ? '比べてから保存'
    : createdMenuNeedingFollowUp
      ? '残りの設定をやり直す'
      : editTarget
        ? '変更を保存する'
        : '保存して公開'

  const previewContent = <>
          <div className={shell.sideActions}>
            {previewUrl ? <Button href={previewUrl} external><Smartphone size={16} aria-hidden="true" />お客さまに見える画面を確かめる</Button> : null}
          </div>
          <p className={shell.sideTitle}>お客さまの予約画面</p>
          {hiddenMenuFields ? <Notice tone="warn">{`${hiddenMenuFields.name}さんには「${draftMenu.name}」は見えません（${hiddenMenuFields.reason}）`}</Notice> : null}
          <>
            <LiffPhoneMenuStep categoryTone="customer"
              menus={menus.filter((menu) => menu.id !== editTarget?.id)}
              draft={hiddenMenuFields ? null : draftMenu}
              status={menusStatus}
            />
          </>
          <p className={shell.sideLineLink}>
            {previewUrl
              ? <TextLink external href={previewUrl}  >実際の画面で確かめる</TextLink>
              : 'このアカウントには予約画面のURLがまだありません'}
          </p>
</>

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage elementRef={formRef} boardId={conflict ? 'v5L19Z' : 'QqER7'} dirty={false}
        noticeSpacing="band"
        status={conflict ? 'ほかの人の変更を確かめてから保存してください' : undefined}
        footerActions={(
            <>
              <Button onClick={() => guarded(() => router.push('/booking/menus'))}>キャンセル</Button>
              {!editTarget && (
                <Button
                  disabled={saving !== null || resourceSaving}
                  busy={saving === 'draft'}
                  onClick={() => void save(false)}
                >
                  下書きを保存
                </Button>
              )}
              <Button
                variant="primary"
                disabled={saving !== null || resourceSaving}
                busy={saving !== null}
                onClick={() => void save(true, Boolean(conflict))}
              >
                <Upload size={16} aria-hidden="true" />{primaryLabel}
              </Button>
            </>
          )}
        previewLabel="お客さまの予約画面を見る"
        previewTitle="お客さまの予約画面"
        preview={previewContent}
        previewToggle={<PreviewLauncher title="お客さまの予約画面" label="お客さまの予約画面を見る">{previewContent}</PreviewLauncher>}
       title={editTarget ? '予約メニューを直す' : '予約メニューを作る'}
        help={<>{editTarget ? '保存すると、お客さまの画面にすぐ出ます' : 'まだお客さまの画面には出ていません'}</>}
        /* 競合の帯は本文と右の欄をまたいで上に出す。 */
        notice={conflict ? (
          <div ref={conflictRef} className={styles.conflictRow} data-design="Bar" data-design-node="v5L19Z">
            <SaveConflictBand title={`${conflict.author ? `${conflict.author}さんが` : 'ほかの人が'}${conflict.at ? ` ${conflictTime(conflict.at)} に` : ''}メニュー「${conflict.name}」を保存しました`} onCompare={() => setComparing(true)} onReload={() => void reloadLatest()} />
          </div>
        ) : undefined} >


          {/* ① メニューの中身 */}
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="メニューの中身" />
            <SettingsFormRow layout="name-folder" keepColumns>
              <Field label="メニュー名" requirement={menuNameRequirement}><SaveErrorField names={["name"]}><TextField
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (fieldErrors.name !== undefined) {
                      setFieldErrors((previous) => ({ ...previous, name: menuNameRequirement.check(e.target.value) ?? undefined }))
                    }
                  }}
                  onBlur={() => {
                    setFieldErrors((previous) => ({ ...previous, name: menuNameRequirement.check(name) ?? undefined }))
                  }}
                  placeholder="例：トリミング（小型犬）"
                  aria-invalid={fieldErrors.name !== undefined}
                /></SaveErrorField>
{fieldErrors.name !== undefined ? (
                  <span className={styles.fieldError} role="alert">{fieldErrors.name}</span>
                ) : null}</Field>
              <Field label="分類">
                <SaveErrorField names={["categoryLabel","categoryPicking","category_label","category_picking"]}><Select
                  size="full"
                  aria-label="分類"
                  value={categoryPicking ? '__new__' : categoryLabel}
                  onChange={(value) => {
                    if (value === '__new__') {
                      setCategoryPicking(true)
                      setCategoryNew('')
                    } else {
                      setCategoryPicking(false)
                      setCategoryLabel(value)
                    }
                  }}
                  options={categoryOptions}
                /></SaveErrorField>
                {categoryPicking && (
                  <SaveErrorField names={["categoryNew","category_new"]}><TextField
                    type="text"
                    value={categoryNew}
                    onChange={(e) => setCategoryNew(e.target.value)}
                    placeholder="新しい分類の名前（例：トリミング）"
                    aria-label="新しい分類の名前"
                  /></SaveErrorField>
                )}
              </Field>
            </SettingsFormRow>
            <Field label="説明（お客さまに見えます）"><SaveErrorField names={["description"]}><TextField
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例：シャンプー・カット・爪切り"
              /></SaveErrorField></Field>
            <SettingsFormRow layout="columns" columns={3} keepColumns>
              <Field label="かかる時間" requirement={menuDurationRequirement}>
                <SaveErrorField names={["durationMinutes","duration_minutes"]}><NumberInput unit="分"
                  type="number"
                  min={1}
                  value={durationMinutes}
                  onChange={(e) => {
                    setDurationMinutes(e.target.value)
                    if (fieldErrors.duration !== undefined) {
                      setFieldErrors((previous) => ({ ...previous, duration: menuDurationRequirement.check(e.target.value) ?? undefined }))
                    }
                  }}
                  onBlur={() => {
                    setFieldErrors((previous) => ({ ...previous, duration: menuDurationRequirement.check(durationMinutes) ?? undefined }))
                  }}
                  aria-label="かかる時間（分）"
                  aria-invalid={fieldErrors.duration !== undefined}
                /></SaveErrorField>

              </Field>
              <Field label="金額" help="空なら、お客さまにはお問い合わせと出します">
                <SaveErrorField names={["basePrice","base_price"]}><AffixedTextField layout="field" startAdornment="¥"
                  type="number"
                  min={0}
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  placeholder="8,400"
                  aria-label="金額（円）"
                /></SaveErrorField>
              </Field>
              <Field label="予約したときのマイル" optional={false} help="お店全体の設定で決まります" note={<TextLink external href="/mileage?tab=earning-rules">マイル設定へ</TextLink>}>
              <SaveErrorField names={["bookingMileage","booking_mileage"]}><AffixedTextField layout="field"
                  readOnly endAdornment="マイル"
                  value={
                    mileageStatus === 'loading' ? '…'
                      : mileageStatus === 'error' ? '未取得'
                      : bookingMileage === null ? emptyValue('unconfigured')
                      : formatNumber(bookingMileage)
                  }
                  aria-label="予約したときのマイル（お店全体の設定）"
                /></SaveErrorField>
              </Field>
            </SettingsFormRow>
            {fieldErrors.duration !== undefined ? (
              <span className={styles.fieldError} role="alert">{fieldErrors.duration}</span>
            ) : null}
          </Card>

          {/* ② 担当スタッフ */}
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="担当スタッフ" meta="1人も選ばないと、お客さまの画面に枠が出ません" />
            {staffStatus === 'loading' ? (
              <span className="inline-block" aria-busy="true">
                <span className="sr-only">担当を読み込んでいます</span>
                <DelayedSkeleton loading skeleton={<ChipRowSkeleton />} />
              </span>
            ) : staffStatus === 'error' ? (
              <div className="space-y-2">
                <p className="text-ink-faint text-sm">
                  {classifyApiFailure(staffError) === 'forbidden'
                    ? permissionDeniedMessage('store')
                    : '担当を読み込めませんでした。入力はそのまま残っています。'}
                </p>
                {classifyApiFailure(staffError) !== 'forbidden' && selectedAccountId && (
                  <Button variant="secondary" size="compact" onClick={() => loadAll()} busyLabel="処理中…">
                    担当をもう一度読み込む
                  </Button>
                )}
              </div>
            ) : staff.length === 0 ? (
              <p className="text-ink-faint text-sm">
                まだスタッフが登録されていません。先に予約設定の「担当スタッフ」から登録してください。
              </p>
            ) : (
              <>
                <SettingsFormRow layout="columns" columns={3} keepColumns role="group" aria-label="担当スタッフ" aria-invalid={!!fieldErrors.staff && assigned.size === 0} tabIndex={-1}>
                  {staff.filter((person) => person.is_active).map((person) => {
                    const on = assigned.has(person.id)
                    // 絵 ：トリマーは名前だけ、それ以外は（役割）を付ける。
                    const label = `${person.display_name || person.name}${person.role && person.role !== 'トリマー' ? `（${person.role}）` : ''}`
                    return (
                      <CheckCard key={person.id} size="row" checked={on}
                        invalid={!!fieldErrors.staff && assigned.size === 0}
                        title={<span title={person.role ? `${person.display_name || person.name}（${person.role}）` : undefined}>{label}</span>}
                        onChange={() => toggleAssigned(person.id)} />
                    )
                  })}
                </SettingsFormRow>
                {fieldErrors.staff && assigned.size === 0 ? <p className={styles.fieldError} role="alert">{fieldErrors.staff}</p> : null}
                {/* 保存する設定はチェック（決まり14・絵どおり：言葉は左、チェックは右）。 */}
                <div className={styles.toggleLine}>
                  <span className={styles.toggleLineLabel}>「指名なし」でも受ける</span>
                  <SaveErrorField names={["noAssign","no_assign"]}><Toggle label="「指名なし」でも受ける" checked={noAssign} onChange={toggleNoAssign} /></SaveErrorField>
                </div>
              </>
            )}
          </Card>

          {/* 会い方（B7・ELruS）：担当スタッフと予約のきまりの間。 */}
          <MeetingModeCard state={meeting} readOnly={Boolean(editTarget && !canEdit)} />

          {/* ③ 予約のきまり */}
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="予約のきまり" meta="空ならお店全体のきまり（予約のルール）を使います" />
            {ownRules ? (
              <SettingsFormRow layout="columns" columns={3} keepColumns>
                <Field label="先の予約が取れる範囲">
                  <SaveErrorField names={["windowDays","window_days"]}><NumberInput unit="日先まで" type="number" min={1} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} aria-label="先の予約が取れる範囲（日）" /></SaveErrorField>
                </Field>
                <Field label="受付の締め切り">
                  <SaveErrorField names={["cutoffHours","cutoff_hours"]}><NumberInput unit="時間前" type="number" min={1} value={cutoffHours} onChange={(e) => setCutoffHours(e.target.value)} aria-label="受付の締め切り（時間前）" /></SaveErrorField>
                </Field>
                <Field label="キャンセルの期限">
                  <SaveErrorField names={["cancelDeadlineHours","cancel_deadline_hours"]}><NumberInput unit="時間前" type="number" min={1} value={cancelDeadlineHours} onChange={(e) => setCancelDeadlineHours(e.target.value)} aria-label="キャンセルの期限（時間前）" /></SaveErrorField>
                </Field>
              </SettingsFormRow>
            ) : (
              <>
                <div className={styles.ruleRow}>
                  <span className={styles.ruleLabel}>先の予約が取れる範囲</span>
                  <span className={styles.ruleValue}>
                    {settings ? `お店のきまり（${settings.bookingWindowDays}日先まで）` : 'お店のきまり'}
                  </span>
                </div>
                <div className={styles.ruleRow}>
                  <span className={styles.ruleLabel}>受付の締め切り</span>
                  <span className={styles.ruleValue}>{cutoffStoreLabel(settings)}</span>
                </div>
                <div className={styles.ruleRow}>
                  <span className={styles.ruleLabel}>キャンセルの期限</span>
                  <span className={styles.ruleValue}>{cancelStoreLabel(settings)}</span>
                </div>
              </>
            )}
            <div className={styles.changeRow}>
              <Button variant="text" textTone="ink" onClick={() => setOwnRules((v) => !v)}>
                {ownRules ? 'お店のきまりに戻す' : <><Pencil aria-hidden="true" />このメニューだけ変更する</>}
              </Button>
            </div>
          </Card>

          {/* 見せる相手（B9・絵 L6ifay）。 */}
          <AudienceSection accountId={selectedAccountId ?? null} mode={audienceMode} tagIds={audienceTagIds} onMode={setAudienceMode} onTagIds={setAudienceTagIds} canEdit={canEditAudience}
            friendId={previewFriendId} onFriendId={setPreviewFriendId} onFriends={setPreviewFriends} />
          {/* お客さまの予約のしかた（B4 繰り返し・B5 人数と追加メニュー）。 */}
          <CustomerBookingCard state={customerBooking} menus={menus} selfId={editTarget?.id ?? null} readOnly={!canEditAudience} />
          {/* お支払い（B1・CnV1I）：予約のきまりのすぐ下に、独立した段で。 */}
          <BookingMenuPaymentCard payment={payment} deposit={deposit} price={basePrice.trim() === '' ? null : Number(basePrice) || 0} readOnly={Boolean(editTarget && !canEdit)} />

          {/* ④ そのほか（受け方・予約を受けたとき・設備）と お支払い。絵 QqER7・v5L19Z は白い段に白い小段を積む。 */}
          <Card variant="form" gap="normal">
            <Card variant="form" padding="compact" gap="normal">
              <CardHeader size="stacked" headingLevel={3} title="受け方" />
              <div className={styles.fieldStack}>
                <Field label="同時に受けられる件数">
                    <SaveErrorField names={["concurrentCapacity","concurrent_capacity"]}><NumberInput unit="件"
                      type="number"
                      min={1}
                      value={concurrentCapacity}
                      onChange={(e) => setConcurrentCapacity(e.target.value)}
                      aria-label="同時に受けられる件数"
                    /></SaveErrorField></Field>
                <Field label="後の空き時間（片付け・移動）">
                    <SaveErrorField names={["bufferAfterMinutes","buffer_after_minutes"]}><NumberInput unit="分"
                      type="number"
                      min={0}
                      value={bufferAfterMinutes}
                      onChange={(e) => {
                        setBufferAfterMinutes(e.target.value)
                        if (fieldErrors.buffer !== undefined) {
                          setFieldErrors((previous) => ({ ...previous, buffer: bookingMenuBufferError(e.target.value) ?? undefined }))
                        }
                      }}
                      onBlur={() => {
                        setFieldErrors((previous) => ({ ...previous, buffer: bookingMenuBufferError(bufferAfterMinutes) ?? undefined }))
                      }}
                      aria-label="後の空き時間（分）"
                      aria-invalid={fieldErrors.buffer !== undefined}
                    /></SaveErrorField>
{fieldErrors.buffer !== undefined ? (
                    <span className={styles.fieldError} role="alert">{fieldErrors.buffer}</span>
                  ) : null}</Field>
              </div>
            </Card>

            <Card variant="form" padding="compact" gap="normal">
              {/* 説明は「？」の中へ（絵 v5L19Z は題の下に説明を置かない）。 */}
              <CardHeader size="stacked" headingLevel={3} title={<span className={styles.titleWithMark}>予約を受けたときにすること<HelpTip label="予約を受けたときにすることの説明">予約を受け付けたことを知らせる：日時・メニュー・場所を書いた案内をLINEへ送ります。前日・開始前に思い出してもらう：確定した予約は、前日と設定時間前のリマインダへ登録されます。</HelpTip></span>} />
              {tagStatus === 'loading' ? (
                <span className="inline-block w-full" aria-busy="true">
                  <span className="sr-only">タグを読み込んでいます</span>
                  <DelayedSkeleton loading skeleton={<Skeleton width="100%" height={36} />} />
                </span>
              ) : tagStatus === 'error' ? (
                <p className="text-ink-faint text-sm">タグを読み込めませんでした。タグなしで保存できます。</p>
              ) : tagCandidates.length === 0 && autoTagId === null ? (
                <p className="text-ink-faint text-sm">このアカウントに使えるタグがありません。タグなしで保存できます。</p>
              ) : (
                /* 打って絞り込める1つ選び（タグが多いアカウントでも探せる）。 */
                <SaveErrorField names={["autoTagId","auto_tag_id"]}><EntitySelect clearable size="full" kind="tag"
                  aria-label="予約後に付けるタグ"
                  value={autoTagId ?? ''}
                  onChange={(value) => setAutoTagId(value === '' ? null : value)}
                  placeholder="付けるタグ：なし"
                  /* 「なし」は候補に入れず、空のときの見出し（placeholder）と × で表す。 */
                  options={[
                    ...tagCandidates.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: `付けるタグ：${tag.name}` })),
                    ...(unavailableTag ? [{ value: autoTagId!, label: `付けるタグ：${unavailableTagName}（今は使えません）`, disabled: true }] : []),
                  ]}
                /></SaveErrorField>
              )}
              {unavailableTag && <Notice tone="warn" role="alert">設定されていたタグは整理済みか、このアカウントのタグではありません。選び直すか「なし」にしてください。</Notice>}
              <div className={styles.toggleLineLead}>
                <SaveErrorField names={["askQuestion","ask_question"]}><Toggle
                  label="予約するときに質問を出す"
                  checked={askQuestion}
                  onChange={setAskQuestion}
                /></SaveErrorField>
                <span className={styles.toggleLineLabel}>予約するときに質問を出す</span>
              </div>
              {askQuestion && (
                <Field label="質問文"><SaveErrorField names={["intakeQuestion","intake_question"]}><TextField
                    type="text"
                    value={intakeQuestion}
                    onChange={(e) => setIntakeQuestion(e.target.value)}
                    placeholder="例：気になるところ・アレルギーがあれば教えてください"
                    maxLength={200}
                  /></SaveErrorField></Field>
              )}
            </Card>

            <Card variant="form" padding="compact" gap="normal">
              <CardHeader size="stacked" headingLevel={3} title="使う設備" />
              {resourcesStatus === 'loading' ? (
                <span className="inline-block" aria-busy="true">
                  <span className="sr-only">設備を読み込んでいます</span>
                  <DelayedSkeleton loading skeleton={<ChipRowSkeleton />} />
                </span>
              ) : resourcesStatus === 'error' ? (
                <p className="text-ink-faint text-sm">設備を読み込めませんでした。選ばずに保存できます。</p>
              ) : resourceChoices.length === 0 ? (
                <p className="text-ink-faint text-sm">使える設備はまだありません。受付枠の設備から登録できます。</p>
              ) : (
                /* 絵 ：選んだ設備を札で並べ、［変える］で選ぶ窓を開く。 */
                <EntityPickerField multiple label="使う設備" noun="設備" unit="件"
                  items={resourceChoices.map((item) => ({ id: item.id, name: `${item.name}${!item.isActive ? '（停止中）' : ''}`, disabled: !item.isActive && !resourceIds.has(item.id) }))}
                  value={[...resourceIds]} allowEmpty
                  readOnly={Boolean(editTarget && !canManageResources)}
                  disabled={Boolean(editTarget && (resourceSaving || saving))}
                  onChange={pickResources} />
              )}
              {editTarget && resourceChoices.filter((item) => resourceIds.has(item.id)).map((item) => (
                <Field key={item.id} label={`${item.name}の必要数`}>
                  <SaveErrorField names={[`resources.${[...resourceIds].indexOf(item.id)}.quantity`]}><NumberInput unit="個" type="number" min={1} max={1000} step={1}
                    aria-label={`${item.name}の必要数`} value={resourceQuantities[item.id] ?? '1'}
                    disabled={!canManageResources || resourceSaving || saving !== null || !item.isActive}
                    onChange={(event) => {
                      setResourceMessage(null)
                      setResourceQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                    }} /></SaveErrorField>
                </Field>
              ))}
              {editTarget && (canManageResources ? (
                <Button variant="secondary" size="compact" busy={resourceSaving} disabled={resourceSaving || saving !== null || resourcesStatus !== 'ready'} onClick={() => void submitResources()}>設備の割当を保存する</Button>
              ) : <p className="text-ink-faint text-sm">設備の割当は閲覧のみです。変更は管理者へ依頼してください。</p>)}
              {resourceMessage && <p role="status" className="text-ink-secondary text-sm">{resourceMessage}</p>}
            </Card>

          </Card>

          {saveError && (
            <Notice tone="danger" >{saveError}</Notice>
          )}
          {createdMenuNeedingFollowUp && !saveError && (
            <p className={styles.saveNote}>
              メニューは保存済みです。もう一度押しても新しいメニューは増えません。
            </p>
          )}
      </CreatePage>

      {comparing && (editTarget ?? createdMenuNeedingFollowUp) && (
        <MenuVersionHistory
          menuId={editTarget?.id ?? createdMenuNeedingFollowUp!.menuId}
          menuName={conflict?.name ?? name}
          currentVersion={conflict?.version ?? editTarget?.version ?? 0}
          accountId={selectedAccountId!}
          canRevert={false}
          onReverted={() => void reloadLatest()}
          onClose={() => setComparing(false)}
        />
      )}
      <UnsavedLeaveDialog open={leaveTarget !== null} subject={editTarget ? 'メニューの変更' : '入力したメニュー'} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </SaveErrorScope>
  )
}


function bookingErrorText(error: unknown, action: '読み込み' | '保存'): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return permissionDeniedMessage('store')
    if (error.status === 409) return `ほかの変更と重なったため、予約メニューを${action}できませんでした。`
  }
  return `予約メニューを${action}できませんでした。通信状態を確認して、もう一度お試しください。`
}
