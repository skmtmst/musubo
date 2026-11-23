'use client'

import { ActionsStep,PreviewStep } from './editor-actions-preview'
import { BasicStep,RoutesStep,sharedPrefix } from './editor-basic-routes'
import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { MessageStep } from './editor-message'
import { EMPTY_DEFINITION,EMPTY_RULE,EditorRule,RouteUse,STEPS,Step,b244Requirements,editorSnapshot,toEditorRule } from './editor-model'


import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { notifySaved,notifyToast } from '@/components/shared/toast'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { ArrowRight,Power } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useEffect,useMemo,useRef,useState } from 'react'


import { withPermissionFailure } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import DateTimeField from '@/components/shared/date-time-field'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select'
import { folderByName,folderCreator } from '@/components/shared/folder-select'
import { Field } from '@/components/shared/form-controls'
import FriendPickerField from '@/components/shared/friend-picker-field'
import LinePreview,{ LinePreviewMessage } from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import type { StepperStep } from '@/components/shared/stepper'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import { CreatePreviewNote,CreateSummaryCard } from '@/components/templates/create-parts'
import { Steps } from '@/components/templates/steps'
import { useAccount } from '@/contexts/account-context'
import { ApiError,api,describeSaveFailure,type FriendAddRuleDefinition,type FriendAddRuleKind,type FriendAddRuleOptions } from '@/lib/api'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useNarrowViewport } from '@/lib/use-narrow-viewport'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import styles from './editor.module.css'
import { describeFriendAddFailure } from './failure'
import { MESSAGE_TYPE_LABEL } from './flow'
import { formatNumber } from '@/lib/format'

export default function FriendAddEditorV8({ ruleId }: { ruleId?: string }) {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <FriendAddEditor ruleId={ruleId} />
    </Suspense>
  )
}

