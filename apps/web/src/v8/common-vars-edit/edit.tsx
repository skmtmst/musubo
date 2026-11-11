'use client'

import { ImpactRows,readOnlyDate,ReadOnlyValue } from './edit-impact'
import { loadCommonVar } from './edit-load'
import { b244Requirements,formatHourMinute,historyStamp,jstNowLocalInput,utcToJstLocalInput } from './edit-model'
import { saveCommonVar } from './edit-save'
import { renderScheduleCard } from './edit-schedule-card'
import { renderValueFields } from './edit-value-fields'
export { historyStamp } from './edit-model'
export { changeText,scheduleStamp } from './edit-text'

import { changeText,scheduleStamp } from './edit-text'


import { SaveConflictBand } from '@/components/shared/save-conflict'
import { useFeatureAccess } from '@/lib/use-feature-access'
import type { CommonVar,CommonVarChangeImpact,CommonVarDeleteImpact,CommonVarSchedule,Folder } from '@line-crm/shared'
import { ArrowRight,Check,GitCompare,Pause,Play,Smartphone,Trash2 } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useEffect,useRef,useState } from 'react'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'

import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DateField from '@/components/shared/date-field'
import DateTimeField,{ TimeField } from '@/components/shared/date-time-field'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import LinePreview from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import ListState from '@/components/shared/list-state'
import { NOT_AVAILABLE,STATE_TEXT } from '@/components/shared/not-connected'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { StickyBarAction } from '@/components/shared/sticky-bar'
import ChooseCommonVarTarget from './choose-target'
import TargetMissing from '@/components/shared/target-missing'
import TruncatedText from '@/components/shared/truncated-text'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { api,ApiError,type CommonVarDetail } from '@/lib/api'
import { COMMON_VAR_STATE_LABELS,commonVarValueError,VAR_TYPE_LABELS } from '@/lib/common-vars'
import { csvFileName } from '@/lib/csv-file-name'
import { formatNumber } from '@/lib/format'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { focusFieldById } from '@/lib/use-form-errors'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import styles from './edit.module.css'
import { blockingErrors,historicalText,impactBreakdown,impactCsv,impactStateFromError,impactStateText,overLimitCount,placeholderText,reflectionScopeText,reflectionTimingText,scheduleErrorText,urgentImpactCount,type ChangeImpactState } from './impact'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'

