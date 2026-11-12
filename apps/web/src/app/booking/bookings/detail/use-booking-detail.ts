'use client'

import { usePermissionAccess } from '@/lib/use-feature-access'
import { loadStaffIdentity } from '@/lib/staff-role'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ApiError, bookingApi, type BookingAdminDetail, type BookingAvailabilitySlot, type BookingAuditLog, type BookingMenu, type BookingMenuStaff, type BookingNotificationPolicy } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { notifyToast } from '@/components/shared/toast'
import { usePageTitle } from '../../../../components/shell/page-chrome'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { BookingAction, POLICY_FIELD_LABELS, jstDate, jstHHMM, snapshotEditBase, EditBase, serverChangedLabels } from './detail-model'
import { formatNumber } from '@/lib/format'

export function useBookingDetail() {
  const { selectedAccountId } = useAccount()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  /**
   * DEEP-18: 詳細は「どのアカウントの・どの予約の応答か」を鍵付きで持つ。
   * 表示・操作に使う detail は、URLの予約IDと選択中アカウントに
   * 一致するものだけ（下の detail 定義でピン留めする）。
   */
  const [detailState, setDetailState] = useState<{
    key: { accountId: string; bookingId: string }
    booking: BookingAdminDetail
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [decideTarget, setDecideTargetState] = useState<BookingAction | null>(null)
  const [error, setError] = useState('')
  // 取得の失敗を共通部品へ渡し、権限・混雑・通信の案内を区別する。
  const [loadError, setLoadError] = useState<unknown>(null)
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [bookingMissing, setBookingMissing] = useState(false)
  /**
   * 表示・操作に使うのは、URLの予約IDと選択中アカウントに一致する
   * 詳細だけ。鍵が合わない（切替直後・古い応答）ものは null として
   * 扱い、変更操作を出さない（DEEP-18）。
   */
  const detail = detailState
    && detailState.key.accountId === selectedAccountId
    && detailState.key.bookingId === id
    ? detailState.booking
    : null
  usePageTitle(detail ? `${detail.customer.displayName} ／ ${detail.menuName}` : '予約の詳細')
  /* ★V8 は本文の「予約管理 / 予約の詳細」を置かない（オーナー 2026-10-08）。一覧へは上の帯のパンくずで戻る。互換経路は今までどおり。 */
  /**
   * R322: 保存・再試行・承認を始めた対象を覚える。今見ている対象と
   * 違う操作の完了では、現在の表示・編集中の内容を変えない。
   * 世代番号（loadGeneration）と同じ考え方で、操作ごとに対象を照合する。
   */
  const targetRef = useRef({ accountId: selectedAccountId, bookingId: id })
  const targetGeneration = useRef(0)
  if (targetRef.current.accountId !== selectedAccountId || targetRef.current.bookingId !== id) targetGeneration.current += 1
  targetRef.current = { accountId: selectedAccountId, bookingId: id }
  const decideGeneration = useRef<number | null>(null)
  const decisionTicket = useRef<object | null>(null)
  const renderedDecisionTicket = decisionTicket.current
  useEffect(() => () => { decisionTicket.current = null }, [])
  const setDecideTarget = (action: BookingAction | null) => {
    decisionTicket.current = action === null ? null : {}
    decideGeneration.current = action === null ? null : targetGeneration.current
    setDecideTargetState(action)
  }
  const closeDecideTarget = () => {
    if (renderedDecisionTicket && decisionTicket.current === renderedDecisionTicket) setDecideTarget(null)
  }
  const isCurrentTarget = useCallback(
    (target: { accountId: string; bookingId: string; generation?: number }) =>
      targetRef.current.accountId === target.accountId
      && targetRef.current.bookingId === target.bookingId
      && (target.generation === undefined || targetGeneration.current === target.generation),
    [],
  )

  // ---- 変更モード (N-389) ----
  const [editing, setEditing] = useState(false)
  const [editMenus, setEditMenus] = useState<BookingMenu[]>([])
  const [editStaff, setEditStaff] = useState<BookingMenuStaff[]>([])
  const [editMenuId, setEditMenuId] = useState('')
  const [editStaffId, setEditStaffId] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editSlots, setEditSlots] = useState<BookingAvailabilitySlot[]>([])
  const [editSlotsLoading, setEditSlotsLoading] = useState(false)
  const [editPrice, setEditPrice] = useState('')
  const [editCustomerNote, setEditCustomerNote] = useState('')
  const [editInternalNote, setEditInternalNote] = useState('')
  const [editPolicy, setEditPolicy] = useState<BookingNotificationPolicy>({
    send_line_confirmation: true,
    day_before: true,
    hours_before: true,
  })
  const [editSendNotice, setEditSendNotice] = useState(true)
  const [editReason, setEditReason] = useState('')
  /**
   * R318: 編集を始めた時点の値を覚える。保存で送るのは「この値から
   * 実際に変えた欄」だけ。競合で読み直した後も、触っていない欄を
   * 古い値で上書きしないための基準。
   */
  const [editBase, setEditBase] = useState<EditBase | null>(null)
  const [saving, setSaving] = useState(false)
  const editDirty = editing && editBase !== null && (
    editMenuId !== editBase.menuId || editStaffId !== editBase.staffId
    || editDate !== editBase.date || editTime !== editBase.time
    || editPrice !== String(editBase.price) || editCustomerNote !== editBase.customerNote
    || editInternalNote !== editBase.internalNote || editReason.trim() !== ''
    || !editSendNotice || JSON.stringify(editPolicy) !== JSON.stringify(editBase.policy)
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: editDirty })

  const [retrying, setRetrying] = useState<string | null>(null)
  /**
   * IDEA-27: 変更履歴の初回応答は要点分だけ。残りは「あとN件を読み込む」で
   * audit-logs 口から追加取得し、詳細の要点分と id で重複を潰して繋げる。
   */
  const [extraAuditLogs, setExtraAuditLogs] = useState<BookingAuditLog[] | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState('')
  /** これまでの予約の内訳。初期表示は件数だけ（要点）にし、開いてから一覧を見せる。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  const slotRequest = useRef(0)
  /** DEEP-18: 遅れて返った古い取得が、今の対象を上書きしないよう要求の世代を数える。 */
  const loadGeneration = useRef(0)
  // N-401: 閲覧のみの人には承認・変更・再試行のボタンを見せない。
  // 読み込めるまでは隠す。最終の可否はサーバ側の403が決める。
  const canOperate = usePermissionAccess('/booking/bookings')
  // 権限を読み終わるまで「閲覧のみ」の案内も出さない（操作できる人へ一瞬見せない）。
  const [staffResolved, setStaffResolved] = useState(false)
  useEffect(() => {
    let active = true
    void loadStaffIdentity()
      .catch(() => {})
      .finally(() => { if (active) setStaffResolved(true) })
    return () => { active = false }
  }, [])

  /**
   * R318: 競合後の入力の戻し先に使うため、読み直した予約を返す。
   * 古い応答・対象外の応答のときは null を返す。
   */
  const load = useCallback(async (): Promise<BookingAdminDetail | null> => {
    if (!selectedAccountId || !isCurrentTarget({ accountId: selectedAccountId, bookingId: id })) return null
    const target = { accountId: selectedAccountId, bookingId: id, generation: targetGeneration.current }
    const generation = ++loadGeneration.current
    const accountId = selectedAccountId
    const bookingId = id
    // DEEP-18: 対象が変わった瞬間に前の予約を残さない。古い詳細が
    // 表示・操作に使われ続ける事故を防ぐ。
    setDetailState((current) =>
      current == null
      || (current.key.accountId === accountId && current.key.bookingId === bookingId)
        ? current
        : null,
    )
    if (!bookingId || !accountId) {
      setLoading(false)
      return null
    }
    setLoading(true)
    setError('')
    setLoadError(null)
    setBookingMissing(false)
    try {
      const res = await bookingApi.getBooking(accountId, bookingId)
      // あとから始めた取得が先に返っている場合、この応答は古い。
      // 遅い応答で今の対象を上書きしない（世代の確認）。
      if (loadGeneration.current !== generation || !isCurrentTarget(target)) return null
      setDetailState({ key: { accountId, bookingId }, booking: res.booking })
      return res.booking
    } catch (caught) {
      if (loadGeneration.current !== generation || !isCurrentTarget(target)) return null
      // 失敗時は前の予約を「今の予約」として残さない。
      setDetailState(null)
      if (caught instanceof ApiError && caught.status === 404) {
        setBookingMissing(true)
      } else {
        setLoadError(caught)
        setError('読み込みに失敗しました。もう一度読み込んでください。')
      }
      return null
    } finally {
      if (loadGeneration.current === generation && isCurrentTarget(target)) setLoading(false)
    }
  }, [id, selectedAccountId])

  useEffect(() => {
    void load()
  }, [load])

  // DEEP-18: 対象（アカウント×予約ID）が切り替わったら、変更モードや
  // 確認窓・メッセージも前の対象のものを残さない。
  useEffect(() => {
    setEditing(false)
    setSaving(false)
    setRetrying(null)
    // R318: 前の予約の編集基準も残さない。
    setEditBase(null)
    setDecideTarget(null)
    setError('')
    // IDEA-27: 追加取得した履歴・開いた内訳も前の対象のものを残さない。
    setExtraAuditLogs(null)
    setAuditLoading(false)
    setAuditError('')
    setHistoryOpen(false)
  }, [id, selectedAccountId])

  const status = detail?.status ?? ''
  const editable = status === 'requested' || status === 'confirmed'
  const isLineLinked = detail?.customer.isLineLinked === true

  // 失敗した外部処理（台帳行から拾う）。
  const failedCalendarOps = useMemo(
    () => (detail?.operations ?? []).filter(
      (op) => op.kind === 'google_calendar' && (op.status === 'retry_wait' || op.status === 'permanent_failed'),
    ),
    [detail],
  )
  const failedNotificationOps = useMemo(
    () => (detail?.operations ?? []).filter(
      (op) => op.kind === 'confirmation_line' && (op.status === 'retry_wait' || op.status === 'permanent_failed'),
    ),
    [detail],
  )
  const queuedCalendar = useMemo(
    () => (detail?.operations ?? []).some((op) => op.kind === 'google_calendar' && op.status === 'queued'),
    [detail],
  )
  // DEEP-19: 通知履歴は実行台帳（operations）だけから作る。
  const notificationOps = useMemo(
    () => (detail?.operations ?? []).filter((op) => op.kind === 'confirmation_line'),
    [detail],
  )

  /**
   * IDEA-27: 変更履歴は「詳細の要点分（直近）＋追加取得分」を id で重複排除して
   * 新しい順に繋ぐ。操作後の再読み込みで要点分が新しくなっても、
   * 追加取得済みの古い記録はそのまま残る。
   */
  const shownAuditLogs = useMemo(() => {
    if (!detail) return [] as BookingAuditLog[]
    const byId = new Map<string, BookingAuditLog>()
    for (const log of [...(extraAuditLogs ?? []), ...detail.auditLogs]) {
      if (!byId.has(log.id)) byId.set(log.id, log)
    }
    return [...byId.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  }, [detail, extraAuditLogs])
  const auditTotal = detail?.auditLogTotal ?? shownAuditLogs.length
  const auditRemaining = Math.max(0, auditTotal - shownAuditLogs.length)
  // audit-logs 口は最大200件。取り切っても残るなら「古い記録は省略」と伝える。
  const auditTruncated = extraAuditLogs !== null && auditRemaining > 0

  /**
   * IDEA-27: 未確認・要対応のまとめ。予約・カレンダー・通知・顧客の
   * 「まだ確認していない／失敗している」ことを1か所に集める。
   */
  const attentionItems = useMemo(() => {
    if (!detail) return [] as Array<{ key: string; text: string; href?: string }>
    const items: Array<{ key: string; text: string; href?: string }> = []
    if (detail.status === 'requested') {
      items.push({
        key: 'pending',
        text: 'まだ承認・お断りの判断をしていません',
        href: '#sec-actions',
      })
      if (detail.customerNote?.trim()) {
        items.push({
          key: 'customer-note',
          text: 'お客様からの要望があります。確認してから判断してください',
          href: '#sec-answer',
        })
      }
    }
    if (detail.previousHandover?.trim()) {
      items.push({
        key: 'handover',
        text: '前回の来店時の申し送りがあります',
        href: '#sec-customer',
      })
    }
    if (detail.calendarSync === 'failed') {
      items.push({
        key: 'calendar',
        text: 'Googleカレンダーに反映できていません',
        href: '#sec-failures',
      })
    }
    if (failedNotificationOps.length > 0) {
      items.push({
        key: 'notification',
        text: `届いていないお知らせが${formatNumber(failedNotificationOps.length)}件あります`,
        href: '#sec-failures',
      })
    }
    const failedReminders = detail.reminders.filter(
      (reminder) => reminder.status === 'failed' || reminder.status === 'failed_permanent',
    )
    if (failedReminders.length > 0) {
      items.push({
        key: 'reminder',
        text: `送信に失敗したお知らせ予定が${failedReminders.length}件あります`,
        href: isLineLinked ? '#sec-reminders' : undefined,
      })
    }
    return items
  }, [detail, failedNotificationOps, isLineLinked])

  const loadMoreAudit = async () => {
    if (!selectedAccountId || !detail) return
    // 対象の切替で始まる load と同じ世代番号で、遅れて返った
    // 別予約の履歴が今の画面へ混ざらないようにする（DEEP-18 と同じ仕組み）。
    const generation = loadGeneration.current
    const target = { accountId: selectedAccountId, bookingId: detail.id, generation: targetGeneration.current }
    setAuditLoading(true)
    setAuditError('')
    try {
      const res = await bookingApi.getAuditLogs(selectedAccountId, detail.id, 200)
      if (loadGeneration.current !== generation || !isCurrentTarget(target)) return
      setExtraAuditLogs(res.audit_logs)
    } catch {
      if (loadGeneration.current !== generation || !isCurrentTarget(target)) return
      setAuditError('記録を読み込めませんでした。もう一度お試しください。')
    } finally {
      if (loadGeneration.current === generation && isCurrentTarget(target)) setAuditLoading(false)
    }
  }

  const decide = async (action: BookingAction) => {
    if (!selectedAccountId || !renderedDecisionTicket || decisionTicket.current !== renderedDecisionTicket || decideGeneration.current !== targetGeneration.current) return
    const actionTarget = { accountId: selectedAccountId, bookingId: id, generation: targetGeneration.current }
    setActing(true)
    setError('')
    try {
      await bookingApi.decideRequest(selectedAccountId, id, action)
      // R322: 承認中に別の予約へ移っていたら、今の画面を触らない。
      if (!isCurrentTarget(actionTarget) || decisionTicket.current !== renderedDecisionTicket) return
      notifyToast(
        action === 'approve' ? '予約を確定しました'
          : action === 'reject' ? '予約をお断りしました'
          : action === 'cancel' ? '予約をキャンセルしました'
          : action === 'complete' ? '予約を完了にしました'
          : '来店なしにしました',
      )
      void load()
      return true
    } catch (e) {
      // R322: 前の予約の失敗で今の画面を汚さない。
      if (!isCurrentTarget(actionTarget) || decisionTicket.current !== renderedDecisionTicket) return
      setError(describeApiFailure(e, '予約の変更'))
      return false
    } finally {
      setActing(false)
    }
  }

  // ---- 変更モードのデータ読み込み ----

  const startEdit = useCallback(() => {
    if (!detail) return
    setEditMenuId(detail.menuId)
    setEditStaffId(detail.staffId)
    setEditDate(jstDate(detail.startsAt))
    setEditTime(jstHHMM(detail.startsAt))
    setEditPrice(String(detail.price))
    setEditCustomerNote(detail.customerNote ?? '')
    setEditInternalNote(detail.internalNote ?? '')
    setEditPolicy(detail.notificationPolicy)
    setEditSendNotice(true)
    setEditReason('')
    // R318: この時点の値を差分の基準にする。
    setEditBase(snapshotEditBase(detail))
    setError('')
    setEditing(true)
  }, [detail])

  useEffect(() => {
    if (!editing || !selectedAccountId) return
    let active = true
    void bookingApi.listMenus(selectedAccountId)
      .then((response) => {
        if (active) setEditMenus(response.menus.filter((item) => item.is_active === 1))
      })
      .catch(() => { if (active) setError('予約メニューを読み込めませんでした') })
    return () => { active = false }
  }, [editing, selectedAccountId])

  useEffect(() => {
    if (!editing || !selectedAccountId || !editMenuId) {
      setEditStaff([])
      return
    }
    let active = true
    void bookingApi.listMenuStaff(selectedAccountId, editMenuId)
      .then((response) => { if (active) setEditStaff(response.staff) })
      .catch(() => { if (active) setError('担当者を読み込めませんでした') })
    return () => { active = false }
  }, [editing, selectedAccountId, editMenuId])

  // 空き枠の取得。変更対象の予約は重なり判定から外す（excludeBookingId）。
  // 外さないと「今の日時のまま」も衝突扱いになって保存できない。
  useEffect(() => {
    const requestId = ++slotRequest.current
    if (!editing || !selectedAccountId || !editMenuId || !editStaffId || !editDate) {
      setEditSlots([])
      return
    }
    setEditSlotsLoading(true)
    void bookingApi.getAvailability(selectedAccountId, {
      menuId: editMenuId,
      staffId: editStaffId,
      from: editDate,
      to: editDate,
      excludeBookingId: id,
    })
      .then((response) => {
        if (requestId !== slotRequest.current) return
        setEditSlots(response.by_staff.find((item) => item.staff_id === editStaffId)?.slots ?? [])
      })
      .catch(() => {
        if (requestId !== slotRequest.current) return
        setEditSlots([])
        setError('空き時間を確認できませんでした。時間をおいて、もう一度お試しください。')
      })
      .finally(() => {
        if (requestId === slotRequest.current) setEditSlotsLoading(false)
      })
  }, [editing, selectedAccountId, editMenuId, editStaffId, editDate, id])

  const saveEdit = async () => {
    // R318: 差分は編集開始時の値（editBase）と比べる。読み直し後の
    // 最新値と比べると、触っていない欄まで「変更あり」に見えてしまう。
    if (!selectedAccountId || !detail || !editBase) return
    const saveTarget = { accountId: selectedAccountId, bookingId: id, generation: targetGeneration.current }
    const base = editBase
    const patch: Parameters<typeof bookingApi.updateBooking>[2] = {
      lock_version: detail.lockVersion,
    }
    if (editMenuId !== base.menuId) patch.menu_id = editMenuId
    if (editStaffId !== base.staffId) patch.staff_id = editStaffId
    const chosenSlot = editSlots.find((slot) => slot.date === editDate && slot.start === editTime)
    if (chosenSlot?.startUtc) {
      const iso = new Date(chosenSlot.startUtc).toISOString()
      if (iso !== base.startsAt) patch.starts_at = iso
    }
    // 日時を変えようとして枠が取れないまま保存すると、日時だけが
    // 静かに無変更になる。それを防ぐため、ここで止める。
    const dateOrTimeChanged = editDate !== base.date || editTime !== base.time
    if (dateOrTimeChanged && !chosenSlot) {
      setError(editTime === '' ? '変更後の時間を選択してください' : '選んだ時間は空いていません。別の時間を選んでください。')
      return
    }
    const priceNum = Number(editPrice)
    if (editPrice.trim() !== '' && (!Number.isInteger(priceNum) || priceNum < 0)) {
      setError('料金は0以上の整数で入力してください')
      return
    }
    if (editPrice.trim() !== '' && Number.isInteger(priceNum) && priceNum >= 0 && priceNum !== base.price) {
      patch.price = priceNum
    }
    if (editCustomerNote !== base.customerNote) patch.customer_note = editCustomerNote || null
    if (editInternalNote !== base.internalNote) patch.internal_note = editInternalNote || null
    const policyPatch: Partial<BookingNotificationPolicy> = {}
    for (const key of Object.keys(POLICY_FIELD_LABELS) as Array<keyof BookingNotificationPolicy>) {
      if (editPolicy[key] !== base.policy[key]) policyPatch[key] = editPolicy[key]
    }
    if (Object.keys(policyPatch).length > 0) patch.notification_policy = policyPatch
    if (!editSendNotice) patch.send_change_notification = false
    if (editReason.trim()) patch.reason = editReason.trim()

    if (Object.keys(patch).length === 1) {
      setError('変更する項目がありません')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await bookingApi.updateBooking(selectedAccountId, id, patch)
      // R322: 保存中に別の予約へ移っていたら、今の画面を触らない。
      if (!isCurrentTarget(saveTarget)) return
      setEditing(false)
      /* IDEA-07: 変更と一緒に動いた通知も応答から言う。
         「組み直した/送る」が見えないと、古い通知が残ったままか、
         新しい通知が組まれたかを画面から確かめられない。 */
      const effects: string[] = []
      if (updated.change_notification === 'queued') {
        effects.push('変更のお知らせをお客様へ送ります')
      }
      if (updated.reminders_created > 0) {
        effects.push('今後のお知らせを新しい日時で組み直しました')
      }
      notifyToast(`${['予約を変更しました', ...effects].join('。')}。`)
      await load()
    } catch (cause) {
      if (!isCurrentTarget(saveTarget)) return
      if (cause instanceof ApiError && cause.code === 'version_conflict') {
        // R318: 競合時は読み直して警告を残す。触っていない欄は最新値に
        // 戻し、自分が変えた欄は残す。再試行は差分だけを新しい版で送る。
        const latest = await load()
        // R322: 読み直しの間に別の予約へ移っていたら何もしない。
        if (!isCurrentTarget(saveTarget)) return
        if (latest) {
          const changed = serverChangedLabels(base, latest)
          if (editMenuId === base.menuId) setEditMenuId(latest.menuId)
          if (editStaffId === base.staffId) setEditStaffId(latest.staffId)
          if (editDate === base.date) setEditDate(jstDate(latest.startsAt))
          if (editTime === base.time) setEditTime(jstHHMM(latest.startsAt))
          if (editPrice === String(base.price)) setEditPrice(String(latest.price))
          if (editCustomerNote === base.customerNote) setEditCustomerNote(latest.customerNote ?? '')
          if (editInternalNote === base.internalNote) setEditInternalNote(latest.internalNote ?? '')
          if ((Object.keys(POLICY_FIELD_LABELS) as Array<keyof BookingNotificationPolicy>)
            .every((key) => editPolicy[key] === base.policy[key])) {
            setEditPolicy({ ...latest.notificationPolicy })
          }
          // 差分の基準を最新に付け替える。変えた欄は最新と違うままなので、
          // 再試行でも差分だけが送られる。
          setEditBase(snapshotEditBase(latest))
          setError(changed.length > 0
            ? `ほかの人が先に${changed.join('・')}を変更しました。最新の内容を確認して、必要なら修正してからもう一度変更してください。`
            : 'ほかの人が先にこの予約を変更しました。最新の内容を確認してから、もう一度変更してください。')
        } else {
          setError('ほかの人が先にこの予約を変更しました。最新の状態を読み直してから、もう一度変更してください。')
        }
      } else if (!isCurrentTarget(saveTarget)) {
        // R322: 別の予約へ移っていたら、前の予約の失敗で今の画面を汚さない。
        return
      } else if (cause instanceof ApiError && (cause.code === 'slot_conflict' || cause.code === 'slot_not_available')) {
        setError('選んだ時間はほかの予約で埋まっています。別の時間を選んでください。')
      } else if (cause instanceof ApiError && cause.code === 'line_notification_unavailable') {
        setError('LINEと結びついていないお客様へは、LINEのお知らせを送れません。')
      } else {
        setError('予約を変更できませんでした。内容を確認して、もう一度お試しください。')
      }
    } finally {
      if (isCurrentTarget(saveTarget)) setSaving(false)
    }
  }

  // ---- 再試行 (N-392 / N-393) ----

  const retryCalendar = async () => {
    if (!selectedAccountId) return
    const retryTarget = { accountId: selectedAccountId, bookingId: id, generation: targetGeneration.current }
    setRetrying('calendar')
    setError('')
    try {
      const result = await bookingApi.retryCalendarSync(selectedAccountId, id)
      // R322: 再試行中に別の予約へ移っていたら、今の画面を触らない。
      if (!isCurrentTarget(retryTarget)) return
      notifyToast(result.status === 'succeeded' ? 'Googleカレンダーへ反映しました' : '反映を再試行しました（まだ失敗している場合は時間をおいて再度お試しください）', result.status === 'succeeded' ? undefined : { tone: 'error' })
      await load()
    } catch (cause) {
      if (!isCurrentTarget(retryTarget)) return
      // R319: 再試行の失敗理由は読み直しで消さない。先に読み直してから
      // 文を置く（load は文を空にするため）。R322: 対象外なら置かない。
      await load()
      if (!isCurrentTarget(retryTarget)) return
      setError(cause instanceof ApiError && cause.code === 'no_retryable_operation'
        ? '再試行できる失敗はありません'
        : '再試行できませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      if (isCurrentTarget(retryTarget)) setRetrying(null)
    }
  }

  const retryNotification = async (runId: string) => {
    if (!selectedAccountId || detail?.operations.some((op) => op.id === runId && op.errorCode === 'delivery_unknown')) return
    const retryTarget = { accountId: selectedAccountId, bookingId: id, generation: targetGeneration.current }
    setRetrying(runId)
    setError('')
    try {
      const result = await bookingApi.retryNotification(selectedAccountId, id, runId)
      // R322: 再試行中に別の予約へ移っていたら、今の画面を触らない。
      if (!isCurrentTarget(retryTarget)) return
      notifyToast(result.status === 'succeeded' ? 'お知らせを送りました' : result.error_code === 'delivery_unknown' ? '送達不明です。送り直さず、運営に確認してください。' : 'お知らせの送信に失敗しました。状態を読み直して確認してください。', result.status === 'succeeded' ? undefined : { tone: 'error' })
      await load()
    } catch (cause) {
      if (!isCurrentTarget(retryTarget)) return
      // R319: 再試行の失敗理由は読み直しで消さない。先に読み直してから文を置く（load は文を空にするため）。
      // R322: 対象外なら置かない。R323/R324: 処理中と失効は理由を分けて出す。
      await load()
      if (!isCurrentTarget(retryTarget)) return
      const code = cause instanceof ApiError ? cause.code : ''
      setError(code === 'delivery_unknown'
        ? '送達不明です。二重送信を避けるため送り直さず、運営に確認してください。'
        : code === 'notification_obsolete'
        ? 'このお知らせは今の予約の状態に合わないため送れません'
        : code === 'retry_in_progress'
          ? 'ほかの担当者が再送中のため送れません。しばらくしてからお試しください'
          : 'お知らせを再送できませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      if (isCurrentTarget(retryTarget)) setRetrying(null)
    }
  }
  return {
    id,
    selectedAccountId,
    loading,
    acting,
    decideTarget,
    setDecideTarget,
    closeDecideTarget,
    error,
    setError,
    loadError,
    bookingMissing,
    detail,
    editing,
    setEditing,
    editMenus,
    editStaff,
    editMenuId,
    setEditMenuId,
    editStaffId,
    setEditStaffId,
    editDate,
    setEditDate,
    editTime,
    setEditTime,
    editSlots,
    editSlotsLoading,
    editPrice,
    setEditPrice,
    editCustomerNote,
    setEditCustomerNote,
    editInternalNote,
    setEditInternalNote,
    editPolicy,
    setEditPolicy,
    editSendNotice,
    setEditSendNotice,
    editReason,
    setEditReason,
    saving,
    leaveTarget,
    confirmLeave,
    cancelLeave,
    retrying,
    auditLoading,
    auditError,
    historyOpen,
    setHistoryOpen,
    canOperate,
    staffResolved,
    load,
    status,
    editable,
    isLineLinked,
    failedCalendarOps,
    failedNotificationOps,
    queuedCalendar,
    notificationOps,
    shownAuditLogs,
    auditRemaining,
    auditTruncated,
    attentionItems,
    loadMoreAudit,
    decide,
    startEdit,
    saveEdit,
    retryCalendar,
    retryNotification,
  }
}

export type BookingDetailModel = ReturnType<typeof useBookingDetail>
