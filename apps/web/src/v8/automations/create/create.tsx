'use client'

import { automationWaitLabel } from '@line-crm/shared'

import { useCanManageCommonActions } from '@/components/automations/use-common-action-permission'
import Button from '@/components/shared/button'
import { LOADING_MESSAGE } from '@/components/shared/list-state'
import { pruneCondition, type SegmentCondition } from '@/components/shared/condition-builder'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { api, type AutomationDraftAction, type AutomationDraftCommonActionVersionDetail, type AutomationDraftDetail } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import type { Automation } from '@line-crm/shared'
import { ArrowLeftRight, FilePen, MessageCircle, Play, Tag as TagIcon, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActionDraft } from './action-draft'
import styles from './create.module.css'
import { collectConditionRules, describeConditionRule, hasUnknownCondition } from './draft-conditions'
import { actionDraftToPayload, draftPayloadFingerprint, formatClock, FormSnapshot, newActionDraft, normalizeTriggerConfigFor, TestConfirmation, TestRunRecord } from './draft-model'
import { EVENTS, KEYWORD_EVENTS, REPRESENTATIVE_TRIGGER_EVENTS, TRIGGER_EVENT_GROUPS } from './draft-options'
import { StoredDraft } from './draft-storage'
import { validateAutomationInput } from './draft-validation'
import { friendNamesOf, normalizeFriendIds, normalizeWeekdays, weekdayNames } from './trigger-helpers'

import { AutomationDialogs } from './automation-dialogs'
import { AutomationFields } from './automation-fields'
import { AutomationReview } from './automation-review'
import { useAutomationAudience } from './use-automation-audience'
import { useAutomationDraftResume } from './use-automation-draft-resume'
import { useAutomationSave } from './use-automation-save'
import { useAutomationTest } from './use-automation-test'
export { actionDraftToPayload,draftDetailToForm } from './draft-model'

/*
 * ★V8-B オートメーションを作る（板 ・競合 ）。src/v8 に一から書いた画面。
 *
 * 型（CreatePage）に、戻る・題・説明・左の段（名前・どんなときに・だれに・何をするか）、
 * 右の列（文章にすると・人数・1人で試す・気をつけること・つながる先）、
 * 下の帯（キャンセル・下書きを保存・つくって動かす）を渡す。
 * 動き（きっかけ・条件・することの並び・下書き保存・公開・1人テスト・人数・再開・競合）は
 * app/automations/new/new-v8.tsx から写した（src/v8 は @/app を読めない）。
 * することの中身は行の「…」→「中身を直す」の窓で選ぶ。だれにの条件は窓の ConditionBuilder。
 * 競合は頭の下の帯と、比べる窓・「比べてから保存」。
 *
 * `chrome` は写し元と同じ口（'draft' は下書きの仕上げ  用）。入口 /automations/new は 'create'。
 */