function EditCommonVarV8Inner() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('共通情報を編集')
  usePageCrumbs([
    { label: 'ホーム', href: '/' },
    { label: '共通情報', href: '/contents/vars' },
  ])
  const { selectedAccountId, selectedAccount, loading: accountLoading, error: accountError } = useAccount()
  const latestAccountRef = useRef(selectedAccountId)
  latestAccountRef.current = selectedAccountId
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  // 1152 の板：右の列の上に「LINEでの見え方を見る」を置き、スマホは窓で開く。
  const narrow = useNarrowViewport()

  /*
   * 保存・削除・状態切替の口は `requireRole('owner', 'admin')` で閉じている。
   * staff には閲覧のみの帯を出し、保存などの押し口は置かない（2026-10-06 オーナー決定）。
   */
  const canWrite = useFeatureAccess('commonVars')

  const [item, setItem] = useState<CommonVarDetail | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [schedules, setSchedules] = useState<CommonVarSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadFailure, setLoadFailure] = useState<'missing' | 'error' | null>(null)
  const [foldersError, setFoldersError] = useState(false)
  const [schedulesError, setSchedulesError] = useState(false)
  const [saved, setSaved] = useState(false)

  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [value, setValue] = useState('')
  const [memo, setMemo] = useState('')
  const [changeReason, setChangeReason] = useState('')
  const [reasonFieldError, setReasonFieldError] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [expiryBehavior, setExpiryBehavior] = useState<'stop' | 'fallback'>('stop')
  const [fallbackValue, setFallbackValue] = useState('')
  const [valueFieldError, setValueFieldError] = useState('')
  const [fallbackFieldError, setFallbackFieldError] = useState('')
  const [scheduleFieldError, setScheduleFieldError] = useState('')
  /* 欄の誤りは帯ではなく欄の真下に出して移る。 */
  const [nameFieldError, setNameFieldError] = useState('')
  const [periodFieldError, setPeriodFieldError] = useState('')
  const [scheduleDateError, setScheduleDateError] = useState('')

  const [draft, setDraft] = useState<{ date: string; time: string; value: string } | null>(null)
  const [clearSchedulesOpen, setClearSchedulesOpen] = useState(false)
  const [clearScope, setClearScope] = useState<{ accountId: string; itemId: string; scheduleIds: string[]; window: object } | null>(null)
  const clearWindow = useRef<object>({})
  useEffect(() => { setClearSchedulesOpen(false); setClearSchedulesBusy(false); return () => { clearWindow.current = {} } }, [selectedAccountId])
  const [addingSchedule, setAddingSchedule] = useState(false)
  const [clearSchedulesBusy, setClearSchedulesBusy] = useState(false)
  const [clearSchedulesError, setClearSchedulesError] = useState('')
  const [clearSchedulesNeedsReview, setClearSchedulesNeedsReview] = useState(false)

  useEffect(() => { setValueFieldError('') }, [value])
  useEffect(() => { setFallbackFieldError('') }, [fallbackValue])
  useEffect(() => { setScheduleFieldError('') }, [draft?.value])

  const [impact, setImpact] = useState<CommonVarDeleteImpact | CommonVarChangeImpact | null>(null)
  const [impactState, setImpactState] = useState<ChangeImpactState>('loading')
  /** 狭い板ではスマホの見え方を窓で見る（板 ）。 */
  const [previewOpen, setPreviewOpen] = useState(false)

  const loadImpact = useCallback(async (
    varId: string,
    accountId: string,
    nextValue?: string,
    expectedVersion?: number,
  ) => {
    setImpactState('loading')
    try {
      const res = nextValue === undefined
        ? await api.commonVars.deleteImpact(varId, accountId)
        : await api.commonVars.impactPreview(varId, accountId, nextValue, expectedVersion)
      if (accountId !== latestAccountRef.current) return
      if (!res.success) {
        setImpact(null)
        setImpactState('error')
        return
      }
      setImpact(res.data)
      setImpactState('ready')
    } catch (e) {
      if (accountId !== latestAccountRef.current) return
      const fieldFailure = saveErrors.capture(e)
      setImpact(null)
      { if (!fieldFailure)
      setImpactState(impactStateFromError(e))
    }
  }
  }, [saveErrors])

  useEffect(() => {
    if (!item || !selectedAccountId) return
    const nextValue = value === item.value ? undefined : value
    const timer = setTimeout(() => {
      void loadImpact(item.id, selectedAccountId, nextValue, item.version)
    }, 400)
    return () => clearTimeout(timer)
  }, [item, selectedAccountId, value, loadImpact])

  const blocked = impact && 'canSave' in impact && impactState === 'ready'
    ? blockingErrors(impact)
    : []

  const loadFolders = useCallback(async (accountId: string) => {
    try {
      const folderList = await api.folders.list('common_var')
      if (accountId !== latestAccountRef.current) return
      if (folderList.success) {
        setFolders(folderList.data)
        setFoldersError(false)
      } else {
        setFoldersError(true)
      }
    } catch (saveFailure) {
      if (accountId !== latestAccountRef.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setFoldersError(true)
    }
  }
  }, [saveErrors]);


  const loadSchedules = useCallback(async (varId: string, accountId: string) => {
    try {
      const scheduleList = await api.commonVars.schedules(varId, accountId)
      if (accountId !== latestAccountRef.current) return
      if (scheduleList.success) {
        setSchedules(scheduleList.data)
        setSchedulesError(false)
      } else {
        setSchedulesError(true)
      }
    } catch (saveFailure) {
      if (accountId !== latestAccountRef.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setSchedulesError(true)
    }
  }
  }, [saveErrors]);


  const applyDetail = useCallback((found: CommonVarDetail) => {
    setItem(found)
    setName(found.name)
    setFolderId(found.folderId ?? '')
    setValue(found.value)
    setMemo(found.memo)
    setValidFrom(utcToJstLocalInput(found.validFrom))
    setValidUntil(utcToJstLocalInput(found.validUntil))
    setExpiryBehavior(found.expiryBehavior ?? 'stop')
    setFallbackValue(found.fallbackValue ?? '')
  }, [])

  const load = useCallback(() => loadCommonVar({ accountLoading, applyDetail, id, latestAccountRef, saveErrors, selectedAccountId, setConflict, setError, setFolders, setFoldersError, setItem, setLoadFailure, setLoading, setSchedules, setSchedulesError }), [accountLoading, applyDetail, id, selectedAccountId, saveErrors])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * 競合の帯（板 ）。保存が409で止まったとき、入力を残したまま
   * いま保存されている版へ合わせ、誰がいつ保存したかを見せる。
   */
  const [conflict, setConflict] = useState<{
    actorName: string | null
    savedAt: string | null
  } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)

  const refreshBaseline = async (varId: string, accountId: string, err?: ApiError) => {
    const body = err?.data as { currentVersion?: unknown } | undefined
    if (typeof body?.currentVersion === 'number' && Number.isInteger(body.currentVersion)) {
      const currentVersion = body.currentVersion
      setItem((prev) => (prev ? { ...prev, version: currentVersion } : prev))
    }
    try {
      const detail = await api.commonVars.detail(varId, accountId)
      if (accountId !== latestAccountRef.current) return null
      if (detail.success) {
        setItem(detail.data)
        return detail.data
      }
      return null
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      return null
    } finally {
      await loadSchedules(varId, accountId)
    }
  }

  const save = () => saveCommonVar({ changeReason, expiryBehavior, fallbackValue, folderId, item, latestAccountRef, load, memo, name, refreshBaseline, saveErrors, saving, selectedAccountId, setChangeReason, setCompareOpen, setConflict, setError, setFallbackFieldError, setNameFieldError, setPeriodFieldError, setReasonFieldError, setSaved, setSaving, setValueFieldError, validFrom, validUntil, value })

  /** 最新を読み込んで続ける。打ち込んだ内容は捨て、いまの版から直し直す。 */
  const adoptLatest = () => {
    if (!item) return
    applyDetail(item)
    setConflict(null)
    setCompareOpen(false)
    setError('')
  }

  const [deleteTarget, setDeleteTarget] = useState<{ item: CommonVar; accountId: string; window: object } | null>(null)
  const deleteWindow = useRef<object>({})
  const deleteWindowAccount = useRef(selectedAccountId)
  if (deleteWindowAccount.current !== selectedAccountId) deleteWindow.current = {}
  deleteWindowAccount.current = selectedAccountId
  useEffect(() => () => { deleteWindow.current = {} }, [])
  const [deleteReason, setDeleteReason] = useState('')
  const [deletePhase, setDeletePhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [deleteImpact, setDeleteImpact] = useState<CommonVarDeleteImpact | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const deleteAccountSwitched = deleteTarget !== null && (deleteTarget.accountId !== selectedAccountId || deleteTarget.window !== deleteWindow.current)
  useEffect(() => { setDeleting(false) }, [selectedAccountId])

  const dirty = item !== null && (
    name !== item.name ||
    folderId !== (item.folderId ?? '') ||
    value !== item.value ||
    memo !== item.memo ||
    validFrom !== utcToJstLocalInput(item.validFrom) ||
    validUntil !== utcToJstLocalInput(item.validUntil) ||
    expiryBehavior !== (item.expiryBehavior ?? 'stop') ||
    fallbackValue !== (item.fallbackValue ?? '') ||
    draft !== null
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty,
    busy: saving || deleting,
  })
  const leaveConfirmDialog = (
    <UnsavedLeaveDialog open={leaveTarget !== null} subject="共通情報への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
  )

  const openDelete = async () => {
    if (!item || !selectedAccountId) return
    deleteWindow.current = {}
    const target = { item, accountId: selectedAccountId, window: deleteWindow.current }
    setDeleteTarget(target)
    setDeleteImpact(null)
    setDeleteError('')
    setDeleteReason('')
    setDeletePhase('loading')
    try {
      const res = await api.commonVars.deleteImpact(target.item.id, target.accountId)
      if (latestAccountRef.current !== target.accountId || deleteWindow.current !== target.window) return
      if (!res.success) throw new Error(res.error)
      setDeleteImpact(res.data)
      setDeletePhase('ready')
    } catch (saveFailure) {
      if (latestAccountRef.current !== target.accountId || deleteWindow.current !== target.window) return
      saveErrors.capture(saveFailure)
      setDeletePhase('error')
    }
  }

  const closeDelete = () => {
    if (deleting)
 return
    deleteWindow.current = {}
    setDeleteTarget(null)
    setDeleteImpact(null)
    setDeleteError('')
    setDeleteReason('')
    setDeletePhase('loading')
  }

  const remove = async () => {
    if (!deleteTarget || deleting || deleteAccountSwitched || latestAccountRef.current !== deleteTarget.accountId || deleteWindow.current !== deleteTarget.window) return
    if (deletePhase !== 'ready' || !deleteImpact?.canDelete) return
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.commonVars.delete(deleteTarget.item.id, deleteTarget.accountId, deleteReason.trim())
      if (latestAccountRef.current !== deleteTarget.accountId || deleteWindow.current !== deleteTarget.window) return
      if (!res.success) throw new Error(res.error)
      setDeleting(false)
      deleteWindow.current = {}
      setDeleteTarget(null)
      router.push('/contents/vars')
    } catch (e) {
      if (latestAccountRef.current !== deleteTarget.accountId || deleteWindow.current !== deleteTarget.window) return
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && e.status === 409) {
        { if (!fieldFailure)
        setDeleteError('いま使われ始めたため、削除できませんでした。使用先を読み直しました。') }
        try {
          const again = await api.commonVars.deleteImpact(deleteTarget.item.id, deleteTarget.accountId)
          if (latestAccountRef.current !== deleteTarget.accountId || deleteWindow.current !== deleteTarget.window) return
          if (again.success) setDeleteImpact(again.data)
          else setDeletePhase('error')
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          setDeletePhase('error')
        }
        return
      }
      { if (!fieldFailure)
      setDeleteError('削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (latestAccountRef.current === deleteTarget.accountId && deleteWindow.current === deleteTarget.window) setDeleting(false)
    }
  }

  const addSchedule = async () => {
    if (addingSchedule || !item || !draft || !selectedAccountId) return
    if ((b244Requirements.draft_date.check(draft.date) !== null)) {
      setScheduleDateError('開始日を入れてください')
      focusFieldById('sc-date')
      return
    }
    const scheduleValueError = commonVarValueError(item.type, draft.value, '更新後の値')
    if (scheduleValueError) {
      setError(scheduleValueError)
      setScheduleFieldError(scheduleValueError)
      return
    }
    setError('')
    setAddingSchedule(true)
    try {
      const res = await api.commonVars.addSchedule(item.id, selectedAccountId, {
        effectiveFrom: `${draft.date}T${draft.time || '00:00'}`,
        value: draft.value,
      })
      if (!res.success) {
        setError(res.error)
        if (res.error.includes('更新後の値') || res.error.includes('種別')) {
          setScheduleFieldError(res.error)
        }
        return
      }
      setDraft(null)
      await refreshBaseline(item.id, selectedAccountId)
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(scheduleErrorText(e)) }
    } finally {
      setAddingSchedule(false)
    }
  }

  const removeSchedule = async (scheduleId: string) => {
    if (!item || !selectedAccountId) return
    setError('')
    try {
      await api.commonVars.deleteSchedule(item.id, scheduleId, selectedAccountId)
      await refreshBaseline(item.id, selectedAccountId)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('予約の削除に失敗しました。通信を確かめて、もう一度お試しください。') }
    }
  }

  const clearSchedules = async () => {
    if (!item || !selectedAccountId || !clearScope || clearScope.itemId !== item.id || clearScope.accountId !== selectedAccountId || latestAccountRef.current !== clearScope.accountId || clearScope.window !== clearWindow.current || clearSchedulesBusy || clearSchedulesNeedsReview) return
    if (schedules.length !== clearScope.scheduleIds.length || schedules.some(schedule => !clearScope.scheduleIds.includes(schedule.id))) {
      setClearSchedulesError('予定が変わりました。閉じて、予定を確認してからやり直してください。')
      setClearSchedulesNeedsReview(true)
      return
    }
    setClearSchedulesBusy(true)
    setClearSchedulesError('')
    try {
      for (const scheduleId of clearScope.scheduleIds) {
        if (latestAccountRef.current !== clearScope.accountId || clearWindow.current !== clearScope.window) return
        const response = await api.commonVars.deleteSchedule(item.id, scheduleId, selectedAccountId)
        if (!response.success) throw new Error('schedule_delete_failed')
      }
      if (latestAccountRef.current !== clearScope.accountId || clearWindow.current !== clearScope.window) return
      setClearSchedulesBusy(false); clearWindow.current = {}
      setClearSchedulesOpen(false)
      await refreshBaseline(item.id, selectedAccountId)
    } catch (saveFailure) {
      if (latestAccountRef.current !== clearScope.accountId || clearWindow.current !== clearScope.window) return
      setClearSchedulesNeedsReview(true)
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setClearSchedulesError('消せなかった予定があります。通信を確かめて、もう一度お試しください。') }
    } finally {
      if (latestAccountRef.current === clearScope.accountId && clearWindow.current === clearScope.window) setClearSchedulesBusy(false)
    }
  }

  const [statusAction, setStatusAction] = useState<'stop' | 'resume' | 'publish' | null>(null)
  const [statusScope, setStatusScope] = useState<{ accountId: string; itemId: string; window: object } | null>(null)
  const statusWindow = useRef<object>({})
  useEffect(() => { setStatusAction(null); setStatusBusy(false); return () => { statusWindow.current = {} } }, [selectedAccountId])
  const [statusReason, setStatusReason] = useState('')
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState('')

  const openStatusDialog = (action: 'stop' | 'resume' | 'publish') => {
    if (!selectedAccountId || !item) return
    statusWindow.current = {}
    setStatusScope({ accountId: selectedAccountId, itemId: item.id, window: statusWindow.current })
    setStatusAction(action)
    setStatusReason('')
    setStatusError('')
  }

  const closeStatusDialog = () => {
    if (statusBusy) return
    statusWindow.current = {}
    setStatusAction(null)
    setStatusReason('')
    setStatusError('')
  }

  const applyStatus = async () => {
    if (!item || !selectedAccountId || !statusAction || !statusScope || statusScope.accountId !== selectedAccountId || statusScope.itemId !== item.id || latestAccountRef.current !== statusScope.accountId || statusWindow.current !== statusScope.window) return
    const reason = statusReason.trim()
    if (!reason) {
      setStatusError('変える理由を入力してください')
      return
    }
    setStatusBusy(true)
    setStatusError('')
    try {
      const res = await api.commonVars.setStatus(item.id, selectedAccountId, {
        to: statusAction === 'stop' ? 'stopped' : 'active',
        changeReason: reason,
        expectedVersion: item.version,
      })
      if (latestAccountRef.current !== statusScope.accountId || statusWindow.current !== statusScope.window) return
      if (!res.success) {
        setStatusError(res.error)
        return
      }
      setStatusBusy(false); statusWindow.current = {}; setStatusAction(null)
      setStatusReason('')
      await load()
    } catch (e) {
      if (latestAccountRef.current !== statusScope.accountId || statusWindow.current !== statusScope.window) return
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)
      setStatusError(
        e instanceof ApiError && e.status === 409
          ? '別の担当者が先に更新しました。最新内容を読み直してください。'
          : '状態を変えられませんでした。通信を確かめて、もう一度お試しください。',
      ) }
    } finally {
      if (latestAccountRef.current === statusScope.accountId && statusWindow.current === statusScope.window) setStatusBusy(false)
    }
  }

  const exportImpactCsv = () => {
    if (!impact || !('canSave' in impact)) return
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${impactCsv(impact)}`], { type: 'text/csv;charset=utf-8' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("共通情報の影響範囲")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (!id) {
    return (
      <SaveErrorScope errors={saveErrors}><ChooseCommonVarTarget accountId={selectedAccountId}
        onSelect={targetId => router.push(`/contents/vars/edit?id=${encodeURIComponent(targetId)}`)} /></SaveErrorScope>
    )
  }
  if (!accountLoading && !selectedAccountId) {
    return (
      <SaveErrorScope errors={saveErrors}><ListState
        kind="empty"
        title="LINEアカウントを選んでください"
        description="選ぶと共通情報を編集できます。"
        action={<Button href="/contents/vars">共通情報一覧へ戻る</Button>}
      /></SaveErrorScope>
    )
  }
  if (!loading && loadFailure === 'missing') {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="not-found"
        title="この共通情報は見つかりません"
        description="削除されたか、リンクが古くなっています。一覧から選び直してください。"
        backHref="/contents/vars"
        backLabel="共通情報一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (!loading && loadFailure === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="error"
        title="共通情報を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void load()}
      /></SaveErrorScope>
    )
  }

  const usageTotal = item?.usagePage
    ? item.usagePage.total
    : impactState === 'ready' && impact
      ? impact.total
      : null
  const stateLabel = item ? (COMMON_VAR_STATE_LABELS[item.state ?? item.status ?? 'active'] ?? '使用中') : ''
  const typeLabel = item ? (VAR_TYPE_LABELS[item.type] ?? item.type) : ''
  const stopped = (item?.status ?? 'active') === 'stopped'
  const isDraft = (item?.status ?? 'active') === 'draft'

  const previewAccountName = !accountLoading && !accountError && selectedAccountId && selectedAccount?.id === selectedAccountId && !loading && !loadFailure && item?.lineAccountId === selectedAccountId
    ? selectedAccount.displayName?.trim() || selectedAccount.name.trim() || 'アカウント名未取得'
    : 'アカウント名未取得'

  const previewTalk = (
    <LinePreview
      caption={schedules.length > 0 && schedules[0] ? `${scheduleStamp(schedules[0].effectiveFrom)} から` : undefined}
      accountName={previewAccountName}
      note="差し込んだときの見え方です。新しい中身を入れると、ここが変わります。"
    >
      <div className={styles.talkRow}>
        <span className={styles.talkIcon} aria-hidden="true"><MusuboMark /></span>
        <div className={styles.talkCol}>
          <TruncatedText value={previewAccountName} className={styles.talkName} />
          <div className={styles.talkBubbleRow}>
            <p className={styles.talkBubble}>
              {`いつもありがとうございます。\n${item?.name ?? '共通情報'}は ${value || emptyValue('unconfigured')} です。`}
            </p>
            <span className={styles.talkTime}>10:00</span>
          </div>
        </div>
      </div>
    </LinePreview>
  )

  const fieldsGroup = renderValueFields({ canWrite, expiryBehavior, fallbackFieldError, fallbackValue, folderId, folders, foldersError, item, loadFolders, memo, name, nameFieldError, periodFieldError, selectedAccountId, setExpiryBehavior, setFallbackValue, setFolderId, setFolders, setMemo, setName, setNameFieldError, setPeriodFieldError, setSaved, setValidFrom, setValidUntil, validFrom, validUntil })

  const scheduleCard = renderScheduleCard({ canWrite, item, loadSchedules, removeSchedule, schedules, schedulesError, selectedAccountId, setClearSchedulesError, setClearSchedulesOpen: () => { if (!selectedAccountId || !item) return; clearWindow.current = {}; setClearSchedulesNeedsReview(false); setClearScope({ accountId: selectedAccountId, itemId: item.id, scheduleIds: schedules.map(schedule => schedule.id), window: clearWindow.current }); setClearSchedulesOpen(true) }, setDraft, value })

  const historyCard = item ? (
    <section className={styles.sideCard} aria-labelledby="cv-edit-history-heading">
      <h2 id="cv-edit-history-heading" className={styles.sideTitle}>これまでの変更</h2>
      {item.history.length > 0 ? (
        <ol className={styles.historyList}>
          {item.history.slice(0, 5).map((entry, index) => {
            const previous = item.history[index + 1]
            const actor = entry.actorName ?? (entry.actorId ? '担当者名を確認できません' : '担当者未記録')
            const what = previous
              ? `${changeText(previous.value, entry.value)}・${actor}${entry.changeReason ? `「${entry.changeReason}」` : ''}`
              : `作成・${actor}`
            return (
              <li key={entry.id} className={styles.historyItem}>
                <span className={styles.historyDate}>{historyStamp(entry.createdAt)}</span>
                <span className={previous ? styles.historyText : styles.historyTextQuiet} title={entry.changeReason || undefined}>{what}</span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className={styles.fieldHint}>まだ変更履歴はありません。</p>
      )}
    </section>
  ) : null

  const preview = item ? (
    narrow ? (
      <>
        <div className={styles.narrowPhoneOpen}>
          <Button type="button" onClick={() => setPreviewOpen(true)}>
            <Smartphone size={16} aria-hidden="true" />
            LINEでの見え方を見る
          </Button>
        </div>
        {scheduleCard}
        {fieldsGroup}
        {historyCard}
      </>
    ) : conflict ? (
      /* 競合のとき：決めた日と見え方を上に。名前・期間・メモ・履歴は下へ回す（消さない）。 */
      <>
        {scheduleCard}
        {previewTalk}
        {fieldsGroup}
        {historyCard}
      </>
    ) : (
      <>
        {fieldsGroup}
        {scheduleCard}
        {historyCard}
        <div className={styles.phoneWrap}>{previewTalk}</div>
      </>
    )
  ) : undefined

  const conflictNotice = item && conflict ? <>
          {/* 競合の帯（板 `piWhz`）。頭の下に横いっぱい。入力は残したまま、誰の保存かを見せる。 */}
            {/* 誰が・いつ保存したかの文と、入力を残す動きは同じ。 */}
            <div className={styles.conflictSlot}>
              <SaveConflictBand reloadVariant="primary"
                title={`${conflict.actorName ?? '別の担当者'}さんが ${conflict.savedAt && formatHourMinute(conflict.savedAt) ? `${formatHourMinute(conflict.savedAt)} に` : ''}共通情報「${item.name}」を保存しました`}
                description={`あなたが直した所はまだ保存されていません。このまま保存すると、${conflict.actorName ?? '別の担当者'}さんの変更が消えます。`}
                designNode="piWhz"
                onCompare={() => setCompareOpen(true)}
                onReload={adoptLatest}
              />
            </div>
  </> : undefined

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId={narrow ? 'C67dE' : 'AYc6O'}
      title={item?.name ?? '共通情報を編集'}
      help={item ? (
        <>
          {`${placeholderText(item.varKey)}・${typeLabel}・${stateLabel}・${usageTotal === null ? emptyValue('unknown') : `${formatNumber(usageTotal)}か所で使っています`}`}

        </>
      ) : undefined}
      notice={conflictNotice}
      noticeSpacing="band"
      identity={<></>}
      preview={preview}
      /* 1152は右の列を畳まず、スマホだけをボタンにして「決めた日に変える」を右に残す（畳むと予定の欄が見えなくなっていた）。 */
      hidePreviewWhenNarrow={!narrow}
      previewCompactWhenNarrow
      destructive={canWrite && item ? (
        <StickyBarAction destructive icon={Trash2} label="削除する" onClick={() => openDelete()} />
      ) : undefined}
      status={blocked.length > 0 ? `${blocked[0]}。直すまで保存できません。` : undefined}
      footerActions={(
        <>
          <Button href="/contents/vars">キャンセル</Button>
          {/* 閲覧のみには押せない操作を置かない（隠す）。 */}
          {canWrite && item && !stopped && !isDraft ? (
            <Button type="button" onClick={() => openStatusDialog('stop')} disabled={saving}>
              <Pause size={16} aria-hidden="true" />
              止める
            </Button>
          ) : null}
          {/* 状態で変わる操作は下の帯だけに置く（右の列に同じ操作を並べない）。止めている→再開する、下書き→公開する。 */}
          {canWrite && item && stopped ? (
            <Button type="button" onClick={() => openStatusDialog('resume')} disabled={saving}>
              <Play size={16} aria-hidden="true" />
              再開する
            </Button>
          ) : null}
          {canWrite && item && isDraft ? (
            <Button type="button" onClick={() => openStatusDialog('publish')} disabled={saving}>
              公開する
            </Button>
          ) : null}
          {canWrite && item ? (
            conflict ? (
              <Button type="button" variant="primary" icon={<GitCompare size={16} aria-hidden="true" />} onClick={() => setCompareOpen(true)} disabled={saving}>
                比べてから保存
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary" widthReserve="dynamic" icon={<Check size={16} aria-hidden="true" />}
                disabled={saving || blocked.length > 0}
                onClick={() => void save()}
                busy={saving}
                busyLabel="保存中…"
              >
                {impactState === 'ready' && impact && usageTotal !== null
                  ? `${formatNumber(usageTotal)}か所に反映して保存`
                  : '保存する'}
              </Button>
            )
          ) : null}
        </>
      )} dirty={false}
    >
      {canWrite ? null : (
        <div className={styles.roBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
      )}
      {item?.varKey === 'business_hours' ? <Notice tone="info">Googleビジネスと接続済みのときは、配信に差し込む営業時間もGoogleの通常・特別営業時間を使います。<Button href="/settings/google-hours" variant="text">Googleの営業時間を開く</Button></Notice> : null}

      {error && item ? (
        <Notice tone="danger" message={error} onClose={() => setError('')} />
      ) : null}

      {loading || !item ? (
        <ListState kind="loading" title="共通情報を読み込んでいます" />
      ) : (
        <>
          <section className={styles.card} aria-labelledby="cv-edit-value-heading">
            <div className={styles.cardHead}>
              <h2 id="cv-edit-value-heading" className={styles.cardTitle}>中身を変える</h2>
            </div>
            <div className={styles.valueRow}>
              <div className={styles.field}><Field label="いまの中身" htmlFor="cv-current"><SaveErrorField names={["value","item.value"]}><SharedTextField
                  id="cv-current"
                  type="text"
                  value={item.value || '（空）'}
                  readOnly
                  aria-readonly="true"
                  className={styles.fieldInput}
                /></SaveErrorField></Field></div>
              <span className={styles.valueArrow} aria-hidden="true"><ArrowRight size={20} /></span>
              <div className={styles.field}><Field label="新しい中身" htmlFor="cv-value">{!canWrite && (item.type === 'boolean' || (item.type as string) === 'date' || (item.type as string) === 'datetime') ? (
                  // 閲覧のみ：選ぶ部品は置かず、中身を文字で見せる。
                  <ReadOnlyValue id="cv-value" label="新しい中身" value={item.type === 'boolean' ? value : readOnlyDate(value)} />
                ) : item.type === 'boolean' ? (
                  <SaveErrorField names={["value","saved"]}><Select size="full" aria-label="新しい中身" id="cv-value" value={value} onChange={(next) => { setSaved(false); setValue(next) }} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} /></SaveErrorField>
                ) : (item.type as string) === 'long_text' ? (
                  <SaveErrorField names={["value","saved"]}><SharedTextArea id="cv-value" value={value} onChange={(e) => { setSaved(false); setValue(e.target.value) }} className={styles.fieldArea} rows={2} readOnly={!canWrite} aria-invalid={valueFieldError ? true : undefined} /></SaveErrorField>
                ) : (item.type as string) === 'date' ? (
                  <SaveErrorField names={["value","saved"]}><DateField id="cv-value" invalid={Boolean(valueFieldError)} value={value} onChange={(v) => { setSaved(false); setValue(v) }} /></SaveErrorField>
                ) : (item.type as string) === 'datetime' ? (
                  <SaveErrorField names={["value","saved"]}><DateTimeField id="cv-value" invalid={Boolean(valueFieldError)} value={value} onChange={(v) => { setSaved(false); setValue(v) }} /></SaveErrorField>
                ) : (
                  <SaveErrorField names={["value","saved"]}><SharedTextField
                    id="cv-value"
                    type={item.type === 'number' ? 'number' : 'text'}
                    maxLength={item.type === 'number' ? undefined : 200}
                    value={value}
                    onChange={(e) => { setSaved(false); setValue(e.target.value) }}
                    className={styles.fieldInput}
                    aria-invalid={valueFieldError ? true : undefined}
                    aria-label="新しい中身"
                    readOnly={!canWrite}
                  /></SaveErrorField>
                )}</Field></div>
            </div>
            {valueFieldError ? <p className={styles.fieldError} role="alert">{valueFieldError}</p> : null}
            <div className={styles.field}><Field label="変える理由（記録に残ります）" htmlFor="cv-change-reason" requirement={b244Requirements.changeReason}><SaveErrorField names={["changeReason","saved","change_reason"]}><SharedTextField
                id="cv-change-reason"
                type="text"
                value={changeReason}
                onChange={(e) => { setSaved(false); setReasonFieldError(''); setChangeReason(e.target.value) }}
                maxLength={200}
                placeholder="例：10月から営業時間が変わるため"
                className={styles.fieldInput}
                aria-label="変える理由（記録に残ります）"
                readOnly={!canWrite}
              /></SaveErrorField>
{reasonFieldError ? <p className={styles.fieldError} role="alert">{reasonFieldError}</p> : null}</Field></div>
          </section>

          <section className={styles.card} aria-labelledby="cv-edit-impact-heading">
            <div className={styles.cardHead}>
              <h2 id="cv-edit-impact-heading" className={styles.cardTitle}>変える前に影響を見る</h2>
              <p className={styles.cardNote} title={impact ? [reflectionScopeText(impact), reflectionTimingText(impact), historicalText(impact), ...('canSave' in impact ? [impactBreakdown(impact), `予約中・配信中：${urgentImpactCount(impact) ?? NOT_AVAILABLE}か所`, `文字数超過：${overLimitCount(impact)}か所`] : [])].filter(Boolean).join('\n') : undefined}>
                {impactState === 'ready' && impact
                  ? `${formatNumber(impact.total)}か所。次に送る・動くときから新しい値が入ります。すでに届いた文は変わりません`
                  : '次に送る・動くときから新しい値が入ります。すでに届いた文は変わりません'}
              </p>
            </div>
            {impactState !== 'ready' || !impact ? (
              <div className={styles.impactState} data-impact-state={impactState}>
                <p className={styles.cardNote}>{impactStateText(impactState)}</p>
                {impactState === 'error' ? (
                  <Button
                    type="button"
                    onClick={() => {
                      if (item && selectedAccountId) return loadImpact(item.id, selectedAccountId)
                    }}
                   busyLabel="処理中…">
                    {STATE_TEXT.retry}
                  </Button>
                ) : null}
              </div>
            ) : (
              <ImpactRows impact={impact} onExportCsv={exportImpactCsv} />
            )}
          </section>

          {null}
        </>
      )}

      {/* 状態の切替（止める・再開する・公開する）。理由は記録に残すので必須。 */}
      <Dialog
        open={statusAction !== null && statusScope?.accountId === selectedAccountId && statusScope.window === statusWindow.current}
        designNode="AYc6O-status"
        title={item && statusAction
          ? `「${item.name}」を${statusAction === 'stop' ? '止める' : statusAction === 'resume' ? '再開する' : '公開する'}`
          : ''}
        description={statusAction === 'stop'
          ? '止めているあいだ、この共通情報を差し込んだ配信は送られません。あとで再開できます。'
          : statusAction === 'resume'
            ? 'この共通情報を再び配信で使えるようにします。'
            : '下書きを配信で使えるようにします。公開すると差し込みに使われます。'}
        busy={statusBusy}
        error={statusError || undefined}
        onCancel={closeStatusDialog}
        footer={
          <DialogActions>
            <Button type="button" onClick={closeStatusDialog} disabled={statusBusy}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void applyStatus()}
              disabled={statusBusy}
              busy={statusBusy}
              busyLabel="変更中…"
            >
              {statusAction === 'stop' ? '止める' : statusAction === 'resume' ? '再開する' : '公開する'}
            </Button>
          </DialogActions>
        }
      >
        <OperationTargetSummary accounts={[{ id: statusScope?.accountId ?? '' }]} />
        <Field required label={<><span className={styles.fieldLabelStrong}>
            {statusAction === 'stop' ? '止める理由（記録に残ります）'
              : statusAction === 'resume' ? '再開する理由（記録に残ります）'
                : '公開する理由（記録に残ります）'}
          </span></>}><SaveErrorField names={["statusReason","statusError","changeReason","status_reason","status_error"]}><SharedTextField
            value={statusReason}
            onChange={(e) => { setStatusError(''); setStatusReason(e.target.value) }}
            maxLength={200}
            placeholder={statusAction === 'stop' ? '例：キャンペーンが終わったため' : '例：新しい期間の案内を始めるため'}
            className={styles.fieldInput}
          /></SaveErrorField></Field>
      </Dialog>

      {/* 削除の確認。使われているものは消さず、一覧の窓（`xxKtW`）へ導く。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `共通情報「${deleteTarget.item.name}」を削除しますか？` : ''}
        description="この共通情報と、登録値・次回の更新予約を削除します。テンプレート・配信・フォルダ・友だちは削除しません。この操作は取り消せません。"
        confirmLabel="削除する"
        destructive
        busy={deleting}
        error={
          deleteAccountSwitched
            ? '窓を開けたあとにLINEアカウントが切り替わりました。この共通情報は、いま選んでいるアカウントのものではありません。閉じてから選び直してください。'
            : deleteError || undefined
        }
        onConfirm={
          deleteAccountSwitched || deletePhase !== 'ready' || !deleteImpact?.canDelete
            || !deleteReason.trim()
            ? undefined
            : () => remove()
        }
        onCancel={closeDelete}
      >
        <OperationTargetSummary accounts={[{ id: deleteTarget?.accountId ?? '' }]} />
        <div className={styles.dialogBody}>
          {deletePhase === 'loading' ? (
            <p className={styles.fieldHint}>使われている場所を読み込んでいます</p>
          ) : deletePhase === 'error' ? (
            <Notice tone="danger" className={styles.fieldErrorNoticePlacement} >使用先を読み込めませんでした。読み直してから、もう一度お試しください。</Notice>
          ) : deleteImpact ? (
            <>
              <p className={deleteImpact.blockingTotal > 0 ? styles.fieldError : styles.fieldHint}>
                {deleteImpact.unavailableReferences?.length
                  ? 'まだ数えられていない使用先があります。読み直してから確認してください。'
                  : deleteImpact.blockingTotal > 0
                  ? `いま${deleteImpact.blockingTotal}か所で使われています。一覧の削除の窓から差し替えてください。`
                  : '使っている設定はありません。'}
              </p>
              {deleteImpact.unavailableReferences?.map((reference) => <p key={reference.kind} className={styles.fieldHint}>{reference.kindLabel}：{reference.reason}</p>)}
              <Field label="消した理由" required><SaveErrorField names={["deleteReason","delete_reason"]}><SharedTextField
                  value={deleteReason}
                  onChange={(event) => setDeleteReason(event.target.value)}
                  placeholder="例：店舗情報の変更のため"
                  className={styles.fieldInput}
                /></SaveErrorField></Field>
            </>
          ) : null}
        </div>
      </ConfirmDialog>

      {/* 予定を足す窓。 */}
      <Dialog
        open={draft !== null}
        busy={addingSchedule}
        designNode="AYc6O-schedule"
        title="予定を足す"
        description="決めた日時から、ここに入れた値へ変わります。"
        onCancel={() => setDraft(null)}
        footer={
          <DialogActions>
            <Button type="button" disabled={addingSchedule} onClick={() => setDraft(null)}>
              キャンセル
            </Button>
            <Button type="button" variant="primary" disabled={addingSchedule} busy={addingSchedule} onClick={() => void addSchedule()}>
              登録する
            </Button>
          </DialogActions>
        }
      >
        {draft ? (
          <div className={styles.dialogBody}>
            <div className={styles.dialogPair}>
              <div className={styles.field}><Field label="開始日" htmlFor="sc-date" requirement={b244Requirements.draft_date}><SaveErrorField names={["date","draft.date"]}><DateField
                  id="sc-date"
                  value={draft.date}
                  min={jstNowLocalInput().date}
                  invalid={Boolean(scheduleDateError)}
                  onChange={(v) => { setDraft({ ...draft, date: v }); setScheduleDateError('') }}
                /></SaveErrorField>
{scheduleDateError ? <p className={styles.fieldError} role="alert">{scheduleDateError}</p> : null}</Field></div>
              <div className={styles.field}><Field label="開始時刻" htmlFor="sc-time"><SaveErrorField names={["time","draft.time"]}><TimeField
                  id="sc-time"
                  size="field"
                  value={draft.time}
                  onChange={(v) => setDraft({ ...draft, time: v })}
                /></SaveErrorField></Field></div>
            </div>
            <div className={styles.field}><Field label="更新後の値" htmlFor="sc-value">{item?.type === 'boolean' ? (
                <SaveErrorField names={["value","draft.value"]}><Select size="full" aria-label="更新後の値" id="sc-value" value={draft.value} onChange={(v) => setDraft({ ...draft, value: v })} options={[{ value: '', label: '選んでください' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} /></SaveErrorField>
              ) : (item?.type as string) === 'date' ? (
                <SaveErrorField names={["value","draft.value"]}><DateField id="sc-value" value={draft.value} onChange={(v) => setDraft({ ...draft, value: v })} /></SaveErrorField>
              ) : (item?.type as string) === 'datetime' ? (
                <SaveErrorField names={["value","draft.value"]}><DateTimeField id="sc-value" value={draft.value} onChange={(v) => setDraft({ ...draft, value: v })} /></SaveErrorField>
              ) : (
                <SaveErrorField names={["value","draft.value"]}><SharedTextField
                  id="sc-value"
                  type={item?.type === 'number' ? 'number' : 'text'}
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                  className={styles.fieldInput}
                /></SaveErrorField>
              )}
{scheduleFieldError ? <p className={styles.fieldError}>{scheduleFieldError}</p> : null}</Field></div>
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={clearSchedulesOpen && clearScope?.accountId === selectedAccountId && clearScope.window === clearWindow.current}
        title={schedules.length > 1 ? "更新の予定をすべて消しますか？" : "更新の予定を消しますか？"}
        description="予定の時刻に値が変わる設定をすべて取り消します。いま入力中の内容はそのまま残ります。"
        confirmLabel="すべて削除する"
        destructive
        busy={clearSchedulesBusy}
        confirmDisabled={clearSchedulesNeedsReview}
        confirmDisabledReason="閉じて予定を読み直してからやり直してください。"
        error={clearSchedulesError || undefined}
        onConfirm={clearSchedulesBusy ? undefined : () => clearSchedules()}
        onCancel={() => { if (!clearSchedulesBusy) { clearWindow.current = {}; setClearSchedulesOpen(false); if (clearSchedulesNeedsReview && clearScope && latestAccountRef.current === clearScope.accountId) { setSchedulesError(true); void loadSchedules(clearScope.itemId, clearScope.accountId) } } }}
      ><OperationTargetSummary accounts={[{ id: clearScope?.accountId ?? '' }]} /></ConfirmDialog>

      {/* 違いを比べる窓（板 `piWhz`）。いまの版と自分の入力を見せる。 */}
      <Dialog
        open={compareOpen && conflict !== null && item !== null}
        designNode="piWhz-compare"
        title={item ? `「${item.name}」の違いを比べる` : ''}
        description="いま保存されている中身と、あなたが入力した中身を見せます。このまま保存すると、相手の変更が消えます。"
        busy={saving}
        error={error || undefined}
        onCancel={() => { if (!saving) setCompareOpen(false) }}
        footer={
          <DialogActions>
            <Button type="button" onClick={() => { if (!saving) setCompareOpen(false) }} disabled={saving}>
              閉じる
            </Button>
            <Button type="button" onClick={adoptLatest} disabled={saving}>
              最新の値で続け直す
            </Button>
            {canWrite ? (<Button
                type="button"
                variant="danger"
                onClick={() => void save()}
                disabled={saving}
                busy={saving}
                busyLabel="保存中…"
              >
                このまま保存して上書きする
              </Button>) : null}
          </DialogActions>
        }
      >
        {item ? (
          <div className={styles.dialogBody}>
            <p className={styles.fieldLabelStrong}>いま保存されている中身</p>
            <p className={`${styles.compareBox} ${styles.compareServer}`}>{item.value || '（空）'}</p>
            <p className={styles.fieldLabelStrong}>あなたの入力</p>
            <p className={`${styles.compareBox} ${styles.compareMine}`}>{value || '（空）'}</p>
            <p className={styles.fieldHint}>
              名前・フォルダ・期間・メモの違いはこの窓に出ません。最新の値で続け直すと、すべて最新の版に戻ります。
            </p>
          </div>
        ) : null}
      </Dialog>

      {/* 狭い板のスマホの見え方（板 `C67dE` の「LINEでの見え方を見る」）。 */}
      <Dialog
        open={previewOpen}
        designNode="C67dE-preview"
        title="LINEでの見え方"
        onCancel={() => setPreviewOpen(false)}

      >
        {previewTalk}
      </Dialog>

      {leaveConfirmDialog}
    </CreatePage></SaveErrorScope>
  )
}

export default function EditCommonVarV8() {
  return (
    <Suspense fallback={<ListState kind="loading" title="共通情報を読み込んでいます" />}>
      <EditCommonVarV8Inner />
    </Suspense>
  )
}