function FriendAddEditor({ ruleId }: { ruleId?: string }) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const searchParams = useSearchParams()
  const narrow = useNarrowViewport()
  const { selectedAccountId, accounts, loading: accountLoading } = useAccount()
  const tokenNames = useInsertTokenNames(selectedAccountId)
  const accountName = accounts.find((account) => account.id === selectedAccountId)?.name ?? '公式アカウント'
  const role = useStaffRole()
  const canEdit = canManageRole(role)
  const requestedStep = searchParams.get('step') as Step | null
  const step: Step = STEPS.some((item) => item.key === requestedStep) ? requestedStep! : 'basic'
  usePageTitle('初回案内を作る')
  /* 板の頭の「← 〇〇へ」は 2026-10-08 に無くした。一覧へは上の帯のパンくずで戻る。 */
  usePageCrumbs([{ label: '友だち追加時の配信', href: '/friend-add-settings' }])
  const [rule, setRule] = useState<EditorRule>(EMPTY_RULE)
  const [definition, setDefinition] = useState<FriendAddRuleDefinition>(EMPTY_DEFINITION)
  const [options, setOptions] = useState<FriendAddRuleOptions>({ routes: [], scenarios: [], tags: [], folders: [] })
  const [routeUses, setRouteUses] = useState<Map<string, RouteUse>>(new Map())
  const [slackConnected, setSlackConnected] = useState<boolean | null>(null)
  const [validateChecks, setValidateChecks] = useState<Array<{ key: string; status: string; detail: string }> | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [error, setError] = useState('')
  const [duplicating, setDuplicating] = useState(false)
  const duplicateKey = useRef(crypto.randomUUID())
  const [notice, setNotice] = useState('')
  /* 先にほかの人が保存したとき（版の競合）。保存はせず、違いを比べるか最新を読むかを選ぶ。 */
  const [conflict, setConflict] = useState(false)
  const [compare, setCompare] = useState<Array<{ label: string; mine: string; theirs: string }> | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [testConditionsOpen, setTestConditionsOpen] = useState(false)
  const [testInput, setTestInput] = useState<{ routeId: string | null; expectedAt: string | null; friendId: string | null }>({ routeId: null, expectedAt: null, friendId: null })
  const [testResult, setTestResult] = useState<{
    accountId: string
    ruleId: string
    snapshot: string
    matched: boolean
    reasons: string[]
    stateChanged: false
  } | null>(null)
  const saveIdempotencyKey = useRef(crypto.randomUUID())
  useEffect(() => {
    setTestInput({ routeId: null, expectedAt: null, friendId: null })
    setTestConditionsOpen(false)
    setTestResult(null)
  }, [selectedAccountId, ruleId])
  const changeTestInput = (patch: Partial<typeof testInput>) => {
    setTestInput((current) => ({ ...current, ...patch }))
    setTestResult(null)
  }
  const folderKey = useRef(crypto.randomUUID())
  const saveInFlight = useRef(false)
  const savedSnapshot = useRef<string | null>(null)
  const loadRequestRef = useRef({ accountId: null as string | null, ruleId: null as string | null, generation: 0 })
  const [loadedAccountId, setLoadedAccountId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selectedAccountId) { setLoading(false); return }
    const request = {
      accountId: selectedAccountId,
      ruleId: ruleId ?? null,
      generation: loadRequestRef.current.generation + 1,
    }
    loadRequestRef.current = request
    const isCurrentRequest = () =>
      loadRequestRef.current.accountId === request.accountId
      && loadRequestRef.current.ruleId === request.ruleId
      && loadRequestRef.current.generation === request.generation
    setLoading(true)
    setLoadedAccountId(null)
    setSaving(false); setEnabling(false); saveInFlight.current = false
    setTestResult(null); setValidateChecks(null); setCompare(null); setCompareBusy(false)
    if (!ruleId) { setRule(EMPTY_RULE); setDefinition(EMPTY_DEFINITION); savedSnapshot.current = null }
    setError('')
    try {
      let kind: FriendAddRuleKind = 'first_time'
      if (ruleId) {
        const response = await api.friendAddRules.get(request.accountId, ruleId)
        if (!isCurrentRequest()) return
        if (!response.success) { setError(response.error); return }
        const loadedRule = toEditorRule(response.data.rule)
        kind = loadedRule.friendKind
        setRule(loadedRule)
        setDefinition(response.data.rule.definition)
        savedSnapshot.current = editorSnapshot(loadedRule, response.data.rule.definition)
        setOptions({ ...response.data.options, folders: response.data.options.folders ?? [] })
        setSlackConnected(response.data.staffNotification?.status === 'connected' ? true : response.data.staffNotification?.status == null ? null : false)
      }
      /* 一覧の口から、流入リンクを使っているほかの設定と（作るときは）並びの位置を読む。 */
      const listResponse = await api.friendAddRules.list(request.accountId, kind)
      if (!isCurrentRequest()) return
      if (listResponse.success) {
        const uses = new Map<string, RouteUse>()
        for (const item of listResponse.data.items) {
          if (item.id === ruleId || item.isFallback || item.status !== 'published') continue
          for (const id of item.definition.routeIds) {
            if (!uses.has(id)) uses.set(id, { ruleId: item.id, name: item.name, priority: item.priority })
          }
        }
        setRouteUses(uses)
        if (!ruleId) {
          setOptions({ ...listResponse.data.options, folders: listResponse.data.options.folders ?? [] })
          const conflictRes = await api.friendAddRules.conflicts(request.accountId, 'first_time')
          if (!isCurrentRequest()) return
          const fallbackIds = new Set(listResponse.data.items.filter((item) => item.isFallback).map((item) => item.id))
          const maxPriority = conflictRes.success
            ? conflictRes.data.rules.reduce((max, item) => (fallbackIds.has(item.id) ? max : Math.max(max, item.priority)), 0)
            : listResponse.data.items.filter((item) => !item.isFallback).length
          setRule((current) => {
            const initialRule = { ...EMPTY_RULE, priority: Math.max(1, maxPriority + 1) }
            savedSnapshot.current = editorSnapshot(initialRule, EMPTY_DEFINITION)
            return initialRule
          })
        }
      } else if (!ruleId) {
        setError(listResponse.error)
        return
      }
      setLoadedAccountId(request.accountId)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (isCurrentRequest()) { if (!fieldFailure)

 setError(describeFriendAddFailure(caught, '設定', 'load').message) }
    } finally {
      if (isCurrentRequest()) setLoading(false)
    }
  }, [ruleId, selectedAccountId, saveErrors])

  useEffect(() => { void load() }, [load])

  const currentIndex = STEPS.findIndex((item) => item.key === step)
  const hrefFor = (next: Step, extra = '') => ruleId
    ? `/friend-add-settings?view=edit&id=${encodeURIComponent(ruleId)}&step=${next}${extra}`
    : `/friend-add-settings?view=new&step=${next}${extra}`
  const input = () => {
    if (!selectedAccountId || loadedAccountId !== selectedAccountId) return null
    return {
      accountId: selectedAccountId,
      friendKind: rule.friendKind,
      name: rule.name,
      folderName: rule.folderName,
      priority: rule.priority,
      version: rule.version,
      definition,
    }
  }

  const hasUnsavedChanges = savedSnapshot.current !== null
    && savedSnapshot.current !== editorSnapshot(rule, definition)

  /* 未保存の変更がある間、画面外への離脱を確認対話へ寄せる。 */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: hasUnsavedChanges, busy: saving || enabling || duplicating, subject: '追加時の動きへの変更' })

  const validateStep = (target: Step) => {
    const skipsScenario = rule.friendKind === 'returning' && definition.returningMode === 'none'
    const scenarioProblem = !definition.scenarioId && !skipsScenario
      ? '実際に配信するシナリオを決めてください。'
      : ''
    const routesProblem = !rule.isFallback && definition.routeIds.length === 0
      ? '対象にする流入リンクを1つ以上選んでください。'
      : ''
    if (target === 'routes' && routesProblem) return { step: 'routes' as const, message: routesProblem }
    if (target === 'message' && scenarioProblem) return { step: 'message' as const, message: scenarioProblem }
    if (target === 'preview') {
      if (routesProblem) return { step: 'routes' as const, message: routesProblem }
      if (scenarioProblem) return { step: 'message' as const, message: scenarioProblem }
    }
    return null
  }
  const [fieldError, setFieldError] = useState<{ step: Step; message: string } | null>(null)
  useEffect(() => { setFieldError(null) }, [rule, definition])
  useEffect(() => {
    if (!fieldError || fieldError.step !== step) return
    const frame = requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>(fieldError.step === 'basic'
        ? '#fa-name'
        : fieldError.step === 'routes'
          ? '[data-friend-add-routes] input[type=checkbox]'
          : '#fa-scenario[aria-haspopup], #fa-returning-scenario[aria-haspopup]')
      field?.focus()
      field?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [fieldError, step])

  const showFieldError = (problem: { step: Step; message: string }) => {
    setError('')
    setFieldError(problem)
    if (step !== problem.step) samePageUrl.replace(hrefFor(problem.step))
  }

  const save = async (nextStep?: Step): Promise<string | null> => {
    if (saveInFlight.current) return null
    const payload = input()
    if (!payload) {
      setError(selectedAccountId && loadedAccountId !== selectedAccountId
        ? 'アカウントを切り替えています。読み込みが終わってから保存してください。'
        : 'LINE公式アカウントを選んでください。')
      return null
    }
    if ((b244Requirements.rule_name.check(rule.name) !== null)) {
      showFieldError({ step: 'basic', message: '設定名を入力してください。' })
      return null
    }
    if (nextStep && STEPS.findIndex((item) => item.key === nextStep) >= currentIndex) {
      const problem = validateStep(step)
      if (problem) { showFieldError(problem); return null }
    }
    const request = loadRequestRef.current
    const isCurrent = () => loadRequestRef.current === request
    setFieldError(null)
    saveInFlight.current = true
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = ruleId
        ? await api.friendAddRules.saveDraft(ruleId, payload, saveIdempotencyKey.current)
        : await api.friendAddRules.createDraft(payload, saveIdempotencyKey.current)
      if (!isCurrent()) return null
      if (!response.success) { setError(response.error); return null }
      const savedId = response.data.id
      saveIdempotencyKey.current = crypto.randomUUID()
      const savedVersion = (response.data as { version?: number }).version
      if (typeof savedVersion === 'number') {
        setRule((current) => ({ ...current, version: savedVersion }))
      }
      savedSnapshot.current = editorSnapshot(rule, definition)
      setConflict(false)
      notifySaved('下書きを保存しました。')
      if (!ruleId || nextStep) samePageUrl.replace(`/friend-add-settings?view=edit&id=${encodeURIComponent(savedId)}&step=${nextStep ?? step}`)
      return savedId
    } catch (caught) {
      if (!isCurrent()) return null
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true)
      } else {
        { if (!fieldFailure)

        setError(withPermissionFailure(caught, describeSaveFailure(caught), 'store')) }
      }
      return null
    } finally {
      if (isCurrent()) { saveInFlight.current = false; setSaving(false) }
    }
  }

  /* 競合：最新を読み込んで続ける（いまの直しは捨てる）。 */
  const reloadAfterConflict = async () => {
    if (!selectedAccountId || !ruleId || compareBusy) return
    const request = { accountId: selectedAccountId, ruleId, generation: loadRequestRef.current.generation + 1 }
    loadRequestRef.current = request
    const isCurrent = () => loadRequestRef.current === request
    setCompareBusy(true); setError('')
    try {
      // Read everything before replacing the operator's draft. Failure leaves both the draft and comparison open.
      const response = await api.friendAddRules.get(request.accountId, ruleId)
      if (!isCurrent()) return
      if (!response.success) throw new Error(response.error)
      const loadedRule = toEditorRule(response.data.rule)
      const listResponse = await api.friendAddRules.list(request.accountId, loadedRule.friendKind)
      if (!isCurrent()) return
      if (!listResponse.success) throw new Error(listResponse.error)
      const uses = new Map<string, RouteUse>()
      for (const item of listResponse.data.items) {
        if (item.id === ruleId || item.isFallback || item.status !== 'published') continue
        for (const id of item.definition.routeIds) if (!uses.has(id)) uses.set(id, { ruleId: item.id, name: item.name, priority: item.priority })
      }
      setRule(loadedRule); setDefinition(response.data.rule.definition)
      savedSnapshot.current = editorSnapshot(loadedRule, response.data.rule.definition)
      setOptions({ ...response.data.options, folders: response.data.options.folders ?? [] })
      setSlackConnected(response.data.staffNotification?.status === 'connected' ? true : response.data.staffNotification?.status == null ? null : false)
      setRouteUses(uses); setLoadedAccountId(request.accountId)
      setConflict(false); setCompare(null); setTestResult(null); setValidateChecks(null)
      return true
    } catch (caught) {
      if (!isCurrent()) return
      saveErrors.capture(caught)
      setError(describeFriendAddFailure(caught, '設定', 'load').message)
      return false
    } finally { if (isCurrent()) setCompareBusy(false) }
  }

  /* 競合：違いを比べる（最新の保存とあなたの直しを、項目ごとに並べる）。 */
  const openCompare = async () => {
    if (!ruleId || !selectedAccountId) return
    const request = loadRequestRef.current
    setCompareBusy(true)
    try {
      const response = await api.friendAddRules.get(selectedAccountId, ruleId)
      if (!response.success) { setError(response.error); return }
      if (loadRequestRef.current !== request) return
      const latest = response.data.rule
      const routeText = (ids: string[]) => ids
        .map((id) => options.routes.find((route) => route.id === id)?.name ?? id)
        .join('・') || '未選択'
      const rows = [
        { label: '設定名', mine: rule.name, theirs: latest.name },
        { label: 'フォルダ', mine: rule.folderName ?? '未分類', theirs: latest.folderName ?? '未分類' },
        { label: '流入リンク', mine: routeText(definition.routeIds), theirs: routeText(latest.definition.routeIds) },
        { label: '最初に送るもの', mine: definition.messageText, theirs: latest.definition.messageText },
        { label: 'あわせて行うこと', mine: JSON.stringify(definition.actions), theirs: JSON.stringify(latest.definition.actions) },
        { label: '順番', mine: String(rule.priority), theirs: String(latest.priority) },
        { label: '友だちの区分', mine: rule.friendKind, theirs: latest.friendKind },
        { label: '経路不明の設定', mine: String(rule.isFallback), theirs: String(latest.isFallback) },
        ...Object.entries({scenarioId:'シナリオ',messageType:'メッセージの種類',timing:'送るタイミング',friendCondition:'友だちの条件',activeFrom:'有効期間の開始',activeUntil:'有効期間の終了',returningMode:'以前からの友だちへの送り方',startPosition:'シナリオの開始位置',deliveryChoices:'配信する内容',resendSuppressionHours:'再送を止める時間',unknownRouteAction:'経路不明のときの動作',weekdays:'曜日',timeWindows:'時間帯',internalMemo:'メモ'}).map(([key,label]) => ({label, mine: JSON.stringify(definition[key as keyof FriendAddRuleDefinition] ?? null), theirs: JSON.stringify(latest.definition[key as keyof FriendAddRuleDefinition] ?? null)})),
      ].filter((row) => row.mine !== row.theirs)
      setCompare(rows)
    } catch (caught) {
      if (loadRequestRef.current !== request) return
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)

      setError(describeFriendAddFailure(caught, '設定', 'load').message) }
    } finally {
      if (loadRequestRef.current === request) setCompareBusy(false)
    }
  }

  const moveToStep = (nextStep: Step) => {
    if (nextStep === step || saving || enabling) return
    if (STEPS.findIndex((item) => item.key === nextStep) > currentIndex) {
      if ((b244Requirements.rule_name.check(rule.name) !== null)) {
        showFieldError({ step: 'basic', message: '設定名を入力してください。' })
        return
      }
      const problem = validateStep(step)
      if (problem) { showFieldError(problem); return }
    }
    if (!hasUnsavedChanges) {
      samePageUrl.replace(hrefFor(nextStep))
      return
    }
    void save(nextStep)
  }

  const runTest = async () => {
    const request = loadRequestRef.current
    const activeId = ruleId ?? await save('preview')
    if (!activeId || !selectedAccountId || loadedAccountId !== selectedAccountId) return
    setSaving(true)
    setError('')
    try {
      const response = await api.friendAddRules.test(selectedAccountId, activeId, testInput)
      if (loadRequestRef.current !== request) return
      const testedMeta = {
        accountId: selectedAccountId,
        ruleId: activeId,
        snapshot: savedSnapshot.current ?? editorSnapshot(rule, definition),
      }
      if (!response.success) {
        if ('data' in response && response.data) setTestResult({ ...testedMeta, ...response.data })
        setError(response.error)
        return
      }
      setTestResult({ ...testedMeta, ...response.data })
      setNotice('テストが完了しました。本番の登録・送信・タグ・マイルは変更していません。')
    } catch (saveFailure) {
      if (loadRequestRef.current !== request) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)

      setError('テストを実行できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (loadRequestRef.current === request) setSaving(false)
    }
  }

  /* 確認段の「有効にする前の確認」はサーバの検証を読む（公開の面と同じ口）。 */
  const [overlapNotes, setOverlapNotes] = useState<string[]>([])
  useEffect(() => {
    if (step !== 'preview' || !ruleId || !selectedAccountId || loadedAccountId !== selectedAccountId) return
    let alive = true
    void (async () => {
      try {
        const res = await api.friendAddRules.validate(selectedAccountId, ruleId)
        if (!alive || !res.success) return
        setValidateChecks(res.data.checks.map((check) => ({ key: check.key, status: check.status, detail: check.detail })))
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        /* 読めないときはテストの行だけを見る。 */
      }
    })();

    return () => { alive = false }
  }, [step, ruleId, selectedAccountId, loadedAccountId, saveErrors])
  useEffect(() => {
    if (step !== 'preview' || !selectedAccountId) return
    let alive = true
    void (async () => {
      try {
        const res = await api.friendAddRules.conflicts(selectedAccountId, rule.friendKind)
        if (!alive || !res.success) return
        setOverlapNotes(res.data.conflicts.map((item) => item.message))
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        /* 読めないときは重なりの行を出さない。 */
      }
    })();

    return () => { alive = false }
  }, [step, selectedAccountId, rule.friendKind, saveErrors])

  /* 「有効にする」：検証が通り、テストで判定が通ったときだけ押せる。 */
  const testOk = testResult
    && testResult.accountId === selectedAccountId
    && testResult.ruleId === (ruleId ?? testResult.ruleId)
    && testResult.snapshot === editorSnapshot(rule, definition)
    && testResult.matched
  const overlapOk = (validateChecks === null || !validateChecks.some((check) => check.status !== 'passed')) && overlapNotes.length === 0
  const canEnable = Boolean(ruleId && canEdit && testOk && overlapOk && !saving && !enabling)

  const enableRule = async () => {
    const activeId = ruleId ?? await save('preview')
    if (!activeId || !selectedAccountId || loadedAccountId !== selectedAccountId || enabling) return
    const request = loadRequestRef.current
    setEnabling(true)
    setError('')
    try {
      const res = await api.friendAddRules.publish(selectedAccountId, activeId, saveIdempotencyKey.current)
      if (loadRequestRef.current !== request) return
      if (!res.success) {
        setError('有効化できませんでした。状態を読み直してから、もう一度お試しください。')
        return
      }
      router.replace(`/friend-add-settings/publish?id=${encodeURIComponent(activeId)}&done=1`)
    } catch (saveFailure) {
      if (loadRequestRef.current !== request) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)

      setError('有効化できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (loadRequestRef.current === request) setEnabling(false)
    }
  }

  const toggleRoute = (id: string) => setDefinition((current) => ({
    ...current,
    routeIds: current.routeIds.includes(id) ? current.routeIds.filter((routeId) => routeId !== id) : [...current.routeIds, id],
  }))

  const routeNames = useMemo(() => definition.routeIds
    .map((id) => options.routes.find((route) => route.id === id)?.name)
    .filter((name): name is string => Boolean(name)), [definition.routeIds, options.routes])

  if (accountLoading || loading) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="設定を読み込んでいます" /></SaveErrorScope>
  if (!selectedAccountId) return <SaveErrorScope errors={saveErrors}><ListState kind="empty" title="LINE公式アカウントを選んでください" description={accounts.length ? '上のバーで対象を選ぶと設定を表示します。' : '先にLINE公式アカウントを登録してください。'} /></SaveErrorScope>
  if (loadedAccountId !== selectedAccountId) {
    return error
      ? <ListState kind="error" title="設定を表示できませんでした" description={error} onRetry={() => void load()} />
      : <ListState kind="loading" title="設定を読み込んでいます" />
  }
  if (error && !rule.name && ruleId) return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="設定を表示できませんでした" description={error} onRetry={() => void load()} /></SaveErrorScope>

  /* ===== 右の列：設定内容と LINE での見え方 ===== */
  const noneMode = rule.friendKind === 'returning' && definition.returningMode === 'none'
  const textReady = definition.messageType === 'text' && definition.messageText
  const firstSend = noneMode
    ? '配信なし'
    : textReady
      ? step === 'actions' || step === 'preview'
        ? `テキスト＋${definition.actions.length}つの処理`
        : `テキスト ${definition.messageText.length}字`
      : step === 'basic' || step === 'routes'
        ? '手順3で作る'
        : MESSAGE_TYPE_LABEL[definition.messageType] ?? emptyValue('unconfigured')
  const statusLabel = rule.status === 'published' ? '有効' : rule.status === 'stopped' ? '停止中' : '下書き'
  const routeSummary = step === 'basic'
    ? '手順2で選ぶ'
    : routeNames.length === 0
      ? '未選択'
      : routeNames.length === 1
        ? routeNames[0]
        : `${routeNames.length}つ（${sharedPrefix(routeNames) || routeNames[0]}）`
  const summary = (
    <CreateSummaryCard rows={[
      { label: 'だれに', value: rule.friendKind === 'returning' ? '以前からの友だち' : 'はじめての人' },
      { label: '流入リンク', value: routeSummary },
      { label: '最初に送るもの', value: firstSend },
      { label: '状態', value: step === 'preview' ? `${statusLabel} → 有効にする` : statusLabel },
    ]} />
  )
  const phone = (
    <LinePreview
      accountName={accountName}
      caption={textReady || noneMode ? undefined : '友だち追加しました'}
      empty={textReady || noneMode ? false : '初回案内は手順3で作ります'}
    >
      {textReady || noneMode ? (
        <>
          <p className={styles.talkChip}><span>友だち追加しました</span></p>
          <LinePreviewMessage accountName={accountName} avatar={accountName.slice(0, 1)} time="今">
            {noneMode ? '再追加では配信しません。案内後の操作だけを行います。' : definition.messageText}
          </LinePreviewMessage>
        </>
      ) : null}
    </LinePreview>
  )
  /* 1152：見え方は「LINEでの見え方を見る」で開き、列には設定内容だけを置く。 */
  const preview = step === 'basic' ? (
    <>
      {summary}
      <CreatePreviewNote>LINEでの見え方は、届けるメッセージを決める手順から右に出ます。</CreatePreviewNote>
    </>
  ) : (
    <>
      {summary}
      {phone}
    </>
  )

  const duplicateSaved = async () => {
    if (!ruleId || !selectedAccountId || !canEdit || duplicating) return
    setDuplicating(true); setError('')
    try {
      const response = await api.friendAddRules.duplicate(selectedAccountId, ruleId, rule.version, duplicateKey.current)
      if (!response.success) throw new Error(response.error)
      notifyToast('複製した下書きを追加しました')
      router.push(`/friend-add-settings?kind=${rule.friendKind}&highlight=${encodeURIComponent(response.data.id)}&status=draft`)
    } catch (cause) { if (!saveErrors.capture(cause))

 setError('複製できませんでした。保存済みの内容を読み直してお試しください。') }
    finally { setDuplicating(false) }
  }

  const nextStep = STEPS[Math.min(currentIndex + 1, STEPS.length - 1)]
  const stepperSteps: StepperStep[] = STEPS.map((item, index) => ({
    key: item.key,
    label: item.label,
    state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo',
    onSelect: index !== currentIndex ? () => moveToStep(item.key) : undefined,
  }))

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage step={currentIndex}
      boardId={step === 'routes' && narrow ? 'xHpkS' : conflict ? 'h5rm8t' : STEPS[currentIndex].node}
      title="初回案内を作る"
      actions={canEdit && ruleId ? <RowMenu label="初回案内の操作" triggerProps={{ disabled: saving || enabling || duplicating }} items={[{ id: 'duplicate', label: '複製する', onSelect: () => requestUnsavedAction(() => void duplicateSaved()) }]} /> : undefined}
      steps={<Steps label="初回案内の作る手順" steps={stepperSteps} currentKey={step} readOnly={!canEdit} summaries={{ basic: rule.name, routes: routeSummary, message: firstSend, actions: `${formatNumber(definition.actions.length)}件のアクション` }} />}
      help={<>
        {step === 'basic'
          ? 'いまは下書きとして作ります。最後の「確認」で有効にします。'
          : `名前：${rule.name || emptyValue('unconfigured')}・いまは${statusLabel}です`}
      </>}
      /* 先に保存されたとき：板の頭の下に、入力欄と右の列にまたがる帯（型の notice の置き場）。
         帯は共通部品（save-conflict）。比べる窓は項目を左右に並べるこの画面のものを使う。 */
      notice={conflict ? (
        <SaveConflictBand reloadVariant="primary"
          title={`ほかの人が先に初回案内「${rule.name}」を保存しました`}
          designNode="h5rm8t"
          compareBusy={compareBusy}
          onCompare={() => void openCompare()}
          onReload={() => void reloadAfterConflict()}
        />
      ) : null}
      noticeSpacing="band"
      preview={preview}
      previewLabel={step === 'basic' ? '設定内容を見る' : undefined}
      previewTitle={step === 'basic' ? '設定内容' : undefined}
      footerActions={canEdit ? (
        <>
          <Button href="/friend-add-settings">キャンセル</Button>
          <Button type="button" disabled={saving || enabling} busy={saving} busyLabel="保存中…" onClick={() => void save()}>下書きを保存</Button>
          {step === 'preview' ? (
            <Button
              type="button"
              variant="primary"
              disabled={!canEnable}
              title={!testOk ? 'テストで判定が通るまで、有効にはできません' : !overlapOk ? '確認の直しを終えてから有効にできます' : undefined}
              busy={enabling}
              busyLabel="有効化中…"
              onClick={() => void enableRule()}
            >
              <Power size={16} aria-hidden="true" />有効にする
            </Button>
          ) : (
            <Button type="button" variant="primary" disabled={saving || enabling} onClick={() => moveToStep(nextStep.key)} busy={Boolean(saving)} busyLabel="処理中…">
              次へ：{nextStep.label}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          )}
        </>
      ) : (
        /* 閲覧のみ：変える操作（保存・次へ・有効にする）は置かない。 */
        <></>
      )} dirty={false}
    >
      {!canEdit ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
      ) : null}
      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {notice ? <Notice tone="success" message={notice} onClose={() => setNotice('')} /> : null}

      {step === 'basic' ? (
        <BasicStep
          rule={rule}
          setRule={setRule}
          definition={definition}
          setDefinition={setDefinition}
          options={options}
          canEdit={canEdit}
          isExisting={Boolean(ruleId)}
          nameError={fieldError?.step === 'basic' ? fieldError.message : undefined}
          onCreateFolder={canEdit && selectedAccountId
            ? folderCreator(
              // 一覧の左の列と同じ口。やり直しで二重に作らないよう、作れるまで同じ鍵で送る。
              (name, color) => api.friendAddRules.createFolder(selectedAccountId, name, folderKey.current, color),
              folderByName,
              (created) => {
                folderKey.current = crypto.randomUUID()
                setOptions((current) => ({ ...current, folders: [...current.folders, { id: created.id, name: created.name, color: created.color }] }))
              },
            )
            : undefined}
        />
      ) : null}
      {step === 'routes' ? (
        <RoutesStep
          rule={rule}
          definition={definition}
          setDefinition={setDefinition}
          options={options}
          routeUses={routeUses}
          toggleRoute={toggleRoute}
          canEdit={canEdit}
          routeError={fieldError?.step === 'routes' ? fieldError.message : undefined}
        />
      ) : null}
      {step === 'message' ? (
        <MessageStep tokenNames={tokenNames} definition={definition} setDefinition={setDefinition} friendKind={rule.friendKind} scenarios={options.scenarios} canEdit={canEdit} scenarioError={fieldError?.step === 'message' ? fieldError.message : undefined} />
      ) : null}
      {step === 'actions' ? (
        <ActionsStep definition={definition} setDefinition={setDefinition} options={options} canEdit={canEdit} />
      ) : null}
      {step === 'preview' ? (
        <PreviewStep
          rule={rule}
          definition={definition}
          routeNames={routeNames}
          runTest={runTest}
          onTestConditions={() => setTestConditionsOpen(true)}
          testing={saving}
          testOk={Boolean(testOk)}
          overlapNotes={overlapNotes}
          slackConnected={slackConnected}
          canEdit={canEdit}
          hrefFor={hrefFor}
          accountId={selectedAccountId}
          ruleId={ruleId}
          scenarios={options.scenarios}
        />
      ) : null}

      <Dialog open={testConditionsOpen && canEdit} title="テストの条件" busy={saving} onCancel={() => setTestConditionsOpen(false)} footer={<DialogActions><Button type="button" variant="primary" busy={saving} busyLabel="判定中…" onClick={() => { setTestConditionsOpen(false); void runTest() }}>この条件でテストする</Button></DialogActions>}>
        <Field label="試す流入リンク"><SaveErrorField names={["routeId"]}><EntitySelect noun="流入リンク" clearable aria-label="試す流入リンク" value={testInput.routeId ?? ''} onChange={(routeId) => changeTestInput({ routeId: routeId || null })} options={[{ value: '', label: 'どの経路でも' }, ...options.routes.map((route) => ({ ...entityOptionMetadata(route), value: route.id, label: route.name }))]} /></SaveErrorField></Field>
        <Field label="想定日時"><SaveErrorField names={["expectedAt"]}><DateTimeField aria-label="想定日時" value={testInput.expectedAt ?? ''} onChange={(expectedAt) => changeTestInput({ expectedAt: expectedAt || null })} /></SaveErrorField></Field>
        <SaveErrorField names={["friendId"]}><FriendPickerField accountId={selectedAccountId} label="試す友だち" value={testInput.friendId ?? ''} onChange={(friendId) => changeTestInput({ friendId: friendId || null })} /></SaveErrorField>
        <Notice tone="info" message="指定しない条件は、いま・どの経路でも・友だち不問で判定します。実際の友だちへは送信しません。" />
      </Dialog>

      <ConfirmDialog
        open={compare !== null}
        title="最新の保存とあなたの直しの違い"
        description={compare && compare.length === 0 ? '項目の違いはありません。最新を読み込んで続けてください。' : '左があなたの直し、右が先に保存された内容です。'}
        confirmLabel="最新を読み込んで続ける"
        busy={compareBusy} error={error || undefined} onSuccess={() => setCompare(null)} onConfirm={() => reloadAfterConflict()}
        onCancel={() => setCompare(null)}
      >
        {compare && compare.length > 0 ? (
          <dl className={styles.compareRows}>
            {compare.map((row) => (
              <div key={row.label} className={styles.compareRow}>
                <dt>{row.label}</dt>
                <dd title={row.mine}>{row.mine || '（空）'}</dd>
                <dd title={row.theirs}>{row.theirs || '（空）'}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </ConfirmDialog>
      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="追加時の動きへの変更"
        busy={saving || enabling}
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
    </CreatePage></SaveErrorScope>
  )
}