export function NewAutomationV8({
  draftId,
  chrome = 'create',
}: {
  draftId?: string
  chrome?: 'create' | 'draft'
}) {
  const saveErrors = useSaveFormErrors()
  usePageTitle(chrome === 'draft' ? '下書きを仕上げる' : 'オートメーションを作る')
  usePageCrumbs([{ label: 'オートメーション', href: '/automations' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const canManage = useCanManageCommonActions()
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState<string>(EVENTS[0].value)
  /* #975 U061: 10件を一度に並べない。代表＋絞り込み＋「すべてを見る」。 */
  const [eventQuery, setEventQuery] = useState('')
  const [showAllEvents, setShowAllEvents] = useState(false)
  const [keyword, setKeyword] = useState('')
  /*
   * 「だれに」の条件。形は worker の SegmentCondition と同じ——
   * 独自形で保存すると計算側とずれるので、共通部品の値をそのまま持つ。
   */
  const [condition, setCondition] = useState<SegmentCondition | null>(null)
  /* 読んだ下書きの条件が古い形で読めなかった。付け直すまで保存しない。 */
  const [conditionUnreadable, setConditionUnreadable] = useState(false)
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>({})
  const [savedDraft, setSavedDraft] = useState<StoredDraft | null>(null)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  /* AUTOMATION-03: 人数の確認は保存とは別の成否として持つ。 */
  const [previewFailed, setPreviewFailed] = useState(false)
  const [previewRefreshing, setPreviewRefreshing] = useState(false)
  const [previewTotal, setPreviewTotal] = useState<{ accountId: string; draftId: string; total: number } | null>(null)
  /* 右の列の「…」と、することの中身を直す窓・条件の窓。 */
  const [editingActionKey, setEditingActionKey] = useState<number | null>(null)
  const [conditionOpen, setConditionOpen] = useState(false)
  const [testFriendId, setTestFriendId] = useState('')
  const [actions, setActions] = useState<ActionDraft[]>([newActionDraft()])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])
  const [tagsLoading, setTagsLoading] = useState(true)
  const [tagsFailed, setTagsFailed] = useState(false)
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string }>>([])
  const [commonActions, setCommonActions] = useState<Array<{ id: string; name: string }>>([])
  const [saving, setSaving] = useState(false)
  /* #975 U073: 作成（下書き保存）と動かし始めることを分け、動かす前に内容を確認する。 */
  const [activateConfirmOpen, setActivateConfirmOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [preparingTest, setPreparingTest] = useState(false)
  const [testConfirmation, setTestConfirmation] = useState<TestConfirmation | null>(null)
  const [error, setError] = useState('')
  const [inputError, setInputError] = useState<{ target: string; message: string } | null>(null)

  useEffect(() => {
    if (!inputError) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(inputError.target)
      // 選ぶ窓の欄は id が行の箱に付くので、中の［選ぶ］へ移る。
      const control = target?.querySelector<HTMLElement>('button[aria-haspopup="dialog"]') ?? target
      control?.focus()
      control?.scrollIntoView?.({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [inputError])
  const [notice, setNotice] = useState('')
  const [existingAutomations, setExistingAutomations] = useState<Automation[]>([])
  const [existingError,setExistingError]=useState(false)
  const [existingRetry,setExistingRetry]=useState(0)
  /*
   * DETAIL-13: 「再開」は `?draft=<番号>` で明示した下書きだけ。
   * `undefined` はURLをまだ読んでいない（読み終わるまで画面を出さない）。
   */
  const [resumeTarget, setResumeTarget] = useState<string | null | undefined>(draftId ?? undefined)
  const [resumeStatus, setResumeStatus] = useState<'none' | 'loading' | 'ready' | 'failed'>('none')
  /* 下書きを仕上げるの帯に出す、読んだときの名前（入力で名前を変えても帯は動かさない）。 */
  const [sourceName, setSourceName] = useState('')
  /*
   * R532: 再開の読み込みが失敗した理由。通信断・対象なし・権限なしで
   * 案内を分け、通信断では同じ下書きの再試行だけを出し、保存は止める。
   */
  const [resumeErrorKind, setResumeErrorKind] = useState<'gone' | 'forbidden' | 'network' | null>(null)
  /* R532: 「もう一度読み込む」で再開の読み込みを走らせ直す番号。 */
  const [resumeRetry, setResumeRetry] = useState(0)
  /* このアカウントに前に保存した下書きがある、という案内にだけ使う控え。 */
  const [storedDraftHint, setStoredDraftHint] = useState<StoredDraft | null>(null)
  /* DETAIL-15: 未保存・保存中・保存済み・保存後の変更・失敗を1つの状態から出す。 */
  const [saveOutcome, setSaveOutcome] = useState<'idle' | 'saved' | 'failed' | 'published'>('idle')
  /* R491: 公開済みで戻ったとき、元のルールへ案内するための番号。 */
  const [publishedRuleId, setPublishedRuleId] = useState<string | null>(null)
  /*
   * 競合（板 ）：保存しようとしたら、ほかの人が先に同じ下書きを
   * 保存していた。自分の入力は残したまま、帯で知らせる。
   * 誰が・いつ保存したかは口が返さないため、帯の文言は相手を名指ししない。
   * 比べる窓は、自分のいまの入力と、取り直した保存済みの内容を並べる。
   */
  const [conflict, setConflict] = useState<null | {
    draftId: string
    serverVersionId: string
    serverName: string
    serverEventLabel: string
    serverActionCount: number
  }>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  /* R488: 受け付けた1人テストの実行。 */
  const [testRun, setTestRun] = useState<TestRunRecord | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null)
  // 画面の描き直しを待たずに二重押しを止める鍵（N-357・N-358）。
  const saveRunningRef = useRef(false)
  const testRunningRef = useRef(false)
  const prepareRunningRef = useRef(false)
  /*
   * R485: 送信前の読み取り待ちに取消の番号を持たせる。「やめる」を押すと
   * 番号が進み、遅れて返った読み取りは送信へ進まない。
   */
  const testTicketRef = useRef(0)
  /*
   * R491: 公開待ちの応答を要求の世代で照合する。アカウントごとに保存の
   * 番号を振り、切替後に届いた古い応答で画面を戻さない。
   */
  const saveTicketRef = useRef<Record<string, number>>({})
  const selectedAccountRef = useRef(selectedAccountId)
  selectedAccountRef.current = selectedAccountId
  /*
   * DETAIL-14: アカウントごとの入力の控えと、そのアカウントに結び付いた
   * 下書き。切り替えのたびに預け・戻し、保存はこの控えにある下書きだけを
   * 更新する（＝いま選んでいるアカウントのものだけ）。
   */
  const formStashRef = useRef<Record<string, FormSnapshot>>({})
  const draftByAccountRef = useRef<Record<string, StoredDraft>>({})
  /*
   * DETAIL-13: まだ下書きが結び付いていない作成操作の冪等鍵（アカウントごと）。
   * 作り直しのたびに振り直すと再試行が別の下書きを増やしてしまうので、
   * 鍵は下書きが結び付くまで持ち回る。結び付いたら捨てる——その次に
   * 作り直しが走るのは別の新規作成だから。
   */
  const createOpKeyRef = useRef<Record<string, string>>({})
  const previousAccountRef = useRef(selectedAccountId)
  /* 切り替えの直後はURLがまだ前のアカウントの下書きを指している。 */
  const accountSwitchPendingRef = useRef(false)
  /* 再開の読み込みを二度走らせないための、読んだ組み合わせの記録。 */
  const resumedKeyRef = useRef<string | null>(null)
  /* 再開・復元で eventType を戻すとき、入力のリセットを1回だけ止める。 */
  const suppressTriggerResetRef = useRef(false)

  /** いま画面に出ている入力一式を、そのアカウントの控えとして取り出す。 */
const { syncResumeUrl, bindAccountDraft, captureFormSnapshot, resumeBase } = useAutomationDraftResume({
    name, eventType, keyword,
    condition, conditionUnreadable, triggerConfig,
    actions, testFriendId, savedDraft,
    savedAt, savedFingerprint, saveOutcome,
    publishedRuleId, previewCount, previewFailed,
    testRun, suppressTriggerResetRef, setName,
    setEventType, setKeyword, setCondition,
    setConditionUnreadable, setTriggerConfig, setActions,
    setTestFriendId, setSavedDraft, setSavedAt,
    setSavedFingerprint, setSaveOutcome, setPublishedRuleId,
    setPreviewCount, setPreviewFailed, setTestRun,
    draftByAccountRef, createOpKeyRef, formStashRef,
    selectedAccountRef, chrome, setTagsLoading,
    setTagsFailed, selectedAccountId, setTags,
    setScenarios, setCommonActions, setExistingAutomations,
    setExistingError, existingRetry, setResumeTarget,
    setStoredDraftHint, previousAccountRef, accountSwitchPendingRef,
    setError, setInputError, setTestConfirmation,
    refreshTestRun: (record, accountId) => refreshTestRun(record, accountId), setNotice, resumeTarget,
    setResumeStatus, resumedKeyRef, setResumeErrorKind,
    setSourceName, resumeRetry,
  })
  const selectedEvent = EVENTS.find((event) => event.value === eventType) ?? EVENTS[0]
  const usesKeyword = KEYWORD_EVENTS.includes(eventType)
  /* #975 U061: 検索中は一致したものだけ。それ以外は代表3件、選択中が代表外なら全件を出す。 */
  const normalizedEventQuery = eventQuery.trim().toLowerCase()
  const matchedEvents = normalizedEventQuery
    ? EVENTS.filter((event) => `${event.label} ${event.note}`.toLowerCase().includes(normalizedEventQuery))
    : null
  const expandedEvents = showAllEvents || !REPRESENTATIVE_TRIGGER_EVENTS.includes(eventType)
  const triggerEventGroups = matchedEvents
    ? [{ id: 'search', label: `「${eventQuery.trim()}」に合うきっかけ`, events: matchedEvents }]
    : TRIGGER_EVENT_GROUPS.map((group) => ({
        ...group,
        events: group.values
          .filter((value) => expandedEvents || REPRESENTATIVE_TRIGGER_EVENTS.includes(value))
          .map((value) => EVENTS.find((event) => event.value === value))
          .filter((event): event is (typeof EVENTS)[number] => Boolean(event)),
      }))
  const hasSameTrigger = existingAutomations.some((item) => item.eventType === selectedEvent.value)
  /*
   * AUTOMATION-02: 要約は「保存に送る条件」と同じものから作る。
   * 名前の条件など、言葉以外の条件が要約から落ちて「条件なし」に
   * 見えていたので、pruneCondition（保存と同じ取捨）の結果をそのまま
   * 文章にする。
   */
  const usableCondition = pruneCondition(condition)
  const conditionSummaries = collectConditionRules(usableCondition).map(
    (rule) => describeConditionRule(rule, { tags, scenarios }),
  )
  const triggerAudience = usesKeyword && keyword.trim()
    ? `「${keyword.trim()}」を含む内容を送った人`
    : 'きっかけに当てはまった人'
  const targetSummary = conditionUnreadable
    ? `${triggerAudience}に（以前保存した条件は読めませんでした）`
    : conditionSummaries.length > 0
      ? `${triggerAudience}のうち、${conditionSummaries.join('・')}に`
      : `${triggerAudience}に`
  const actionSummary = actions.map((row) => {
    if (row.type === 'add_tag') {
      const tagName = tags.find((tag) => tag.id === row.tagId)?.name
      return row.tagId === '' ? 'タグ（未選択）' : tagName ? `タグ「${tagName}」を付ける` : '選んだタグを付ける'
    }
    if (row.type === 'common_action') {
      const commonActionName = commonActions.find((item) => item.id === row.commonActionId)?.name
      return row.commonActionId === '' ? '共通アクション（未選択）' : commonActionName ? `共通アクション「${commonActionName}」を実行` : '共通アクションを実行'
    }
    if (row.type === 'start_scenario') {
      const scenarioName = scenarios.find((item) => item.id === row.scenarioId)?.name
      return row.scenarioId === '' ? 'シナリオ（未選択）' : scenarioName ? `シナリオ「${scenarioName}」を始める` : 'シナリオを始める'
    }
    if (row.type === 'wait') return automationWaitLabel(row.kept ?? {})
    if (row.type === 'notify_staff') return '担当へ知らせる'
    return row.message.trim() ? '入力したメッセージを送る' : 'メッセージを送る'
  }).join('、')

  /** 保存で送る「すること」。確認画面とのずれを見るときも同じ形を使う。 */
  const draftActions = (): AutomationDraftAction[] => actions.map(actionDraftToPayload)

  /**
   * 共通アクションの版の中身を、確認画面向けの一文へたたむ（R486）。
   * 入れ子の呼び出しは `commonActionVersions` 地図を辿って版番号まで出す。
   * 中身を確かめられない枝があれば `unresolved` を立て、送信へ進めない。
   */
  const describeCommonActionSteps = (
    steps: AutomationDraftCommonActionVersionDetail['actions'],
    versions: AutomationDraftDetail['commonActionVersions'],
    depth: number,
    unresolved: { flag: boolean },
  ): string => {
    if (depth > 5) {
      unresolved.flag = true
      return '中身を確認できません'
    }
    const parts = steps.map((step) => {
      const params = step.params ?? {}
      if (step.type === 'send_message') return `メッセージ「${String(params.content ?? '')}」を送る`
      if (step.type === 'add_tag' || step.type === 'remove_tag') {
        const tagId = String(params.tagId ?? '')
        const tagName = tags.find((tag) => tag.id === tagId)?.name ?? tagId
        return step.type === 'add_tag' ? `タグ「${tagName}」を付ける` : `タグ「${tagName}」を外す`
      }
      if (step.type === 'wait') {
        return automationWaitLabel(params)
      }
      if (step.type === 'start_scenario' || step.type === 'stop_scenario' || step.type === 'resume_scenario') {
        const scenarioId = String(params.scenarioId ?? '')
        const scenarioName = scenarios.find((item) => item.id === scenarioId)?.name ?? scenarioId
        if (step.type === 'stop_scenario') return `シナリオ「${scenarioName}」を止める`
        if (step.type === 'resume_scenario') return `シナリオ「${scenarioName}」を再開する`
        return `シナリオ「${scenarioName}」を始める`
      }
      if (step.type === 'send_webhook') return 'Webhookへ送る'
      if (step.type === 'set_metadata') return '友だち情報を更新する'
      if (step.type === 'switch_rich_menu' || step.type === 'remove_rich_menu') return 'リッチメニューを切り替える'
      if (step.type === 'common_action') {
        const versionId = String(params.commonActionVersionId ?? '')
        const version = versionId ? versions[versionId] : undefined
        if (!version) {
          unresolved.flag = true
          return '共通アクション（使う版を確認できません）'
        }
        return `共通アクション「${version.name}」第${version.versionNumber}版（${describeCommonActionSteps(version.actions, versions, depth + 1, unresolved)}）`
      }
      if (step.type === 'branch') return '条件で分かれる'
      return '設定した処理を実行'
    })
    return parts.length > 0 ? parts.join('、') : '処理なし'
  }

  /**
   * 確認に出す「実際に送られる中身」（N-358）。
   *
   * **画面の入力からは作らない。** サーバーが持っている下書きから作る。
   * 入力中で未保存の文面が確認へ混ざると、見た内容と送る内容がずれる。
   *
   * R486: 共通アクションは名前だけでなく、確認時に固定される版の番号と
   * その中身（本文）まで出す。版や中身が解決できない処理が1件でも
   * あれば `unconfirmed` を立て、送信は受け付けない。
   */
  const describeDraftActions = (
    list: AutomationDraftAction[],
    refs: AutomationDraftDetail['commonActionRefs'],
    versions: AutomationDraftDetail['commonActionVersions'],
  ): { contents: string[]; effects: string[]; unconfirmed: boolean } => {
    const unresolved = { flag: false }
    const contents = list.map((step) => {
      if (step.type === 'send_message') return `メッセージ「${String(step.params.content ?? '')}」`
      if (step.type === 'add_tag') {
        const tagId = String(step.params.tagId ?? '')
        return `タグ「${tags.find((tag) => tag.id === tagId)?.name ?? tagId}」を付ける`
      }
      if (step.type === 'common_action') {
        const ref = refs.find((item) => item.stepId === step.id)
        const name = ref?.name
          ?? commonActions.find((item) => item.id === ref?.commonActionId)?.name
          ?? ref?.commonActionId ?? '共通アクション'
        if (!ref?.versionId) {
          unresolved.flag = true
          return `共通アクション「${name}」（使う版を確認できません）`
        }
        const version = versions[ref.versionId]
        if (!version) {
          unresolved.flag = true
          return `共通アクション「${name}」第${ref.versionNumber ?? '?'}版（中身を確認できません）`
        }
        return `共通アクション「${version.name}」第${version.versionNumber}版：${describeCommonActionSteps(version.actions, versions, 1, unresolved)}`
      }
      return `シナリオ「${String(step.params.scenarioId ?? '')}」を始める`
    })
    return {
      contents,
      effects: [
        list.some((step) => step.type === 'send_message') ? 'メッセージが相手に届きます' : null,
        list.some((step) => step.type === 'add_tag') ? 'タグが相手に付きます' : null,
        list.some((step) => step.type === 'start_scenario') ? 'シナリオが相手に始まります' : null,
        list.some((step) => step.type === 'common_action') ? '共通アクションの処理が相手に動きます' : null,
      ].filter((item): item is string => item !== null),
      unconfirmed: unresolved.flag,
    }
  }

  useEffect(() => {
    /*
     * 再開・控えの復元で eventType と詳細設定を一緒に戻したときは、
     * この切替で詳細設定を空にしない（戻した直後に消えてしまう）。
     */
    if (suppressTriggerResetRef.current) {
      suppressTriggerResetRef.current = false
      return
    }
    setTriggerConfig({})
  }, [eventType])

  /*
   * R22: 読み込んだ下書きの対象（IDだけ）へ名前を付け直す。
   * 保存にはIDだけを送り、名前は表示専用（`friendNames`）として持つ。
   * 指紋・保存の中身には名前を入れないので、付け直しで「変更あり」にはならない。
   */
  useEffect(() => {
    if (!selectedAccountId) return
    const ids = normalizeFriendIds(triggerConfig.friendIds)
    const names = friendNamesOf(triggerConfig)
    const missing = ids.filter((id) => !names[id])
    if (missing.length === 0) return
    let cancelled = false
    void Promise.all(
      missing.map((id) =>
        api.friends
          .get(id, { includeSubmissions: false })
          .then((response) => {
            if (!response.success) return { id, name: id }
            const label = (response.data as { displayName?: unknown }).displayName
            return { id, name: typeof label === 'string' && label ? label : id }
          })
          .catch(() => ({ id, name: id })),
      ),
    ).then((resolved) => {
      if (cancelled || resolved.length === 0) return
      const found: Record<string, string> = {}
      for (const item of resolved) found[item.id] = item.name
      setTriggerConfig((current) => ({ ...current, friendNames: { ...friendNamesOf(current), ...found } }))
    })
    return () => {
      cancelled = true
    }
  }, [selectedAccountId, triggerConfig.friendIds, triggerConfig.friendNames])

  // #519 軽 + #942 N-355: 共有の選択肢すべてを描く。設定の要約もそれぞれ持つ。
  const weeklyDays = eventType === 'weekly' ? normalizeWeekdays(triggerConfig.weekdays) : []
  const triggerConfigSummary = eventType === 'datetime'
    ? String(triggerConfig.at ?? '日時を指定')
    : eventType === 'weekly'
      ? `毎週${weekdayNames(weeklyDays) || '曜日を選ぶ'} ${String(triggerConfig.time ?? '時刻を指定')}`
      : eventType === 'daily'
      ? String(triggerConfig.time ?? '時刻を指定')
      : eventType === 'form_submitted'
        ? String(triggerConfig.formId ?? 'すべてのフォーム')
        : eventType === 'link_clicked'
          ? String(triggerConfig.trackedLinkId ?? 'すべての計測リンク')
          : eventType === 'calendar_booked'
            ? String(triggerConfig.bookingType === 'salon' ? 'サロン予約' : triggerConfig.bookingType === 'event' ? 'イベント予約' : 'すべての予約')
            : ''

  const draftEventType: AutomationDraftDetail['eventType'] =
    selectedEvent.value as AutomationDraftDetail['eventType']
  const normalizedTriggerConfig = () =>
    normalizeTriggerConfigFor(draftEventType, triggerConfig, keyword)

  const updateAction = (key: number, patch: Partial<ActionDraft>) => {
    setInputError(null)
    setActions((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  useEffect(() => { setInputError(null) }, [eventType, triggerConfig])

  const validate = (forPublish = true): string | null => {
    setError('')
    setInputError(null)
    const problem = validateAutomationInput({ name, eventType, triggerConfig, conditionUnreadable, condition, actions, forPublish })
    if (!problem) return null
    if (problem.actionKey !== undefined) setEditingActionKey(problem.actionKey)
    setInputError({ target: problem.target, message: problem.message })
    return problem.message
  }

  /**
   * 保存を押せない理由。
   *
   * **押せるのに何も起きないボタンを置かない。** 権限が無いときは押せない形に
   * したうえで、理由を本文にも出す。
   */
  const blockedReason = useMemo(() => {
    if (canManage === null) return LOADING_MESSAGE
    if (!canManage) return '操作する権限がありません'
    // DETAIL-13: 再開した下書きは、中身を読み終わるまで保存できない。
    if (resumeStatus === 'loading') return '下書きを読み込んでいます'
    /*
     * R532: 再開の読み込みに失敗したまま保存させない。Aの更新も新規作成も
     * 実行されない。再試行でAを読めた後だけ保存でき、明示の作り直しでだけ
     * 白紙に戻る。
     */
    if (resumeTarget && resumeStatus === 'failed') {
      return resumeErrorKind === 'network'
        ? '下書きを読み込めませんでした。下の「下書きをもう一度読み込む」で取り直してから保存してください'
        : '指定された下書きを開けません。下の案内から読み直すか、白紙から作り直してください'
    }
    return null
  }, [canManage, resumeStatus, resumeTarget, resumeErrorKind])

  /*
   * R532: 失敗した再開の読み込みを、同じ下書きでもう一度だけ走らせる。
   * 読んだ組み合わせの記録を消して番号を進めるので、効果が取り直される。
   */
  const retryResume = () => {
    resumedKeyRef.current = null
    setResumeRetry((n) => n + 1)
  }

  /*
   * R532: 白紙からの作り直し（明示の選択）。URLの指定を外して再開をやめ、
   * この後保存したら別の新規下書きとして作る。失敗中の自動的な新規作成はしない。
   */
  const restartFresh = () => {
    syncResumeUrl(null)
    setResumeTarget(null)
    setResumeStatus('none')
    setResumeErrorKind(null)
    setError('')
    setNotice('')
  }

  /*
   * DETAIL-15: 保存の状態は1本。未保存・保存中・保存済み・保存後の変更・
   * 失敗をここだけから出すので、「保存しました」と「まだ保存していません」が
   * 同時に出ることはない。
   */
  const currentFingerprint = draftPayloadFingerprint({
    name,
    eventType: draftEventType,
    keyword,
    condition,
    triggerConfig,
    actions,
  })
  const initialFingerprint = useRef(currentFingerprint)
  const leaveBusy = saving || testing || preparingTest
  const { leaveTarget, confirmLeave, cancelLeave, guarded, disarm } = useUnsavedGuard({
    dirty: currentFingerprint !== (savedFingerprint ?? initialFingerprint.current),
    busy: leaveBusy,
  })
  const dirtySinceSave = savedFingerprint !== null && savedFingerprint !== currentFingerprint
  const unknownCondition = hasUnknownCondition(condition)
  const saveStatusText = saving
    ? '保存しています'
    : blockedReason ?? (unknownCondition ? '条件を選び直してください' : null) ?? (
        saveOutcome === 'failed'
          ? '保存できませんでした。入力した内容は残っています'
          : saveOutcome === 'published'
            ? '公開しました。一覧で確認できます'
            : saveOutcome === 'saved'
            ? [
                dirtySinceSave
                  ? '保存したあとに内容を変更しています'
                  /* 読み込んだだけ（この画面でまだ保存していない）なら、下の帯に保存の知らせを出さない。 */
                  : savedAt === null ? null : `下書きに保存しました（${formatClock(savedAt)}）`,
                // AUTOMATION-03: 人数の確認の失敗は、保存の結果とは別に添える。
                previewFailed ? '人数の確認に失敗しました。通信を確かめて、もう一度お試しください。' : null,
              ].filter((part): part is string => part !== null).join('・')
            : 'まだ保存していません')

  /**
   * 保存した版の見込み人数を数え直す（AUTOMATION-03）。
   *
   * **保存とは別の成否を持つ。** 以前は保存と同じ try の中で待っていた
   * ため、人数の取得が失敗すると「保存できませんでした」と出て、
   * 保存済みの下書きが失敗扱いになっていた。ここで失敗しても下書きは
   * 残っているので、「人数をもう一度数える」で保存した版へだけ再び
   * 問い合わせられる（新しい下書きは作らない）。途中で店が替わっても
   * 前の店へは書かない。
   */
const { refreshAudiencePreview } = useAutomationAudience({ formStashRef, selectedAccountRef, setPreviewRefreshing, setPreviewFailed, setPreviewCount, setPreviewTotal, saveErrors })

  /**
   * R490: 下書きが消えていたら、公開済みの定義として残っているか照合する。
   * 公開の応答が失われたあとの再試行で、新しい下書きを作る前に呼ぶ。
   * 公開済み（動いている・止めている）が見つかれば true。
   */
const { saveErrors: saveScopeErrors, reloadServerDraft, save } = useAutomationSave({
    saveErrors, selectedAccountRef, setConflict,
    conflict, selectedAccountId, eventType,
    suppressTriggerResetRef, setName, setEventType,
    setKeyword, setCondition, setConditionUnreadable,
    setTriggerConfig, setActions, setPreviewFailed,
    setSavedFingerprint, bindAccountDraft, setCompareOpen,
    setSaveOutcome, setError, setNotice,
    saveRunningRef, saving, blockedReason,
    validate, setSaving, name,
    draftEventType, normalizedTriggerConfig, condition,
    draftActions, captureFormSnapshot, saveOutcome,
    publishedRuleId, savedFingerprint, disarm,
    router, saveTicketRef, draftByAccountRef,
    createOpKeyRef, formStashRef, setSavedAt,
    setPublishedRuleId, setTestRun, setStoredDraftHint,
    setResumeTarget, syncResumeUrl, refreshAudiencePreview,
    setPreviewCount,
  })

  /**
   * N-358: 1人テストは2段階にする。
   *
   * 以前はIDを入れて押すとすぐ本番送信していた。送り先・送る内容・
   * 起きることを見せてから送る。**見せる中身はサーバーから取り直す**ので、
   * 画面に残っている古い記憶や未保存の入力は確認へ混ざらない。
   */
const { refreshTestRun, askOnePersonTest, runOnePersonTest } = useAutomationTest({
    selectedAccountId, testFriendId, savedDraft,
    setError, prepareRunningRef, setPreparingTest,
    setNotice, bindAccountDraft, selectedAccountRef,
    describeDraftActions, setTestConfirmation, saveErrors,
    setTestRun, formStashRef, testConfirmation,
    testRunningRef, testTicketRef, setTesting,
  })
  const openStoredDraft = () => {
    if (!storedDraftHint || !selectedAccountId) return
    guarded(() => {
      // 再開は「明示した下書き番号」。URLへ載せて読み込みに行く。
      if (chrome === 'draft') {
        router.push(`${resumeBase}?id=${encodeURIComponent(storedDraftHint.id)}`)
      } else {
        router.push(`${resumeBase}?draft=${encodeURIComponent(storedDraftHint.id)}`)
      }
      setResumeTarget(storedDraftHint.id)
    })
  }

  /*
   * 済んだことの知らせ（保存した・読み込んだ・テストを受け付けた）は、本文の上に帯を
   * 積まずに右下の知らせで出す。帯で出すと、そのたびに段が下へずれる。
   */
  useEffect(() => {
    if (!notice) return
    notifyToast(notice)
    setNotice('')
  }, [notice])

  // `?draft=` を読み終わるまで描かない。一瞬だけ空の新規画面が出て、
  // そのまま保存で以前の下書きを上書きする事故を防ぐ。
  if (resumeTarget === undefined) return null

  /* つながる先：選んだ処理が指す名前を、読み込んだ選択肢から引く。 */
  const usedTagNames = actions
    .filter((row) => row.type === 'add_tag' && row.tagId)
    .map((row) => tags.find((tag) => tag.id === row.tagId)?.name ?? '選んだタグ')
  const usedScenarioNames = actions
    .filter((row) => row.type === 'start_scenario' && row.scenarioId)
    .map((row) => scenarios.find((item) => item.id === row.scenarioId)?.name ?? '選んだシナリオ')
  const usedCommonActionNames = actions
    .filter((row) => row.type === 'common_action' && row.commonActionId)
    .map((row) => commonActions.find((item) => item.id === row.commonActionId)?.name ?? '選んだ共通アクション')
  /* 見え方：閲覧のみ（権限なし）には、変える操作（足す・直す・保存・動かす・試す）を置かない。 */
  const canEdit = canManage === true
  const totalForDraft = previewTotal && savedDraft && previewTotal.accountId === selectedAccountId && previewTotal.draftId === savedDraft.id
    ? previewTotal.total
    : null
  /* することの1行の下の小さな文（どれを・何を）。 */
  const actionRowDetail = (row: ActionDraft): string => {
    if (row.type === 'wait') return automationWaitLabel(row.kept ?? {})
    if (row.type === 'add_tag') {
      const tagName = tags.find((tag) => tag.id === row.tagId)?.name
      return tagName ? `タグ「${tagName}」` : 'タグを選んでください'
    }
    if (row.type === 'start_scenario') {
      const scenarioName = scenarios.find((item) => item.id === row.scenarioId)?.name
      return scenarioName ? `シナリオ「${scenarioName}」` : 'シナリオを選んでください'
    }
    if (row.type === 'common_action') {
      const commonActionName = commonActions.find((item) => item.id === row.commonActionId)?.name
      return commonActionName ? `共通アクション「${commonActionName}」` : '共通アクションを選んでください'
    }
    if (row.type === 'notify_staff') {
      const note = String(row.kept?.message ?? '').trim().replace(/\s+/g, ' ')
      return note || '知らせのルールのとおりに知らせます'
    }
    return row.message.trim() ? row.message.trim().replace(/\s+/g, ' ') : '送る文面を入れてください'
  }
  const representativeIcon: Record<string, ReactNode> = {
    friend_add: <UserPlus size={16} />,
    message_received: <MessageCircle size={16} />,
    tag_change: <TagIcon size={16} />,
  }

  /*
   * いまの決めごとを1つの文にする（「〜したら、〜に、〜して、〜します」）。
   * 保存に送るのと同じ条件・することから作るので、文と実際の動きはずれない。
   */
  const triggerPhrase = (() => {
    if (eventType === 'message_received') {
      return keyword.trim() ? `友だちから「${keyword.trim()}」を含むメッセージが届いたら` : '友だちからメッセージが届いたら'
    }
    if (eventType === 'friend_add') return '友だちになったら'
    if (eventType === 'tag_change') {
      const tagName = tags.find((tag) => tag.id === String(triggerConfig.tagId ?? ''))?.name
      const verb = triggerConfig.action === 'remove' ? '外れたら' : '付いたら'
      return tagName ? `タグ「${tagName}」が${verb}` : `選んだタグが${verb}`
    }
    return `${selectedEvent.label.replace(/とき$/, '')}ら`
  })()
  const actionPhrases = actions.map((row, index) => {
    const last = index === actions.length - 1
    const tagName = tags.find((tag) => tag.id === row.tagId)?.name
    const scenarioName = scenarios.find((item) => item.id === row.scenarioId)?.name
    const commonName = commonActions.find((item) => item.id === row.commonActionId)?.name
    if (row.type === 'add_tag') return `${row.tagId === '' ? 'タグ（未選択）' : tagName ? `タグ「${tagName}」` : 'タグ'}を付け${last ? 'ます' : 'て'}`
    if (row.type === 'start_scenario') return `${row.scenarioId === '' ? 'シナリオ（未選択）' : scenarioName ? `シナリオ「${scenarioName}」` : 'シナリオ'}を始め${last ? 'ます' : 'て'}`
    if (row.type === 'common_action') return `${row.commonActionId === '' ? '共通アクション（未選択）' : commonName ? `共通アクション「${commonName}」` : '共通アクション'}を実行し${last ? 'ます' : 'て'}`
    if (row.type === 'wait') return automationWaitLabel(row.kept ?? {}).replace(/待つ$/, last ? '待ちます' : '待って')
    if (row.type === 'notify_staff') return `担当へ知らせ${last ? 'ます' : 'て'}`
    return `メッセージを送${last ? 'ります' : 'り'}`
  })
  const ruleSentence = conditionUnreadable
    ? `${triggerPhrase}、${actionPhrases.join('、')}（以前保存した条件は読めませんでした）。`
    : `${triggerPhrase}、${conditionSummaries.length > 0 ? `${conditionSummaries.join('・')}に、` : ''}${actionPhrases.join('、') || '処理を実行します'}。`

  const conflictBand = conflict ? (
    <SaveConflictBand title="ほかの人が先にこのルールを保存しました" description="このまま保存すると、相手の変更が消えます" onCompare={() => setCompareOpen(true)} onReload={() => void reloadServerDraft()} />
  ) : null

  const sideColumn = (
<AutomationReview
        ruleSentence={ruleSentence}
        previewFailed={previewFailed}
        previewCount={previewCount}
        totalForDraft={totalForDraft}
        savedDraft={savedDraft}
        selectedAccountId={selectedAccountId}
        previewRefreshing={previewRefreshing}
        refreshAudiencePreview={refreshAudiencePreview}
        testFriendId={testFriendId}
        setTestFriendId={setTestFriendId}
        canEdit={canEdit}
        askOnePersonTest={askOnePersonTest}
        saving={saving}
        testing={testing}
        preparingTest={preparingTest}
        testConfirmation={testConfirmation}
        draftActions={draftActions}
        testTicketRef={testTicketRef}
        setTestConfirmation={setTestConfirmation}
        runOnePersonTest={runOnePersonTest}
        testRun={testRun}
        guarded={guarded}
        router={router}
        refreshTestRun={refreshTestRun}
        saveOutcome={saveOutcome}
        publishedRuleId={publishedRuleId}
        existingError={existingError}
        setExistingRetry={setExistingRetry}
        hasSameTrigger={hasSameTrigger}
        usedScenarioNames={usedScenarioNames}
        usedTagNames={usedTagNames}
        usedCommonActionNames={usedCommonActionNames}
       />
  )

  /*
   * 下書きを仕上げる：見本から作った下書き。頭の下に「どの見本から作ったか」の帯を出し、
   * 段の見出しに番号を付ける。戻る先・キャンセルは見本の一覧。
   */
  const isDraft = chrome === 'draft'
  const backHref = isDraft ? '/automations?tab=templates' : '/automations'
  const sourceBand = isDraft && resumeStatus === 'ready' ? (
    <Notice tone="info" role="note" icon={<FilePen size={16} aria-hidden="true" />}>
      <span>{`見本「${sourceName.trim() || '見本'}」から作った下書きです。${usedTagNames.length > 0 || usedScenarioNames.length > 0
        ? `${[
          ...usedTagNames.map((tagName) => `タグ「${tagName}」`),
          ...usedScenarioNames.map((scenarioName) => `シナリオ「${scenarioName}」`),
        ].join('と')}を、このアカウントのものに選び直してください。`
        : 'タグやシナリオを、このアカウントのものに選び直してください。'}`}</span>
    </Notice>
  ) : null

  return (
    <SaveErrorScope errors={saveScopeErrors}><CreatePage
      boardId={conflict ? 'tJqST' : isDraft ? 'J1VA8' : 'M4torY'}
      title={isDraft ? '下書きを仕上げる' : 'オートメーションを作る'}
      /* 見本の帯は頭の中、説明のすぐ下（絵では頭の線より上）。 */
      help={isDraft
        ? (
          <>
            見本に実データは入っていません。このアカウントで使うタグやシナリオを選び、下書きとして保存します。
            保存しても自動では動きません。公開するまでは下書きのままです。
          </>
        )
        : 'きっかけ・だれに・何をするかを決めます。1人で試してから動かすと、まちがいを防げます。'}
      /* 競合の帯は板の頭の下・左右の列の上に、板いっぱいで出す（型の頭と本文の間の段）。 */
      /* 見本の帯は頭の中、題のすぐ下（絵では頭の線より上）。 */
      subtitle={sourceBand ?? undefined}
      notice={<>{conflictBand}{savedDraft?.followupManagement?<Notice tone="info" action={<Button href={savedDraft.followupManagement.path}>来店フォローを見る →</Button>}>来店フォロー（{savedDraft.followupManagement.storeName}）で管理しています。{savedDraft.followupManagement.reason??'承認された内容で送っています。'}変更後は来店フォローでテスト送信と承認をやり直してください。</Notice>:null}</>}
      noticeSpacing="band"
      previewLabel="設定内容を見る"
      previewTitle="設定内容"
      preview={sideColumn}
      status={saveStatusText || undefined}
      footerActions={(
        <>
          <Button href={backHref}>キャンセル</Button>
          {canEdit ? (
            <>
              <Button disabled={saving || Boolean(blockedReason)} onClick={() => void save(false)} busy={Boolean(saving)} busyLabel="処理中…">下書きを保存</Button>
              {conflict ? (
                <Button variant="primary" onClick={() => setCompareOpen(true)}>
                  <ArrowLeftRight size={16} aria-hidden="true" />比べてから保存
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={saving || Boolean(blockedReason) || unknownCondition}
                  busy={saving}
                  busyLabel="作成中…"
                  onClick={() => {
                    const invalid = validate()
                    if (invalid) {
                      setNotice('')
                      return
                    }
                    setError(''); setActivateConfirmOpen(true)
                  }}
                >
                  <Play size={16} aria-hidden="true" />つくって動かす
                </Button>
              )}
            </>
          ) : null}
        </>
      )} dirty={false}
    >
      {canManage === false ? (
        <div className={styles.viewerBand}><ReadOnlyNotice role="status">閲覧のみで見ています。オートメーションを作る操作はオーナーか管理者に頼んでください。</ReadOnlyNotice></div>
      ) : null}
      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {resumeTarget && resumeStatus === 'failed' ? (
        <div className={styles.buttonRow}>
          <Button onClick={retryResume}>下書きをもう一度読み込む</Button>
          {resumeErrorKind !== 'network' ? <Button onClick={restartFresh}>白紙から作り直す</Button> : null}
        </div>
      ) : null}
      {storedDraftHint && !savedDraft && resumeTarget === null ? (
        <Notice tone="info" role="note" action={<>
          <Button onClick={openStoredDraft}>保存した下書きを開く</Button>
        </>}>
          <span>前にこのアカウントで保存した下書きがあります。このまま入力すると、別の新しいルールになります。</span>
        </Notice>
      ) : null}
<AutomationFields
        isDraft={isDraft}
        inputError={inputError}
        name={name}
        setName={setName}
        setInputError={setInputError}
        expandedEvents={expandedEvents}
        normalizedEventQuery={normalizedEventQuery}
        eventQuery={eventQuery}
        setEventQuery={setEventQuery}
        triggerEventGroups={triggerEventGroups}
        matchedEvents={matchedEvents}
        eventType={eventType}
        setEventType={setEventType}
        representativeIcon={representativeIcon}
        setShowAllEvents={setShowAllEvents}
        usesKeyword={usesKeyword}
        keyword={keyword}
        setKeyword={setKeyword}
        triggerConfig={triggerConfig}
        setTriggerConfig={setTriggerConfig}
        tags={tags}
        selectedAccountId={selectedAccountId}
        triggerConfigSummary={triggerConfigSummary} unknownCondition={unknownCondition}
        conditionUnreadable={conditionUnreadable}
        setConditionUnreadable={setConditionUnreadable}
        conditionSummaries={conditionSummaries}
        setConditionOpen={setConditionOpen}
        actions={actions}
        setActions={setActions}
        canEdit={canEdit}
        editingActionKey={editingActionKey}
        actionRowDetail={actionRowDetail}
        scenarios={scenarios}
        commonActions={commonActions}
        updateAction={updateAction}
        tagsLoading={tagsLoading}
        tagsFailed={tagsFailed}
       />

<AutomationDialogs
        conditionOpen={conditionOpen}
        setConditionOpen={setConditionOpen}
        condition={condition}
        setCondition={setCondition}
        activateConfirmOpen={activateConfirmOpen}
        saving={saving}
        setActivateConfirmOpen={setActivateConfirmOpen}
        save={save}
        error={error}
        name={name}
        selectedEvent={selectedEvent}
        triggerConfigSummary={triggerConfigSummary}
        targetSummary={targetSummary}
        previewCount={previewCount}
        actionSummary={actionSummary}
        eventType={eventType}
        compareOpen={compareOpen}
        conflict={conflict}
        setCompareOpen={setCompareOpen}
        leaveTarget={leaveTarget}
        leaveBusy={leaveBusy}
        confirmLeave={confirmLeave}
        cancelLeave={cancelLeave}
       />
    </CreatePage></SaveErrorScope>
  )
}
