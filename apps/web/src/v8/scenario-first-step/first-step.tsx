'use client'

import { firstQuestionChoiceLabelProblem } from '@/components/scenarios/question-choice-label-validation'
import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { jstDate } from '@/lib/jst-datetime';
import { formatNumber } from '@/lib/format';
import { notifySaved } from '@/components/shared/toast';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { Filter, PencilLine, Tag as TagIcon, Users } from 'lucide-react';
import { countTemplateTextCharacters, type DeliveryMode, type Scenario, type ScenarioStep, type Tag, type Template } from '@line-crm/shared';
import { api, ApiError } from '@/lib/api';
import { scenarioReferenceData } from '@/components/scenarios/scenario-reference-data';
import ImageUploader, { type ImageUploaderValue } from '@/components/shared/image-uploader';
import { STEP_MESSAGE_KINDS, type StepMessageKind } from '@/components/scenarios/message-type-tabs';
import MessageKindFields, { emptyMessageKindState, serializeMessageKind, type MessageKind, type MessageKindState } from '@/components/scenarios/message-kind-fields';
import QuestionEditor, { emptyQuestion, type ScenarioQuestion } from '@/components/scenarios/question-editor';
import { ConditionDialog } from '@/components/scenarios/scenario-dialogs';
import CarouselPicker from '@/components/scenarios/carousel-picker'
import { MessageBody } from '@/components/shared/message-insert-row'
import InsertToolbar from '@/components/scenarios/insert-toolbar'
import { LINE_TEXT_LIMIT, isOverCharLimit } from '@/components/scenarios/char-counter';
import type { SegmentCondition } from '@/components/shared/condition-builder';
import { pruneCondition } from '@/lib/segment-condition';
import { CreatePage } from '@/components/templates';
import { Steps } from '@/components/templates/steps';
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources';
import { Field } from '@/components/shared/form-controls';
import { TimeField } from '@/components/shared/date-time-field';
import SegmentedControl from '@/components/shared/segmented'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import Notice from '@/components/shared/notice'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview';
import StickerPreview from '@/components/shared/sticker-preview'
import TargetMissing from '@/components/shared/target-missing'
import ListState from '@/components/shared/list-state'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { useAccount } from '@/contexts/account-context';
import { captureScenarioWriteAccess, useScenarioWriteAccess } from '@/v8/scenarios'
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { restoreFirstStep, scheduleToPayload } from './first-step-form';
import styles from './first-step.module.css'
import { browserDraftKey } from '@/v8/autosave/public/use-browser-draft/index'
import { scenarioDraftStatus, BrowserDraftNotice, ScenarioDraftConflictNotice } from '@/v8/autosave/public/browser-draft-notice/index'
import { ScenarioDraftLoadNotice } from '@/v8/autosave/public/scenario-draft-load-notice/index'
import { scenarioDraftKey, useScenarioDraft } from '@/v8/autosave/public/use-scenario-draft/index'
import InsertTextField, { type InsertTextFieldHandle } from '@/components/shared/insert-text-field';

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import ReadOnlyNotice from '@/components/shared/read-only-notice'

export function firstStepFailureMessage(reason: unknown, phase: 'load' | 'save'): string {
  if (phase === 'load') return describeApiFailure(reason, '読み込み')
  if (!(reason instanceof ApiError) || reason.status >= 500) return '保存できませんでした。入力内容は残っています。通信状態を確認して、もう一度お試しください。'
  return `${describeApiFailure(reason, '保存')}入力内容は残っています。`
}

/*
 * ★V8 シナリオを作る②：1通目を設定（Pencil ・1152 ）。
 *
 * 型（CreatePage）に、戻る・題・手順の輪・説明・左の段（だれに送るか・1通目の内容）と、
 * 右の列（LINEでの見え方）・下の帯（キャンセル・1通目はあとで書く・作って編集へ）を渡す。
 * 1152 の板では右の列に「LINEでの見え方を見る」だけを置き、スマホは窓で開く。
 *
 * 動き（読み込み・保存・失敗時・1通目の復元）は 管理画面（app/scenarios/first-step）と同じ。
 * 1通目は飛ばせる。書かせないと進めない形にすると、あとで考えたい人が
 * 適当な本文を入れて先へ進む。
 */

const modeLabel: Record<DeliveryMode, string> = {
  absolute_time: '時刻で指定',
  elapsed: '経過時間で指定',
  relative: '経過時間で指定（旧）',
}

/** シナリオ取得の状態。確定するまで保存はできない（SCENARIO-04）。 */
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type TargetMode = 'all' | 'tag' | 'advanced'
type ContentMode = 'compose' | 'template'

const TIME_RE = /^\d{2}:\d{2}$/
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const pad2 = (n: number) => String(n).padStart(2, '0')
/** 時刻の分は30分きざみ。保存済みの半端な時刻（10:15 など）は時刻の欄が分の列に足して残す。 */
const TIME_MINUTE_STEP = 30
/** 日数の候補。保存済みの大きい日数は候補に足して残す。 */
const DAY_OPTIONS = Array.from({ length: 61 }, (_, i) => String(i))

