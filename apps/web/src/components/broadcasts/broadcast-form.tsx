'use client'

import { requestUnsavedAction } from '@/lib/unsaved-action'
import { BroadcastLengthNotice } from './broadcast-length-notice'

import type { BroadcastDeliveryLimit } from '@line-crm/shared'
import { jstCalendar as japanCalendar, jstDate as japanDate } from '@/lib/jst-datetime'
import { copyBroadcastDraft,copyRecentBroadcast } from './broadcast-copy-draft'
import { applyBroadcastTemplate } from './broadcast-apply-template'
import { placeBroadcastTemplate } from './broadcast-place-template'
import { broadcastAbProblem, B_DRAFT_UNAVAILABLE } from './broadcast-ab-guard'
import { broadcastAbSendProblem } from './broadcast-ab-send-guard'
import BroadcastCheckAcknowledgement from './broadcast-check-acknowledgement'
import { useBroadcastFormError } from './use-broadcast-form-error'
import { confirmBroadcastMessage } from './broadcast-confirm-action'
import { openBroadcastTest } from './broadcast-open-test'
import { saveBroadcastTemplate } from './broadcast-save-template'
import { renderBroadcastConfirmDialogs } from './broadcast-confirm-dialogs'
import { renderBroadcastEditorDialogs } from './broadcast-editor-dialogs'
import { persistBroadcastFormDraft } from './broadcast-persist-draft'
import { BubblePreview } from './broadcast-preview-model'
export { MediaUpload,mediaTooLargeMessage } from "./broadcast-form-gap-parts"
export { moveMessageTypeTabFocus,typeLabel,videoPreviewProblem } from './broadcast-form-model'
export { BubblePreview } from './broadcast-preview-model'
import { BroadcastAudienceStep } from './broadcast-audience-step'
import { BroadcastBasicStep } from './broadcast-basic-step'
import { buildBroadcastDraft,saveBroadcastDraft } from './broadcast-draft-actions'
import { MessageButtonsSection,TITLE_MAX,VALIDATION_STEP_LABEL,bubblesError,emptyBubble,formatScheduleTime,typeLabel } from './broadcast-form-model'
import { BroadcastMessageStep } from './broadcast-message-step'
import { runBroadcastPreflight } from './broadcast-preflight'
import { broadcastPreflightSummary } from './broadcast-preflight-summary'
import { BroadcastPreviewRail } from './broadcast-preview-rail'
import { BroadcastScheduleStep } from './broadcast-schedule-step'
import { saveBroadcast } from './broadcast-send-actions'
import { testBroadcast } from './broadcast-test-actions'
import { broadcastSteps,type BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'
import { broadcastNextBlockReason,broadcastSaveProblem,broadcastSaveProblemStep,broadcastStepPassed,broadcastStepProblems } from './broadcast-step-gate'
import { createLoadGeneration,filterSendableTemplates } from '@/components/scenarios/carousel-picker'
import ActionList,{ ActionAddButton } from '@/components/shared/action-list'
import Button from '@/components/shared/button'
import Disclosure from '@/components/shared/disclosure'
import { EntityPickerDialog,EntityPickerField } from '@/components/shared/entity-picker'
import { folderById,folderCreator } from '@/components/shared/folder-select'
import LinePreview from '@/components/shared/line-preview'
import { MessageComposerPage } from '@/components/shared/message-composer'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useBroadcastStepVisited } from './broadcast-step-mount'
import { SaveConflictBand,SaveConflictCompareDialog,useSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import StickyBar from '@/components/shared/sticky-bar'
import { usePageTitle } from '@/components/shell/page-chrome'
import { Steps, StepContent } from '@/components/templates/steps'
import { CreateColumns } from '@/components/templates/create-page'
import { useAccount } from '@/contexts/account-context'
import type { BroadcastApprovalCandidate } from '@/lib/api'
import { api,type ApiBroadcast,type BroadcastBubble,type BroadcastMessageAsset,type BroadcastMessageButton,type BroadcastPreflight } from '@/lib/api'
import { chatSafetyApi } from '@/lib/api/helpers/gap1'
import { audienceError,buildAudienceCondition,type TargetMode } from '@/lib/broadcast-audience'
import { newBroadcastDraftSession,type BroadcastDraftSession } from '@/lib/broadcast-draft'
import { contentTemplateToBubble,isContentTemplateType,messageButtonsError,messageTemplateToBubble,type BroadcastTemplateOption } from '@/lib/broadcast-template'
import { formatListDay,formatNumber } from '@/lib/format'
import { datetimeLocalJstToUtcIso } from '@/lib/jst-datetime'
import type { SegmentCondition } from '@/lib/segment-condition'
import { canEditFeature } from '@/lib/staff-capability'
import { useStaffRole } from '@/lib/staff-role'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useFormErrors } from '@/lib/use-form-errors'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useDraftAutosave } from '@/v8/autosave/public/use-draft-autosave/index'
import { useBroadcastAb } from '@/v8/broadcast-ab/public/use-ab/index'
import type { TemplateEditHost, TemplateHostContent } from '@/v8/template-edit/public/host/index'
import type { Folder,SendConfirmationPreview } from '@line-crm/shared'
import { AlertTriangle,ArrowRight,CheckCircle2,Eye,Save } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useCallback,useEffect,useMemo,useRef,useState } from 'react'
import { useScopedDialog } from './use-scoped-dialog'
import { broadcastSpreadMinutes, broadcastSendLabel, readBroadcastSchedule, type BroadcastSendChoice, type BroadcastSpreadStart } from './broadcast-schedule'
import type { BroadcastFormProps } from './broadcast-form-props'
import styles from './broadcast-form-v8.module.css'
import { MAX_BUBBLES,messageLengthNotice } from './message-limits'
import { type TestSendView } from './test-send-view'
import { ToggleField } from '@/components/shared/toggle'
export default function BroadcastForm({
  tags,
  tagsStatus = 'ready',
  onRetryTags,
  onSuccess,
  onDraftSaved,
  onCancel,
  openTemplatePickerInitially = false,
  initialTemplateId = null,
  initialContentTemplateId = null,
  initialCondition = null,
  audienceNotice = null,
  initialScheduledDate = '',
  initialScheduledTime = '10:00',
  currentStep = null,
  onStepChange,
  visualQaAugustCampaign = false,
}: BroadcastFormProps) {
  const saveErrors = useSaveFormErrors()
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  /*
   * テスト送信と本番予約で同じ下書きを使う。
   * 押すたびにPOSTすると、テストした回数だけ一覧へ下書きが増え、最後の予約は
   * さらに別のレコードになる。アカウントを切り替えた場合だけ新しい下書きへ分ける。
   */
  const draftSession = useRef(newBroadcastDraftSession())
  /*
   * R625/R626/R627: 保存の直列化とアカウント別の世代管理。
   * 同じアカウントの保存が重なったら後から来た方は先行を待ってから
   * 最新の入力で送り直す（初回作成の二重POSTにしない）。
   * 別アカウントの応答で今のアカウントの保存表示・版・下書きIDを
   * 書き換えない。作りかけの冪等キーはアカウントごとに1つに保つ。
   */
  const saveInFlightRef = useRef<{ accountId: string | null; promise: Promise<ApiBroadcast | null> } | null>(null)
  const draftSessionsByAccount = useRef(new Map<string | null, BroadcastDraftSession>())
  const createKeyByAccount = useRef(new Map<string | null, string>())
  const appliedInitialTemplate = useRef(false)
  // 独立審査(指摘4): テンプレート読み込みの世代照合と選択中アカウントの記録。
  const templateLoadGenerationRef = useRef(createLoadGeneration())
  const selectedAccountIdRef = useRef(selectedAccountId)
  const accountGenerationRef = useRef(0)
  if (selectedAccountIdRef.current !== selectedAccountId) accountGenerationRef.current += 1
  selectedAccountIdRef.current = selectedAccountId
  const searchParams = useSearchParams()
  const appliedDuplicateFrom = useRef(false)
  /*
   * BROADCAST-17: 保存済みの下書きを `/broadcasts/new?draft=<id>` で
   * 開き直したとき、下書きの中身をフォームへ戻す。
   * `editingDraft` が無い間は下の描画を読み込み表示へ切り替える。
   */
  const appliedDraftFrom = useRef<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<ApiBroadcast | null>(null)
  const [draftError, setDraftError] = useState('')
  const [draftReloadKey, setDraftReloadKey] = useState(0)
  const [draftReloadId, setDraftReloadId] = useState<string | null>(null)
  const saveConflict = useSaveConflict<ApiBroadcast>({
    fetchLatest: async () => {
      const accountId = selectedAccountIdRef.current
      const id = draftSession.current.draftId
      if (!id) return null
      const result = await api.broadcasts.get(id)
      return result.success && accountId === selectedAccountIdRef.current ? result.data : null
    },
    reload: () => {
      appliedDraftFrom.current = null
      setDraftReloadId(draftSession.current.draftId)
      setDraftReloadKey((key) => key + 1)
    },
  })
  useEffect(() => { saveConflict.clear(); setDraftReloadId(null) }, [selectedAccountId, saveConflict.clear])
  const [title, setTitle] = useState(visualQaAugustCampaign ? '8月キャンペーンのお知らせ' : '')
  const [internalMemo, setInternalMemo] = useState('')
  const [deliveryMethod, setDeliveryMethod] = useState<'new' | 'template' | 'duplicate'>('new')
  const [recentBroadcasts, setRecentBroadcasts] = useState<ApiBroadcast[]>([])
  const [recentState, setRecentState] = useState<'unselected' | 'loading' | 'error' | 'ready'>('unselected')
  const [recentRetry, setRecentRetry] = useState(0)
  const retryRecent = () => setRecentRetry((value) => value + 1)
  const [inlineComposer, setInlineComposer] = useState<{ index: number; kind: 'carousel' | 'rich_message' | 'rich_video' } | null>(null)
  const [composerBusy, setComposerBusy] = useState(false)
  /** 吹き出しの［テンプレートから選ぶ］で開いたときだけ何通目か。作り方の「テンプレート」から開いたときは null（末尾へ足す・WEB256）。 */
  const [composerTemplateIndex, setComposerTemplateIndex] = useState<number | null>(null)
  const [composerTemplateKind, setComposerTemplateKind] = useState<string | undefined>()
  const [templateSaveIndex, setTemplateSaveIndex] = useState<number | null>(null)
  const [templateSaveName, setTemplateSaveName] = useState('')
  const [templateSaveError, setTemplateSaveError] = useState('')
  const [templateSaveCreatedId, setTemplateSaveCreatedId] = useState<string | null>(null)
  const [templateApplyError, setTemplateApplyError] = useState('')
  const templateApplyLock = useRef(false)
  /* G1 A/B テスト（QOdsh・cM35y・a5r5Wg）。A 案はこの bubbles、B 案は ab が持つ。 */
  const ab = useBroadcastAb()
  const [bubbles, setBubbles] = useState<BroadcastBubble[]>(visualQaAugustCampaign ? [{
    id: 'visual-qa-august-campaign',
    type: 'text',
    content: { text: '{{name}}さんへ\n8月限定キャンペーンのお知らせです。\n詳しくはこちらをご確認ください。' },
  }] : [emptyBubble()])
  const [assets, setAssets] = useState<BroadcastMessageAsset[]>([])
  const [messageTemplates, setMessageTemplates] = useState<BroadcastTemplateOption[]>([])
  /*
   * PERF-06: 素材・テンプレート候補は、選択窓や素材型の吹き出しが
   * 必要になってから取る。「未取得（＝まだ読み込み中かも）」と
   * 「0件」を区別しないと、読み込み中に「まず作成してください」と
   * 誤った案内が出る。
   */
  const [templateCandidatesStatus, setTemplateCandidatesStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /**
   * テンプレート選択窓の絞り込み（IDEA-11）。
   * 「置き場」はテンプレートのフォルダで、配信そのものの置き場
   * (`folders` / kind='broadcast') とは別物なので別に持つ。
   */
  const [templateFolders, setTemplateFolders] = useState<Folder[]>([])
  /** 「よく使う」：使った回数が1回以上のテンプレートのうち多い順に5件（受信箱のテンプレートを選ぶ窓と同じ数え方）。 */
  const frequentTemplateIds = useMemo(() => new Set([...messageTemplates]
    .filter((template) => (template.usageCount ?? 0) > 0)
    .sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
    .slice(0, 5).map((template) => template.id)), [messageTemplates])
  const [showTemplatePicker, setShowTemplatePicker] = useState(openTemplatePickerInitially)
  const [targetMode, setTargetMode] = useState<TargetMode>(initialCondition ? 'advanced' : 'unselected')
  /** シナリオ購読で絞るときの相手。空なら「どれか1つでも購読している人」。 */
  const [scenarioId, setScenarioId] = useState('')
  const [scenarios, setScenarios] = useState<Array<{ id: string; name: string }>>([])
  /** PERF-06: シナリオ候補は対象者の節で「シナリオ購読中」を選んでから取る。 */
  const [scenariosStatus, setScenariosStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [tagId, setTagId] = useState('')
  const [excludeTagId, setExcludeTagId] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewToggleRef = useRef<HTMLButtonElement>(null)
  const previewCloseRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!previewOpen) return
    previewCloseRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPreviewOpen(false)
      previewToggleRef.current?.focus()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [previewOpen])
  const [previewDevice, setPreviewDevice] = useState<'phone' | 'pc'>('phone')
  const [preflightStatus, setPreflightStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** 「詳細条件」で組み立てた絞り込み。シナリオと同じ部品で作る。 */
  const [condition, setCondition] = useState<SegmentCondition | null>(initialCondition)
  const [conditionDraft, setConditionDraft] = useState<SegmentCondition | null>(initialCondition)
  const [conditionDialogOpen, setConditionDialogOpen] = useState(false)
  /*
   * 本文のURLを短くしてクリックを数えるか。
   *
   * 既定は数える。ただし短縮すると届く文面のURLが `https://.../r/xxxx` に
   * 変わるので、ドメインを見せたい配信では切れるようにしておく。
  */
  const [trackLinks, setTrackLinks] = useState(true)
  const [messageButtons, setMessageButtons] = useState<BroadcastMessageButton[]>(visualQaAugustCampaign ? [{
    label: 'キャンペーンを見る', type: 'url', value: 'https://nen.example/aug',
  }] : [])
  const [afterActionVersionId, setAfterActionVersionId] = useState(visualQaAugustCampaign ? 'cav-broadcast-delivered-tag-1' : '')
  const [publishedActions, setPublishedActions] = useState<Array<{ versionId: string; name: string; version: number }>>([])
  /** 分類。空なら未分類。 */
  const [folderId, setFolderId] = useState('')
  const [folders, setFolders] = useState<Array<{ id: string; name: string; color?: string | null }>>([])
  // フォルダを選ぶ欄からその場で作る（dLffh）。一覧の左の列の「フォルダを追加」と同じ口・同じ権限。
  const staffRoleForFolders = useStaffRole()
  const canCreateFolder = canEditFeature('broadcast.definition.edit', staffRoleForFolders)
  const createFolder = folderCreator(
    (name, color) => api.folders.create({ kind: 'broadcast', name, color, accountId: selectedAccountId }),
    folderById,
    (created) => setFolders((current) => [...current, { id: created.id, name: created.name, color: created.color }]),
  )
  /*
   * 開封数を取るか。既定は取る。
   *
   * LINE の集計ユニットはアカウントあたり**月1,000**まで。1配信＝1ユニット
   * なので、全部の配信で取ると月1,000配信で頭打ちになる。しかも上限に
   * 当たったことは送信のエラーにならず、あとから数字が出ないだけなので
   * 気づけない。取らなくてよい配信では切れるようにしておく。
   */
  const [measureOpens, setMeasureOpens] = useState(true)
  /*
   * 送る前の確認。押すまで走らせない。入力のたびに投げると、
   * 書いている途中の本文で「二重送信では」と言われ続ける。
   *
   * **条件が変わった時点で古い確認は解除する（IDEA-06）。**
   * `preflightResult` は最後に返ってきた応答、`preflightKey` はその応答を
   * 取ったときの入力の指紋（下の `preflightRequestBody` のJSON）。
   * 画面に出す・確定に使うのは、今の入力の指紋と一致する応答だけ。
   */
  const [preflightResult, setPreflightResult] = useState<BroadcastPreflight | null>(null)
  const [preflightKey, setPreflightKey] = useState<string | null>(null)
  // 古い要求の応答で新しい確認を上書きしないための通し番号。
  const preflightSeq = useRef(0)
  // 分散を選んだ時の入力。選んでいない間は配送値に0を渡す。
  const [spreadMinutes, setSpreadMinutes] = useState('30')
  const [sendChoice, setSendChoice] = useState<BroadcastSendChoice>(initialScheduledDate ? 'scheduled' : 'unselected')
  const [spreadStartMode, setSpreadStartMode] = useState<BroadcastSpreadStart>('scheduled')
  const sendMode = sendChoice === 'spread' ? spreadStartMode : sendChoice
  const effectiveSpreadMinutes = sendChoice === 'spread' ? spreadMinutes : '0'
  const [scheduledDate, setScheduledDate] = useState(initialScheduledDate)
  const [scheduledTime, setScheduledTime] = useState(initialScheduledTime)
  const [saving, setSaving] = useState(false)
  const submittingRef = useRef(false)
  /*
    最終確認（設計 `FpgxH`）。**「配信を予約する」で直に送らない。**
    ここまでは、押した瞬間に `save` が走って 1,000人以上へ予約が入り、
    何人に何をいつ送るのかを読み合わせる場所が無かった。
  */
  const { open: confirmOpen, setOpen: setConfirmOpen, scope: confirmationScope, renderedScope: renderedConfirmationScope } = useScopedDialog()
  const [acknowledgementKey, setAcknowledgementKey] = useState<string | null>(null)
  const [preflightDialogOpen, setPreflightDialogOpen] = useState(false)
  const { open: testDialogOpen, setOpen: setTestDialogOpen, scope: testScope, renderedScope: renderedTestScope } = useScopedDialog()
  const [testResultOpen, setTestResultOpen] = useState(false)
  const [testRecipients, setTestRecipients] = useState<Array<{ id: string; displayName: string; pictureUrl: string | null }>>([])
  const [testRecipientState, setTestRecipientState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [testSending, setTestSending] = useState(false)
  const [testRetryBlocked, setTestRetryBlocked] = useState(false)
  useEffect(() => { if (!testDialogOpen) setTestRetryBlocked(false) }, [testDialogOpen])
  /*
   * テスト送信の結果と実行履歴。
   *
   * **受信者の設定一覧と履歴は別物。** 登録済みの送信先を並べただけでは
   * まだ1件も送っていないので、履歴は実際に testSend を呼んで返ってきた
   * 結果だけから作る（新しい順）。
   */
  const [testResult, setTestResult] = useState<TestSendView | null>(
    visualQaAugustCampaign ? { kind: 'success', message: 'テスト送信しました（2件）' } : null,
  )
  const [testHistory, setTestHistory] = useState<TestSendView[]>([])
  const [previewConfirmed, setPreviewConfirmed] = useState(visualQaAugustCampaign)
  const { error, setError, setValidationError, resolveValidationError } = useBroadcastFormError()

  /*
   * 二者承認（m12a / 設計 A-1・A-4）。確認の窓を開いたときに境目と
   * 運用者数を読み、人数で出し分ける。人数は配信前チェックの数だけを使う。
   */
  const [approvalConfig, setApprovalConfig] = useState<{
    threshold: number
    singleOperator: boolean
  } | null>(null)
  const [approvalConfigState, setApprovalConfigState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [approvalCandidates, setApprovalCandidates] = useState<BroadcastApprovalCandidate[]>([])
  const [approvalCandidatesState, setApprovalCandidatesState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [approverId, setApproverId] = useState('')
  const [approvalNote, setApprovalNote] = useState('')
  const [approvalCountInput, setApprovalCountInput] = useState('')
  const [limitToQuota, setLimitToQuota] = useState(false)
  const [recipientLimitInput, setRecipientLimitInput] = useState('')
  const deliveryLimit: BroadcastDeliveryLimit | undefined = limitToQuota || recipientLimitInput.trim() ? { upToRemainingQuota: limitToQuota, ...(recipientLimitInput.trim() ? {maxRecipients:Number(recipientLimitInput)} : {}) } : undefined

  /* ★V8 だけ、手順を型の共通部品 Steps で題と説明の下に置く（互換経路はこれまでの帯）。
     ★V8 は板の頭に戻る（← 一斉配信一覧）を置かない（オーナー 2026-10-08）。互換経路は今までどおり。 */
  /* ★V8 は板の頭に戻る（← 一斉配信一覧）を置かない（オーナー 2026-10-08）。互換経路は今までどおり。手順は V8 だけ題と説明の下（Steps）。 */

  usePageTitle(
    preflightDialogOpen
      ? '一斉配信の配信前チェック'
      : '一斉配信を作る',
  )

  /*
   * BC-02: `?templatePicker=1` で開いたとき、選択窓はメッセージの
   * 段の中だけに出る。基本設定の段にいたままでは見出しだけ
   * 「テンプレートを選ぶ」に変わって中身が出ないので、
   * メッセージの段へも一緒に進める。
   */
  useEffect(() => {
    if (openTemplatePickerInitially) {
      setShowTemplatePicker(true)
      onStepChange?.('message')
    }
  }, [openTemplatePickerInitially]) // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * 送信済み詳細の「同じ設定で作り直す」から来たとき、元配信を種にする
   *（#605）。読むのは題名と本文だけ。口が他アカウントを404で断るので、
   * 見られない配信は引き継げない。無い・読めないときは空のままにして
   * 理由を出す（黙って空にしない）。
   */
  useEffect(() => {
    if (appliedDuplicateFrom.current) return
    const sourceId = searchParams.get('duplicateFrom')?.trim()
    if (!sourceId) return
    appliedDuplicateFrom.current = true
    const generation = accountGenerationRef.current
    const requestAccountId = selectedAccountIdRef.current
    void api.broadcasts.get(sourceId).then((res) => {
      if (selectedAccountIdRef.current !== requestAccountId || generation !== accountGenerationRef.current) return
      if (!res.success || !res.data) {
        setError('元の配信を読み込めませんでした。作り直す配信を選び直してください。')
        return
      }
      const copy = duplicateCopy(res.data)
      setTitle(copy.title)
      setLimitToQuota(res.data.messageOptions?.deliveryLimit?.upToRemainingQuota ?? false)
      setRecipientLimitInput(res.data.messageOptions?.deliveryLimit?.maxRecipients === undefined ? '' : String(res.data.messageOptions.deliveryLimit.maxRecipients))
      setBubbles(copy.bubbles)
      setDeliveryMethod('duplicate')
    }).catch(() => {
      if (generation !== accountGenerationRef.current) return
      setError('元の配信を読み込めませんでした。作り直す配信を選び直してください。')
    })
  }, [searchParams])

  /*
   * 下書きの再開（BROADCAST-17）。
   *
   * 管理画面 の作成5段は「同じ下書きIDを使う」作りなので、詳細画面の
   * 「本文を編集」から来たときは同じ下書きをここで続けられる。
   * 保存はいつもの persistDraft へ流し、下書きIDと版を draftSession へ
   * 載せるので、新しい配信が増えることはない。
   */
  useEffect(() => {
    // アカウントが確定する前に照合すると「別アカウントの下書き」と誤判定する。
    if (accountLoading) return
    const draftId = searchParams.get('draft')?.trim() || draftReloadId
    if (!draftId) return
    const restoreKey = `${draftId}:${selectedAccountId}`
    if (appliedDraftFrom.current === restoreKey) return
    appliedDraftFrom.current = restoreKey
    setDraftError('')
    const generation = accountGenerationRef.current
    const requestAccountId = selectedAccountIdRef.current
    void api.broadcasts.get(draftId).then((res) => {
      if (selectedAccountIdRef.current !== requestAccountId || generation !== accountGenerationRef.current) return
      if (!res.success || !res.data) {
        setDraftError('下書きを読み込めませんでした。一覧から開き直してください。')
        return
      }
      const draft = res.data
      if (draft.status !== 'draft' && draft.status !== 'scheduled') {
        setDraftError('この配信はすでに送信が始まっているため、ここでは編集できません。')
        return
      }
      /*
       * 複数アカウントの重複排除配信は、この画面では対象を組み立てられない。
       * そのまま保存すると優先順位やアカウント指定が消えるので、ここでは開かない。
       */
      if (draft.targetType === 'multi-account-dedup') {
        setDraftError('複数アカウントへ配る配信は、この画面では編集できません。')
        return
      }
      /*
       * 別アカウントの下書きを、いま選んでいるアカウントへ付け替えない。
       * そのまま保存すると宛先の人数が別アカウント基準で数えられ、
       * 配信元も静かに変わってしまう。
       */
      if (draft.lineAccountId && selectedAccountId && draft.lineAccountId !== selectedAccountId) {
        setDraftError('この下書きは別のLINEアカウントで作られています。アカウントを切り替えて開き直してください。')
        return
      }
      setTitle(draft.title)
      setInternalMemo(draft.internalMemo ?? '')
      setTrackLinks(draft.trackLinks)
      setMessageButtons(draft.messageOptions?.buttons ?? [])
      setLimitToQuota(draft.messageOptions?.deliveryLimit?.upToRemainingQuota ?? false)
      setRecipientLimitInput(draft.messageOptions?.deliveryLimit?.maxRecipients === undefined ? '' : String(draft.messageOptions.deliveryLimit.maxRecipients))
      setAfterActionVersionId(draft.afterActionVersionId ?? '')
      setFolderId(draft.folderId ?? '')
      setMeasureOpens(draft.measureOpens ?? true)
      const schedule = readBroadcastSchedule(draft)
      setSendChoice(schedule.sendChoice)
      setSpreadStartMode(schedule.spreadStart)
      setSpreadMinutes(schedule.spreadMinutes)
      // 吹き出し。形が読めないときだけ、従来の平文本文から1枚作る。
      const savedBubbles = draft.messageBubbles?.filter((bubble): bubble is BroadcastBubble => (
        Boolean(bubble)
        && typeof bubble === 'object'
        && typeof bubble.id === 'string'
        && typeof bubble.type === 'string'
        && Boolean(bubble.content)
      ))
      setBubbles(savedBubbles?.length
        ? savedBubbles
        : [{ id: crypto.randomUUID(), type: draft.messageType, content: { text: draft.messageContent } }])

      /*
       * 宛先の条件。保存時に画面が足す is_following（ブロック中を除く基礎条件）は
       * 外して戻す——残すと条件ビルダーに自分が書いていない行が出て、
       * 保存のたびに重複していく。
       */
      const stored = draft.segmentConditions ?? null
      const userCondition: SegmentCondition | null = stored
        ? { ...stored, rules: (stored.rules ?? []).filter((rule) => rule.type !== 'is_following') }
        : null
      if (draft.targetType === 'tag' && !draft.targetTagId && draft.draftPayload?.draftTargetMode === 'unselected') {
        // 相手をまだ選んでいない下書き。全員へ置き換えない。
        setTargetMode('unselected')
      } else if (draft.targetType === 'tag') {
        setTargetMode('tag')
        setTagId(draft.targetTagId ?? '')
      } else if (draft.targetType === 'all') {
        setTargetMode(draft.status === 'draft' && draft.draftPayload?.draftTargetMode !== 'all' ? 'unselected' : 'all')
      } else {
        const rules = userCondition?.rules ?? []
        const groups = userCondition?.groups ?? []
        // 「シナリオ購読中の全員」で保存された条件は、その選び方へ戻す。
        if (stored && rules.length === 0 && groups.length === 0) {
          setTargetMode(draft.status === 'draft' && draft.draftPayload?.draftTargetMode !== 'all' ? 'unselected' : 'all')
        } else if (rules.length === 1 && rules[0]?.type === 'scenario_subscribed' && groups.length === 0) {
          setTargetMode('scenario')
          setScenarioId(String(rules[0].value ?? ''))
        } else {
          setTargetMode('advanced')
          setCondition(userCondition)
          setConditionDraft(userCondition)
        }
      }

      // 予約日時。保存値はUTC、入力は一覧と同じ日本時間（EVENT-05と同じ決めごと）。
      if (draft.scheduledAt) {
        const jst = japanCalendar(new Date(draft.scheduledAt))
        setScheduledDate(japanDate(new Date(draft.scheduledAt)))
        setScheduledTime(jst.toISOString().slice(11, 16))
      }
      if (schedule.scheduledDate !== null) setScheduledDate(schedule.scheduledDate)
      if (schedule.scheduledTime !== null) setScheduledTime(schedule.scheduledTime)

      /*
       * このIDを更新として保存するため、下書きIDと版をセッションへ載せる。
       * 載せないと persistDraft が新規作成へ流れ、下書きがもう1件増える。
       */
      draftSession.current = {
        accountId: draft.lineAccountId ?? selectedAccountId ?? null,
        draftId: draft.id,
        version: draft.version ?? 1,
        createKey: draftSession.current.createKey,
      }
      draftSessionsByAccount.current.set(draftSession.current.accountId, draftSession.current)
      setEditingDraft(draft)
      saveConflict.clear()
      // 読み込んだ下書きの形を「保存ずみ」の基準にし直す（★管理画面 §5 未保存判定）。
      cleanFingerprintRef.current = null
    }).catch(() => {
      if (generation !== accountGenerationRef.current) return
      setDraftError('下書きを読み込めませんでした。一覧から開き直してください。')
    })
  }, [searchParams, accountLoading, selectedAccountId, draftReloadKey, draftReloadId])


  useEffect(() => {
    api.folders.list('broadcast')
      .then((res) => { if (res.success) setFolders(res.data.map((f) => ({ id: f.id, name: f.name, color: f.color }))) })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    // PERF-06: 複製候補は画面に出る3件ぶんだけAPIへ頼む。
    // 以前は一覧を全件取って先頭3件に絞っていた。
    let cancelled = false
    setRecentBroadcasts([])
    if (accountLoading || !selectedAccountId) { setRecentState('unselected'); return }
    setRecentState('loading')
    api.broadcasts.list({ accountId: selectedAccountId || undefined, limit: 3 })
      .then((res) => {
        if (cancelled) return
        if (!res.success) throw new Error('recent_broadcasts_failed')
        setRecentBroadcasts(res.data.slice(0, 3))
        setRecentState('ready')
      })
      .catch(() => { if (!cancelled) setRecentState('error') })
    return () => { cancelled = true }
  }, [selectedAccountId, accountLoading, recentRetry])

  /*
   * 「シナリオ購読中の全員」で選ぶ相手。名前だけ使う。
   * PERF-06: 対象者の節が見え、かつシナリオ選択になったときだけ取る。
   * ステップ形式では対象者ステップへ進むまで、埋め込み形式では
   * 節が常に見えているので従来どおり取る。
   * アカウントごとに一度取ったら、選択肢の開閉では取り直さない。
   */
  const audienceSectionVisible = currentStep == null || currentStep === 'audience'
  const needsScenarioCandidates = audienceSectionVisible && targetMode === 'scenario'
  const scenariosLoadedForRef = useRef<string | null>(null)
  useEffect(() => {
    // アカウントが変わったら前のアカウントの候補を見せない。
    setScenarios([])
    setScenariosStatus('idle')
  }, [selectedAccountId])
  useEffect(() => {
    if (!selectedAccountId || !needsScenarioCandidates) return
    if (scenariosLoadedForRef.current === selectedAccountId) return
    const accountId = selectedAccountId
    let cancelled = false
    setScenariosStatus('loading')
    api.scenarios.list({ accountId, limit: 200 })
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setScenarios(res.data.map((item) => ({ id: item.id, name: item.name })))
          setScenariosStatus('ready')
          scenariosLoadedForRef.current = accountId
        } else {
          setScenariosStatus('error')
        }
      })
      .catch(() => { if (!cancelled) setScenariosStatus('error') })
    return () => { cancelled = true }
  }, [selectedAccountId, needsScenarioCandidates])

  /*
   * PERF-06: 素材・テンプレートの候補は、必要になってから取る。
   * 必要になるのは、テンプレート選択窓を開いた・素材型の吹き出しが
   * ある・初期テンプレート指定で来た、のどれか。基本設定だけを
   * 進める利用では1回も呼ばれない。
   */
  const needsTemplateCandidates = showTemplatePicker
    || Boolean(initialTemplateId || initialContentTemplateId)
    || bubbles.some((bubble) => isContentTemplateType(bubble.type))
  useEffect(() => {
    // 独立審査(指摘4): アカウント切替で古い応答が混ざらないよう世代で照合する。
    const requestAccountId = selectedAccountId || undefined
    // 独立審査(指摘4): 新しい応答が来るまで旧アカウントの候補を見せない。
    setMessageTemplates([])
    setAssets([])
    if (!needsTemplateCandidates) {
      setTemplateCandidatesStatus('idle')
      return
    }
    setTemplateCandidatesStatus('loading')
    const requestGeneration = templateLoadGenerationRef.current.next()
    const isCurrent = () =>
      templateLoadGenerationRef.current.isCurrent(requestGeneration)
      && (selectedAccountIdRef.current ?? undefined) === requestAccountId
    Promise.all([
      api.broadcastMessageAssets.list({ accountId: requestAccountId }),
      // #645 差し戻し: 選んでいるアカウントを必ず渡す。口の主文は公開版だけが返り、
      // 未公開・他アカウントは候補にしない。初回引用の検索も同じ候補から行う。
      api.templates.list(undefined, requestAccountId),
      // テンプレートの置き場（kind='template'）。配信の置き場とは別系統。
      api.folders.list('template', requestAccountId),
    ]).then(([assetResult, templateResult, folderResult]) => {
      if (!isCurrent()) return
      if (assetResult.success) setAssets(assetResult.data)
      if (folderResult.success) setTemplateFolders(folderResult.data)
      // 候補自体がなくても「0件」として完了扱い。失敗は別の札にする。
      setTemplateCandidatesStatus(
        assetResult.success && templateResult.success && folderResult.success ? 'ready' : 'error',
      )
      const sendable = templateResult.success
        ? filterSendableTemplates(templateResult.data, requestAccountId)
        : []
      if (templateResult.success) {
        setMessageTemplates(sendable
          .filter((template) => ['text', 'image', 'video', 'audio', 'sticker', 'location', 'carousel', 'flex', 'imagemap'].includes(template.messageType))
          .map((template) => ({
            id: template.id,
            name: template.name,
            category: template.category,
            messageType: template.messageType,
            messageContent: template.messageContent,
            folderId: template.folderId,
            usageCount: template.usageCount,
            updatedAt: template.updatedAt,
            accountId: template.accountId,
          })))
      }
      if (!appliedInitialTemplate.current) {
        const template = templateResult.success
          ? sendable.find((item) => item.id === initialTemplateId)
          : undefined
        const contentTemplate = assetResult.success
          ? assetResult.data.find((item) => item.id === initialContentTemplateId)
          : undefined
        const bubble = template
          ? messageTemplateToBubble(template)
          : contentTemplate
            ? contentTemplateToBubble(contentTemplate)
            : null
        if (bubble) {
          placeTemplateBubble(bubble)
          setTitle(template?.name ?? contentTemplate?.name ?? '')
          setShowTemplatePicker(false)
        }
        appliedInitialTemplate.current = true
      }
    }).catch(() => {
      if (isCurrent()) setTemplateCandidatesStatus('error')
    })
  }, [initialContentTemplateId, initialTemplateId, needsTemplateCandidates, selectedAccountId])

  // 独立審査(指摘4): アカウント切替で旧候補・選択・吹き出しを残さない。
  // 持ち主の分かる吹き出しだけ落とし、手書き・素材は保つ。
  useEffect(() => {
    setExcludeTagId('')
    setBubbles((items) => items.filter((bubble) => {
      const owner = bubble.content.templateAccountId
      return owner == null || owner === selectedAccountId
    }))
  }, [selectedAccountId])
  useEffect(() => {
    let cancelled = false
    setPublishedActions([])
    setAfterActionVersionId('')
    if (!selectedAccountId) {
      setPublishedActions([])
      setAfterActionVersionId('')
      return
    }
    api.commonActions.resources(selectedAccountId)
      .then((result) => {
        if (cancelled || !result.success) return
        setPublishedActions((result.data.commonActions ?? []).flatMap((action) => (
          action.currentPublishedVersionId
            ? [{ versionId: action.currentPublishedVersionId, name: action.name, version: action.version }]
            : []
        )))
      })
      .catch(() => { if (!cancelled) setPublishedActions([]) })
    return () => { cancelled = true }
  }, [selectedAccountId])
  /*
   * 送る相手を、そのまま送信に使える条件の形で組み立てる。
   *
   * 人数を数えるのと実際に送るのとで別々に組み立てていた頃は、詳細条件で
   * 絞った人数が出るのに、送信は全員へ行っていた（条件が送信側に渡って
   * いなかった）。1か所で作って両方に渡す。
   */
  const audience = useMemo(
    () => {
      if (targetMode === 'unselected') return null
      const next = buildAudienceCondition(targetMode, { scenarioId, tagId, condition })
      if (excludeTagId) return { operator: 'AND' as const, rules: [{ type: 'tag_not_exists', value: excludeTagId }], groups: [next] }
      return next
    },
    [condition, scenarioId, tagId, targetMode, excludeTagId],
  )

  /**
   * 作成・テスト送信・事前確認に渡す宛先。
   *
   * タグ1つだけの絞り込みは、前からある targetType='tag' をそのまま使う。
   * 送信の経路が別（キューに載せずにその場で送る）で、少人数のときに速い。
   */
  const targetPayload = useCallback(() => {
    if (!audience) return { targetType: 'tag' as const, targetTagId: '', segmentConditions: undefined }
    if (targetMode === 'tag' && tagId && !excludeTagId) {
      return { targetType: 'tag' as const, targetTagId: tagId, segmentConditions: undefined }
    }
    return {
      targetType: 'segment' as const,
      targetTagId: null,
      segmentConditions: audience,
    }
  }, [audience, tagId, targetMode, excludeTagId])
  /*
   * 宛先か本文が変わったら、少し待ってから自動で確かめる。
   *
   * 打つたびに走らせると、1文字ごとに問い合わせが飛ぶ。打ち終わってから
   * 1回で足りるので、手が止まって 600ms 経ってから走らせる。
   */
  useEffect(() => {
    // 本文が空のうちは走らせない。何も書いていない状態で「文字数が足りません」
    // と出しても、直しようがない。
    if (
      audienceError(targetMode, { scenarioId, tagId, condition })
      || bubblesError(bubbles)
    ) {
      setPreflightResult(null)
      setPreflightKey(null)
      setPreflightStatus('idle')
      preflightSeq.current += 1
      return
    }
    setPreflightStatus('loading')
    const timer = setTimeout(() => void runPreflight(true), 600)
    return () => clearTimeout(timer)
    // runPreflight は毎回作り直されるので依存に入れない。見たいのは中身の変化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bubbles, tagId, excludeTagId, condition, scenarioId, targetMode, selectedAccountId, scheduledDate, scheduledTime, sendMode, effectiveSpreadMinutes, limitToQuota, recipientLimitInput])

  /*
   * BC-01: 型を切り替えると `emptyBubble` で中身が空になるが、
   * 書きかけの本文を黙って捨てない。型ごとの中身を吹き出し単位で
   * 一時保管し、切り替えて戻したときに同じ内容を復元する。
   * 保存するのは画面を開いている間だけ（下書きへの永続化はしない）。
   */
  const bubbleContentStash = useRef(new Map<string, Map<string, Record<string, unknown>>>())
  /*
   * 対象は吹き出しの id で決める（並べ替え・削除の途中でも別の吹き出しを書き換えない）。
   * 共通の作成部品は何通目かで渡すので、呼んだ時点の並びで id に直してから更新する。
   */
  const updateBubble = (target: number | string, bubble: BroadcastBubble, restoreKind = true) => {
    const targetId = typeof target === 'number' ? bubbles[target]?.id : target
    if (!targetId) return
    setBubbles((items) => items.map((item) => {
    if (item.id !== targetId) return item
    if (item.type !== bubble.type) {
      const stash = bubbleContentStash.current.get(item.id) ?? new Map<string, Record<string, unknown>>()
      stash.set(item.type, item.content)
      bubbleContentStash.current.set(item.id, stash)
      const restored = stash.get(bubble.type)
      return { ...bubble, id: item.id, content: (restoreKind ? restored : undefined) ?? bubble.content }
    }
    return { ...bubble, id: item.id }
  }))
  }
  const placeTemplateBubble = (bubble: BroadcastBubble) => placeBroadcastTemplate(bubble, { index: composerTemplateIndex, bubbles, setBubbles, updateBubble, setError })
  const moveBubble = (index: number, direction: -1 | 1) => setBubbles((items) => { const next = [...items]; const [item] = next.splice(index, 1); next.splice(index + direction, 0, item); return next })
  const applyTemplate = (template: BroadcastTemplateOption) => applyBroadcastTemplate({ placeTemplateBubble, saveErrors, selectedAccountId, selectedAccountIdRef, setComposerBusy, setShowTemplatePicker, setTemplateApplyError, templateApplyLock }, template)

  /*
   * 複製で引き継ぐのは題名と本文だけ。宛先・予約日時・配信元アカウントは
   * 引き継がない（送る前に選ばせる）。秘密値を持たない配信設定なので、
   * ここに来るのは本文だけでよい（#605）。
   */
  const duplicateCopy = (broadcast: ApiBroadcast) => copyBroadcastDraft(broadcast)
  const duplicateRecent = (broadcast: ApiBroadcast) => copyRecentBroadcast({ duplicateCopy, setBubbles, setDeliveryMethod, setTitle, setLimitToQuota, setRecipientLimitInput }, broadcast)

  const openConditionDialog = () => {
    setTargetMode('advanced')
    setConditionDraft(condition)
    setConditionDialogOpen(true)
  }
  /*
   * 保存・確認・テストで落ちた吹き出し。帯ではなく吹き出しの中身の下に理由を出し、
   * 吹き出しの頭に赤い丸、メッセージの段を開いて1つ目の吹き出しへ移る。ボタンは「ほかの設定」を開いて移る。
   * 配信名・対象者は段の帯（［〇〇へ移動］）のまま。
   */
  const fields = useFormErrors()
  const buttonsRef = useRef<HTMLDetailsElement>(null)
  const revealMessage = () => { if (currentStep && currentStep !== 'message') goToStep('message') }
  bubbles.forEach((bubble, index) => {
    fields.define(`bubble-${index}`, `${index + 1}通目`, () => {
      const problem = bubblesError([bubble])
      return problem ? problem.replace(/^吹き出し1(の|：)?/, '') : null
    }, { reveal: revealMessage, group: `bubble-${index}` })
  })
  fields.define('buttons', 'ボタン', () => messageButtonsError(messageButtons, { hasLiff: Boolean(selectedAccount?.liffId) }) || null, {
    reveal: () => { revealMessage(); if (buttonsRef.current) buttonsRef.current.open = true },
  })
  /** 検査で落ちたとき。メッセージの段の不備は欄で知らせて移り、ほかの段は帯（［〇〇へ移動］つき）。 */
  const rejectValidation = (validationError: string) => {
    if (validationStep() === 'message' && fields.submit().length > 0) { setError(''); return }
    if (validationError === validate()) setValidationError(validationError)
    else setError(validationError)
  }

  /*
   * 段ごとの確かめ。帯の ✓・［次へ］・保存の検査は、どれもこの1つの結果を読む。
   * 送信枠は配信前チェックの結果を使うので、下で数えてから組み立てる（stepProblems）。
   */
  const stepCheckInput = () => ({
    title,
    titleMax: TITLE_MAX,
    audienceProblem: audienceError(targetMode, { scenarioId, tagId, condition }),
    audienceUnselected: targetMode === 'unselected',
    bubbleProblem: broadcastAbProblem(bubbles, ab.b, ab.enabled, targetMode === 'all') || bubblesError(bubbles),
    // 監査 R206: ボタンの不備は「保存できませんでした」で済ませない。
    buttonProblem: messageButtonsError(messageButtons, { hasLiff: Boolean(selectedAccount?.liffId) }),
    sendMode,
    spreadSelected: sendChoice === 'spread',
    spreadMinutes: effectiveSpreadMinutes,
    scheduledDate,
    scheduledTime,
    scheduledAt: scheduledAtIso(),
    stepped: Boolean(currentStep),
  })
  const validate = () => recipientLimitInput.trim() && (!Number.isSafeInteger(Number(recipientLimitInput)) || Number(recipientLimitInput)<1) ? '上限人数は1以上の整数を入れてください。' : deliveryLimit && ab.enabled ? '人数の上限とA/Bは併用できません。A/Bをオフにしてください。' : broadcastSaveProblem(stepProblems())
  /**
   * R580: いまの入力に対する検査結果が、どの段の不備か。
   * `validate` と同じ結果から読む。送信設定の段は移動の導線を出さない（今のまま）。
   */
  const validationStep = (): 'basic' | 'audience' | 'message' | null => {
    const step = broadcastSaveProblemStep(stepProblems())
    return step === 'schedule' ? null : step
  }
  /**
   * 配信前チェックへ渡す入力。
   *
   * 人数を数える口と同じ組み立てを1か所にする。この中身の指紋（JSON）を
   * 応答と一緒に残すので、宛先・本文・日時が変わったあとに古い確認を
   * そのまま使い回さない（IDEA-06「条件変更で古い確認が解除される」）。
   */
  const preflightRequestBody = () => {
    const first = bubbles[0]
    const content = first?.type === 'text' ? String(first.content.text ?? '') : ''
    const target = targetPayload()
    return {
      targetType: target.targetType,
      targetTagId: target.targetTagId,
      // 条件を渡さないと、絞り込みを無視した人数（＝全員）が返る。
      segmentConditions: target.segmentConditions ?? null,
      lineAccountId: selectedAccountId || null,
      messageContent: content,
      scheduledAt: scheduledAtIso(),
      messageCount: bubbles.length,
      deliveryLimit,
      stealthSpreadMinutes: broadcastSpreadMinutes(effectiveSpreadMinutes),
    }
  }

  /**
   * 配信前チェック。
   *
   * 宛先と本文が決まっていれば、押されなくても勝手に確かめる。押して初めて
   * 出る作りだと、押さないまま送れてしまう。設計でも右側に出しっぱなしで、
   * 送る前に「全部緑か」を見るものになっている。
   *
   * @param silent 自動で走るとき。確認中の表示もエラーも出さない。打っている
   *   最中に「確認中…」が点いたり、書きかけを直せと言われたりすると邪魔になる。
   */
  const runPreflight = async (silent = false) => {
    const problem = audienceError(targetMode, { scenarioId, tagId, condition })
    if (problem) { if (!silent) setError(problem); return }
    await runBroadcastPreflight({ preflightRequestBody, preflightSeq, saveErrors, setError, setPreflightKey, setPreflightResult, setPreflightStatus }, silent)
  }

  /*
   * 文字数は**いちばん長い通**と**合計**の両方を見る。
   * 1つ目だけを見ていたころは、2通目に長い本文を書いても
   * 「分割なし」と出たままだった。
   */
  const bubbleLengths = bubbles.map((b) => (b.type === 'text' ? String(b.content.text ?? '').length : 0))
  const textLength = Math.max(0, ...bubbleLengths)
  const totalTextLength = bubbleLengths.reduce((sum, n) => sum + n, 0)
  const lengthNotice = messageLengthNotice({
    longest: textLength,
    total: totalTextLength,
    bubbles: bubbles.length,
  })
  // 本文に入っているURLの数。trackLinks: true で送るので、この数だけ
  // 短縮されてクリックが記録される。
  const urlCount = bubbles.reduce((sum, b) => {
    if (b.type !== 'text') return sum
    return sum + (String(b.content.text ?? '').match(/https?:\/\/\S+/g)?.length ?? 0)
  }, 0)

  /** 予約の日時。JST で入れてもらい、UTC に直して送る。 */
  const scheduledAtIso = (): string | null => {
    if (sendMode !== 'scheduled' || !scheduledDate) return null
    return datetimeLocalJstToUtcIso(`${scheduledDate}T${scheduledTime}`)
  }

  /*
    最終確認に並べる値。**どれも固定値で作らない。**

    人数は `runPreflight` が数えたものだけを使う（`preflight.audienceCount`）。
    数えられていないときは `null` のままにして、下の `canConfirm` で
    送らせない。「たぶんこのくらい」を書くと、その数を根拠に押される。
  */
  /*
   * **いまの入力に対する確認だけを確定値として使う。**
   * 宛先・本文・日時を変えると指紋がずれ、前の応答は古い確認として解除される。
   * 再計算が終わるまで「—」のままにし、古い人数のまま予約させない（IDEA-06）。
   */
  const currentPreflightKey = JSON.stringify(preflightRequestBody())
  const preflight = preflightResult !== null && preflightKey === currentPreflightKey ? preflightResult : null
  const {
    audienceCount, audienceDisplayCount, confirmAudienceLabel, exclusionNote,
    quota, quotaInsufficient, quotaNote, evaluatedAtLabel, concurrentBroadcasts,
    scheduledLabel, sendWhenLabel,
  } = broadcastPreflightSummary({
    preflight, targetMode, tags, tagId, scenarios, scenariosStatus, audience,
    excludeTagId, sendMode, scheduledDate, scheduledTime, spreadMinutes: effectiveSpreadMinutes,
  })
  const stepProblems = () => broadcastStepProblems({
    ...stepCheckInput(),
    lengthProblem: lengthNotice.tone === 'error' ? lengthNotice.description : null,
    now: Date.now(),
    quotaInsufficient,
  })
  const liveStepProblems = stepProblems()
  const sendInputProblem = useRef<string | null>(null)
  sendInputProblem.current = liveStepProblems.audience?.message ?? liveStepProblems.schedule?.message ?? null

  const draftPayload = (scheduledAt: string | null, saveAsDraft = false, confirmedCount?: number) => buildBroadcastDraft({ afterActionVersionId, bubbles, currentStep, folderId, internalMemo, measureOpens, messageButtons, deliveryLimit, selectedAccountId, sendChoice, spreadStartMode, spreadMinutes: effectiveSpreadMinutes, scheduledDate, scheduledTime, targetMode, targetPayload, title, trackLinks }, scheduledAt, saveAsDraft, confirmedCount)

  /**
   * テスト後の修正も同じ下書きへ上書きし、予約時に別レコードを作らない。
   * #772: 更新は保持している版をその場で付けて送り、成功応答の版へ進める。
   * 版を閉じ込めた古い関数は作らない。409時は送り直さず、最新版を読み直して案内する。
   */
  const persistDraft = (scheduledAt: string | null, saveAsDraft = false, confirmedCount?: number, autosaveStep?: typeof currentStep) => persistBroadcastFormDraft({ createKeyByAccount, currentStep, draftPayload, draftSession, draftSessionsByAccount, editingDraft, saveConflict, saveErrors, saveInFlightRef, selectedAccountIdRef, setError }, scheduledAt, saveAsDraft, confirmedCount, autosaveStep)

  /*
   * ★管理画面 sTJsh §5: 書きかけを守る。
   * 保存に送るのと同じ組み立て（draftPayload）を指紋にして、
   * 「最後に保存した形」と違う間だけ未保存とする。開いた直後や
   * 下書き読み込み直後は指紋が基準になるので、何もしていないのに
   * 確認が出ることはない。lineAccountId は共通バーの選択が遅れて
   * 届くと誤って未保存に見えるので指紋から外す（別アカウントへの
   * 誤保存は persistDraft が別の口で止めている）。
   */
  const formFingerprint = JSON.stringify(
    draftPayload(scheduledAtIso()),
    (key, value) => (key === 'lineAccountId' ? undefined : value),
  )
  const cleanFingerprintRef = useRef<string | null>(null)
  // 最初の描画と、下書き適用で内容が入れ替わった直後に「保存ずみの形」を採る。
  useEffect(() => {
    if (cleanFingerprintRef.current === null) cleanFingerprintRef.current = formFingerprint
  })
  const draftDirty = cleanFingerprintRef.current !== null && formFingerprint !== cleanFingerprintRef.current
  const dirty = draftDirty || ab.b !== null
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving, subject: '配信の変更' })
  const queuedAutosave = useRef({ fingerprint: formFingerprint, step: currentStep })
  if (queuedAutosave.current.fingerprint !== formFingerprint) queuedAutosave.current = { fingerprint: formFingerprint, step: currentStep }
  const draftAutosave = useDraftAutosave({
    fingerprint: `${selectedAccountId}:${formFingerprint}`,
    dirty: draftDirty,
    enabled: Boolean(selectedAccountId) && ab.b === null && !saveConflict.conflict && !validate(),
    paused: saving || testSending || leaveTarget !== null,
    save: async () => {
      if (!selectedAccountId || validate()) return false
      const account = selectedAccountIdRef.current || null
      const fingerprint = formFingerprint
      const saved = await persistDraft(scheduledAtIso(), true, undefined, queuedAutosave.current.step)
      if (!saved || (selectedAccountIdRef.current || null) !== account) return false
      cleanFingerprintRef.current = fingerprint
      onDraftSaved?.(saved)
      return true
    },
  })
  const draftStatusLabel = ab.b !== null ? 'B案は下書きに保存できません' : draftAutosave.label

  const saveDraftNow = () => ab.b !== null ? (setError(broadcastAbProblem(bubbles, ab.b, ab.enabled, targetMode === 'all') || B_DRAFT_UNAVAILABLE), Promise.resolve(false)) : saveBroadcastDraft({ cleanFingerprintRef, draftAutosave, formFingerprint, onDraftSaved, persistDraft, rejectValidation, saveErrors, scheduledAtIso, selectedAccountIdRef, setError, setSaving, validate })

  /**
   * テスト送信。下書きを作って、そこから自分宛に送る。
   *
   * 最初だけ下書きを作り、2回目以降と本番予約は同じ行を更新する。
   * 確かめた内容と本番で送る内容を同じ実体にし、テスト回数ぶん下書きを増やさない。
   */
  const testScopeCurrent = () => renderedTestScope !== null && renderedTestScope === testScope.current && renderedTestScope.generation === accountGenerationRef.current
  const handleTestSend = () => testScopeCurrent() ? testBroadcast({ isCurrent: testScopeCurrent, onDraftSaved, persistDraft, rejectValidation, saveErrors, setError, setTestHistory, setTestResult, setTestSending, setTestRetryBlocked, validate }) : Promise.resolve()

  /**
   * テスト送信の前に、実際に登録されている送信先を読み合わせる。
   * 送信先を固定名で描くと、別アカウントでもその人へ届くように誤解される。
   */
  const testRecipientsGeneration = useRef(0)
  useEffect(() => { testRecipientsGeneration.current += 1; setTestDialogOpen(false); setTestResultOpen(false); setTestRecipients([]) }, [selectedAccountId])
  const afterActionChoices = [{ id: 'common_action', label: '共通アクションを実行する', make: () => '', picker: {
    title: '公開済みの共通アクションを選ぶ', items: publishedActions.map(action => ({ id: action.versionId, name: action.name, meta: `第${action.version}版` })), apply: (_: string, ids: string[]) => ids[0],
  } }]
  const testBlockReason = bubblesError(bubbles) || messageButtonsError(messageButtons, { hasLiff: Boolean(selectedAccount?.liffId) })
  const openTestDialog = async () => { if (!selectedAccountId) return; testScope.current = { accountId: selectedAccountId, generation: accountGenerationRef.current }; return openBroadcastTest({ rejectValidation, saveErrors, selectedAccountId, setTestDialogOpen, setTestRecipients, setTestRecipientState, testRecipientsGeneration, validate }) }


  /**
   * 確認の窓を開く。
   *
   * **入り口で止める。** 窓の中で初めて弾くと、読み合わせたのに送れない
   * 形になる。`validate` は保存のときと同じものを使う。
   */
  const openConfirm = () => {
    const validationError = broadcastAbSendProblem(ab.enabled, audienceCount) || validate() || sendInputProblem.current
    if (validationError) { rejectValidation(validationError); return }
    if (!selectedAccountId) return
    confirmationScope.current = { accountId: selectedAccountId, generation: accountGenerationRef.current }
    setError('')
    setAcknowledgementKey(null)
    setConfirmOpen(true)
  }

  /*
   * 二者承認の境目と候補は、確認の窓を開いたときに読む。
   * 入力を打つたびに読むと重く、開く前に読むと古くなる。
   */
  useEffect(() => {
    if (!confirmOpen) return
    setApproverId('')
    setApprovalNote('')
    setApprovalCountInput('')
    const accountId = selectedAccountId
    if (!accountId) {
      setApprovalConfigState('error')
      setApprovalCandidatesState('error')
      return
    }
    let cancelled = false
    setApprovalConfigState('loading')
    setApprovalCandidatesState('loading')
    api.broadcasts.approval.config(accountId).then((res) => {
      if (cancelled) return
      if (res.success) {
        setApprovalConfig({ threshold: res.data.threshold, singleOperator: res.data.singleOperator })
        setApprovalConfigState('ready')
      } else {
        setApprovalConfigState('error')
      }
    }).catch(() => { if (!cancelled) setApprovalConfigState('error') })
    api.broadcasts.approval.candidates(accountId).then((res) => {
      if (cancelled) return
      if (res.success) {
        setApprovalCandidates(res.data)
        setApprovalCandidatesState('ready')
      } else {
        setApprovalCandidatesState('error')
      }
    }).catch(() => { if (!cancelled) setApprovalCandidatesState('error') })
    return () => { cancelled = true }
  }, [confirmOpen, selectedAccountId])

  /*
    **人数が数えられていないなら送らせない。**
    `ConfirmDialog` は `onConfirm` を渡さないと確認のボタンごと出さないので、
    押せそうに見えるボタンが残らない。
  */
  /*
   * 設計 `LMiL2` の5段。判定は保存の検査と同じ関数を通す。
   *
   * **人数が0でも「対象者は済み」にする。** 条件としては決まっていて、
   * 0人であることは配信前チェックと最終確認が別に止める。ここで赤くすると
   * 数え終わる前は毎回「未入力」に見えて、進み表示として読めなくなる。
   */
  const progressSteps = broadcastSteps({
    basicDone: broadcastStepPassed(liveStepProblems, 'basic'),
    audienceDone: broadcastStepPassed(liveStepProblems, 'audience'),
    messageDone: broadcastStepPassed(liveStepProblems, 'message'),
    scheduleDone: broadcastStepPassed(liveStepProblems, 'schedule'),
  })
  const stepOrder: BroadcastStepKey[] = ['basic', 'audience', 'message', 'schedule', 'confirm']
  const currentStepIndex = currentStep ? stepOrder.indexOf(currentStep) : -1
  /*
   * 設計 C：いまいる所（URL の ?step=）と入力済みを分ける。
   * 以前は居場所より前の段を全部 done にしていたので、「次へ」で進んでも
   * 空の段に ✓ が付いた。state は入力済みかだけを表し、居場所は currentKey で渡す。
   * 確認の段にいるとき、まだ埋まっていない段は直すところ（△）として出す。
   */
  const steps = currentStep
    ? progressSteps.map((step) => {
        const filled = step.state === 'done'
        const needsFix = !filled && currentStep === 'confirm'
        return {
          ...step,
          label: ({ basic: '基本設定', audience: '配信対象', message: 'メッセージを作成', schedule: '送信設定', confirm: '最終確認' })[step.key],
          state: (needsFix ? 'attention' : filled ? 'done' : 'todo') as 'done' | 'todo' | 'attention',
          // 段ごとの画面にいるときは、済み・要修正の段を押すとその段へ移る。
          onSelect: (filled || needsFix) && onStepChange ? () => goToStep(step.key) : undefined,
        }
      })
    : progressSteps
  const inlineBubble = inlineComposer ? bubbles[inlineComposer.index] : null
  const previousComposerAccount = useRef(selectedAccountId)
  useEffect(() => {
    if (previousComposerAccount.current === selectedAccountId) return
    previousComposerAccount.current = selectedAccountId
    ab.removeB(); setInlineComposer(null); setTemplateSaveIndex(null); setTemplateSaveCreatedId(null); setComposerBusy(false); setTemplateSaveError(''); setTemplateApplyError('')
  }, [selectedAccountId])
  const inlineHost: TemplateEditHost | undefined = inlineComposer && inlineBubble ? {
    composer: { index: inlineComposer.index, accountId: selectedAccountId },
    accountName: selectedAccount?.name ?? null,
    description: '作った中身をこの吹き出しに入れます。', folders: [], folder: '', onFolderChange: () => {}, busy: composerBusy,
    primaryLabel: 'この吹き出しに入れる',
    initialContent: inlineComposer.kind === 'carousel' && inlineBubble.content.columnsJson ? { kind: 'carousel', name: String(inlineBubble.content.templateName ?? ''), messageContent: String(inlineBubble.content.columnsJson), tapLimitMode: inlineBubble.content.tapLimitMode === 'once' ? 'once' : 'none', tapLimitText: String(inlineBubble.content.tapLimitText ?? ''), carouselActions: inlineBubble.content.carouselActions as Record<string, Record<string, unknown[]>> | undefined, templateId: String(inlineBubble.content.templateId ?? '') } : inlineComposer.kind === 'rich_message' && inlineBubble.content.assetName ? { kind: 'rich_message', name: String(inlineBubble.content.assetName), payload: inlineBubble.content, media: [] } : inlineComposer.kind === 'rich_video' && inlineBubble.content.video ? { kind: 'message', name: String(inlineBubble.content.templateName ?? ''), messageType: 'imagemap', messageContent: JSON.stringify(inlineBubble.content) } : undefined,
    onCancel: () => setInlineComposer(null),
    onSave: async (content: TemplateHostContent, alsoSave) => {
      let bubble: BroadcastBubble | null = null
      if (content.kind === 'carousel') bubble = { id: inlineBubble.id, type: 'carousel', content: { templateName: content.name, columnsJson: content.messageContent, templateId: content.templateId ?? '', carouselActions: content.carouselActions, tapLimitMode: content.tapLimitMode, tapLimitText: content.tapLimitText, inline: true } }
      if (content.kind === 'rich_message') {
        let assetId = `inline-${inlineBubble.id}`
        let payload = content.payload
        if (alsoSave) {
          setComposerBusy(true)
          try {
            const saved = await api.broadcastMessageAssets.create({ lineAccountId: selectedAccountId, kind: 'rich_message', name: content.name, payload })
            if (selectedAccountIdRef.current !== selectedAccountId) return false
            if (!saved.success) throw new Error(saved.error)
            assetId = saved.data.id; payload = saved.data.payload
          } catch (saveFailure) {
            const fieldFailure = saveErrors.capture(saveFailure);
 if (selectedAccountIdRef.current === selectedAccountId) { if (!fieldFailure) setTemplateSaveError('テンプレートに保存できませんでした。時間をおいて、もう一度お試しください。'); } return false }
          finally { if (selectedAccountIdRef.current === selectedAccountId) setComposerBusy(false) }
        }
        bubble = { id: inlineBubble.id, type: 'rich_message', content: { ...payload, assetId, assetName: content.name, inline: true } }
      }
      if (content.kind === 'message' && content.messageType === 'imagemap') bubble = { id: inlineBubble.id, type: 'rich_video', content: { ...JSON.parse(content.messageContent), templateName: content.name, inline: true } }
      if (selectedAccountIdRef.current !== selectedAccountId) return false
      if (bubble) { const problem = bubblesError([bubble]); if (problem) { setTemplateSaveError(problem); return false } updateBubble(inlineComposer.index, bubble) }
      setInlineComposer(null)
      return true
    },
    notice: templateSaveError ? <Notice tone="danger">{templateSaveError}</Notice> : undefined,
  } : undefined
  const saveComposerTemplate = () => saveBroadcastTemplate({ bubbles, composerBusy, saveErrors, selectedAccount, selectedAccountId, selectedAccountIdRef, setComposerBusy, setTemplateSaveCreatedId, setTemplateSaveError, setTemplateSaveIndex, templateSaveCreatedId, templateSaveIndex, templateSaveName })
  const messageVisited = useBroadcastStepVisited(currentStep === null || currentStep === 'message' || showTemplatePicker || inlineComposer !== null)
  const shows = (step: BroadcastStepKey) => currentStep === null || currentStep === step
  const goToStep = (step: BroadcastStepKey) => onStepChange?.(step)
  /*
   * R580: 保存を押した段で理由を示し、直す欄がある段へ移動できるようにする。
   *
   * 以前は失敗の文がメッセージの段の中にだけあり、対象者の段で保存を
   * 押しても理由が見えなかった（非表示の段に隠れていた）。
   *
   * 導線は「いまの入力に対する検査結果」と画面の文が一致するときだけ出す。
   * サーバー側で断られた文・直した後の古い文では、指す段がずれるので出さない。
   */
  const liveValidationProblem = validate()
  useEffect(() => {
    resolveValidationError(liveValidationProblem)
  }, [liveValidationProblem, resolveValidationError])
  const validationMoveStep: 'basic' | 'audience' | 'message' | null =
    currentStep && error && error === liveValidationProblem ? validationStep() : null
  /*
   * 段を移動したあと、直す欄へ焦点を移す。押した位置（下部追従バー）に
   * 取り残されると、キーボードだけの操作では修正欄へたどり着けない。
   */
  const pendingValidationFocus = useRef<BroadcastStepKey | null>(null)
  const goToValidationStep = (step: 'basic' | 'audience' | 'message') => {
    if (!onStepChange) {
      pendingValidationFocus.current = null
      return
    }
    pendingValidationFocus.current = step
    goToStep(step)
  }
  useEffect(() => {
    if (!pendingValidationFocus.current || pendingValidationFocus.current !== currentStep) return
    pendingValidationFocus.current = null
    const section = document.getElementById(`broadcast-step-${currentStep}`)
    if (typeof section?.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start' })
    }
    section?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea')?.focus()
  }, [currentStep])

  const canConfirm = !liveStepProblems.audience && audienceCount !== null && audienceCount > 0
  /*
   * ［次へ］は、今の段の確かめが通るまで押せない。押せない理由は下の帯の左に1行で出す
   * （title だけだと指を乗せないと見えない）。最終確認の段の止め方（人数・文字数）は今のまま。
   */
  const nextBlockReason = currentStep ? broadcastNextBlockReason(liveStepProblems, currentStep) : null
  const confirmBlockReason = broadcastAbSendProblem(ab.enabled, audienceCount) ?? liveStepProblems.audience?.message ?? liveStepProblems.schedule?.message ?? (!canConfirm ? '対象人数を確認できるまで実行できません' : lengthNotice.tone === 'error' ? lengthNotice.description : null)
  const footerReason = currentStep === 'confirm' ? confirmBlockReason : nextBlockReason

  /*
   * 二者承認の出し分け（設計 A-1・A-4）。人数は配信前チェックの数だけを使う。
   * 5手順の作成画面では、設定が読めるまで送信の確定を止める。
   */
  const needsApproval = audienceCount !== null
    && approvalConfig !== null
    && (preflight?.deliveryLimit?.candidateCount ?? audienceCount) >= approvalConfig.threshold
  const needsApprovalSingle = needsApproval && approvalConfig?.singleOperator === true
  const approvalCountMatched = needsApprovalSingle
    && approvalCountInput.trim() !== ''
    && Number(approvalCountInput) === audienceCount
  /*
   * 共通の「送る前の確かめ」の中身は、保存した配信に対するサーバーの数え直し（GET send-preview）。
   * 窓を開くたびに下書きを保存して数え直し、確定は「見た人数・版」を添えて送る（人数・版が変わっていたら 409）。
   */
  const canSendBroadcast = useFeatureAccess('broadcasts')
  const broadcastRole = useStaffRole()
  const [sendPreview, setSendPreview] = useState<{ state: 'loading' | 'error' | 'ready'; data: SendConfirmationPreview | null; broadcast: ApiBroadcast | null }>({ state: 'loading', data: null, broadcast: null })
  const [previewSeq, setPreviewSeq] = useState(0)
  useEffect(() => { setConfirmOpen(false); setApprovalConfig(null); setSendPreview({ state: 'loading', data: null, broadcast: null }) }, [selectedAccountId])
  useEffect(() => {
    if (!confirmOpen || needsApprovalSingle || !currentStep) return
    let alive = true
    setSendPreview({ state: 'loading', data: null, broadcast: null })
    void (async () => {
      try {
        const saved = await persistDraft(scheduledAtIso(), true, undefined, 'confirm')
        if (!alive) return
        if (!saved) { setSendPreview({ state: 'error', data: null, broadcast: null }); return }
        const preview = await chatSafetyApi.sendPreview(saved.id)
        if (!alive) return
        setSendPreview(preview.success ? { state: 'ready', data: preview.data, broadcast: saved } : { state: 'error', data: null, broadcast: saved })
      } catch {
        if (alive) setSendPreview({ state: 'error', data: null, broadcast: null })
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen, previewSeq])
  // 確認する行と件数は同じ一覧を使い、未実施・未取得を確認済みにしない。
  const preflightChecks: { key: string; label: string; value: string; done: boolean; step?: BroadcastStepKey; action?: () => void; actionLabel?: string }[] = [
    { key: 'basic', label: '配信名', value: title.trim() || '配信名を入力してください', done: Boolean(title.trim()) && title.trim().length <= TITLE_MAX, step: 'basic', actionLabel: '基本設定へ戻る' },
    { key: 'audience', label: '配信対象', value: `${confirmAudienceLabel}・${audienceCount === null ? '—' : `${formatNumber(audienceCount)}人`}・${exclusionNote ?? '除外の内訳は未取得'}`, done: canConfirm, step: 'audience', actionLabel: '対象を一覧で見る' },
    { key: 'message', label: 'メッセージ', value: `${formatNumber(bubbles.length)}件・${bubblesError(bubbles) || (previewConfirmed ? 'LINEプレビュー確認済み' : 'LINEプレビューが未確認です')}`, done: !bubblesError(bubbles) && previewConfirmed, step: 'message', actionLabel: 'メッセージへ戻る' },
    { key: 'schedule', label: '送信設定', value: sendWhenLabel ?? '配信日時が未設定です', done: broadcastStepPassed(stepProblems(), 'schedule'), step: 'schedule', actionLabel: '送信設定へ戻る' },
    { key: 'quota', label: '送信枠', value: quotaNote ?? '送信枠は未確認です', done: quota?.state === 'available', step: 'schedule', actionLabel: '送信枠を確認する' },
    { key: 'test', label: 'テスト送信', value: testResult?.kind === 'success' ? 'テスト送信が届きました' : testResult ? 'テスト送信で届かなかった宛先があります' : 'テスト送信がまだです', done: testResult?.kind === 'success', action: openTestDialog, actionLabel: 'テスト送信する' },
    ...(preflight?.warnings ?? []).filter(warning => warning.level === 'warning').map((warning, index) => ({ key: `warning-${index}`, label: '追加の確認', value: warning.message, done: false })),
    ...(concurrentBroadcasts.length > 0 ? [{ key: 'concurrent', label: '同じ時刻の配信', value: `同じ時刻の前後1時間に別の予約配信があります。対象が重なる場合は間隔を空けてください。${concurrentBroadcasts.map(item => `${formatScheduleTime(item.scheduledAt)} ${item.title}`).join('・')}`, done: false }] : []),
  ]
  const pendingChecks = preflightChecks.filter(check => !check.done)
  const unconfirmedCount = preflight ? pendingChecks.length : null
  // アカウント・保存内容・確認結果が変わったとき、前の了承を使わない。
  const confirmationKey = JSON.stringify([selectedAccountId, formFingerprint, preflightChecks.map(({ key, value, done }) => ({ key, value, done })), sendPreview.data, previewSeq])
  const confirmationBlocked = pendingChecks.length > 0 && acknowledgementKey !== confirmationKey
  const confirmedDeliveryLimit = currentStep && !needsApprovalSingle ? sendPreview.data?.deliveryLimit : preflight?.deliveryLimit
  const confirmationCurrent = renderedConfirmationScope !== null && renderedConfirmationScope.generation === accountGenerationRef.current && renderedConfirmationScope.accountId === selectedAccountId
  const visibleConfirmOpen = confirmOpen && confirmationCurrent
  const confirmationFields = <>{confirmationScope.current && <OperationTargetSummary accounts={[{ id: confirmationScope.current.accountId }]} />}{confirmedDeliveryLimit && <Notice tone="info">配信できる候補{formatNumber(confirmedDeliveryLimit.candidateCount)}人から、無作為に最大{formatNumber(confirmedDeliveryLimit.recipientCount)}人へ送ります。確認後に人数を増やしません。</Notice>}<BroadcastCheckAcknowledgement issues={pendingChecks.map(check => `${check.label}：${check.value}`)} checked={acknowledgementKey === confirmationKey} onCheckedChange={checked => setAcknowledgementKey(checked ? confirmationKey : null)} disabled={saving} /></>
  const confirmMessage = async () => {
    const abProblem = broadcastAbSendProblem(ab.enabled, audienceCount)
    if (abProblem) { setError(abProblem); return }
    if (!renderedConfirmationScope || renderedConfirmationScope !== confirmationScope.current || renderedConfirmationScope.generation !== accountGenerationRef.current) return
    const problem = sendInputProblem.current
    if (problem) { rejectValidation(problem); return Promise.resolve() }
    if (!canConfirm || confirmationBlocked) return
    return confirmBroadcastMessage({ onSuccess, scheduledAtIso, sendPreview, setConfirmOpen, setError, setPreviewSeq })
  }

  const save = async () => {
    if (confirmOpen && (!renderedConfirmationScope || renderedConfirmationScope !== confirmationScope.current || renderedConfirmationScope.generation !== accountGenerationRef.current)) return
    if (confirmOpen && (!canConfirm || confirmationBlocked)) return
    return saveBroadcast({ ab, approvalConfigState, approvalCountInput, approvalCountMatched, approvalNote, approverId, audienceCount, deliveryLimited:!!deliveryLimit, bubbles, currentStep, needsApproval, needsApprovalSingle, onSuccess, persistDraft, rejectValidation, saveErrors, saving, scheduledAtIso, selectedAccountIdRef, sendMode, sendProblem: () => sendInputProblem.current, setConfirmOpen, setError, setSaving, submittingRef, validate })
  }

  /*
   * BROADCAST-17: `?draft=` で開いたとき、読み込み・照合が終わるまで
   * 作成フォームを出さない。空のフォームが一瞬出てから下書きで
   * 埋まると、新規作成と取り違える。
   */
  const draftParam = searchParams.get('draft')?.trim() ?? ''
  if (draftParam) {
    if (draftError) {
      return (
        <SaveErrorScope errors={saveErrors}><div className={styles.root}>
          <div className="rounded-card border border-hairline bg-canvas p-8 text-center">
            <p className="text-ink text-sm font-semibold">{draftError}</p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <></>
            </div>
          </div>
        </div></SaveErrorScope>
      )
    }
    if (!editingDraft) {
      return (
        <SaveErrorScope errors={saveErrors}><div className="bg-canvas rounded-card border-hairline text-ink-faint border p-8 text-center text-sm">
          下書きを読み込んでいます…
        </div></SaveErrorScope>
      )
    }
  }

  return <SaveErrorScope errors={saveErrors}><MessageComposerPage active={currentStep !== null}><div className={styles.root} data-design-node="FU2aU" data-step={currentStep ?? 'all'}>
    <header className={styles.header} data-steps-below={true}>
      <div className={styles.heading}>
        <h2>一斉配信を作る</h2>
        <p>{currentStepIndex >= 0 ? <><span data-step-count>{`${currentStepIndex + 1}/${stepOrder.length} ${steps[currentStepIndex]?.label ?? ''}`}</span>{' ・ '}</> : null}<span aria-live="polite">{draftStatusLabel || '下書き・未保存'}</span></p>
      </div>
      {/* ★V8：手順は題と説明のすぐ下・左寄せ・1行（型の共通部品 Steps・Fa8ED / q1xNMz）。v7 はこれまでの帯のまま。 */}
      {<div className={styles.stepsBelow}><Steps connectorSize={currentStep === 'message' ? 'short' : undefined} label="配信作成の進み" steps={steps} currentKey={currentStep ?? undefined} summaries={currentStep ? { basic: title.trim(), audience: confirmAudienceLabel, message: `${formatNumber(bubbles.length)}通・${bubbles.map(bubble => String(bubble.content.text ?? typeLabel(bubble.type))).join(' / ')}`, schedule: sendWhenLabel ?? '未設定' } : undefined} /></div>}
      <Button ref={previewToggleRef} aria-expanded={previewOpen} aria-controls="broadcast-line-preview" className={styles.previewToggle} onClick={() => setPreviewOpen(true)}><Eye size={16} aria-hidden /> LINEの見え方</Button>
    </header>
    {/*
      R580: 保存を押した段で理由を示す。失敗の帯は1画面に1つまでなので、
      段ごとに分かれているときはここだけに出し、メッセージの段の中の帯は
      段分けなしの従来フォームのときだけ出す（下の `{!currentStep && ...}`）。
    */}
    {saveConflict.conflict ? <SaveConflictBand title="ほかの担当者が先に配信を保存しました" onCompare={() => void saveConflict.compare()} compareBusy={saveConflict.compareBusy} onReload={() => void saveConflict.reloadLatest()} /> : null}
    <SaveConflictCompareDialog open={saveConflict.compareOpen} busy={saveConflict.compareBusy} error={saveConflict.compareError} onCancel={saveConflict.closeCompare} onReload={() => void saveConflict.reloadLatest()} lines={saveConflict.latest ? [
      { text: `名前：入力 ${title} ／ 最新 ${saveConflict.latest.title}`, kind: title === saveConflict.latest.title ? undefined : 'change' },
      { text: `本文：入力 ${bubbles.map((bubble) => String(bubble.content.text ?? '')).join(' / ')} ／ 最新 ${saveConflict.latest.messageContent}`, kind: 'change' },
      { text: `配信時刻：入力 ${scheduledDate} ${scheduledTime} ／ 最新 ${saveConflict.latest.scheduledAt ?? '今すぐ'}`, kind: 'change' },
    ] : null} />
    {currentStep && error ? (
      <Notice
        tone="danger"
        className="mt-3"
        action={validationMoveStep && validationMoveStep !== currentStep ? (
          <Button variant="secondary" size="compact" onClick={() => goToValidationStep(validationMoveStep)}>
            {`${VALIDATION_STEP_LABEL[validationMoveStep]}へ移動`}
          </Button>
        ) : undefined}
      >
        {error}
      </Notice>
    ) : null}
    {editingDraft && currentStep !== 'message' ? (
      <p className="border-hairline bg-canvas-sunken text-ink-secondary mt-3 rounded-card border px-4 py-2 text-xs">
        保存済みの下書き「{editingDraft.title}」を開いています。保存すると、この下書きへ上書きします。
      </p>
    ) : null}
    <CreateColumns>
      <StepContent step={currentStep ? currentStepIndex : null} slide={false} className={`${styles.input} ${preflightDialogOpen ? 'broadcast-preflight-page-open' : ''}`}>
        {preflightDialogOpen ? (
          <section className="broadcast-preflight-page space-y-3">
            <section className="rounded-card border content-card bg-canvas p-5">
              <h3 className="text-lg font-bold text-ink">配信内容</h3>
              <p className="mt-1 text-xs text-ink-faint">対象・日時・メッセージの最終確認です。</p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-ink-faint">対象</dt><dd className="mt-1 font-medium text-ink">{confirmAudienceLabel} {formatNumber(audienceCount)}人</dd></div>
                <div><dt className="text-xs text-ink-faint">配信日時</dt><dd className="mt-1 font-medium text-ink">{sendWhenLabel ?? '未設定'}</dd></div>
              </dl>
            </section>
            <section className="rounded-card border content-card bg-canvas p-5">
              <h3 className="text-lg font-bold text-ink">確認項目</h3>
              <p className="mt-1 text-xs text-ink-faint">警告が残っている場合は配信できません。</p>
              <dl className="mt-4 divide-y divide-hairline text-sm">
                <div className="flex justify-between py-3"><dt className="font-medium text-ink">対象条件</dt><dd className="text-ink-secondary">除外{preflight?.exclusions?.total ?? 0}人を含めて確認済み</dd></div>
                <div className="flex justify-between py-3"><dt className="font-medium text-ink">メッセージ表示</dt><dd className="text-ink-secondary">LINEプレビュー確認済み</dd></div>
                <div className="flex justify-between py-3"><dt className="font-medium text-ink">送信枠</dt><dd className="text-ink-secondary">残り {formatNumber(quota?.remaining)} / {formatNumber(quota?.monthlyLimit)}通</dd></div>
              </dl>
            </section>
          </section>
        ) : null}
        <BroadcastBasicStep {...{ canCreateFolder, createFolder, deliveryMethod, duplicateRecent, folderId, folders, goToStep, internalMemo, recentBroadcasts, recentState, retryRecent, setComposerTemplateIndex, setComposerTemplateKind, setDeliveryMethod, setFolderId, setInternalMemo, setShowTemplatePicker, setTitle, shows, title }} />
        <BroadcastAudienceStep {...{ audienceDisplayCount, audienceNotice, condition, excludeTagId, exclusionNote, onRetryTags, openConditionDialog, preflight, preflightStatus, runPreflight, scenarioId, scenarios, scenariosStatus, selectedAccountId, setCondition, setExcludeTagId, setScenarioId, setTagId, setTargetMode, shows, tagId, tags, tagsStatus, targetMode }} />
        <div className={shows('message') ? 'contents' : 'hidden'}>{messageVisited && <>
        <BroadcastMessageStep {...{ ab, assets, bubbles, composerBusy, fields, moveBubble, selectedAccountId, selectedAccountIdRef, setBubbles, setComposerBusy, setComposerTemplateIndex, setComposerTemplateKind, setInlineComposer, setShowTemplatePicker, setTemplateSaveCreatedId, setTemplateSaveError, setTemplateSaveIndex, setTemplateSaveName, targetMode, title, updateBubble }} />
        {showTemplatePicker && (
          <EntityPickerDialog key={selectedAccountId ?? ''} title="テンプレートを選ぶ" searchPlaceholder="テンプレート名・本文で探す"
            folders={templateFolders} busy={composerBusy} error={templateApplyError}
            state={templateCandidatesStatus === 'loading' ?
                <p role="status">テンプレートを読み込んでいます…</p> : templateCandidatesStatus === 'error' ? <SaveErrorField names={["templatePickerFolderId","template_picker_folder_id"]}><Notice tone="danger">テンプレートを読み込めませんでした。窓を閉じて開き直すと再取得します。</Notice></SaveErrorField> : undefined}
            items={[
                    ...assets.filter((asset) => (!composerTemplateKind || asset.kind === composerTemplateKind) && (!asset.lineAccountId || asset.lineAccountId === selectedAccountId)).map((asset) =>( { id: `asset:${asset.id}`, name:asset.name, folderId: null, meta:`${typeLabel(asset.kind)}・更新 ${formatListDay(asset.updatedAt)}`})),
              ...messageTemplates.filter((template) => !composerTemplateKind || messageTemplateToBubble(template)?.type === composerTemplateKind).map((template) => ({ id:template.id, name:template.name, folderId: template.folderId, frequent: frequentTemplateIds.has(template.id), keywords: template.messageContent, meta : `${typeLabel(messageTemplateToBubble(template)?.type ?? 'unknown')}・更新 ${formatListDay(template.updatedAt)}`}
              )),
            ]}
            preview=
              {(item) => { const template = messageTemplates.find((row) => row.id === item?.id
              ); const asset = assets.find((row) => `asset:${row.id}` === item?.id
              ); const bubble = template ? messageTemplateToBubble (template
              ) : asset ? contentTemplateToBubble(asset) : null; return bubble ?
            <LinePreview accountName={selectedAccount?.name}><BubblePreview bubble={bubble} accountName={selectedAccount?.name}/>
          </LinePreview> : null }}
            onCancel={() => setShowTemplatePicker(false)}
            onConfirm={(id) => { const asset = assets.find((row) => `asset:${row.id}` === id); if (asset) { placeTemplateBubble(contentTemplateToBubble(asset)); setShowTemplatePicker(false); return }; const template = messageTemplates.find((row) => row.id === id); if (template) void applyTemplate(template) }} />
        )}
        {!showTemplatePicker && <section className="rounded-card border content-card bg-canvas p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h4 className="text-sm font-bold text-ink">配信後のアクション</h4>{currentStep !== 'message' && <p className="mt-1 text-xs text-ink-faint">配信後にタグ追加などを実行します。</p>}</div>
            </div>
          <ActionList
            <string> value={afterActionVersionId ? [afterActionVersionId] : []} onChange={next =>setAfterActionVersionId(next[next.length - 1] ?? '')}
            idOf={id => id} titleOf={id => publishedActions.find(action => action.versionId === id)?.name ?? '設定済みの共通アクション'}
            choices={afterActionVersionId ? [] :afterActionChoices}
            addActions={afterActionVersionId ? null : <div className="flex flex-wrap gap-2"><ActionAddButton label="アクションを追加する" choices={afterActionChoices} onAdd={id => setAfterActionVersionId(id)} /></div>}
            renderEditor={(id, update) =>
          <EntityPickerField label="配信後のアクション" noun="共通アクション" items={publishedActions.map(action => ({ id: action.versionId, name: action.name, meta: `第${action.version}版` }))} value={id} onChange={update}/>}/>
        </section>}
        {!showTemplatePicker && bubbles.some(bubble => bubble.type === 'text') ? <Disclosure size="compact" title="ほかの設定" hint="クリックを数える・ボタン" detailsRef={(el) => { buttonsRef.current = el; fields.bind('buttons').ref(el) }} onBlur={fields.bind('buttons').onBlur}><SaveErrorField names={["trackLinks","track_links"]}><ToggleField checked={trackLinks} onChange={setTrackLinks}>URLを短縮してクリックを数える</ToggleField></SaveErrorField><MessageButtonsSection buttons={messageButtons} error={messageButtonsError(messageButtons, { hasLiff: Boolean(selectedAccount?.liffId) })} onChange={setMessageButtons} liffId={selectedAccount?.liffId ?? null} accountId={selectedAccountId ?? null} /></Disclosure> : null}
        {!currentStep && error && <Notice tone="danger" message={error} />}
        </>}</div>
        <BroadcastScheduleStep onRetryQuota={() => void runPreflight()} {...{ selectedAccountId, limitToQuota, setLimitToQuota, recipientLimitInput, setRecipientLimitInput, ab, approvalConfig, audienceCount, concurrentBroadcasts, goToStep, measureOpens, quota, quotaInsufficient, scheduledAtIso, scheduledDate, scheduledTime, sendMode, sendChoice, setSendChoice, spreadStartMode, setSpreadStartMode, setMeasureOpens, setScheduledDate, setScheduledTime, setSpreadMinutes, shows, spreadMinutes, targetMode }} />

    <div id="broadcast-step-confirm" className={shows('confirm') ? styles.section : 'hidden'}>
      <h3>配信前チェック</h3>
      <div className={styles.checkList}>
        {preflightChecks.map((row) => <div className={styles.checkRow} key={row.key} data-preflight-check={row.key} data-check-state={row.done ? 'done' : 'pending'}>
          {row.done ? <CheckCircle2 size={20} className="text-success" aria-hidden /> : <AlertTriangle size={20} className="text-warning" aria-hidden />}
          <div><strong>{row.label}</strong><p>{row.value}</p></div>{row.actionLabel ? <Button variant="secondary" className={styles.textButton} size="compact" onClick={row.action ?? (() => { if (row.step) goToStep(row.step) })}>{row.actionLabel}</Button> : null}
        </div>)}
      </div>
      <Notice tone={unconfirmedCount || !canConfirm ? 'warn' : 'info'} action={<Button variant="secondary" className={styles.textButton} size="compact" onClick={() => setPreflightDialogOpen(true)}>配信前チェックを確認</Button>}>
        {audienceCount === 0 ? 'この条件に当てはまる友だちがいません。条件を変えてください' : audienceCount === null ? '人数を確認してから送れます' : unconfirmedCount ? `${formatNumber(unconfirmedCount)}件の確認が残っています` : '配信する内容を確認してください'}
      </Notice>
      <details className={styles.details}>
        <summary>最終確認の内訳</summary>
        <dl className={styles.confirmDetails}>{[
          ['対象', `${confirmAudienceLabel} ${audienceCount === null ? '—' : `${formatNumber(audienceCount)}人`}`],
          ['除外', exclusionNote ?? '—'], ['除くタグ', tags.find((tag) => tag.id === excludeTagId)?.name ?? 'なし'],
          ['配信日時', sendWhenLabel ?? '未設定'], ['送信枠', quotaNote ?? '—'], ['計算時刻', evaluatedAtLabel ?? '—'],
          ['メッセージ', `${formatNumber(bubbles.length)}通`], ['開封計測', measureOpens ? '有効' : '無効'],
          ['配信後', publishedActions.find((action) => action.versionId === afterActionVersionId)?.name ?? '未設定'],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </details>

      <p className="text-xs text-ink-faint">{sendMode === 'scheduled' ? '予約後も配信開始前までは編集・取消できます。' : '「今すぐ送る」で確認の画面を開き、そこで送ると友だちに届きます。送信は取り消せません。'}</p>
    </div>
    <BroadcastLengthNotice visible={shows('message')} notice={lengthNotice} />
      </StepContent>
      <BroadcastPreviewRail reviewKey={visualQaAugustCampaign ? 'visual-example' : JSON.stringify([bubbles, ab.hasB, ab.b, messageButtons, selectedAccountId, scheduledDate, scheduledTime, sendMode, effectiveSpreadMinutes])} {...{ ab, afterActionVersionId, audienceDisplayCount, bubbles, confirmAudienceLabel, currentStep, excludeTagId, messageButtons, openTestDialog, preflight, preflightStatus, previewCloseRef, previewConfirmed, previewDevice, previewOpen, previewToggleRef, publishedActions, saving, scheduledLabel, selectedAccount, sendWhenLabel, setPreviewConfirmed, setPreviewDevice, setPreviewOpen, tags, testBlockReason }} />
    </CreateColumns>

    <StickyBar className={styles.footer} status={currentStep && footerReason ? <span id="broadcast-footer-reason" role="note">{footerReason}</span> : undefined} actions={(
      <>
      {currentStep ? (
        <>
          {currentStep === 'confirm' ? <Button type="button" onClick={() => goToStep('schedule')}>戻って修正</Button> : null}
          {currentStep === 'schedule' ? <Button type="button" disabled={saving || composerBusy} onClick={() => goToStep('message')}>メッセージへ戻る</Button> : null}
          <Button variant="secondary" type="button" disabled={saving || composerBusy} onClick={() => saveDraftNow()} busy={saving}>{currentStep === 'message' && <Save size={16} aria-hidden />}{'下書きを保存する'}</Button>
          {currentStep !== 'confirm' ? (
            <Button variant="primary" disabled={composerBusy || nextBlockReason !== null} aria-describedby={nextBlockReason ? 'broadcast-footer-reason' : undefined} onClick={() => { if (nextBlockReason === null) goToStep(stepOrder[Math.min(currentStepIndex + 1, stepOrder.length - 1)]) }}>
              {currentStep === 'basic' ? '対象設定へ'
                : currentStep === 'audience' ? 'メッセージ設定へ'
                  : currentStep === 'message' ? <><span>送信設定へ</span><ArrowRight size={16} aria-hidden /></>
                    : '配信前チェックへ'}
            </Button>
          ) : (
            <Button variant="primary" disabled={saving || confirmBlockReason !== null} title={confirmBlockReason ?? undefined} aria-describedby={confirmBlockReason ? 'broadcast-footer-reason' : undefined} onClick={openConfirm} busy={saving}>
              {broadcastSendLabel(sendMode)}
            </Button>
          )}
        </>
      ) : (
        <>
          <Button variant="secondary" className="rounded-card px-5 py-3 font-bold h-auto whitespace-normal" onClick={() => requestUnsavedAction(onCancel)}>キャンセル</Button>
          {(shows('message') || shows('confirm')) && <Button variant="secondary" className="rounded-card px-5 py-3 font-bold disabled:opacity-50 h-auto whitespace-normal" disabled={testSending || saving || lengthNotice.tone === 'error'} title={lengthNotice.tone === 'error' ? lengthNotice.description : undefined}  onClick={() => openTestDialog()} busy={testSending} busyLabel="送信中…" widthReserve="idle">{'テストを送る'}</Button>}
          <Button variant="primary" className="rounded-card px-7 py-3 font-bold disabled:opacity-50 border-0 h-auto whitespace-normal" disabled={saving || lengthNotice.tone === 'error'} title={lengthNotice.tone === 'error' ? lengthNotice.description : undefined}  onClick={() => (stepProblems().schedule || (ab.b !== null && sendMode !== 'scheduled') ? void saveDraftNow() : sendMode === 'scheduled' ? openConfirm() : void save())} busy={saving} busyLabel="保存中…" widthReserve="idle">{sendMode === 'scheduled' && !liveStepProblems.schedule ? '配信を予約する' : '下書きを保存する'}</Button>
        </>
      )}
      </>
    )} />

    {/*
      書きかけのまま離れようとしたときの確認（★V7 sTJsh §5）。
      「保存して移る」は下書きへ保存できたらそのまま移動し、
      保存できないときはこの画面へ戻って直す。
    */}
    {renderBroadcastConfirmDialogs({ bDraftUnsupported: ab.b !== null, selectedAccountId, canConfirm, confirmationBlocked, confirmationFields, preflightChecks, approvalCandidates, approvalCandidatesState, approvalConfig, approvalConfigState, approvalNote, approverId, audienceCount, broadcastRole, bubbles, cancelLeave, canSendBroadcast, concurrentBroadcasts, conditionDialogOpen, conditionDraft, confirmAudienceLabel, confirmLeave, confirmMessage, confirmOpen: visibleConfirmOpen, currentStep, error, exclusionNote, goToStep, leaveTarget, needsApproval, needsApprovalSingle, preflightDialogOpen, quota, quotaInsufficient, quotaNote, runPreflight, save, saveDraftNow, saving, scheduledDate, scheduledLabel, scheduledTime, sendMode, sendWhenLabel, sendPreview, setApprovalNote, setApproverId, setCondition, setConditionDialogOpen, setConditionDraft, setConfirmOpen, setPreflightDialogOpen, setPreviewSeq, targetMode, title })}
    {renderBroadcastEditorDialogs({ confirmationBlocked, confirmationFields, ab, approvalConfigState, approvalCountInput, audienceCount, bubbles, canConfirm, composerBusy, concurrentBroadcasts, confirmAudienceLabel, confirmOpen: visibleConfirmOpen, currentStep, error, evaluatedAtLabel, exclusionNote, handleTestSend, testTargetAccountId: renderedTestScope?.accountId ?? null, inlineComposer, inlineHost, measureOpens, needsApproval, needsApprovalSingle, quotaInsufficient, quotaNote, save, saveComposerTemplate, saving, scheduledAtIso, selectedAccountId, sendMode, sendWhenLabel, setApprovalCountInput, setConfirmOpen, setTemplateSaveIndex, setTemplateSaveName, setTestDialogOpen, templateSaveError, templateSaveIndex, templateSaveName, testDialogOpen: testDialogOpen && testScopeCurrent(), testHistory, testRecipients, testRecipientState, testResult, testSending, testRetryBlocked, testResultOpen, setTestResultOpen, title, trackLinks })}
  </div></MessageComposerPage></SaveErrorScope>
}
