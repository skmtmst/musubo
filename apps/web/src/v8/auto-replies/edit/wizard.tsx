'use client'

import { readLineImageContent } from '@/lib/line-image-content'

import { canEditWizardNow } from './wizard-access'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { WizardBasicStep } from './wizard-basic-step'
import { WizardConfirmStep } from './wizard-confirm-step'
import { buildWizardInput } from './wizard-input'
import { loadWizardDraft } from './wizard-load'
import { DONE_DESIGN_NODE,EMPTY_FORM,InputIssue,LoadState,MAIN_KINDS,RuleRow,STEP_DESIGN_NODES,STEP_LABELS_V8,STEP_ORDER,WizardForm,WizardStep,formFromSettings } from './wizard-model'
import { renderWizardPreview } from './wizard-preview'
import { WizardPriorityStep } from './wizard-priority-step'
import { WizardResponseStep } from './wizard-response-step'
import { saveWizardDraft } from './wizard-save'
import { WizardTriggerStep } from './wizard-trigger-step'
export { STARTER_TEMPLATES,type WizardForm } from './wizard-model'

import { PRIORITY_MAX,PRIORITY_MIN,inEvaluationOrder,type OrderedRule } from '@/v8/auto-replies/auto-reply-order'
import {
MESSAGE_KIND_WORDS
} from '@/v8/auto-replies/auto-reply-words'
import { canPublish,publishGates } from '@/v8/auto-replies/publish/publish-flow'
import { useActionOptions } from '@/components/auto-replies/inline-action-list'
import { renderPreviewBody } from '@/components/scenarios/step-preview'
import { describeApiFailure, loadFailureCopy } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import { CardHeader } from '@/components/shared/card'
import { emptyValue } from '@/components/shared/empty-value'
import Link,{ useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { SaveConflictBand,SaveConflictCompareDialog } from '@/components/shared/save-conflict'
import { SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import type { StepperStep } from '@/components/shared/stepper'
import TargetMissing from '@/components/shared/target-missing'
import { notifyToast } from '@/components/shared/toast'
import { usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage, LockedCreatePage } from '@/components/templates'
import { PageFrame,PageHeading } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import { useAccount } from '@/contexts/account-context'
import { ApiError,api,type FriendListItem } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import type {
AutoReplyConflict,
AutoReplyDryRunResult,
AutoReplyValidationResult
} from '@line-crm/shared'
import {
Activity,
ArrowLeft,
ArrowRight,
Check,
List,
Plus,
Power
} from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useEffect,useMemo,useRef,useState } from 'react'
import { describeAutoReplyDiff } from './auto-reply-conflict-diff'
import styles from '../../../app/auto-replies/edit/wizard-v8.module.css'
import { formatNumber } from '@/lib/format'

function readStep(raw: string | null): WizardStep {
  return raw === 'trigger' || raw === 'response' || raw === 'priority' || raw === 'confirm' ? raw : 'basic'
}

function AutoReplyWizardV8Inner() {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const params = useSearchParams()
  const staffRole = useStaffRole()
  const canManage = useFeatureAccess('autoReplies')
  const resolvedReason = usePermissionLockReason(canManage)
  const lockedReason = staffRole === null ? undefined : resolvedReason
  const inputsDisabled = staffRole === null || !canManage || Boolean(lockedReason)
  const conflictsReadable = !inputsDisabled
  const permissionPending = staffRole === null
  const { selectedAccountId, accounts } = useAccount()

  const initialId = params.get('id')
  const [autoReplyId, setAutoReplyId] = useState<string | null>(initialId)
  const ruleIdRef = useRef(autoReplyId)
  ruleIdRef.current = autoReplyId
  const step = readStep(params.get('step'))
  const [published, setPublished] = useState<{ name: string } | null>(null)
  const stage: WizardStep | 'done' = published ? 'done' : step

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [versionNumber, setVersionNumber] = useState<number | null>(null)
  const savedVersionRef = useRef<number | null>(null)
  const [isActive, setIsActive] = useState(false)
  const [lifecycleStatus, setLifecycleStatus] = useState('draft')
  const pageTitle = autoReplyId && lifecycleStatus !== 'draft' ? '自動応答を編集' : '自動応答を作る'
  usePageTitle(stage === 'done' ? '自動応答・有効化完了' : `${pageTitle}・${STEP_LABELS_V8[stage]}`)
  const [matchedLast28Days, setMatchedLast28Days] = useState<number | null>(null)
  const [wasPublished, setWasPublished] = useState(false)
  const [matchedAccountId, setMatchedAccountId] = useState<string | null>(null)

  const [form, setForm] = useState<WizardForm>(EMPTY_FORM)
  const formFingerprintRef = useRef(JSON.stringify(form))
  formFingerprintRef.current = JSON.stringify(form)
  /** 最後に読み込み・保存した形。差分が dirty。 */
  const savedSnapshotRef = useRef(JSON.stringify(EMPTY_FORM))
  // 編集の競合（：409）。入力は捨てず、比べる・読み込むを選んでもらう。
  const [saveConflict, setSaveConflict] = useState(false)
  const [compareTarget, setCompareTarget] = useState<WizardForm | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareError, setCompareError] = useState('')
  // 作る②の1152（）。折り畳みはCSSが担い、ここでは板IDだけを切り替える。
  const narrow = useNarrowViewport()
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; messageType: string; messageContent: string; folderId?: string | null; updatedAt?: string }>>([])
  const [templateState, setTemplateState] = useState<'loading' | 'ready' | 'error' | 'retrying'>('loading')
  const templateRequest = useRef(0)
  const templateInFlight = useRef<number | null>(null)
  const [folders, setFolders] = useState<Array<{ id: string; name: string; color?: string | null }>>([])
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const folderRequest = useRef(0)
  const [rules, setRules] = useState<RuleRow[]>([])
  const [conflicts, setConflicts] = useState<AutoReplyConflict[]>([])
  const [friends, setFriends] = useState<FriendListItem[]>([])
  const [friendTotal, setFriendTotal] = useState(0)
  const [friendQuery, setFriendQuery] = useState('')
  const [friendLoadState, setFriendLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selectedFriendId, setSelectedFriendId] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [dryRun, setDryRun] = useState<AutoReplyDryRunResult | null>(null)
  const [staleTest, setStaleTest] = useState(false)
  const [validation, setValidation] = useState<AutoReplyValidationResult | null>(null)
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  const [priorityState, setPriorityState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [confirmState, setConfirmState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  const [saving, setSaving] = useState(false)
  const [saveNotice, setSaveNotice] = useState('')
  /** 保存が通った直後の「✓保存しました」（共通 Button の done、1.2秒）。 */
  const [saveDone, setSaveDone] = useState(false)
  const [error, setError] = useState('')
  const [inputIssue, setInputIssue] = useState<InputIssue | null>(null)
  const [weekdayNotice, setWeekdayNotice] = useState('')
  const [showMoreKinds, setShowMoreKinds] = useState(false)
  const actionOptions = useActionOptions()
  /** 作成・公開の確認キーは画面ごとに1つ振り、成功するまで変えない。 */
  const createKeyRef = useRef(crypto.randomUUID())
  const publishKeyRef = useRef(crypto.randomUUID())

  const editForm: typeof setForm = next => { if (canEditWizardNow()) setForm(next) }
  const editAcknowledged: typeof setAcknowledged = next => { if (canEditWizardNow()) setAcknowledged(next) }
  const patch = (part: Partial<WizardForm>) => {
    if (!canEditWizardNow()) return
    setInputIssue(null)
    setForm((current) => ({ ...current, ...part }))
  }
  useEffect(() => {
    if (!inputIssue?.field || inputIssue.step !== step || loadState !== 'ready') return
    const target = document.getElementById(inputIssue.field)
    const control = target?.matches('input, textarea, button, [contenteditable="true"]')
      ? target
      : target?.querySelector<HTMLElement>('input, textarea, button, [tabindex="0"]')
    control?.focus()
    control?.scrollIntoView?.({ block: 'center' })
  }, [inputIssue, step, loadState])
  const fieldError = (field: string) => inputIssue?.field === field ? inputIssue.error : undefined
  const showInputIssue = useCallback((issue: InputIssue) => {
    setError('')
    if (!issue.field || !issue.step) {
      setError(issue.error)
      return
    }
    setInputIssue(issue)
    if (issue.step !== step) {
      const query = new URLSearchParams()
      if (autoReplyId) query.set('id', autoReplyId)
      query.set('step', issue.step)
      router.replace(`/auto-replies/edit?${query.toString()}`)
    }
  }, [autoReplyId, router, step])
  const dirty = JSON.stringify(form) !== savedSnapshotRef.current

  useEffect(() => {
    if (dirty) setSaveDone(false)
  }, [dirty])

  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({
    dirty,
    busy: saving,
    subject: '自動応答の変更',
    /*
     * step・id（作成後に付く）の違いだけが変わる遷移は画面の中の移動。
     * 戻る・進む・URL書き換えで離脱確認を出さない。
     */
    samePage: (destination) => destination.pathname === '/auto-replies/edit',
    onDiscard: () => {
      setForm(JSON.parse(savedSnapshotRef.current) as WizardForm)
    },
  })

  /* ===== 読み込み ===== */
  const creationAccountId = autoReplyId ? null : selectedAccountId ?? accounts[0]?.id ?? null
  const templateAccountId = matchedAccountId ?? creationAccountId ?? null
  const templateAccountRef = useRef<string | null>(templateAccountId)
  templateAccountRef.current = templateAccountId
  useEffect(() => () => {
    templateRequest.current += 1
    templateInFlight.current = null
  }, [])
  const load = useCallback(() => loadWizardDraft({ autoReplyId, creationAccountId, savedSnapshotRef, savedVersionRef, saveErrors, setForm, setInputIssue, setIsActive, setLifecycleStatus, setLoadError, setLoadState, setMatchedAccountId, setMatchedLast28Days, setTemplates, setTemplateState, setVersionNumber, setWasPublished }), [autoReplyId, creationAccountId, saveErrors])

  const loadTemplates = useCallback(async () => {
    if (templateInFlight.current !== null) return
    const request = ++templateRequest.current
    const accountId = templateAccountRef.current
    templateInFlight.current = request
    setTemplateState('retrying')
    try {
      const response = await api.templates.list(undefined, accountId ?? undefined)
      if (request !== templateRequest.current || templateAccountRef.current !== accountId) return
      if (!response.success || !Array.isArray(response.data)) throw new Error('templates_not_loaded')
      setTemplates(
        response.data.map((t) => ({
          id: t.id,
          name: t.name,
          messageType: t.messageType,
          messageContent: t.messageContent,
          folderId: t.folderId,
          updatedAt: t.updatedAt,
        })),
      )
      setTemplateState('ready')
    } catch {
      if (request === templateRequest.current && templateAccountRef.current === accountId) {
        setTemplateState('error')
      }
    } finally {
      if (templateInFlight.current === request) templateInFlight.current = null
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // フォルダだけ再取得して、編集中の本文や所属フォルダを読み直しで失わない。
  const loadFolders = useCallback(async () => {
    const request = ++folderRequest.current
    setFolderState('loading')
    try {
      const response = await api.folders.list('auto_reply')
      if (!response.success || !Array.isArray(response.data)) throw new Error('folders_not_loaded')
      if (request !== folderRequest.current) return
      setFolders(response.data.map(folder => ({ id: folder.id, name: folder.name, color: folder.color })))
      setFolderState('ready')
    } catch {
      if (request === folderRequest.current) setFolderState('error')
    }
  }, [])
  useEffect(() => {
    setFolders([])
    void loadFolders()
    return () => { folderRequest.current += 1 }
  }, [loadFolders, autoReplyId, creationAccountId])

  const stepDataRequested = useRef<Set<string>>(new Set())

  /* ===== 手順4・5で読むもの（ルールの並び・重なり・試す相手） ===== */
  /** 評価順の表示に要る「全ルール」と「この下書きと重なるルール」を読む。 */
  const loadOrder = useCallback(async (ruleId: string, accountId: string | null) => {
    const subject = assessmentSubjectRef.current
    const [listRes, conflictRes] = await Promise.all([
      api.autoReplies.list(accountId ? { accountId } : undefined),
      canEditWizardNow() ? api.autoReplies.conflicts(ruleId).catch(() => null) : Promise.resolve(null),
    ])
    if (!listRes.success || !Array.isArray(listRes.data)) throw new Error('list failed')
    setRules(
      listRes.data.map((r) => ({
        id: r.id,
        name: r.name ?? '',
        isActive: r.isActive,
        lifecycleStatus: r.lifecycleStatus,
        priority: r.priority,
        createdAt: r.createdAt,
        keyword: r.keyword,
        activeFrom: r.activeFrom ?? null,
        activeUntil: r.activeUntil ?? null,
      })),
    )
    if (canEditWizardNow() && subject === assessmentSubjectRef.current && conflictRes?.success) {
      setConflicts(Array.isArray(conflictRes.data?.conflicts) ? conflictRes.data.conflicts : [])
    }
  }, [])

  const loadFriendsInitial = useCallback(async (accountId: string | null) => {
    setFriendLoadState('loading')
    try {
      const res = await api.friends.list({
        accountId: accountId ?? undefined,
        includeChatStatus: true,
        limit: 20,
      })
      if (!res.success || !Array.isArray(res.data?.items)) throw new Error('friend list failed')
      setFriends(res.data.items)
      setFriendTotal(typeof res.data.total === 'number' ? res.data.total : res.data.items.length)
      setSelectedFriendId((current) => current || res.data.items[0]?.id || '')
      setFriendLoadState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setFriends([])
      setFriendTotal(0)
      { if (!fieldFailure)
      setFriendLoadState('error')
    }
  }
  }, [saveErrors]);

  const loadPriorityData = useCallback(
    async (ruleId: string, accountId: string | null) => {
      setPriorityState('loading')
      try {
        await loadOrder(ruleId, accountId)
        void loadFriendsInitial(accountId)
        setPriorityState('ready')
      } catch (saveFailure) {
        const fieldFailure = saveErrors.capture(saveFailure)

        { if (!fieldFailure)
        setPriorityState('error') }
      }
    },
    [loadOrder, loadFriendsInitial, saveErrors],
  );

  const searchFriends = useCallback(
    async (query: string) => {
      if (!matchedAccountId) return
      setFriendLoadState('loading')
      try {
        const res = await api.friends.list({
          accountId: matchedAccountId,
          includeChatStatus: true,
          limit: 20,
          search: query.trim() || undefined,
        })
        if (!res.success || !Array.isArray(res.data?.items)) throw new Error('friend list failed')
        setFriends(res.data.items)
        setFriendTotal(typeof res.data.total === 'number' ? res.data.total : res.data.items.length)
        setFriendLoadState('ready')
      } catch (saveFailure) {
        const fieldFailure = saveErrors.capture(saveFailure)

        { if (!fieldFailure)
        setFriendLoadState('error')
      }
    }
    },
    [matchedAccountId, saveErrors],
  )

  /* ===== 手順5で読むもの（公開前チェック） ===== */
  const loadValidation = useCallback(async (ruleId: string) => {
    if (!canEditWizardNow()) return
    const subject = assessmentSubjectRef.current
    setConfirmState('loading')
    try {
      const res = await api.autoReplies.validateDraft(ruleId)
      if (!canEditWizardNow() || subject !== assessmentSubjectRef.current) return
      if (!res.success || !res.data) throw new Error('validate failed')
      setValidation(res.data)
      setConflicts(res.data.conflicts ?? [])
      setConfirmState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (subject === assessmentSubjectRef.current) { if (!fieldFailure) setConfirmState('error')
    }
  }
  }, [saveErrors])

  /*
   * 手順4・5を URL で直接開いた・戻るで戻ったときも、確かめる対象を読む。
   * 「次へ」経由の読み込みと同じ口。dirty の編集は保存されるまで
   * サーバーの下書きに無いので、未保存のまま飛んだときは保存してから読む
   * ——goNext と同じ約束を直接遷移にも持たせる。
   */

  /* ===== 保存 ===== */
  const buildInput = useCallback(() => buildWizardInput({ accounts, form, matchedAccountId, selectedAccountId, templates }), [form, templates, matchedAccountId, selectedAccountId, accounts])

  /**
   * 下書きをサーバーへ保存する。新規はここで初めてルールを作る。
   * 返り値は保存したルールの id。失敗したら理由を出して null。
   */
  const saveDraftNow = useCallback(() => saveWizardDraft({ autoReplyId, buildInput, createKeyRef, form, router, savedSnapshotRef, savedVersionRef, saveErrors, setAutoReplyId, setConfirmState, setDryRun, setError, setInputIssue, setLifecycleStatus, setMatchedAccountId, setSaveConflict, setSaveNotice, setSaving, setValidation, setVersionNumber, setWeekdayNotice, showInputIssue, step, stepDataRequested, versionNumber }), [buildInput, autoReplyId, versionNumber, form, step, router, showInputIssue, saveErrors])

  // 「最新を読み込んで続ける」。入力中の内容は最新の版で置き換わる。
  const inputFingerprint = JSON.stringify(form)
  const accessEpoch = useRef({ readable: conflictsReadable, value: 0 })
  if (accessEpoch.current.readable !== conflictsReadable) {
    accessEpoch.current = { readable: conflictsReadable, value: accessEpoch.current.value + 1 }
  }
  const assessmentSubjectRef = useRef('')
  assessmentSubjectRef.current = `${autoReplyId}:${versionNumber}:${inputFingerprint}:${accessEpoch.current.value}`
  useEffect(() => {
    setValidation(null); setDryRun(null); setAcknowledged(new Set())
    setConfirmState('idle')
    if (!conflictsReadable) { setConflicts([]); setStaleTest(false) }
  }, [inputFingerprint, conflictsReadable])
  useEffect(() => {
    if (loadState !== 'ready' || !autoReplyId || (step !== 'priority' && step !== 'confirm')) return
    const key = `${step}:${assessmentSubjectRef.current}`
    if (stepDataRequested.current.has(key)) return
    stepDataRequested.current.add(key)
    const subject = assessmentSubjectRef.current
    void (async () => {
      let ruleId = autoReplyId
      let accountId = matchedAccountId ?? selectedAccountId ?? null
      if (dirty && canEditWizardNow()) {
        const saved = await saveDraftNow()
        if (!saved) { stepDataRequested.current.delete(key); return }
        ruleId = saved.id; accountId = saved.accountId
        // 保存で版が上がったあとのeffectに一本化する。
        return
      }
      if (subject !== assessmentSubjectRef.current) return
      if (step === 'priority') await loadPriorityData(ruleId, accountId)
      else { await loadValidation(ruleId); await loadOrder(ruleId, accountId).catch(() => setPriorityState('error')) }
    })()
  }, [loadState, autoReplyId, step, versionNumber, inputFingerprint, dirty, matchedAccountId, selectedAccountId, saveDraftNow, loadPriorityData, loadValidation, loadOrder, conflictsReadable])

  const reloadAfterConflict = useCallback(async () => {
    setSaveConflict(false)
    setCompareTarget(null)
    setCompareError('')
    setError('')
    await load()
    setSaveNotice('最新の内容を読み込みました')
  }, [load])

  // 「違いを比べる」。最新を取って比べるだけで、画面は書き換えない。
  const openCompare = useCallback(async () => {
    if (!autoReplyId || compareBusy) return
    setCompareBusy(true)
    setCompareError('')
    try {
      const draftRes = await api.autoReplies.getDraft(autoReplyId)
      if (!draftRes?.success || !draftRes.data?.settings) {
        setCompareError('最新の内容を取れませんでした。もう一度お試しください。')
        return
      }
      setCompareTarget(formFromSettings(draftRes.data.settings))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setCompareError('最新の内容を取れませんでした。もう一度お試しください。') }
    } finally {
      setCompareBusy(false)
    }
  }, [autoReplyId, compareBusy, saveErrors])

  /* ===== 手順の移動 ===== */
  const goToStep = useCallback(
    (next: WizardStep, ruleId?: string) => {
      const query = new URLSearchParams()
      // 保存直後は state が追いつく前なので、渡された id を優先する。
      // id が落ちると読み直したときに下書きに戻れない。
      const keepId = ruleId ?? autoReplyId
      if (keepId) query.set('id', keepId)
      query.set('step', next)
      router.replace(`/auto-replies/edit?${query.toString()}`)
    },
    [autoReplyId, router],
  )

  /** 「次へ」。手順4へ入る直前に下書きを保存し、重なりと試す相手を読む。 */
  const goNext = useCallback(async () => {
    setError('')
    const nextIndex = STEP_ORDER.indexOf(step) + 1
    if (nextIndex >= STEP_ORDER.length) return
    const next = STEP_ORDER[nextIndex]
    if (autoReplyId && !canEditWizardNow()) { goToStep(next); return }
    if (step === 'trigger') {
      const input = buildInput()
      if ('error' in input && input.step === 'trigger') {
        showInputIssue(input)
        return
      }
    }
    if (next === 'priority' || next === 'confirm') {
      // 確かめる対象はサーバーの下書き。未保存のままでは確かめられないので、
      // 変更があればここで必ず保存する。
      let ruleId = autoReplyId
      if (dirty || !autoReplyId) {
        const saved = await saveDraftNow()
        if (!saved) return
        ruleId = saved.id
      }
      if (!ruleId) return
      goToStep(next, ruleId ?? undefined)
    } else {
      goToStep(next)
    }
  }, [step, dirty, autoReplyId, saveDraftNow, matchedAccountId, selectedAccountId, loadPriorityData, loadValidation, loadOrder, goToStep, buildInput, showInputIssue])

  /* ===== 手順4：順番 ===== */
  /**
   * 画面に出す評価順。他のルールはライブの並び、このルールは下書きの
   * priority で差し込む（公開時に draft.priority がライブへ適用される
   * ため、ここで見える順番がそのまま公開後の順番）。
   */
  const orderedRules = useMemo(() => {
    const existing = rules.find((r) => r.id === autoReplyId)
    const mine: RuleRow | null = autoReplyId
      ? {
          id: autoReplyId,
          name: form.ruleName,
          isActive: isActive || lifecycleStatus === 'published',
          lifecycleStatus,
          priority: form.priority,
          createdAt: existing?.createdAt ?? '9999',
          keyword: form.keywordRules[0]?.keyword.trim() ?? '',
          activeFrom: form.timeMode === 'custom' ? form.activeFrom || null : null,
          activeUntil: form.timeMode === 'custom' ? form.activeUntil || null : null,
        }
      : null
    const others = rules.filter((r) => r.id !== autoReplyId)
    return inEvaluationOrder(mine ? [...others, mine] : others)
  }, [rules, autoReplyId, form.priority, form.ruleName, form.keywordRules, form.timeMode, form.activeFrom, form.activeUntil, isActive, lifecycleStatus])

  const myIndex = orderedRules.findIndex((r) => r.id === autoReplyId)
  const myCreatedAt = rules.find((r) => r.id === autoReplyId)?.createdAt ?? ''

  /**
   * このルールを target の直前へ置く priority を返す。
   * 並びは priority 昇順・同値は createdAt 昇順なので、同じ値なら
   * 作った順で負けるときは 1 下げる。画面は常に結果順を再計算して出す。
   */
  const priorityBefore = useCallback(
    (target: OrderedRule): number | null => {
      const winsTie = myCreatedAt !== '' && myCreatedAt < target.createdAt
      if (winsTie) return target.priority
      const lower = target.priority - 1
      if (lower < PRIORITY_MIN) return null
      return lower
    },
    [myCreatedAt],
  )

  const moveUp = useCallback(() => {
    if (myIndex <= 0) return
    const above = orderedRules[myIndex - 1]
    const next = priorityBefore(above)
    if (next == null || next > PRIORITY_MAX) return
    patch({ priority: next })
  }, [myIndex, orderedRules, priorityBefore])

  /** 「『○○』より前へ」：最初に重なっているルールの直前まで一気に上げる。 */
  const firstConflictAbove = useMemo(() => {
    if (myIndex < 0) return null
    const conflictIds = new Set(conflicts.map((c) => c.autoReplyId))
    return orderedRules.slice(0, myIndex).reverse().find((r) => conflictIds.has(r.id)) ?? null
  }, [orderedRules, myIndex, conflicts])

  const moveBeforeFirstConflict = useCallback(() => {
    if (!firstConflictAbove) return
    const next = priorityBefore(firstConflictAbove)
    if (next == null || next > PRIORITY_MAX) return
    patch({ priority: next })
  }, [firstConflictAbove, priorityBefore])

  /* ===== 手順4：試しに送る ===== */
  const runTest = useCallback(async () => {
    if (!canEditWizardNow() || !autoReplyId || !selectedFriendId || !testMessage.trim()) return
    const testedInput = formFingerprintRef.current
    const testedAccessEpoch = accessEpoch.current.value
    setInputIssue(null)
    setSaving(true)
    setError('')
    try {
      // 試す内容はいま画面にあるもの。未保存なら先に保存してから試す。
      let ruleId = autoReplyId
      if (dirty) {
        const saved = await saveDraftNow()
        if (!saved) return
        ruleId = saved.id
      }
      if (!ruleId || !canEditWizardNow()) return
      const testedVersion = savedVersionRef.current
      const res = await api.autoReplies.testDraft(ruleId, {
        friendId: selectedFriendId,
        incomingText: testMessage.trim(),
      })
      if (!canEditWizardNow() || accessEpoch.current.value !== testedAccessEpoch || ruleIdRef.current !== ruleId || savedVersionRef.current !== testedVersion || formFingerprintRef.current !== testedInput) return
      if (!res.success) throw new Error(res.error || 'test failed')
      if (res.data.staleTest) {
        setDryRun(null)
        setStaleTest(true)
        return
      }
      setStaleTest(false)
      setDryRun(res.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('試し送りできませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      setSaving(false)
    }
  }, [autoReplyId, selectedFriendId, testMessage, dirty, saveDraftNow, saveErrors])

  /* ===== 手順5：有効にする ===== */
  const gates = useMemo(
    () => publishGates(validation, dryRun, acknowledged),
    [validation, dryRun, acknowledged],
  )
  const publishReady = !dirty && canPublish(gates)

  const publish = useCallback(async () => {
    if (!canEditWizardNow() || !autoReplyId || !publishReady || saving) return
    setInputIssue(null)
    setSaving(true)
    setError('')
    try {
      const res = await api.autoReplies.publishDraft(
        autoReplyId,
        { acknowledgedConflictIds: [...acknowledged] },
        publishKeyRef.current,
      )
      if (!res.success) {
        if (res.error?.includes('競合') || res.error?.includes('確認')) {
          setError('重なりの確認が足りていません。手順4へ戻って確かめてください。')
        } else {
          setError(res.error || '自動応答を有効化できませんでした。状態を読み直してからお試しください。')
        }
        void loadValidation(autoReplyId)
        return
      }
      const doneName = form.ruleName.trim() || form.keywordRules[0]?.keyword.trim() || '自動応答'
      setPublished({ name: doneName })
      notifyToast(`「${doneName}」を有効にしました`)
      disarm()
      publishKeyRef.current = crypto.randomUUID()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)

      setError(
        caught instanceof ApiError && caught.status === 409
          ? describeApiFailure(caught, '公開')
          : '自動応答を有効化できませんでした。状態を読み直してからお試しください。',
      ) }
      void loadValidation(autoReplyId)
    } finally {
      setSaving(false)
    }
  }, [autoReplyId, publishReady, saving, acknowledged, form.ruleName, form.keywordRules, disarm, loadValidation, saveErrors])

  /* ===== 手順ごとの内容 ===== */
  const effectiveKeywords = form.keywordRules.filter((r) => r.keyword.trim() !== '')
  const selectedTemplate =
    form.mode === 'template' ? templates.find((t) => t.id === form.templateId) ?? null : null
  const imageContent = form.mode === 'inline-image' ? readLineImageContent(form.responseContent) : null
  const flexContentIsJson = (() => {
    if (form.mode !== 'inline-flex' || !form.responseContent.trim()) return false
    try {
      JSON.parse(form.responseContent)
      return true
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      return false
    }
  })();

  const replyPreviewText =
    form.mode === 'silent'
      ? '返信はせず、設定した処理だけを行います。'
      : form.mode === 'template'
        ? selectedTemplate
          ? selectedTemplate.messageContent
          : 'テンプレートを選ぶと、ここに内容が出ます。'
        : form.mode === 'inline-image'
          ? '画像を返します。'
          : form.mode === 'inline-flex'
            ? flexContentIsJson
              ? 'カード型メッセージを返します。'
              : 'カードの内容（JSON）を読めていません。'
            : form.responseContent ? renderPreviewBody(form.responseContent) : '返す内容を入れると、ここに出ます。'

  /** 手順②の右の列の試し：いまの言葉と合い方で、例の文に当たるか。 */
  const triggerSamples = (() => {
    const words = effectiveKeywords.map((r) => r.keyword.trim()).filter(Boolean)
    const hits = (text: string) => {
      if (form.respondToAll) return true
      if (words.length === 0) return false
      const one = (w: string) => (form.matchType === 'exact' ? text === w : text.includes(w))
      return form.keywordMatchMode === 'all' ? words.every(one) : words.some(one)
    }
    const first = words[0] ? (form.matchType === 'exact' ? words[0] : `${words[0]}したいです`) : 'こんにちは'
    return [first, '日程を変えられますか'].map((text) => ({ text, hit: hits(text) }))
  })()

  /**
   * 手順⑤「有効にする前の確認」：絵の3つ（重なり・試し・知らせる先）を絵の言葉で出す。
   * きっかけ・返す内容の関門は、足りないときだけ前に出す（有効にする条件は gates のまま変えない）。
   */
  const v8Checks = (() => {
    const [triggerGate, replyGate, testGate, conflictGate] = gates
    const rows: Array<{ label: string; state: string; detail: string; back: WizardStep }> = []
    if (triggerGate && triggerGate.state !== 'ok') rows.push({ ...triggerGate, back: 'trigger' })
    if (replyGate && replyGate.state !== 'ok') rows.push({ ...replyGate, back: 'response' })
    if (conflictGate) rows.push({ label: '重なりを確かめた', state: conflictGate.state, detail: conflictGate.detail, back: 'priority' })
    if (testGate) rows.push({ label: '試しに送った', state: testGate.state, detail: testGate.detail, back: 'priority' })
    const notify = form.actions.filter((a) => a.actionType === 'notify_staff')
    if (notify.length > 0) {
      const ids = notify.map((a) => String((a.config as Record<string, unknown> | null)?.notificationRuleId ?? ''))
      const ok = ids.every(Boolean)
      const names = ids.map((id) => actionOptions.notificationRules?.find((r) => r.id === id)?.name).filter(Boolean).join('・')
      rows.push({ label: '担当者へ知らせる先がある', state: ok ? 'ok' : 'blocked', detail: ok ? `${names || '知らせる先'}（通知オン）` : '知らせる先が決まっていない処理があります', back: 'response' })
    }
    return rows
  })()

  const previewAccountName = accounts?.find((account) => account.id === matchedAccountId)?.name ?? '公式アカウント'
  const thisRuleName = form.ruleName.trim() || effectiveKeywords[0]?.keyword.trim() || '名前なしのルール'
  const myPositionLabel = myIndex >= 0 ? `${myIndex + 1}番目` : 'いちばん下'

  /* ===== 読み込み・権限の画面 ===== */
  if (loadState === 'loading') return <SaveErrorScope errors={saveErrors}><ListState kind="loading" /></SaveErrorScope>
  if (loadState === 'not-found') {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="not-found"
        title="この自動応答は見つかりません"
        description="削除されたか、別の記録です。一覧から選び直してください。"
        backHref="/auto-replies"
        backLabel="自動応答の一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (loadState === 'error') {
    const failure = loadError ? loadFailureCopy(loadError, '下書き') : null
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="error"
        title={failure?.title ?? '下書きを読み込めませんでした'}
        description={
          failure?.description ??
          '通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'
        }
        error={loadError ?? undefined}
        onRetry={() => void load()}
      /></SaveErrorScope>
    )
  }
  if (!autoReplyId && staffRole !== null && inputsDisabled) {
    return <SaveErrorScope errors={saveErrors}><LockedCreatePage title="自動応答を作る" backHref="/auto-replies" backLabel="自動応答の一覧へ戻る" /></SaveErrorScope>
  }

  /* ===== 完了 ===== */
  // 絵：作る型の頭（手順はすべて済み）の下に、中央の完了カード（幅560）。保存の帯と右の列は無い。
  if (stage === 'done') {
    const doneSteps: StepperStep[] = STEP_ORDER.map((key) => ({ key, label: STEP_LABELS_V8[key], state: 'done' }))
    const doneKeywords = form.respondToAll
      ? 'すべてのメッセージ'
      : effectiveKeywords.map((r) => r.keyword.trim()).filter(Boolean).join('・') || emptyValue('unknown')
    return (
      <SaveErrorScope errors={saveErrors}><PageFrame kind="create" boardId={DONE_DESIGN_NODE}>
        <PageHeading
          title="自動応答を作る"
          help={`ルール名：${published!.name}`}
          identity={<Link href="/auto-replies" className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden="true" />
            自動応答へ
          </Link>}
          steps={<Steps label="自動応答を作る進み方" steps={doneSteps} />}
        />
        <div className={styles.doneBody}>
          <section className={styles.done} aria-labelledby="auto-reply-done-title">
            <span className={styles.doneIcon} aria-hidden="true">
              <Check size={20} />
            </span>
            <CardHeader size="content" title={`「${published!.name}」を有効にしました`} titleId="auto-reply-done-title" meta={<>
              これから届くメッセージで動き始めます。止めているあいだに届いた分には、さかのぼって返しません。止めたいときは、一覧の「…」から止められます。
            </>} />

            <dl className={styles.doneRows}>
              <div className={styles.doneRow}>
                <dt>動く順番</dt>
                <dd>{myPositionLabel}</dd>
              </div>
              <div className={styles.doneRow}>
                <dt>反応する言葉</dt>
                <dd title={doneKeywords}>{doneKeywords}</dd>
              </div>
            </dl>
            <div className={styles.doneActions}>
              <Button href="/auto-replies"><List size={16} aria-hidden="true" />一覧へ戻る</Button>
              <Button href={`/auto-replies/runs?id=${encodeURIComponent(autoReplyId ?? '')}`}>
                <Activity size={16} aria-hidden="true" />
                実行結果を見る
              </Button>
              <Button href="/auto-replies/edit" variant="primary">
                <Plus size={16} aria-hidden="true" />
                もう1つ作る
              </Button>
            </div>
          </section>
        </div>
      </PageFrame></SaveErrorScope>
    )
  }

  const stepperSteps: StepperStep[] = STEP_ORDER.map((key, index) => ({
    key,
    label: STEP_LABELS_V8[key],
    state: index < STEP_ORDER.indexOf(step) ? 'done' : 'todo',
    onSelect:
      index < STEP_ORDER.indexOf(step)
        ? () => goToStep(key)
        : undefined,
  }))

  // 絵（ ほか）：まだ有効にしていない下書きは「停止中として作っています」。
  const statusBadge = isActive ? '有効' : '停止中'

  const moreKindsButton = !showMoreKinds && MESSAGE_KIND_WORDS.some((k) => !MAIN_KINDS.includes(k.label) && !form.messageKinds.includes(k.key)) ? (
    <button type="button" className={styles.moreKinds} onClick={() => setShowMoreKinds(true)}>ほかの種類</button>
  ) : null

  // 1152 の板では右の列にスマホを置かず、上の「LINEでの見え方を見る」から窓で開く。
  const renderPreview = (withPhone: boolean) => renderWizardPreview({ acknowledged, autoReplyId, conflicts, dryRun, form, imageContent, isActive, matchedLast28Days, myIndex, myPositionLabel, orderedRules, previewAccountName, replyPreviewText, selectedTemplate, setAcknowledged: editAcknowledged, step, testMessage, triggerSamples, conflictsReadable }, withPhone)

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage dirty={false} step={STEP_ORDER.indexOf(step)} footerPlacement="floating" boardId={step === 'trigger' && narrow ? 'Z2LIUx' : STEP_DESIGN_NODES[step]} title={pageTitle} help={<>
          {step === 'basic' ? (
            'いまは停止中として作ります。最後の「確認」で有効にします。'
          ) : (
            `ルール名：${thisRuleName}・${statusBadge}として作っています`
          )}
        </>} identity={<Link href="/auto-replies" className={styles.backLink}>
          <ArrowLeft size={16} aria-hidden="true" />
          自動応答へ
        </Link>} steps={<Steps label="自動応答を作る進み方" steps={stepperSteps} currentKey={step} summaries={{ basic: form.ruleName, trigger: form.respondToAll ? 'すべてのメッセージ' : `${formatNumber(form.keywordRules.length)}件のキーワード`, response: form.mode === 'inline-text' ? form.responseContent : ({ silent: '返信しない', template: 'テンプレートから返信', 'inline-flex': 'カードで返信', 'inline-image': '画像で返信' })[form.mode], priority: `優先順位 ${form.priority}` }} />} previewLabel={step === 'basic' || step === 'trigger' ? '設定内容を見る' : undefined} previewTitle={step === 'basic' || step === 'trigger' ? '設定内容' : undefined} preview={renderPreview(true)} footerActions={
          <>
            <Button
              type="button"
              onClick={() => requestUnsavedAction(() => router.push('/auto-replies'))}
              disabled={saving}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              onClick={() =>
                void saveDraftNow().then((saved) => {
                  // 失敗（競合・入力の不足）のときは「保存しました」を出さない。
                  if (saved) setSaveNotice('下書きを保存しました')
                })
              }
              disabled={inputsDisabled || saving}
              lockedReason={lockedReason}
              busy={saving}
              busyLabel="保存中…"
              done={saveDone}
            >
              {step === 'confirm' ? '下書きのまま保存' : '下書きとして保存'}
            </Button>
            {step !== 'confirm' ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => void goNext()}
                disabled={staffRole === null || saving}
                busy={saving}
                busyLabel="進んでいます…"
              >
                次へ：{STEP_LABELS_V8[STEP_ORDER[STEP_ORDER.indexOf(step) + 1]]}<ArrowRight size={16} aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                onClick={() => void publish()}
                disabled={inputsDisabled || !publishReady || saving}
                lockedReason={lockedReason}
                disabledReason={!inputsDisabled && !publishReady ? (dirty ? '変更を下書きに保存してください。' : '有効にする前の確認を完了してください。') : undefined}
                title={publishReady ? undefined : dirty
                  ? '変更を下書きに保存してから、テストと有効にする前の確認を完了してください。'
                  : [...new Set(gates.filter(gate => gate.state !== 'ok').map(gate => gate.detail))].join(' / ')}
                busy={saving}
                busyLabel="有効にしています…"
                done={saveDone}
              >
                <Power size={16} aria-hidden="true" />
                {wasPublished || isActive ? 'この内容で更新する' : '有効にする'}
              </Button>
            )}
          </>
        } noticeSpacing="band" notice={lockedReason || saveConflict ? (<>
          {lockedReason ? <ReadOnlyNotice need="feature" /> : null}
          {saveConflict ? <SaveConflictBand
            title={`ほかの人がルール「${thisRuleName}」を先に保存しました`}
            designNode="UGrd2"
            compareBusy={compareBusy}
            onCompare={() => void openCompare()}
            onReload={() => void reloadAfterConflict()}
          /> : null}
        </>) : undefined} status={dirty ? '下書きに未保存の変更があります' : undefined}>

      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {saveNotice ? <Notice tone="success" message={saveNotice} onClose={() => setSaveNotice('')} /> : null}
      {staleTest ? (
        <Notice
          tone="warn"
          message="試したあとに内容が変わっています。もう一度「試す」で確かめてください。"
          onClose={() => setStaleTest(false)}
        />
      ) : null}

          {step === 'basic' && (
            <WizardBasicStep accountId={matchedAccountId ?? selectedAccountId ?? null} {...{ canManage, folders, folderState, loadFolders, form, goToStep, patch, setFolders, setForm: editForm, disabled: inputsDisabled, lockedReason }} />
          )}

          {step === 'trigger' && (
            <WizardTriggerStep {...{ effectiveKeywords, fieldError, form, moreKindsButton, narrow, patch, setWeekdayNotice, showMoreKinds, weekdayNotice, disabled: inputsDisabled, lockedReason }} />
          )}

          {step === 'response' && (
            <WizardResponseStep {...{ actionOptions, fieldError, form, imageContent, matchedAccountId, patch, templates, templateState, loadTemplates, disabled: inputsDisabled, lockedReason }} />
          )}

          {step === 'priority' && (
            <WizardPriorityStep {...{ autoReplyId, conflicts, dryRun, effectiveKeywords, firstConflictAbove, friendLoadState, friendQuery, friends, friendTotal, loadPriorityData, matchedAccountId, moveBeforeFirstConflict, moveUp, myIndex, myPositionLabel, orderedRules, priorityState, runTest, saving, searchFriends, selectedFriendId, setFriendQuery, setSelectedFriendId, setTestMessage, testMessage, thisRuleName, canEdit: !inputsDisabled, lockedReason, conflictsReadable, permissionPending }} />
          )}

          {step === 'confirm' && (
            <WizardConfirmStep {...{ actionOptions, autoReplyId, confirmState, effectiveKeywords, folders, form, goToStep, loadValidation, myPositionLabel, selectedTemplate, thisRuleName, v8Checks, conflictsReadable, permissionPending }} />
          )}

      {/* ===== 下の帯 ===== */}

      <SaveConflictCompareDialog
        open={compareTarget !== null || compareError !== ''}
        busy={compareBusy}
        error={compareError || undefined}
        lines={compareTarget ? describeAutoReplyDiff(form, compareTarget).map((text) => ({ text })) : null}
        onReload={() => void reloadAfterConflict()}
        onCancel={() => {
          setCompareTarget(null)
          setCompareError('')
        }}
      />

      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="自動応答の変更"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
        busy={saving}
        saveDisabled={inputsDisabled}
        saveLockedReason={lockedReason}
        onSave={async () => {
          const saved = await saveDraftNow()
          return saved !== null
        }}
      />
    </CreatePage></SaveErrorScope>
  )
}

export default function AutoReplyWizardV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <AutoReplyWizardV8Inner />
    </Suspense>
  )
}