export default function ScenarioFirstStepV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('1通目を設定')
  usePageCrumbs([{ label: 'シナリオ配信', href: '/scenarios' }])
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const narrow = useNarrowViewport()
  const access = useScenarioWriteAccess()
  const canEdit = access.allowed
  const { accounts, selectedAccountId, loading: accountLoading } = useAccount()

  const [scenario, setScenario] = useState<(Scenario & { steps: ScenarioStep[] }) | null>(null)
  const tokenNames = useInsertTokenNames(scenario?.lineAccountId ?? selectedAccountId)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  /** 失敗したあとの「再読み込み」で effect を回し直すための番号。 */
  const [reloadKey, setReloadKey] = useState(0)
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [loadMissing, setLoadMissing] = useState(false)
  /** 取得の世代番号。id が切り替わったあとの古い応答を流し込まない（SCENARIO-11）。 */
  const loadSeq = useRef(0)
  const [existingStepId, setExistingStepId] = useState<string | null>(null)
  /** 復元元の1通目。テンプレ一覧が読めていないときの内容保持に使う。 */
  const [restoredStep, setRestoredStep] = useState<ScenarioStep | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [body, setBody] = useState('')
  /** 差し込みをカーソルの位置に入れるために、入力欄そのものを持つ。 */
  const bodyRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)
  /*
   * 1通目の配信対象。Lステップの「配信対象の絞り込み」と同じ3つ。
   * どれを選んでも、保存するのは scenario_steps.target_condition_json。
   */
  const [targetMode, setTargetMode] = useState<TargetMode>('all')
  const [targetError, setTargetError] = useState('')
  const [timeError, setTimeError] = useState('')
  const [contentError, setContentError] = useState('')
  const editorRef = useRef<HTMLDivElement>(null)
  const [targetTagId, setTargetTagId] = useState('')
  const [targetCondition, setTargetCondition] = useState<SegmentCondition | null>(null)
  const [conditionOpen, setConditionOpen] = useState(false)
  const [contentMode, setContentMode] = useState<ContentMode>('compose')
  const [kind, setKind] = useState<StepMessageKind>('text')
  const [question, setQuestion] = useState<ScenarioQuestion>(() => emptyQuestion())
  const [kindState, setKindState] = useState<MessageKindState>(() => emptyMessageKindState())
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateId, setTemplateId] = useState('')
  const [image, setImage] = useState<ImageUploaderValue | null>(null)
  /** この画面で読めない保存値（Flexや壊れたJSON）。触らずに保存すると、そのまま送り返す（SCENARIO-02）。 */
  const [preserved, setPreserved] = useState<{ messageType: string; messageContent: string } | null>(null)
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null)
  // 予定。配信方式ごとに使う欄が違う（worker の validateStepSchedule）。
  const [offsetDays, setOffsetDays] = useState(0)
  const [deliveryTime, setDeliveryTime] = useState('10:00')
  const [offsetHours, setOffsetHours] = useState(0)
  /** 時間に入りきらない分。日・時間・分は分けて持ち、触っていない値を丸めない（SCENARIO-01）。 */
  const [offsetMinutesRemainder, setOffsetMinutesRemainder] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedWhileBlocked, setSavedWhileBlocked] = useState(false)
  const mounted = useRef(true)
  const scope = useRef({ id, accountId: selectedAccountId, accountLoading, loadState, loadSeq: loadSeq.current })
  if (scope.current.id !== id || scope.current.accountId !== selectedAccountId || scope.current.accountLoading !== accountLoading
    || scope.current.loadState !== loadState || scope.current.loadSeq !== loadSeq.current) {
    scope.current = { id, accountId: selectedAccountId, accountLoading, loadState, loadSeq: loadSeq.current }
  }
  const renderedScope = scope.current
  const currentScope = () => mounted.current && scope.current === renderedScope
  const editLease = captureScenarioWriteAccess()
  const canSaveNow = () => currentScope() && !accountLoading && loadState === 'ready' && Boolean(scenario) && editLease()
  const saveOperation = useRef<{ scope: typeof renderedScope } | null>(null)
  const recordedStep = useRef<{ scope: typeof renderedScope; id: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setSaving(false); setSavedWhileBlocked(false) }, [renderedScope])


  /** 別のシナリオへ切り替わったとき、前のシナリオの入力を持ち越さない。 */
  const resetForm = () => {
    setExistingStepId(null)
    setRestoredStep(null)
    setBody('')
    setContentError('')
    setTimeError('')
    setTargetError('')
    setTargetMode('all')
    setTargetTagId('')
    setTargetCondition(null)
    setConditionOpen(false)
    setContentMode('compose')
    setKind('text')
    setQuestion(emptyQuestion())
    setKindState(emptyMessageKindState())
    setTemplateId('')
    setImage(null)
    setOffsetDays(0)
    setOffsetHours(0)
    setOffsetMinutesRemainder(0)
    setDeliveryTime('10:00')
    setPreserved(null)
    setRestoreNotice(null)
  }

  useEffect(() => {
    if (!id) return
    const seq = ++loadSeq.current
    setScenario(null)
    setLoadState('loading')
    setError('')
    setLoadMissing(false)
    resetForm()
    void (async () => {
      try {
        const res = await scenarioReferenceData.scenario(id)
        if (seq !== loadSeq.current) return
        if (!res.success) {
          // 失敗の応答がキャッシュに残ると、再読み込みでも同じ失敗が返る。
          scenarioReferenceData.invalidateScenario(id)
          setError(firstStepFailureMessage(new Error(res.error), 'load'))
          setLoadState('error')
          return
        }
        setScenario(res.data)
        // 対象タグ・テンプレートの候補はこのシナリオのアカウントだけ（R23横展開）。
        const candidateAccountId = res.data.lineAccountId ?? undefined
        void scenarioReferenceData.tags(candidateAccountId).then((tagRes) => {
          if (seq !== loadSeq.current) return
          if (tagRes.success) setTags(tagRes.data)
        })
        void scenarioReferenceData.templates(candidateAccountId).then((tplRes) => {
          if (seq !== loadSeq.current) return
          if (tplRes.success) setTemplates(tplRes.data as unknown as Template[])
        })
        const first = [...res.data.steps].sort((a, b) => a.stepOrder - b.stepOrder)[0]
        if (first) {
          // 作成フローを途中で閉じて戻ったら、既存の1通目を出す。空へ戻すと保存で1通目が増える。
          const restored = restoreFirstStep(first, res.data.deliveryMode ?? 'relative')
          setExistingStepId(restored.existingStepId)
          setRestoredStep(first)
          setOffsetDays(restored.schedule.offsetDays)
          setOffsetHours(restored.schedule.offsetHours)
          setOffsetMinutesRemainder(restored.schedule.offsetMinutesRemainder)
          setDeliveryTime(restored.schedule.deliveryTime)
          setTargetMode(restored.targetMode)
          setTargetTagId(restored.targetTagId)
          setTargetCondition(restored.targetCondition)
          setContentMode(restored.contentMode)
          setKind(restored.kind)
          setBody(restored.body)
          setImage(restored.image)
          setKindState(restored.kindState)
          setTemplateId(restored.templateId)
          if (restored.question) setQuestion(restored.question)
          setPreserved(restored.preserved)
          setRestoreNotice(restored.restoreNotice)
        }
        setLoadState('ready')
      } catch (caught) {
        if (seq !== loadSeq.current) return
        const fieldFailure = saveErrors.capture(caught)
        scenarioReferenceData.invalidateScenario(id);

        if (caught instanceof ApiError && caught.status === 404) {
          { if (!fieldFailure)

          setError('') }
          setLoadMissing(true)
        } else {
          { if (!fieldFailure)
          setError('シナリオを読み込めませんでした。通信状態を確認して、もう一度お試しください。')
        }
        }
        { if (!fieldFailure)
        setLoadState('error') }
      }
    })()
  }, [id, reloadKey, saveErrors])

  const mode: DeliveryMode = scenario?.deliveryMode ?? 'absolute_time'

  /*
   * 1通目の保存は配信の行へ直に入る。書きかけはシナリオの下書きの口（本物とは別の行・
   * 配信に使わない）へ残し、開き直したときに「前の入力を戻す」を出す。比べる元は読み込み直後の形。
   */
  const formValue = {
    body, targetMode, targetTagId, targetCondition, contentMode, kind, question, kindState,
    templateId, image, offsetDays, deliveryTime, offsetHours, offsetMinutesRemainder, preserved,
  }
  const [formBaseline, setFormBaseline] = useState<typeof formValue | null>(null)
  useEffect(() => {
    if (loadState !== 'ready') {
      if (formBaseline !== null) setFormBaseline(null)
      return
    }
    if (formBaseline === null) setFormBaseline(formValue)
    // 読み込みが済んだ瞬間の形だけを採る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadState, formBaseline])
  const browserDraft = useScenarioDraft({
    accountId: scenario?.lineAccountId ?? selectedAccountId,
    draftKey: formBaseline && scenario ? scenarioDraftKey(id, 'first-step') : null,
    // 共通（アカウントなし）のシナリオは本物に紐づけられないので、キーだけで置く。
    scenarioId: scenario?.lineAccountId ? id : null,
    stepId: scenario?.lineAccountId ? existingStepId : null,
    legacyKey: scenario ? browserDraftKey(['scenario-first-step', scenario.lineAccountId, id]) : null,
    value: formValue,
    baseline: formBaseline ?? formValue,
    active: canEdit && !accountLoading,
    canSaveNow,
  })
  const restoreBrowserDraft = () => {
    const stored = browserDraft.restore()
    if (stored) applyDraft(stored)
  }
  const loadLatestDraft = () => {
    const latest = browserDraft.loadLatest()
    if (latest) applyDraft(latest)
  }
  const cancel = () => {
    if (canSaveNow()) browserDraft.clear()
    router.push('/scenarios')
  }
  function applyDraft(stored: typeof formValue) {
    setBody(stored.body)
    setTargetMode(stored.targetMode)
    setTargetTagId(stored.targetTagId)
    setTargetCondition(stored.targetCondition)
    setContentMode(stored.contentMode)
    setKind(stored.kind)
    setQuestion(stored.question)
    setKindState(stored.kindState)
    setTemplateId(stored.templateId)
    setImage(stored.image)
    setOffsetDays(stored.offsetDays)
    setDeliveryTime(stored.deliveryTime)
    setOffsetHours(stored.offsetHours)
    setOffsetMinutesRemainder(stored.offsetMinutesRemainder)
    setPreserved(stored.preserved)
  }

  /** 1通目に付ける配信対象。タグだけでも詳細条件と同じ形で持ち、書きかけの行は落として送る。 */
  const stepTargetCondition = (): SegmentCondition | null => {
    if (targetMode === 'all') return null
    if (targetMode === 'tag') {
      return targetTagId ? { operator: 'AND', rules: [{ type: 'tag_exists', value: targetTagId }] } : null
    }
    return pruneCondition(targetCondition)
  }

  const goDetail = () => router.push(`/scenarios/detail?id=${encodeURIComponent(id)}`)

  /* 本文が上限を超えているか。超えたまま保存を押せると、LINEに渡してから弾かれる。 */
  const bodyLength = countTemplateTextCharacters(body)
  const bodyOverLimit = contentMode === 'compose' && kind === 'text' && isOverCharLimit(bodyLength, LINE_TEXT_LIMIT)

  /* 内容の入力を書き換えたら「保存値をそのまま保持する」はやめる。 */
  const changeKind = (next: StepMessageKind) => { setContentError(''); setPreserved(null); setRestoreNotice(null); setKind(next) }
  const changeContentMode = (next: ContentMode) => { setContentError(''); setPreserved(null); setRestoreNotice(null); setContentMode(next) }
  const editBody = (next: string) => { setContentError(''); setPreserved(null); setBody(next) }
  const editImage = (next: ImageUploaderValue | null) => { setContentError(''); setPreserved(null); setImage(next) }
  const editQuestion = (next: ScenarioQuestion) => { setContentError(''); setPreserved(null); setQuestion(next) }
  const editKindState = (next: MessageKindState) => { setContentError(''); setPreserved(null); setKindState(next) }
  const editTemplateId = (next: string) => { setContentError(''); setPreserved(null); setTemplateId(next) }

  const submit = async () => {
    // ボタンの disabled だけに頼らない。上限超え・未取得のままの保存を通さない。
    if (!canSaveNow() || saving || bodyOverLimit || loadState !== 'ready' || !scenario || saveOperation.current?.scope === renderedScope) return
    const ticket = { scope: renderedScope }
    saveOperation.current = ticket
    setSavedWhileBlocked(false)
    setSaving(true)
    setError('')
    setTargetError('')
    setTimeError('')
    setContentError('')
    try {
      if (targetMode === 'tag' && !targetTagId) {
        setTargetError('絞り込むタグを選んでください')
        const field = document.querySelector<HTMLElement>('[aria-label="絞り込みに使うタグ"]')
        field?.focus()
        field?.scrollIntoView?.({ block: 'center' })
        return
      }
      if (targetMode === 'advanced' && !pruneCondition(targetCondition)) {
        // 条件が無いまま保存すると、画面の「未設定」と配信側の「全員」が食い違う（SCENARIO-03）。
        setTargetError('詳細条件がまだ設定されていません。「詳細条件で絞る」から条件を設定するか、「購読中の全員」を選び直してください。')
        const field = document.querySelector<HTMLElement>('input[name="targetMode"]:checked')
        field?.focus()
        field?.scrollIntoView?.({ block: 'center' })
        return
      }
      if (mode === 'absolute_time' && !TIME_RE.test(deliveryTime)) {
        setTimeError('配信する時刻を選んでください')
        const field = document.querySelector<HTMLElement>('[aria-label="配信する時刻"]')
        field?.focus()
        field?.scrollIntoView?.({ block: 'center' })
        return
      }
      const hasContent =
        preserved !== null ||
        (contentMode === 'template'
          ? templateId !== ''
          : kind === 'text'
            ? body.trim() !== ''
            : kind === 'image'
              ? image !== null
              : kind === 'question'
                ? question.text.trim() !== ''
                : kind === 'carousel'
                  ? templateId !== ''
                  : serializeMessageKind(kind as MessageKind, kindState) !== null)
      if (!hasContent) {
        // 書かずに進む道は「1通目はあとで書く」に寄せ、保存は空なら理由を出して止める（点検 #495 中7）。
        setContentError('内容を入力してください。あとで書く場合は「1通目はあとで書く」を押してください。')
        const field = editorRef.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input:not([type="file"]):not([disabled])') ?? editorRef.current?.querySelector<HTMLElement>('button:not([disabled])')
        field?.focus()
        field?.scrollIntoView?.({ block: 'center' })
        return
      }
      const labelProblem = contentMode === 'compose' && kind === 'question' ? firstQuestionChoiceLabelProblem(question) : null
      if (labelProblem) {
        setContentError('')
        const field = editorRef.current?.querySelector<HTMLElement>('input[aria-invalid="true"]')
        field?.focus()
        field?.scrollIntoView?.({ block: 'center' })
        return
      }
      const schedule = scheduleToPayload(mode, { offsetDays, offsetHours, offsetMinutesRemainder, deliveryTime })
      const picked = templates.find((t) => t.id === templateId)
      const carouselTpl = kind === 'carousel' ? picked : undefined
      const payload = preserved
        ? { messageType: preserved.messageType as ScenarioStep['messageType'], messageContent: preserved.messageContent }
        : kind === 'carousel' && contentMode === 'compose'
          ? {
              messageType: 'carousel' as const,
              // テンプレ一覧に無い・まだ読めていない選択を空で上書きしない。
              messageContent:
                carouselTpl?.messageContent ??
                (restoredStep && restoredStep.templateId === templateId ? restoredStep.messageContent : '[]'),
              templateId,
            }
          : contentMode === 'template'
            ? {
                messageType: (picked?.messageType ?? 'text') as 'text' | 'image' | 'flex',
                messageContent: picked?.messageContent ?? '',
                templateId,
              }
            : kind === 'image' && image?.mode === 'line-image'
              ? {
                  messageType: 'image' as const,
                  messageContent: JSON.stringify({
                    originalContentUrl: image.originalContentUrl,
                    previewImageUrl: image.previewImageUrl,
                  }),
                }
              : kind === 'question'
                ? { messageType: 'text' as const, messageContent: '' }
                : kind === 'text'
                  ? { messageType: 'text' as const, messageContent: body.trim() }
                  : {
                      messageType: kind as 'location' | 'video' | 'audio' | 'sticker',
                      messageContent: serializeMessageKind(kind as MessageKind, kindState) ?? '',
                    }
      const stepPayload = {
        stepOrder: 1,
        ...payload,
        ...schedule,
        targetCondition: stepTargetCondition(),
        question: contentMode === 'compose' && kind === 'question' ? question : null,
      }
      const targetStepId = recordedStep.current?.scope === renderedScope ? recordedStep.current.id : existingStepId
      const res = targetStepId
        ? await api.scenarios.updateStep(id, targetStepId, stepPayload)
        : await api.scenarios.addStep(id, stepPayload)
      if (res.success && currentScope() && res.data.id) {
        recordedStep.current = { scope: renderedScope, id: res.data.id }
        setExistingStepId(res.data.id)
      }
      if (!canSaveNow()) {
        if (res.success && currentScope()) setSavedWhileBlocked(true)
        return
      }
      if (!res.success) {
        setError(describeApiFailure(new Error(res.error), '保存'))
        return
      }
      scenarioReferenceData.invalidateScenario(id)
      browserDraft.clear()
      notifySaved('1通目を保存しました')
      goDetail()
    } catch (submitError) {
      if (!canSaveNow()) return
      const fieldFailure = saveErrors.capture(submitError)
      // 例外でも「保存中」のままにしない（SCENARIO-05）。入力は残し、同じ場所からやり直せる。
      { if (!fieldFailure)

      setError(firstStepFailureMessage(submitError, 'save')) }
    } finally {
      if (saveOperation.current === ticket) saveOperation.current = null
      if (currentScope()) setSaving(false)
    }
  }

  if (!id) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="unspecified"
        title="1通目を作るシナリオが指定されていません"
        description="一覧から、1通目を作るシナリオを選び直してください。"
        backHref="/scenarios"
        backLabel="シナリオ一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (loadState === 'error') {
    return loadMissing || !error ? (
      <TargetMissing
        kind="not-found"
        title="このシナリオは見つかりません"
        description="削除されたか、別の LINE アカウントのものです。一覧から選び直してください。"
        backHref="/scenarios"
        backLabel="シナリオ一覧へ戻る"
      />
    ) : (
      <TargetMissing
        kind="error"
        title="シナリオを読み込めませんでした"
        description="1通目の作成・保存はできません。通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => setReloadKey((k) => k + 1)}
      />
    )
  }
  /* シナリオが確定するまでフォームは出さない（SCENARIO-04）。 */
  if (loadState !== 'ready') return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="シナリオを読み込んでいます" /></SaveErrorScope>

  /*
   * ===== 届く日時の例（いつの右） =====
   * 配信側（packages/db の computeNextDeliveryAt）と同じ決まりで出す：時刻で指定は
   * 「始めた日＋N日後のその時刻。過ぎていたらすぐ」、経過時間は「始めた時刻＋日・時間・分」。
   * 例の始めた時刻は今日の 14:00 に固定する（開いた時刻で文が変わり、行の高さが揺れないように）。
   */
  // 日本の暦をUTCの欄で計算し、端末の時間帯による日付のずれを避ける。
  const exampleStart = new Date(`${jstDate()}T14:00:00Z`)
  const dayLabel = (d: Date) => `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAYS[d.getUTCDay()]}）`
  const hm = (d: Date) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  const arrivalText = (() => {
    if (mode === 'absolute_time') {
      if (!TIME_RE.test(deliveryTime)) return null
      const [h, m] = deliveryTime.split(':').map(Number)
      const target = new Date(exampleStart)
      target.setUTCDate(target.getUTCDate() + offsetDays)
      target.setUTCHours(h, m, 0, 0)
      if (target.getTime() <= exampleStart.getTime()) return `すぐ（${deliveryTime} を過ぎているため）`
      return `${offsetDays === 0 ? '同じ日の' : dayLabel(target)} ${deliveryTime}`
    }
    const minutes = offsetDays * 1440 + offsetHours * 60 + offsetMinutesRemainder
    if (minutes === 0) return 'すぐ'
    const target = new Date(exampleStart.getTime() + minutes * 60_000)
    return `${dayLabel(target)} ${hm(target)}`
  })()
  const arrivalExample = arrivalText
    ? `→ 例：${dayLabel(exampleStart)} ${hm(exampleStart)} に始めた人には、${arrivalText}`
    : '→ 時刻を選ぶと、届く日時の例が出ます'

  /* ===== 右の列：LINEでの見え方 ===== */
  const accountName = accounts.find((a) => a.id === (scenario?.lineAccountId ?? selectedAccountId))?.name ?? '公式アカウント'
  const caption = mode === 'absolute_time'
    ? `${offsetDays === 0 ? '登録した日' : `登録の${offsetDays}日後`} ${TIME_RE.test(deliveryTime) ? deliveryTime : ''}`.trim()
    : offsetDays === 0 && offsetHours === 0 && offsetMinutesRemainder === 0
      ? '登録した直後'
      : `登録の${offsetDays ? `${offsetDays}日` : ''}${offsetHours ? `${offsetHours}時間` : ''}${offsetMinutesRemainder ? `${offsetMinutesRemainder}分` : ''}後`
  const bubbleTime = mode === 'absolute_time' && TIME_RE.test(deliveryTime) ? deliveryTime : '今'
  const pickedTemplate = templates.find((t) => t.id === templateId)
  const bubble = preserved
    ? '（この画面で読めない形の保存値です。そのまま残します）'
    : contentMode === 'template' || kind === 'carousel'
      ? (pickedTemplate ? `テンプレート「${pickedTemplate.name}」` : '')
      : kind === 'text'
        ? body
        : kind === 'question'
          ? question.text
          : kind === 'image'
            ? (image ? '画像' : '')
            : STEP_MESSAGE_KINDS.find((k) => k.value === kind)?.label ?? ''
  const stickerPreview = !preserved && contentMode === 'compose' && kind === 'sticker' && kindState.sticker.packageId && kindState.sticker.stickerId
    ? <StickerPreview stickerId={kindState.sticker.stickerId} /> : null
  const phone = (
    <LinePreview
      accountName={accountName}
      caption={caption}
      empty={bubble ? false : '1通目の内容を入れると、ここに届く形が出ます'}
    >
      {bubble ? (
        <LinePreviewMessage accountName={accountName} avatar={accountName.slice(0, 1)} time={bubbleTime} bare={Boolean(stickerPreview)}>
          {stickerPreview ?? bubble}
        </LinePreviewMessage>
      ) : null}
    </LinePreview>
  )
  const preview = phone

  const tagName = tags.find((t) => t.id === targetTagId)?.name
  const conditionCount = targetCondition ? pruneCondition(targetCondition)?.rules.length ?? 0 : 0
  const targetCards: Array<{ value: TargetMode; title: string; note: string; icon: React.ReactNode }> = [
    { value: 'all', title: '購読中の全員', note: 'このシナリオを始めた人みんな', icon: <Users size={16} /> },
    { value: 'tag', title: 'タグで絞る', note: tagName ? `タグ「${tagName}」がある人` : '付いているタグで選ぶ', icon: <TagIcon size={16} /> },
    {
      value: 'advanced',
      title: '詳細条件で絞る',
      note: conditionCount > 0 ? `${formatNumber(conditionCount)} 個の条件` : '条件を組み合わせて選ぶ（未設定）',
      icon: <Filter size={16} />,
    },
  ]
  const dayOptions = DAY_OPTIONS.includes(String(offsetDays)) ? DAY_OPTIONS : [...DAY_OPTIONS, String(offsetDays)]

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId={narrow ? 'U5rxyH' : 'V6xAo'}
      title="1通目を設定"

      steps={(
        <Steps
          label="シナリオ作成の進み方" readOnly={!canEdit} summaries={{ 'シナリオ情報・配信方式': [scenario?.name, modeLabel[mode]].filter(Boolean).join('・') }}
          steps={[
            /* 済みの段を押すと、同じ下書きのシナリオ情報・配信方式（/scenarios/new?id=…）へ戻る。 */
            { label: 'シナリオ情報・配信方式', state: 'done', onSelect: id ? () => router.push(`/scenarios/new?id=${encodeURIComponent(id)}`) : undefined },
            { label: '1通目を設定', state: 'current' },
          ]}
        />
      )}
      help={`配信方式：${modeLabel[mode]}・シナリオ：${scenario?.name ?? '読み込み中'}`}
      preview={preview}
      notice={!canEdit ? <ReadOnlyNotice role="status">閲覧のみで見ています。1通目を作る操作はオーナーか管理者に頼んでください。</ReadOnlyNotice> : undefined}
      status={saving ? '保存しています' : scenarioDraftStatus(browserDraft.label) ?? undefined}
      footerActions={(
        <>
          <Button type="button" onClick={cancel}>キャンセル</Button>
          <Button type="button" onClick={goDetail} disabled={saving}>1通目はあとで書く</Button>
          {canEdit ? (
            <Button
              variant="primary"
              type="button"
              onClick={() => submit()}
              disabled={saving || bodyOverLimit}
              busy={saving}
              busyLabel="保存中…"
            >
              <PencilLine size={16} aria-hidden="true" />作って編集へ
            </Button>
          ) : null}
        </>
      )}
    >

      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {savedWhileBlocked ? <Notice tone="info">1通目は保存されています。確認状態が変わったため、続く操作を中止しました。<Link href={`/scenarios/detail?id=${encodeURIComponent(id)}`}>保存したシナリオを見る</Link></Notice> : null}
      <ScenarioDraftLoadNotice failed={browserDraft.loadFailed} onRetry={browserDraft.retryLoad} />
      <BrowserDraftNotice ago={browserDraft.pendingAgo} onRestore={restoreBrowserDraft} onDiscard={browserDraft.clear} />
      <ScenarioDraftConflictNotice ago={browserDraft.conflictAgo} onLoadLatest={loadLatestDraft} onOverwrite={browserDraft.overwrite} />

      {/*
        ここで決めるのは「この1通目を誰に送るか」。シナリオがいつ始まるか（友だち追加時など）は
        シナリオ編集と「友だち追加時の配信」で決める。2か所で同じことを聞かない。
      */}
      <Card variant="form" gap="normal" aria-label="この1通目を誰に送るか">
        <CardHeader size="stacked" title={<>この1通目を誰に送るか</>} meta={<>開始のきっかけは、このあとの編集で決めます</>} />
        <SaveErrorField names={["targetMode","value","card.value"]}><RadioCardGroup legend="この1通目を誰に送るか" className={styles.targetRow}>
          {targetCards.map((card) => (
            <RadioCard
              key={card.value}
              name="targetMode"
              value={card.value}
              checked={targetMode === card.value}
              onChange={() => { setTargetMode(card.value); setTargetError('') }}
              invalid={Boolean(targetError) && targetMode === card.value}
              /* 詳細条件のカードは押すたびに条件の窓を開く（選び済みでも開き直せる）。札の下に「N 個の条件」。 */
              onClick={card.value === 'advanced' ? () => setConditionOpen(true) : undefined}
              icon={card.icon}
              title={card.title}
              note={card.note}
              className={styles.targetCard}
            />
          ))}
        </RadioCardGroup></SaveErrorField>
        {targetError && targetMode === 'advanced' ? <p className={styles.fieldError} role="alert">{targetError}</p> : null}
        {targetMode === 'tag' ? (
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>絞り込むタグ</span>
            <SaveErrorField names={["targetTagId","target_tag_id"]}><EntitySelect kind="tag"
              value={targetTagId}
              onChange={(value) => { setTargetTagId(value); setTargetError('') }}
              error={targetError || undefined}
              aria-label="絞り込みに使うタグ"
              options={[{ value: '', label: '選んでください' }, ...tags.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: tag.name }))]}
            /></SaveErrorField>
          </div>
        ) : null}
      </Card>

      <Card variant="form" gap="normal" aria-label="1通目の内容">
        <CardHeader size="stacked" title={<>1通目の内容</>} meta={<>空のままでも進めます。テンプレートや画像は、このあとの編集でも選べます</>} />

        {/* いつ。右に届く日時の例。方式で欄が変わる（時刻で指定＝日後の時刻・経過時間＝日・時間・分）。 */}
        <div className={styles.whenRow}>
          <span className={styles.whenText}>購読開始から</span>
          <span className={styles.whenSelectDay}>
            <SaveErrorField names={["offsetDays","offset_days"]}><Select
              value={String(offsetDays)}
              onChange={(value) => setOffsetDays(Math.max(0, Number(value)))}
              aria-label="購読開始から何日後"
              width={70}
              options={dayOptions.map((d) => ({ value: d, label: d }))}
            /></SaveErrorField>
          </span>
          {mode === 'absolute_time' ? (
            <>
              <span className={styles.whenText}>日後の</span>
              <span className={styles.whenSelectTime}>
                {/* ★V8 の時刻の欄（打つ＋時と分の2列・提案 YCOoR）。絵 V6xAo・U5rxyH は幅140。 */}
                <SaveErrorField names={["deliveryTime","delivery_time"]}><TimeField
                  value={deliveryTime}
                  onChange={(value) => { setDeliveryTime(value); setTimeError('') }}
                  invalid={Boolean(timeError)}
                  aria-describedby={timeError ? 'first-step-time-error' : undefined}
                  aria-label="配信する時刻"
                  minuteStep={TIME_MINUTE_STEP}
                /></SaveErrorField>
              </span>
            </>
          ) : (
            <>
              <span className={styles.whenText}>日と</span>
              <span className={styles.whenSelectDay}>
                <SaveErrorField names={["offsetHours","offset_hours"]}><Select
                  value={String(offsetHours)}
                  onChange={(value) => setOffsetHours(Number(value))}
                  aria-label="さらに何時間後"
                  width={70}
                  options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: String(h) }))}
                /></SaveErrorField>
              </span>
              <span className={styles.whenText}>時間</span>
              <span className={styles.whenSelectDay}>
                <SaveErrorField names={["offsetMinutesRemainder","offset_minutes_remainder"]}><Select
                  value={String(offsetMinutesRemainder)}
                  onChange={(value) => setOffsetMinutesRemainder(Number(value))}
                  aria-label="さらに何分後"
                  width={70}
                  options={Array.from({ length: 60 }, (_, m) => ({ value: String(m), label: String(m) }))}
                /></SaveErrorField>
              </span>
              <span className={styles.whenText}>分後</span>
            </>
          )}
          <p className={styles.whenExample}>{arrivalExample}</p>
        </div>

        {timeError ? <p id="first-step-time-error" className={styles.fieldError} role="alert">{timeError}</p> : null}
        <div className={styles.modeRow}>
          <SaveErrorField names={["contentMode"]}><SegmentedControl
            aria-label="1通目の作り方"
            value={contentMode}
            onChange={changeContentMode}
            options={[
              { value: 'compose', label: 'この画面で作る' },
              { value: 'template', label: 'テンプレートから選ぶ' },
            ]}
          /></SaveErrorField>
        </div>

        {preserved && restoreNotice ? <Notice tone="warn" message={restoreNotice} /> : null}

        <div ref={editorRef}>
        <Field label="" spacing="section" error={(contentMode === 'compose' ? contentError : '') || (bodyOverLimit ? `本文が ${formatNumber(LINE_TEXT_LIMIT)} 字を超えています。LINEが受け付けないため、この状態では保存できません。` : undefined)} errorFrame={contentMode === 'compose' && kind !== 'text'}>
        {contentMode === 'compose' ? (
          <>
            {/* 種類。作れないもの（紹介）も並べたうえで押せなくし、理由を title に出す。 */}
            <div className={styles.kindRow} role="radiogroup" aria-label="送るものの種類">
              {STEP_MESSAGE_KINDS.map((item, index) => [
                /* 1152 の板は5つ目のあとで2段目へ折る。広い幅では消える。 */
                index === 5 ? <span key="break" className={styles.kindBreak} aria-hidden="true" /> : null,
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={kind === item.value}
                  className={styles.kindChip}
                  data-active={kind === item.value || undefined}
                  disabled={Boolean(item.disabledReason)}
                  title={item.disabledReason}
                  onClick={() => changeKind(item.value)}
                >
                  {item.label}
                </button>,
              ])}
            </div>
            {STEP_MESSAGE_KINDS.find((item) => item.value === 'intro')?.disabledReason ? (
              <Notice tone="info" message="紹介は未対応です。本文に友だち追加のURLを書いてください。" />
            ) : null}

            {kind === 'text' ? (
              <MessageBody>
                <SaveErrorField names={["body","messageContent"]}><InsertTextField tokenNames={tokenNames}
                  id="first-step-body"
                  aria-invalid={Boolean(contentError) || bodyOverLimit || undefined}
                  ref={bodyRef}
                  value={body}
                  onValueChange={(next) => editBody(next)}
                  placeholder="例：はじめまして。友だち追加ありがとうございます。"
                  aria-label="本文"
                  editorSize="message"
                /></SaveErrorField>
                <InsertToolbar targetRef={bodyRef} value={body} onChange={editBody} count={`${formatNumber(bodyLength)} / ${formatNumber(LINE_TEXT_LIMIT)}`} />
              </MessageBody>
            ) : null}
            {kind === 'image' ? (
              <div className={styles.kindBody}>
                <SaveErrorField names={["image"]}><ImageUploader mode="line-image" value={image} onChange={editImage} label="送る画像" title="送る画像を追加" /></SaveErrorField>
              </div>
            ) : null}
            {kind === 'question' ? <QuestionEditor value={question} onChange={editQuestion} /> : null}
            {kind === 'location' || kind === 'video' || kind === 'audio' || kind === 'sticker' ? (
              <MessageKindFields kind={kind} value={kindState} onChange={editKindState} mediaAccountId={scenario?.lineAccountId ?? selectedAccountId} />
            ) : null}
            {/* カルーセルはテンプレートを指す形で持つ。この画面では組み立てない。 */}
            {kind === 'carousel' ? <CarouselPicker value={templateId} onChange={editTemplateId} /> : null}
          </>
        ) : (
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>テンプレート</span>
            <div className="w-full min-w-0">
              <SaveErrorField names={["templateId"]}><EntityKindField
                kind="template"
                label="配信するテンプレート"
                options={templates}
                accountId={scenario?.lineAccountId ?? undefined}
                value={templateId}
                onChange={(value) => editTemplateId(value)}
                invalid={Boolean(contentError)}
              /></SaveErrorField>
              {contentError ? <p className={styles.fieldError} role="alert">{contentError}</p> : null}
            </div>
            <span className={styles.cardDesc}>テンプレートを直すと、この通の中身も一緒に変わります。</span>
          </div>
        )}
        </Field>
        </div>
      </Card>

      {/* 詳細条件。中身はシナリオ編集と同じ部品。 */}
      {conditionOpen ? (
        <ConditionDialog
          title="この通の配信対象"
          description="条件に合わない人には、この通だけ送りません。次の通へはそのまま進みます。"
          value={targetCondition}
          onSave={async (next) => { setTargetCondition(next) }}
          onClose={() => setConditionOpen(false)}
        />
      ) : null}

    </CreatePage></SaveErrorScope>
  )
}
