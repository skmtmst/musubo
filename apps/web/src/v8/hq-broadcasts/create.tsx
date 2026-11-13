'use client'

import { jstDateOffset } from '@/lib/jst-datetime';
import { notifySaved } from '@/components/shared/toast';
import BroadcastAccountPicker, { type BroadcastAccount } from './account-picker';
import { useTenantWideAccess } from '@/lib/staff-role';
import { EntityPickerField, EntityPickerSummary } from '@/components/shared/entity-picker';
import { useSamePageUrl } from '@/lib/use-same-page-url';
import { Steps } from '@/components/templates/steps';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/components/shared/list-navigation';
import { useSearchParams } from 'next/navigation';
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { AlertTriangle, ArrowRight, Building2, CheckCircle2, Copy, FileText, Send, SquarePen, Tag as TagIcon, Workflow } from 'lucide-react';
import type { Folder, HqBroadcastInput, HqBroadcastPreflight, HqBroadcastRun, MessageTemplateDefinition, SegmentCondition } from '@line-crm/shared';
import ConditionBuilder from '@/components/shared/condition-builder';
import Dialog from '@/components/shared/dialog';
import { SingleOperatorFields } from '@/components/broadcasts/broadcast-approval';
import { BubblePreview } from '@/components/broadcasts/broadcast-form';
import { TARGET_MODES } from '@/lib/broadcast-audience';
import { pruneCondition } from '@/lib/segment-condition';
import { HqApprovalBlock, HqTestSendDialog, approvalGate, useHqApproval } from './approval';
import Button from '@/components/shared/button';
import Checkbox from '@/components/shared/checkbox';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import SendConfirmDialog, { describeExclusion } from '@/components/shared/send-confirm-dialog';
import { chatSafetyApi } from '@/lib/api/helpers/gap1';
import type { SendConfirmationPreview } from '@line-crm/shared';
import DateField from '@/components/shared/date-field';
import { TimeField } from '@/components/shared/date-time-field';
import HelpTip from '@/components/shared/help-tip';
import { HqInsertRow, HQ_INSERT_CHIPS, insertHqToken } from '@/components/shared/hq-message-inserts';
import { type InsertTextFieldHandle } from '@/components/shared/insert-text-field';
import LinePreview from '@/components/shared/line-preview';
import ListState from '@/components/shared/list-state';
import Notice from '@/components/shared/notice';
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card';
import { RequiredBadge } from '@/components/shared/form-controls';
import FolderSelect from '@/components/shared/folder-select';
import StatusBadge from '@/components/shared/status-badge';
import { CreatePage } from '@/components/templates/create-page';
import { useFormErrors } from '@/lib/use-form-errors';
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { notifyToast } from '@/components/shared/toast';
import { broadcastSteps, type BroadcastStepKey } from '@/components/broadcasts/broadcast-steps';
import formStyles from '@/components/broadcasts/broadcast-form-v8.module.css';
import { BroadcastBlockedExclusion } from '@/components/broadcasts/broadcast-blocked-exclusion';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { api, type BroadcastMessageAsset } from '@/lib/api';
import { bubbleLegacyMessage } from '@/lib/broadcast-template';
import { formatNumber, formatRelative } from '@/lib/format';
import { hqBroadcastsApi } from '@/lib/hq-broadcasts-api';
import { hqTemplatesApi } from '@/lib/hq-templates-api';
import { useStaffRole } from '@/lib/staff-role';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import RowMenu from './row-menu';
import { ASSET_KIND, STORE_INSERT_CHIPS, type HqKind, jpDateTime, preflightBadge, previewText, runPeople, sendTotals, splitPreflightRows, toApiContent } from './model';
import { HQ_KIND_LABEL, bubbleFromTemplate, emptyContent, fromApiBubble, hqBubbleProblem, previewBubbleOf, bubbleFromHostContent, hostContentOfBubble, templateContentOfBubble, hqBubbleSummary, notYetText, toApiBubble } from './bubbles';
import HqTemplatePicker from './template-picker';
import HqBroadcastSourcePicker, { broadcastPickerItem } from './source-picker';
import { SourcePickerSelection, type SourcePickerItem, type SourcePickerFolder } from '@/components/shared/source-picker-dialog';
import { CarouselV8 } from '@/v8/templates/public/carousel/index'
import { TemplateRichEditor } from '@/v8/template-edit/public/rich/index'
import type { TemplateEditHost } from '@/v8/template-edit/public/host/index'
import { hostDefinition } from '@/v8/hq-templates/public/console/index'
import { freshDefinition } from '@/lib/hq-template-authoring';
import styles from './create.module.css';
import MessageComposer from '@/components/shared/message-composer';
import { PageFrame, PageHeading, PageContent } from '@/components/templates/page-frame';
import PreviewLauncher from '@/components/templates/preview-launcher';
import { usePreviewReview } from '@/components/broadcasts/use-preview-review';
import { Field } from '@/components/shared/form-controls';
import { SettingsFormRow } from '@/components/shared/settings-form-card';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import { type Audience, type Bubble, newBubble, errorText, jstIso, splitJst, assetContent, bubblesFromInput, hasUnsupportedBubbles, audienceFromInput } from "./create-gap-parts"
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
/*
 * ★V8 統括 一括配信を作る（・絵 V8.pen の ：① lmWCZ・② AL5vR・③ lLyFR・④ ZU4Ae・⑤ H9eG3n）。
 *
 * オーナー 10-08：「店の一斉配信とほぼ同じ画面にする。違いは送るアカウントを選ぶだけ」。
 * 店の一斉配信を作る画面（components/broadcasts/broadcast-form.tsx）と同じ5段・同じ部品（段の帯・選ぶカード・
 * LINE の見え方・下の帯）・同じ見た目（店の CSS をそのまま読む）で組む。統括だけの口は2つ：
 *   - ② 配信対象の上の「送るアカウント」（選ぶボタンから共通の窓で選択）
 *   - ⑤ 最終確認の「アカウントごとの確かめ」（送る人数・今月の送信枠の残り・LINE の接続・止めているか。問題のある店は外す）
 * 読み書きは統括の一括配信の口（API-7 の hq-broadcasts）。店の口（承認・テスト送信・分散・配信後のアクション・
 * 除くタグ・詳細条件）は統括の口に無いので出さない（BEHAVIOR.md の「今の口で出せないもの」）。
 */

type Store = BroadcastAccount
type Method = 'new' | 'template' | 'duplicate'
/**
 * 統括の条件で選べる種類（API-18：タグ・シナリオは各アカウントの同じ名前に直す）。
 * 友だち情報・対応マーク・回答フォーム・個別の友だち・分析の対象・クリック履歴は店ごとの ID なので選ばせない。
 */
const HQ_RULE_KINDS = ['name', 'private_memo', 'status_message', 'registered_at', 'tag_exists', 'scenario_subscribed', 'scenario_state', 'last_reaction_at', 'reaction_state', 'score_range', 'is_following', 'is_hidden']

const STEP_ORDER: BroadcastStepKey[] = ['basic', 'audience', 'message', 'schedule', 'confirm']
const STEP_SET = new Set<string>(STEP_ORDER)
const TITLE_MAX = 60
const BODY_MAX = 5000
/** 表に1行ずつ出すのは4店まで。残りは「ほか N店」にまとめ、「…」から全部を開く。 */
const ROWS_SHOWN = 4

const KIND_LABEL = HQ_KIND_LABEL

export default function HqBroadcastCreate() {
  const saveErrors = useSaveFormErrors()
  /* ③ でカルーセル・リッチメッセージをその場で作っている間は、店の作る部品（template-edit/host の口）を画面いっぱいに出す。 */
  const [composerBusy, setComposerBusy] = useState(false)
  const [composer, setComposer] = useState<null | 'carousel' | 'rich'>(null)
  /* 部品も画面名を付けるので、親（この画面）の名前で上書きする（部品より後に走る）。閉じたら一括配信を作るに戻す。 */
  usePageTitle('一括配信を作る')
  usePageCrumbs([{ label: '一括配信', href: '/hq/broadcasts' }])
  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  const role = useStaffRole()
  const canManage = useTenantWideAccess()

  /* 段は ?step=（店の一斉配信と同じ名前・同じ値）。押した段はすぐ出し、URL は履歴を積まずに書き換える。 */
  const urlStep = params.get('step')
  const [step, setStep] = useState<BroadcastStepKey>(urlStep && STEP_SET.has(urlStep) ? urlStep as BroadcastStepKey : 'basic')
  /* 下書きを直すとき（?id=）。保存した下書きは URL に id を残し、読み直しても同じ下書きを開く。 */
  const [draftId, setDraftId] = useState(params.get('id') ?? '')
  const [draftState, setDraftState] = useState<'none' | 'loading' | 'ready' | 'sent' | 'error' | 'unsupported'>(params.get('id') || params.get('copy') ? 'loading' : 'none')
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const [stores, setStores] = useState<Store[] | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [loadError, setLoadError] = useState<unknown>(null)
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [accountPickerOpen, setAccountPickerOpen] = useState(false)
  const accountPickerTrigger = useRef<HTMLButtonElement>(null)
  const [accountIds, setAccountIds] = useState<string[]>([])
  /* 昔の入口（?tag=<アカウントのタグ>）と、タグで作った下書き。読んだあとはアカウントを1つずつ選んだ形に直す。 */
  const legacyTags = useRef<string[]>(params.get('tag') ? [params.get('tag')!] : [])
  const [excluded, setExcluded] = useState<string[]>([])

  const [method, setMethod] = useState<Method>('new')
  const [title, setTitle] = useState('')
  const [recent, setRecent] = useState<HqBroadcastRun[]>([])
  const [recentStatus, setRecentStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [basicPicker, setBasicPicker] = useState<'template' | 'duplicate' | null>(null)
  const basicPickerTrigger = useRef<HTMLButtonElement>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<{ item: SourcePickerItem; folders: SourcePickerFolder[] } | null>(null)
  const [copiedRun, setCopiedRun] = useState<HqBroadcastRun | null>(null)

  /* ① フォルダ（統括の一括配信のフォルダ）・社内メモ（API-18）。 */
  const [hqFolders, setHqFolders] = useState<Array<{ id: string; name: string; color?: string | null }>>([])
  /* フォルダを選ぶ欄からその場で作る（dLffh）。一覧の左の列と同じ口。名前と色を保存する。 */
  const createHqFolder = async (name: string, color: string | null) => {
    const created = (await hqBroadcastsApi.createFolder(name, color)).data
    setHqFolders((current) => [...current, { id: created.id, name: created.name, color: created.color }])
    return { value: created.id, label: created.name, color: created.color }
  }
  const [folderId, setFolderId] = useState('')
  const [internalMemo, setInternalMemo] = useState('')

  const [audience, setAudience] = useState<Audience>('all')
  const [tagName, setTagName] = useState('')
  const [scenarioName, setScenarioName] = useState('')
  const [condition, setCondition] = useState<SegmentCondition | null>(null)
  const [conditionDraft, setConditionDraft] = useState<SegmentCondition | null>(null)
  const [conditionOpen, setConditionOpen] = useState(false)
  const [savedName, setSavedName] = useState('')
  const [excludeTag, setExcludeTag] = useState('')
  /*
   * 配信対象の候補：選んだアカウントのタグ・シナリオ・保存した条件の名前（同じ名前を各アカウントで探して送る。API-18）。
   * accounts はその名前を持っているアカウントの数。
   */
  const [tagOptions, setTagOptions] = useState<Array<{ name: string; accounts: number }> | null>(null)
  const [scenarioOptions, setScenarioOptions] = useState<Array<{ name: string; accounts: number }> | null>(null)
  const [savedOptions, setSavedOptions] = useState<Array<{ name: string; accounts: number }> | null>(null)
  const [tagStatus, setTagStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  /* ③ 吹き出し（5つまで）。開いているのは1つ。 */
  const [bubbles, setBubbles] = useState<Bubble[]>(() => [newBubble('text')])
  const [openBubble, setOpenBubble] = useState(0)
  const active = bubbles[Math.min(openBubble, bubbles.length - 1)]
  const kind = active.kind
  const body = active.body
  const setBody = (next: string | ((text: string) => string)) => setBubbles((items) => items.map((item, index) => (index === Math.min(openBubble, items.length - 1) ? { ...item, body: typeof next === 'function' ? next(item.body) : next } : item)))
  const setKind = (next: HqKind) => setBubbles((items) => items.map((item, index) => (index === Math.min(openBubble, items.length - 1) ? { ...item, kind: next, content: emptyContent(next), cardAsset: undefined } : item)))
  /** 開いている吹き出しの中身（画像・動画・位置情報・カルーセル・素材など）を差し替える。 */
  const setContent = (next: Record<string, unknown>, cardAsset?: boolean) => setBubbles((items) => items.map((item, index) => (index === Math.min(openBubble, items.length - 1) ? { ...item, content: next, cardAsset } : item)))
  /** 開いている吹き出しを、ひな形から読んだ吹き出しに置き換える。 */
  const replaceActive = (next: Bubble) => setBubbles((items) => items.map((item, index) => (index === Math.min(openBubble, items.length - 1) ? { ...next, id: item.id } : item)))
  const bodyRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)
  /* 統括で使える共有の素材（どの店にも属さないクーポン・リッチメッセージ）。 */
  const [assetsError,setAssetsError]=useState(false)
  const [assets, setAssets] = useState<BroadcastMessageAsset[] | null>(null)
  const assetId = String(active.content.assetId ?? '')
  const setAssetId = (next: string) => { const found = (assets ?? []).find((a) => a.id === next); setContent(found ? assetContent(found) : {}) }
  /* 統括のカルーセルのひな形（③ のカルーセル）と、［テンプレートから選ぶ］の窓。 */
  const [carouselError, setCarouselError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerKind, setPickerKind] = useState<string | undefined>()
  /* ［保存してテンプレートにする］（開いている吹き出しを統括のひな形に保存する）。 */
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  const [saveTplName, setSaveTplName] = useState('')
  const [saveTplBusy, setSaveTplBusy] = useState(false)
  const [saveTplError, setSaveTplError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [approvalRequestOpen, setApprovalRequestOpen] = useState(false)
  const [confirmCount, setConfirmCount] = useState('')
  const [previewConfirmed, setPreviewConfirmed] = useState(false)
  const [previewDevice, setPreviewDevice] = useState<'phone' | 'pc'>('phone')

  const [when, setWhen] = useState<'now' | 'later'>('later')
  const [date, setDate] = useState(() => jstDateOffset(1))
  const [time, setTime] = useState('11:00')
  const previewKey = JSON.stringify([bubbles, accountIds, when, date, time])
  const previewReview = usePreviewReview(previewKey, false, previewConfirmed, setPreviewConfirmed)
  const previewOpened = useCallback(() => previewReview.markVariant('A'), [previewReview.markVariant])

  const [run, setRun] = useState<HqBroadcastRun | null>(null)
  const [runKey, setRunKey] = useState('')
  const [checks, setChecks] = useState<HqBroadcastPreflight[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState('')
  const [errorStep, setErrorStep] = useState<BroadcastStepKey | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const confirmTicket = useRef<object | null>(null)
  const renderedConfirmTicket = confirmTicket.current
  const closeConfirm = () => { confirmTicket.current = null; setConfirmOpen(false) }
  const [sending, setSending] = useState(false)
  const sendLock = useRef(false)
  const sendScope = useRef({ open:false, runId:'', version:0, generation:0 })
  /* 共通の「送る前の確かめ」の中身は、保存した一括配信に対するサーバーの数え直し（GET /api/hq/broadcasts/:id/send-preview）。 */
  const [sendPreview, setSendPreview] = useState<{ state: 'loading' | 'error' | 'ready'; data: SendConfirmationPreview | null }>({ state: 'loading', data: null })
  const [previewSeq, setPreviewSeq] = useState(0)
  const [leaving, setLeaving] = useState(false)
  /* 下書きの依頼番号。作ったとき（または読んだ下書き）のものを、直すときもそのまま使う（口の決まり）。 */
  const requestRef = useRef('')
  /* WEB011：requestRef を作った中身（key）。中身が同じやり直しは同じ依頼番号を使う。 */
  const createKeyRef = useRef('')
  /** 保存の成功と事前確認の成功を分ける。後の工程が失敗しても同じ保存を繰り返さない。 */
  const preparedKeyRef = useRef<{ id: string; key: string } | null>(null)

  useEffect(() => {
    let current = true
    void Promise.all([
      api.lineAccounts.list(),
      api.lineAccountFolders.list().catch(() => null),
      hqBroadcastsApi.list().catch(() => null),
      hqBroadcastsApi.folders().catch(() => null),
    ])
      .then(([accounts, folderList, runs, broadcastFolders]) => {
        if (current && broadcastFolders) setHqFolders(broadcastFolders.data.map((f) => ({ id: f.id, name: f.name, color: f.color })))
        if (!current) return
        if (!accounts.success) throw new Error(accounts.error)
        const list: Store[] = accounts.data
          .filter((a) => !a.archivedAt)
          .map((a) => ({ ...a, friendCount: a.stats?.friendCount ?? null }))
        setStores(list)
        if (folderList?.success) setFolders(folderList.data.folders)
        setFoldersFailed(!folderList?.success)
        const sent = runs ? runs.data.filter((r) => r.status !== 'prepared') : []
        setRecent(sent.slice(0, 2))
        setRecentStatus(runs ? 'ready' : 'error')
        if (legacyTags.current.length > 0) {
          const ids = list.filter((s) => s.tags?.some((t) => legacyTags.current.includes(t.id))).map((s) => s.id)
          setAccountIds((prev) => [...new Set([...prev, ...ids])])
          legacyTags.current = []
        }
      })
      .catch((caught) => { if (current) setLoadError(caught) })
    return () => { current = false }
  }, [])

  /** 保存した中身（下書き・複製元）のフォルダ・メモ・対象・吹き出しを画面に戻す。 */
  const applySaved = (saved: HqBroadcastInput) => {
    setFolderId(saved.folderId ?? '')
    setInternalMemo(saved.internalMemo ?? '')
    const target = audienceFromInput(saved)
    setAudience(target.audience); setTagName(target.tagName); setScenarioName(target.scenarioName); setCondition(target.condition); setSavedName(target.savedName)
    setExcludeTag(saved.excludedTagIds?.[0] ?? '')
    setBubbles(bubblesFromInput(saved)); setOpenBubble(0)
  }

  /* 下書きを読む（?id=）。本文・送るアカウント・対象・時刻を戻し、確かめるときは同じ下書きを直す。 */
  useEffect(() => {
    const id = params.get('id')
    if (!id) return
    // 自分の保存でURLへ記録した下書きを取り直して、編集中の内容を置き換えない。
    if (id === run?.id) return
    setDraftState('loading')
    let current = true
    void hqBroadcastsApi.get(id)
      .then((res) => {
        if (!current) return
        const draft = res.data
        if (draft.status !== 'prepared') { setDraftState('sent'); return }
        const saved = draft.input
        if (hasUnsupportedBubbles(saved)) { setDraftState('unsupported'); return }
        setTitle(saved.title ?? '')
        setAccountIds(saved.accountIds)
        if (saved.accountTagIds.length > 0) legacyTags.current = saved.accountTagIds
        setExcluded(saved.excludedAccountIds)
        applySaved(saved)
        const at = saved.scheduledAt ? splitJst(saved.scheduledAt) : null
        if (at) { setWhen('later'); setDate(at.date); setTime(at.time) } else setWhen('now')
        requestRef.current = saved.requestId
        setRun(draft)
        setDraftState('ready')
      })
      .catch(() => { if (current) setDraftState('error') })
    return () => { current = false }
  }, [params, run?.id])

  /* 詳細の［複製して作る］（?copy=<一括配信の id>）：配信名・中身・送るアカウント・対象を写して新しく作る。 */
  useEffect(() => {
    const copyId = params.get('copy')
    if (!copyId || params.get('id')) return
    let current = true
    void hqBroadcastsApi.get(copyId).then((res) => { if (!current) return; if (hasUnsupportedBubbles(res.data.input)) { setDraftState('unsupported'); return }; duplicate(res.data); setDraftState('none') }).catch(() => { if (current) setDraftState('error') })
    return () => { current = false }
    // 開いたときに一度だけ写す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* タグで読んだ下書きは、店の一覧が届いてからアカウントへ直す。 */
  useEffect(() => {
    if (!stores || legacyTags.current.length === 0) return
    const ids = stores.filter((s) => s.tags?.some((t) => legacyTags.current.includes(t.id))).map((s) => s.id)
    setAccountIds((prev) => [...new Set([...prev, ...ids])])
    legacyTags.current = []
  }, [stores, draftState])

  const needsAssets = bubbles.some((item) => item.kind === 'rich' || item.kind === 'coupon')
  useEffect(() => {
    if (!needsAssets || assets || assetsError) return
    let current = true
    void api.broadcastMessageAssets.list()
      .then((res) => { if(!res.success)throw new Error(res.error);if (current) setAssets(res.data.filter((a) => a.lineAccountId === null && (a.kind === 'coupon' || a.kind === 'rich_message'))) })
      .catch(() => { if (current) setAssetsError(true) })
    return () => { current = false }
  }, [needsAssets, assets,assetsError])

  const chosen = useMemo(() => (stores ?? []).filter((s) => accountIds.includes(s.id)), [stores, accountIds])
  const candidatesRequest = useRef(0)
  const candidatesScope = useRef('')
  candidatesScope.current = chosen.map((s) => s.id).join(',')

  /* 配信対象の候補：選んだアカウントごとにタグ・シナリオ・保存した条件を読み、同じ名前でまとめる。 */
  const loadTags = useCallback(async () => {
    const request = ++candidatesRequest.current
    const scope = chosen.map((s) => s.id).join(',')
    const current = () => request === candidatesRequest.current && scope === candidatesScope.current
    if (chosen.length === 0) { setTagOptions([]); setScenarioOptions([]); setSavedOptions([]); setTagStatus('ready'); return }
    setTagStatus('loading')
    const group = (lists: string[][]) => {
      const count = new Map<string, number>()
      for (const names of lists) for (const name of new Set(names)) count.set(name, (count.get(name) ?? 0) + 1)
      return [...count].map(([name, accounts]) => ({ name, accounts })).sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name, 'ja'))
    }
    try {
      const [tagLists, scenarioLists, savedLists] = await Promise.all([
        Promise.all(chosen.map((s) => api.tags.list({ accountId: s.id }))),
        Promise.all(chosen.map((s) => api.scenarios.list({ accountId: s.id }))),
        Promise.all(chosen.map((s) => api.segmentPresets.list(s.id))),
      ])
      if (!current()) return
      if ([...tagLists, ...scenarioLists, ...savedLists].some((res) => !res.success)) throw new Error('candidates')
      setTagOptions(group(tagLists.map((res) => {if(!res.success)throw new Error(res.error);return res.data.map((t) => t.name)})))
      setScenarioOptions(group(scenarioLists.map((res) => {if(!res.success)throw new Error(res.error);return res.data.map((t) => t.name)})))
      setSavedOptions(group(savedLists.map((res) => {if(!res.success)throw new Error(res.error);return res.data.map((t) => t.name)})))
      setTagStatus('ready')
    } catch (saveFailure) {
      if (!current()) return
      saveErrors.capture(saveFailure)
      setTagStatus('error')
    }
  }, [chosen, saveErrors]);

  const tagKey = chosen.map((s) => s.id).join(',')
  useEffect(() => {
    if (step !== 'audience' && audience === 'all') return
    void loadTags()
    // 選んだアカウントが変わったときだけ読み直す。
  }, [audience, tagKey, step === 'audience']) // eslint-disable-line react-hooks/exhaustive-deps

  const changeStep = (next: BroadcastStepKey) => {
    setStep(next)
    const q = new URLSearchParams(window.location.search)
    if (next === 'basic') q.delete('step'); else q.set('step', next)
    if (draftId) q.set('id', draftId)
    samePageUrl.replace(`/hq/broadcasts/new${q.size ? `?${q.toString()}` : ''}`)
    if (next === 'confirm' && (!checks || stale)) void check()
  }

  const scheduledAt = when === 'now' ? null : jstIso(date, time)
  const kindAssets = (assets ?? []).filter((a) => (kind === 'rich' || kind === 'coupon') && a.kind === ASSET_KIND[kind])
  /* 吹き出しは口の messageBubblesJson と同じ形（店の一斉配信と同じ）。テキスト1つだけのときは今までどおり本文だけで送る。 */
  const apiBubbles = bubbles.map((item, index) => toApiBubble(item, `hq-b-${index + 1}`))
  const single = bubbles.length === 1
  const bubble = single && kind !== 'text' ? apiBubbles[0] : null
  const legacy = bubble ? bubbleLegacyMessage(bubble) : null
  const firstText = bubbles.find((item) => item.kind === 'text')
  const targetMode = audience === 'scenario' || audience === 'advanced' ? 'segment' : undefined
  const segmentConditions = audience === 'scenario'
    ? { operator: 'AND' as const, rules: [{ type: 'scenario_subscribed', value: scenarioName }] }
    : audience === 'advanced' ? pruneCondition(condition) ?? undefined : undefined
  const input: Omit<HqBroadcastInput, 'requestId'> = {
    title: title.trim(),
    /* 画像・動画・スタンプ・カルーセル・素材は、店の一斉配信と同じく LINE へ渡せる種類（image・carousel・flex・imagemap など）に直して送る。 */
    messageType: single ? (kind === 'text' ? 'text' : ((legacy?.messageType ?? 'flex') as HqBroadcastInput['messageType'])) : 'text',
    messageContent: single ? (kind === 'text' ? toApiContent(body) : (legacy?.messageContent ?? '')) : toApiContent(firstText?.body ?? ''),
    ...(single ? (bubble ? { messageBubblesJson: JSON.stringify([bubble]) } : {}) : { messageBubblesJson: JSON.stringify(apiBubbles.filter(Boolean)) }),
    accountIds: chosen.map((s) => s.id),
    accountTagIds: [],
    excludedAccountIds: excluded.filter((id) => accountIds.includes(id)),
    audience: audience === 'tag' && tagName ? { kind: 'tag', tagName } : { kind: 'all' },
    ...(targetMode ? { targetType: targetMode } : {}),
    ...(segmentConditions ? { segmentConditions } : {}),
    ...(audience === 'advanced' && savedName ? { savedSearchId: savedName } : {}),
    ...(excludeTag ? { excludedTagIds: [excludeTag] } : {}),
    ...(folderId ? { folderId } : {}),
    ...(internalMemo.trim() ? { internalMemo: internalMemo.trim() } : {}),
    scheduledAt,
  }
  const key = JSON.stringify(input)
  const inputScope = useRef({ key })
  if (inputScope.current.key !== key) inputScope.current = { key }
  const openedInputScope = useRef<typeof inputScope.current | null>(null)
  const confirmChanged = confirmOpen && openedInputScope.current !== inputScope.current
  const stale = !!run && !!checks && runKey !== key
  /* 承認の状態（⑤ を開いて確かめたあと。中身を変えると口が承認を外す）。 */
  const approval = useHqApproval(step === 'confirm' && run && !stale ? run : null)
  const gate = approvalGate(approval.state)
  /** テストを送る前に、下書きを今の中身にそろえる。 */
  const prepareForTest = async () => {
    const result = !run || stale || !checks ? await check() : { run }
    return result?.run.id ?? null
  }

  /*
   * 吹き出しの不備（・店の一斉配信と同じ）：帯ではなく吹き出しの中身の下に理由、頭に赤い丸、
   * メッセージの段を開いて1つ目の吹き出しへ移る。配信名・送り先・日時は段の帯（［〇〇へ移動］つき）のまま。
   */
  const fields = useFormErrors()
  fields.define('title', '配信名', () => !title.trim() ? '配信名を入れてください' : title.trim().length > TITLE_MAX ? `配信名は${TITLE_MAX}文字までです` : null, { ...({ reveal: () => changeStep('basic') }), required: true })
  fields.define('accountIds', '送るアカウント', () => chosen.length ? null : '送るアカウントを選んでください', { ...({ reveal: () => changeStep('audience') }), required: true })
  fields.define('candidates', '配信対象の候補', () => chosen.length && tagStatus !== 'ready' ? '配信対象の候補を読み直してください' : null, { reveal: () => changeStep('audience') })
  fields.define('tagName', '送る相手のタグ', () => audience === 'tag' && !tagName ? '送る相手のタグを選んでください' : null, { ...({ reveal: () => changeStep('audience') }), required: audience === 'tag' })
  fields.define('target', '配信対象', () => audience === 'advanced' && !pruneCondition(condition) && !savedName ? '詳細条件を入力するか、保存した条件を選んでください' : null, { ...({ reveal: () => changeStep('audience') }), required: audience === 'advanced' })
  fields.define('scheduledAt', '送る日時', () => when === 'later' && !scheduledAt ? '送る日時を選んでください' : scheduledAt && Date.parse(scheduledAt) <= Date.now() ? '予約日時は今より後にしてください' : null, { ...({ reveal: () => changeStep('schedule') }), required: when === 'later' })
  bubbles.forEach((item, index) => {
    fields.define(`bubble-${index}`, `${index + 1} 通目`, () => hqBubbleProblem(item) || null, {
      reveal: () => { if (step !== 'message') changeStep('message'); setOpenBubble(index) },
      group: `bubble-${index}`,
    })
  })

  /** 入れていない所と、その欄のある段（店の一斉配信の「保存を押した段で理由を示す」と同じ）。 */
  const problem = (): { message: string; step: BroadcastStepKey } | null => {
    if (!title.trim()) return { message: '配信名を入れてください', step: 'basic' }
    if (title.trim().length > TITLE_MAX) return { message: `配信名は${TITLE_MAX}文字までです`, step: 'basic' }
    if (chosen.length === 0) return { message: '送るアカウントを選んでください', step: 'audience' }
    if (audience === 'tag' && !tagName) return { message: '送る相手のタグを選んでください', step: 'audience' }
    if (audience === 'advanced' && !pruneCondition(condition) && !savedName) return { message: '詳細条件を1つ以上入力するか、保存した条件を選んでください。全員に送るなら「友だち全員に配信する」を選んでください', step: 'audience' }
    for (const [index, item] of bubbles.entries()) {
      /* 質問・紹介（統括の口がまだ受けない）もここで止め、口を呼ばない。 */
      const why = hqBubbleProblem(item)
      if (why) return { message: `${bubbles.length > 1 ? `${index + 1} 通目の` : ''}${why}`, step: 'message' }
    }
    if (when === 'later' && !scheduledAt) return { message: '送る日時を選んでください', step: 'schedule' }
    if (scheduledAt && Date.parse(scheduledAt) <= Date.now()) return { message: '予約日時は今より後にしてください', step: 'schedule' }
    return null
  }

  /** 作る（下書きを固定）→ 確かめる → 問題のある店を外す。中身が変わったら同じ下書きを直す（版つき・依頼番号はそのまま）。 */
  const check = async (): Promise<{ run: HqBroadcastRun; checks: HqBroadcastPreflight[] } | null> => {
    const why = problem()
    if (why) {
      if ( fields.submit().length > 0) { setError(''); setErrorStep(null); return null }
      setError(why.message); setErrorStep(why.step); return null
    }
    setChecking(true); setError(''); setErrorStep(null)
    try {
      let current = run
      if (!current || preparedKeyRef.current?.id !== current.id || preparedKeyRef.current.key !== key) {
        const requestId = current?.input?.requestId || requestRef.current
        if (current && current.status === 'prepared' && requestId) {
          current = (await hqBroadcastsApi.update(current.id, { ...input, requestId, expectedVersion: current.version })).data
        } else {
          // WEB011：応答が切れた作成のやり直しは、同じ中身なら同じ依頼番号で送る（別の下書きを作らない）。
          if (!requestRef.current || createKeyRef.current !== key) {
            requestRef.current = crypto.randomUUID()
            createKeyRef.current = key
          }
          current = (await hqBroadcastsApi.create({ ...input, requestId: requestRef.current })).data
        }
        // WEB011：作れた・直せた下書きは、確かめ（preflight）の前にすぐ覚える。
        // 後の工程が失敗したやり直しは、保存済みの下書きと版から再開する。
        setRun(current)
        preparedKeyRef.current = { id: current.id, key }
      }
      // 保存した下書きの住所は、後の確かめが失敗しても再読込から開けるよう直ちに残す。
      if (current.id !== draftId) {
        setDraftId(current.id)
        const q = new URLSearchParams(window.location.search)
        q.set('id', current.id)
        samePageUrl.replace(`/hq/broadcasts/new?${q.toString()}`)
      }
      let list = (await hqBroadcastsApi.preflight(current.id)).data
      const blocked = list.filter((p) => p.blockedReasons.length > 0 && !p.excluded).map((p) => p.accountId)
      if (blocked.length > 0) {
        const ids = [...new Set([...list.filter((p) => p.excluded).map((p) => p.accountId), ...blocked])]
        current = (await hqBroadcastsApi.exclude(current.id, ids, current.version)).data
        setRun(current)
        list = list.map((p) => (ids.includes(p.accountId) ? { ...p, excluded: true } : p))
      }
      setRun(current); setRunKey(key); setChecks(list); setSavedAt(new Date().toISOString())
      return { run: current, checks: list }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught, fields)

      { if (!fieldFailure)


      setError(errorText(caught, '送る前の確かめができませんでした。もう一度お試しください。')) }
      return null
    } finally {
      setChecking(false)
    }
  }

  /** 表の「…」：この店を外す／この店に送る（問題の無い店だけ戻せる）。 */
  const toggleExclude = async (p: HqBroadcastPreflight) => {
    if (!run || !checks) return
    const ids = checks.filter((c) => (c.accountId === p.accountId ? !p.excluded : c.excluded)).map((c) => c.accountId)
    try {
      const next = (await hqBroadcastsApi.exclude(run.id, ids, run.version)).data
      setRun(next)
      setChecks(checks.map((c) => ({ ...c, excluded: ids.includes(c.accountId) })))
      setExcluded(ids)
      const nextKey = JSON.stringify({ ...input, excludedAccountIds: ids.filter((id) => accountIds.includes(id)) })
      preparedKeyRef.current = { id: next.id, key: nextKey }
      setRunKey(nextKey)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught, fields)

      { if (!fieldFailure)


      setError(errorText(caught, 'アカウントを外せませんでした。もう一度お試しください。')) }
    }
  }

  const saveDraft = async () => {
    const result = await check()
    if (result) notifySaved('下書きに保存しました')
  }

  /*
   * 送る（⑤ の主ボタン）。送る人数が多いときは承認が要る（API-18）：
   * 2人以上の運用は「承認を依頼する」→ 承認されたら送る。1人運用は確かめの窓で人数を入れる。
   */
  const askSend = async () => {
    const result = !run || stale || !checks ? await check() : { run, checks }
    if (!result) return
    if (sendTotals(result.checks).sendStores === 0) { setError('送れるアカウントがありません。外したアカウントの問題を直すか、送るアカウントを変えてください。'); return }
    let state = approval.state
    try { state = (await hqBroadcastsApi.approval(result.run.id)).data } catch (saveFailure) {
      saveErrors.capture(saveFailure) /* 読めなければ口が送るときに止める。 */ }
    const nextGate = approvalGate(state)
    approval.reload();

    if (nextGate === 'needsRequest') { setApprovalRequestOpen(true); return }
    if (nextGate === 'pending') { setError('承認を待っています。承認されると送れます。'); setErrorStep(null); return }
    setConfirmCount('')
    openedInputScope.current = inputScope.current
    confirmTicket.current = {}
    setConfirmOpen(true)
  }

  useEffect(() => {
    if (!confirmOpen || !run) return
    let alive = true
    setSendPreview({ state: 'loading', data: null })
    void chatSafetyApi.hqSendPreview(run.id)
      .then((res) => { if (alive) setSendPreview(res.success ? { state: 'ready', data: res.data } : { state: 'error', data: null }) })
      .catch(() => { if (alive) setSendPreview({ state: 'error', data: null }) })
    return () => { alive = false }
  }, [confirmOpen, run, previewSeq])

  const sendRunId=run?.id??''
  const sendRunVersion=run?.version??0
  if(sendScope.current.open!==confirmOpen||sendScope.current.runId!==sendRunId||sendScope.current.version!==sendRunVersion) sendScope.current={open:confirmOpen,runId:sendRunId,version:sendRunVersion,generation:sendScope.current.generation+1}
  const renderedSendScope=sendScope.current
  const closeSendConfirmation=()=>{sendScope.current={...sendScope.current,open:false,generation:sendScope.current.generation+1};closeConfirm()}
  const confirmedAccountIds = checks?.filter(item => !item.excluded && item.blockedReasons.length === 0).map(item => item.accountId) ?? []
  const confirmedAudiences = sendPreview.state === 'ready' && sendPreview.data !== null && run !== null && sendPreview.data.expectedVersion === run.version && Array.isArray(sendPreview.data.perAccount)
    && sendPreview.data.perAccount.length === confirmedAccountIds.length && sendPreview.data.perAccount.every(item => confirmedAccountIds.includes(item.accountId))
    && sendPreview.data.perAccount.length > 0 && sendPreview.data.perAccount.every(item => typeof item.accountId === 'string' && Number.isSafeInteger(item.recipients) && item.recipients >= 0 && typeof item.recipientToken === 'string' && /^[a-f0-9]{64}$/.test(item.recipientToken))
    && new Set(sendPreview.data.perAccount.map(item => item.accountId)).size === sendPreview.data.perAccount.length
    && sendPreview.data.perAccount.reduce((sum,item) => sum + item.recipients,0) === sendPreview.data.recipients
    ? sendPreview.data.perAccount.map(item => ({ accountId:item.accountId, recipientCount:item.recipients, recipientToken:item.recipientToken! })) : null
  const send = async () => {
    if (!run || stale || sending || sendLock.current || !confirmOpen || !renderedSendScope.open || sendScope.current !== renderedSendScope || !confirmedAudiences) return
    sendLock.current=true
    setSending(true)
    setError('')
    let accepted = false
    try {
      await hqBroadcastsApi.send(run.id, run.version, gate === 'single' ? Number(confirmCount) : undefined, confirmedAudiences)
      accepted = true
      closeConfirm()
      notifyToast(when === 'now' ? '一括配信を送り始めました' : '一括配信を予約しました')
      setLeaving(true)
      router.push(`/hq/broadcasts/detail?id=${encodeURIComponent(run.id)}`)
      return true
    } catch (caught) {
      if (accepted) { closeConfirm(); setLeaving(true); notifyToast('送る依頼は受け付けました。配信の記録を確認してください。'); return true }
      saveErrors.capture(caught, fields)
      setRunKey('')
      setError(`${errorText(caught, '送れませんでした。')} 閉じて、送る前の確かめをやり直してください。`)
      return false
    } finally {
      sendLock.current=false
      setSending(false)
    }
  }

  /** ① 配信方法「テンプレートを選択」・③［テンプレートから選ぶ］：統括のメッセージのひな形を開いている吹き出しに読み込む。 */
  const applyTemplate = async (id: string): Promise<string | null> => {
    if (!id) return 'テンプレートを選んでください'
    try {
      const detail = await hqTemplatesApi.get(id)
      if (detail.template.template_type !== 'template') return 'メッセージのテンプレートを選んでください'
      const read = bubbleFromTemplate(id, detail.definition as MessageTemplateDefinition, detail.template.current_version_id)
      if ('error' in read) return read.error
      setBubbles([{ ...read.bubble, body: read.bubble.body.slice(0, BODY_MAX) }]); setOpenBubble(0)
      if (!title.trim()) setTitle((detail.definition as MessageTemplateDefinition).template.name.slice(0, TITLE_MAX))
      setError(''); setErrorStep(null)
      return null
    } catch (caught) {
      saveErrors.capture(caught, fields);

      return errorText(caught, 'ひな形を読み込めませんでした。もう一度お試しください。')
    }
  }
  /** ③ カルーセル：統括のカルーセルのひな形を読み、中身（カード）を吹き出しに控える。 */
  const chooseCarousel = async (id: string) => {
    setCarouselError('')
    if (!id) { setContent({}); return }
    try {
      const detail = await hqTemplatesApi.get(id)
      if (detail.template.template_type !== 'template') return
      const read = bubbleFromTemplate(id, detail.definition as MessageTemplateDefinition, detail.template.current_version_id)
      if ('error' in read || read.bubble.kind !== 'carousel') { setCarouselError('error' in read ? read.error : 'カルーセルのテンプレートを選んでください'); return }
      setContent(read.bubble.content, read.bubble.cardAsset)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught, fields)

      { if (!fieldFailure)
      setCarouselError(errorText(caught, 'カルーセルを読み込めませんでした。もう一度お試しください。')) }
    }
  }
  /** ③［テンプレートから選ぶ］：選んだひな形で開いている吹き出しを置き換える。読めない種類は窓の中に理由を出す。 */
  const pickTemplate = async (id: string): Promise<string | null> => {
    try {
      const detail = await hqTemplatesApi.get(id)
      if (detail.template.template_type !== 'template') return 'メッセージのテンプレートを選んでください'
      const read = bubbleFromTemplate(id, detail.definition as MessageTemplateDefinition, detail.template.current_version_id)
      if ('error' in read) return read.error
      replaceActive({ ...read.bubble, body: read.bubble.body.slice(0, BODY_MAX) })
      setCarouselError('')
      return null
    } catch (caught) {
      saveErrors.capture(caught, fields);

      return errorText(caught, 'テンプレートを読み込めませんでした。もう一度お試しください。')
    }
  }
  /**
   * ① 最近の配信・「過去の配信を複製」・詳細の［複製して作る］：配信名に「（コピー）」を付け、中身（吹き出し）・フォルダ・社内メモを写す。
   * 宛先（送るアカウント・対象）と日時は写さない（RqYwI・オーナー 10-08）。
   */
  const duplicate = (source: HqBroadcastRun) => {
    const saved = source.input
    if (hasUnsupportedBubbles(saved)) { setError('この配信には読み込めないメッセージがあるため複製できません。元の内容は変更していません。'); setErrorStep(null); return }
    setMethod('duplicate')
    setCopiedRun(source)
    setTitle(`${saved.title}（コピー）`.slice(0, TITLE_MAX))
    setFolderId(saved.folderId ?? '')
    setInternalMemo(saved.internalMemo ?? '')
    setBubbles(bubblesFromInput(saved)); setOpenBubble(0)
    notifyToast(`「${saved.title}」の中身を写しました`)
  }

  const insert = (label: string) => {
    const el = bodyRef.current
    const at = el?.selectionStart ?? body.length
    setBody((text) => `${text.slice(0, at)}${label}${text.slice(at)}`.slice(0, BODY_MAX))
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + label.length, at + label.length) })
  }

  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: !leaving && (body.trim().length > 0 || title.trim().length > 0 || accountIds.length > 0),
    busy: checking || sending,
    samePage: (url) => url.pathname === '/hq/broadcasts/new',
  })

  const sendableChosen = chosen.filter((s) => !excluded.includes(s.id))
  const friendTotal = sendableChosen.some((s) => s.friendCount == null) ? null : sendableChosen.reduce((sum, s) => sum + (s.friendCount ?? 0), 0)
  const accountSummary = `${chosen.slice(0, 2).map((account) => account.name).join('・')}${chosen.length > 2 ? ` ほか${chosen.length - 2}` : ''}`
  /** 統括のタグ・シナリオは名前で送る（API-18）。窓の候補も名前を ID にする。 */
  const byName = (rows: Array<{ name: string; accounts: number }> | null | undefined) => (rows ?? []).map((t) => ({ id: t.name, name: t.name, meta: `${t.accounts}/${chosen.length}アカウント` }))
  const closeAccountPicker = () => { setAccountPickerOpen(false); requestAnimationFrame(() => accountPickerTrigger.current?.focus()) }
  const totals = checks && !stale ? sendTotals(checks) : null
  const peopleLabel = totals ? `${formatNumber(totals.sendPeople)} 人` : audience === 'all' && chosen.length > 0 && friendTotal != null ? `${formatNumber(friendTotal)} 人` : '—人'
  const audienceLabel = audience === 'tag' ? (tagName ? `タグ：${tagName}` : 'タグ：未選択')
    : audience === 'scenario' ? (scenarioName ? `シナリオ「${scenarioName}」を購読中` : 'シナリオ購読中の全員')
    : audience === 'advanced' ? (savedName ? `保存した条件「${savedName}」${pruneCondition(condition) ? '＋詳細条件' : ''}` : pruneCondition(condition) ? '詳細条件' : '詳細条件：未設定')
    : '友だち全員'
  const audienceFull = `${audienceLabel}${excludeTag ? `・タグ「${excludeTag}」を除く` : ''}`
  const bubblesDone = bubbles.every((item) => !hqBubbleProblem(item))
  const bubbleSummary = hqBubbleSummary
  const accountsLabel = chosen.length === 0 ? '未選択' : chosen.length <= 2 ? chosen.map((s) => s.name).join('・') : `${chosen[0].name} ほか ${chosen.length - 1}アカウント`
  const sendWhenLabel = when === 'now' ? '今すぐ' : scheduledAt ? jpDateTime(scheduledAt) : emptyValue('unconfigured')
  const { shown, rest } = splitPreflightRows(checks ?? [], showAll ? Infinity : ROWS_SHOWN)
  const exampleStore = (checks ?? []).find((p) => !p.excluded && !p.blockedReasons.length)?.accountName ?? chosen[0]?.name ?? '店の名前'
  const previewBubbles = bubbles.map((item) => step === 'message' && item.kind === 'carousel' && !item.cardAsset ? toApiBubble(item, item.id) : previewBubbleOf(item, previewText(item.body, exampleStore)) ?? toApiBubble(item, item.id))
  const steps = broadcastSteps({
    basicDone: Boolean(title.trim()) && title.trim().length <= TITLE_MAX,
    audienceDone: chosen.length > 0 && (audience === 'all' || audience === 'scenario' || (audience === 'tag' && Boolean(tagName)) || (audience === 'advanced' && (Boolean(pruneCondition(condition)) || Boolean(savedName)))),
    messageDone: bubblesDone,
    scheduleDone: when === 'now' || Boolean(scheduledAt),
  })
  const stepIndex = STEP_ORDER.indexOf(step)
  const draftLabel = savedAt ? `下書き保存済み・${formatRelative(savedAt)}` : draftState === 'ready' ? '保存済みの下書きを開いています' : '下書き・未保存'

  /** ［保存してテンプレートにする］：開いている吹き出しを統括のひな形（メッセージ）として保存する。 */
  const saveAsTemplate = async () => {
    const name = saveTplName.trim()
    if (!name) { setSaveTplError('テンプレートの名前を入れてください'); return }
    const made = templateContentOfBubble(active, name)
    if ('error' in made) { setSaveTplError(made.error); return }
    setSaveTplBusy(true); setSaveTplError('')
    try {
      const definition = hostDefinition(freshDefinition('template') as MessageTemplateDefinition, made.content)
      await hqTemplatesApi.create({ type: 'template', name, definition }, crypto.randomUUID())
      setSaveTplOpen(false)
      notifySaved(`テンプレート「${name}」に保存しました`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught, fields)

      { if (!fieldFailure)
      setSaveTplError(errorText(caught, 'テンプレートに保存できませんでした。もう一度お試しください。')) }
    } finally {
      setSaveTplBusy(false)
    }
  }

  const inlineEditor = composer && canManage ? (() => {
    /* 店のカルーセル・リッチメッセージの作る部品をそのまま使う（統括のテンプレートと同じ host の口）。保存は吹き出しに入れるだけ。 */
    const host: TemplateEditHost = {
      composer: { index: openBubble, accountId: null },
      backHref: '/hq/broadcasts',
      description: '作った中身は、この一括配信のメッセージに入ります（テンプレートには残りません）',
      folders: [],
      folder: '',
      onFolderChange: () => {},
      busy: composerBusy,
      primaryLabel: 'この吹き出しに入れる',
      initialContent: hostContentOfBubble(active),
      onSave: async (content, alsoSave) => {
        if (alsoSave) {
          setComposerBusy(true)
          try { await hqTemplatesApi.create({ type: 'template', name: content.name, definition: hostDefinition(freshDefinition('template') as MessageTemplateDefinition, content) }, crypto.randomUUID()) } catch (caught) {
            const fieldFailure = saveErrors.capture(caught, fields)
 { if (!fieldFailure) setCarouselError(errorText(caught, 'テンプレートに保存できませんでした。')); } return false } finally { setComposerBusy(false) }
        }
        const next = bubbleFromHostContent(content)
        if (next) { replaceActive({ ...next, content: { ...next.content, inline: true } }); setCarouselError('') }
        if (!next) return false
        setComposer(null)
        return true
      },
      onCancel: () => setComposer(null),
      notice: carouselError ? <Notice tone="danger">{carouselError}</Notice> : undefined,
      uploadCarouselImage: (file) => hqTemplatesApi.uploadImage(file, 'message'),
      uploadRichImage: (file) => hqTemplatesApi.uploadRichMessageImage(file),
    }
    return composer === 'carousel' ? <CarouselV8 host={host} /> : <TemplateRichEditor host={host} />
  })() : null

  if (!canManage) {
    return (
      <SaveErrorScope errors={saveErrors}><SaveErrorScope errors={fields}><PageFrame kind="create" boardId="BBRDb">
        <PageHeading title={<>一括配信を作る</>} />
        <PageContent>
          <Notice tone="info">一括配信を作れるのは、統括全体の編集権限がある人（オーナー・管理者）だけです。</Notice>
        </PageContent>
      </PageFrame></SaveErrorScope></SaveErrorScope>
    )
  }

  if (draftState === 'loading' || (draftState === 'ready' && params.get('id') && params.get('id') !== run?.id)) {
    return <PageFrame kind="create" boardId="BBRDb"><PageHeading title={<>一括配信を作る</>} /><PageContent><Notice tone="info" role="status">下書きを読み込んでいます…</Notice></PageContent></PageFrame>
  }
  if (draftState === 'unsupported' || draftState === 'error') {
    return <PageFrame kind="create" boardId="BBRDb"><PageHeading title={<>一括配信を作る</>} /><PageContent><Notice tone="danger" role="alert" action={<Link href="/hq/broadcasts">一括配信の一覧へ</Link>}>{draftState === 'unsupported' ? 'この配信には読み込めないメッセージが含まれています。編集・保存・送信はできません。元の内容は変更していません。' : '配信を読み込めませんでした。一括配信の一覧から開き直してください。'}</Notice></PageContent></PageFrame>
  }

  const shows = (key: BroadcastStepKey) => step === key
  const nextLabel = step === 'basic' ? '対象設定へ' : step === 'audience' ? 'メッセージ設定へ' : step === 'message' ? '送信設定へ' : '配信前チェックへ'

  const messagePreview = <div className={previewDevice === 'pc' ? formStyles.pcPreview : formStyles.phonePreview}>
              <LinePreview accountName={exampleStore} caption={when === 'now' ? '今日' : sendWhenLabel} note={`${exampleStore}の例です。差し込みはアカウントごとに変わります（予約ページは省いて見せています）。`}
                empty={previewBubbles.every((item) => !item) ? 'メッセージは「メッセージを作成」で作ります' : false}>
                <div className="flex flex-col gap-3 text-ink">
                  {previewBubbles.map((item, index) => (item ? <BubblePreview key={bubbles[index].id} bubble={item} accountName={exampleStore} composer={step === 'message'} /> : null))}
                </div>
              </LinePreview>
            </div>

  const previewContent = (inDialog = false) => <>            <div className={formStyles.previewHead}>
              <h3>LINE の見え方</h3>
              <div className={formStyles.deviceSwitch} role="group" aria-label="プレビューの端末">
                <Button variant="secondary" className={formStyles.textButton} size="compact" aria-pressed={previewDevice === 'phone'} onClick={() => setPreviewDevice('phone')}>スマホ</Button>
                <Button variant="secondary" className={formStyles.textButton} size="compact" aria-pressed={previewDevice === 'pc'} onClick={() => setPreviewDevice('pc')}>PC</Button>
              </div>
            </div>
            {messagePreview}
            <p className={formStyles.previewCaption}>{'店名は例のアカウントの名前で見せています'}</p>
            <div className={formStyles.previewSummary}><h3>設定内容</h3><dl>{[
              ...(step === 'message' ? [] : [['送るアカウント', chosen.length ? `${accountsLabel}（${formatNumber(chosen.length)}）` : '未選択']]),
              ['送る相手', `${audienceFull}（${peopleLabel}）`],
              ['送る日時', sendWhenLabel],
              ...(step === 'message' ? [['配信後のアクション', '—']] : []),
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl></div>
            <div className={formStyles.previewActions}>
              <Button type="button" disabled={checking || chosen.length === 0} title={chosen.length === 0 ? '先に送るアカウントを選んでください' : undefined} onClick={() => setTestOpen(true)}><Send size={16} aria-hidden /> テストを送る</Button>
              {!inDialog ? <PreviewLauncher key={previewKey} label="配信イメージを見る" onOpened={previewOpened}>{messagePreview}</PreviewLauncher> : null}
            </div>
            <SaveErrorField names={["previewConfirmed","preview_confirmed"]}><Checkbox checked={previewConfirmed} onCheckedChange={setPreviewConfirmed} disabled={!previewReview.ready} disabledReason="配信イメージを開いて確認してください">{previewConfirmed ? 'LINEプレビュー確認済み' : 'LINEプレビューが未確認です'}</Checkbox></SaveErrorField>
</>

  return (
    <SaveErrorScope errors={saveErrors}><SaveErrorScope errors={fields}><>
      <CreatePage step={stepIndex} boardId="BBRDb" dirty={false}
        footerActions={(
          <>
            {step === 'basic' ? (checking || sending || composerBusy ? <Button disabled>キャンセル</Button> : <Button href="/hq/broadcasts">キャンセル</Button>) : null}
            {step === 'confirm' ? <Button type="button" onClick={() => changeStep('schedule')}>戻って修正</Button> : null}
            <Button variant="secondary" className={formStyles.textButton} type="button" disabled={checking || sending || composerBusy} busy={checking && step !== 'confirm'} onClick={() => void saveDraft()}>下書きを保存する</Button>
            {step !== 'confirm' ? (
              <Button variant="primary" disabled={composerBusy || (step === 'audience' && chosen.length > 0 && tagStatus !== 'ready')} onClick={() => changeStep(STEP_ORDER[Math.min(stepIndex + 1, STEP_ORDER.length - 1)])}>
                {step === 'message' ? <><span>{nextLabel}</span><ArrowRight size={16} aria-hidden /></> : nextLabel}
              </Button>
            ) : (
              <Button variant="primary" busy={checking || sending} disabled={sending || gate === 'pending'} onClick={() => void askSend()}>
                {gate === 'needsRequest' ? '承認を依頼する' : gate === 'pending' ? '承認を待っています' : when === 'later' ? 'この内容で予約する' : '今すぐ送る'}
              </Button>
            )}
          </>
        )}
        preview={previewContent()}
        previewLabel="LINEの見え方"
        previewToggle={<PreviewLauncher key={previewKey} onOpened={previewOpened}>{previewContent(true)}</PreviewLauncher>}
        status={draftLabel}
         title={<>一括配信を作る</>} headingSize="compact"
        help="送るアカウントを選び、配信対象・メッセージ・送信設定を確かめてから配信します。下書きの保存では、友だちへ送信しません。"
        steps={<><Steps connectorSize={step === 'message' ? 'short' : undefined} label="配信作成の進み" steps={steps.map((item) => ({ ...item, onSelect: () => changeStep(item.key) }))} currentKey={step} summaries={{ basic: title.trim(), audience: `${chosen.length}アカウント`, message: `${formatNumber(bubbles.length)}通`, schedule: sendWhenLabel ?? '未設定' }} /></>}
        >
        {error ? (
          <Notice
            tone="danger"
            role="alert"
            action={errorStep && errorStep !== step ? (
              <Button variant="secondary" size="compact" onClick={() => changeStep(errorStep)}>{`${steps[STEP_ORDER.indexOf(errorStep)].label}へ移動`}</Button>
            ) : undefined}
          >
            {error}
          </Notice>
        ) : null}
        {draftState === 'sent' ? (
          <Notice tone="warn" role="alert" action={<Button size="compact" href={`/hq/broadcasts/detail?id=${encodeURIComponent(params.get('id') ?? '')}`}>詳細を見る</Button>}>
            この一括配信はもう送った（予約した）ので直せません。新しく作るときは、送るアカウントと中身を入れてください。
          </Notice>
        ) : null}


            {/* ① 基本設定（lmWCZ） */}
            {shows('basic') ? (
              <section id="broadcast-step-basic" className={formStyles.section}>
                <h3>配信方法</h3>
                <SaveErrorField names={["hq-broadcast-method","value","method"]}><RadioCardGroup legend="配信方法" className={formStyles.methodCards}>
                  {/* EpTBB：3つのカードは左上に印（書く・テンプレート・写す）。 */}
                  {([
                    ['new', '新しいメッセージを作る', 'テキスト・画像・カルーセルなどを組み合わせて一から作ります。', SquarePen],
                    ['template', 'テンプレートを選択', '統括のテンプレートを呼び出して手直しします。', FileText],
                    ['duplicate', '過去の配信を複製', '送った一括配信をそのまま写して作り直します。', Copy],
                  ] as const).map(([value, label, note, Icon]) => (
                    <RadioCard key={value} name="hq-broadcast-method" value={value} checked={method === value} title={label} note={note} icon={<Icon aria-hidden="true" />} disabled={value === 'duplicate' && (recentStatus !== 'ready' || recent.length === 0)} disabledReason={value !== 'duplicate' ? undefined : recentStatus === 'loading' ? '配信履歴を確認しています。' : recentStatus === 'error' ? '配信履歴を確認できません。画面を読み直してください。' : recent.length === 0 ? '複製できる配信がありません。' : undefined} onChange={(next) => setMethod(next as Method)} />
                  ))}
                </RadioCardGroup></SaveErrorField>
                {/* EpTBB：①は選ぶボタン／選んだ1行だけ。窓の仮選択は確定するまで反映しない。 */}
                {method === 'template' ? selectedTemplate ? (
                  <SourcePickerSelection buttonRef={basicPickerTrigger} item={selectedTemplate.item} folders={selectedTemplate.folders} onChange={() => setBasicPicker('template')} />
                ) : <Button ref={basicPickerTrigger} onClick={() => setBasicPicker('template')}>テンプレートを選ぶ</Button> : null}
                {method === 'duplicate' ? copiedRun ? (
                  <SourcePickerSelection buttonRef={basicPickerTrigger} item={broadcastPickerItem(copiedRun)} folders={hqFolders} onChange={() => setBasicPicker('duplicate')} />
                ) : <Button ref={basicPickerTrigger} onClick={() => setBasicPicker('duplicate')}>過去の配信を選ぶ</Button> : null}
                <Field label="配信名" requirement={fields.requirement('title')} count={{ value: title.trim().length, max: TITLE_MAX }}><SaveErrorField names={["title"]}><SharedTextField {...fields.bind('title')} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：8月キャンペーンのお知らせ" className={formStyles.textInput} aria-label="配信名" maxLength={TITLE_MAX * 2} /></SaveErrorField>
<small>友だちには表示されません。一覧で見分けるための名前です</small></Field>
                {/* 店の一斉配信と同じフォルダ・社内メモ（統括の一括配信のフォルダ。API-18） */}
                <SettingsFormRow layout="columns">
                  <Field label="フォルダ"><SaveErrorField names={["folderId","folder_id"]}><FolderSelect aria-label="フォルダ" value={folderId} onChange={setFolderId} folders={hqFolders.map((f) => ({ value: f.id, label: f.name, color: f.color }))} onCreate={canManage ? createHqFolder : undefined} size="full" /></SaveErrorField></Field>
                  <Field label="社内メモ" help={<>友だちには表示されません。各アカウントの配信にも同じメモが残ります</>}><SaveErrorField names={["internalMemo","internal_memo"]}><SharedTextArea aria-label="社内メモ" value={internalMemo} onChange={(event) => setInternalMemo(event.target.value)} rows={1} maxLength={10000} className={formStyles.textInput} placeholder="友だちには表示されません" /></SaveErrorField></Field>
                </SettingsFormRow>
                <div className={formStyles.recentHeader}><h3>最近の配信</h3><Link href="/hq/broadcasts">一括配信の一覧を見る →</Link></div>
                <div className={formStyles.recentList}>
                  {recent.length ? recent.map((item) => {
                    const people = runPeople(item)
                    return (
                      <div key={item.id} className={formStyles.recentRow}>
                        <Send size={16} aria-hidden /><span className={formStyles.recentName} title={item.title}>{item.title}</span>
                        <span className="text-ink-faint">{jpDateTime(item.scheduledAt)} 送信・{formatNumber(people)} 人</span>
                        <Button size="compact" onClick={() => duplicate(item)}>複製する</Button>
                      </div>
                    )
                  }) : <p className="text-xs text-ink-faint">{recentStatus === 'loading' ? '配信履歴を読み込んでいます。' : recentStatus === 'error' ? '配信履歴を読み込めませんでした。' : '最近の配信はまだありません。'}</p>}
                </div>
              </section>
            ) : null}

            {/* ② 配信対象（AL5vR）。上に統括だけの「送るアカウント」（J5DH6o）。 */}
            {shows('audience') ? (
              <section id="broadcast-step-audience" className={formStyles.section}>
                <div className={styles.accounts} data-design-node="J5DH6o">
                  <h3>送るアカウント{fields.requirement('accountIds').required ? <RequiredBadge /> : null}</h3>
                  {loadError && !stores ? <ListState permissionScope="hq" kind="error" error={loadError} onRetry={() => window.location.reload()} /> : !stores ? <ListState permissionScope="hq" kind="loading" /> : (
                    <div className={styles.accountSelection} aria-live="polite">
                      <SaveErrorField names={["accountIds"]}><EntityPickerSummary id="hq-send-accounts" label="送るアカウント" noun="送るアカウント" icon={Building2} name={chosen.length ? `${formatNumber(chosen.length)} アカウント` : ''} meta={accountSummary}
                        readOnly={!canManage} buttonRef={accountPickerTrigger} onOpen={() => setAccountPickerOpen(true)} /></SaveErrorField>
                    </div>
                  )}
                </div>
                <h3>配信対象</h3>
                {/* 店の一斉配信と同じ4つ。タグ・シナリオ・保存した条件は、各アカウントの同じ名前のものに直して送る（API-18）。 */}
                <SaveErrorField names={["target"]}><RadioCardGroup id="hq-send-target" legend="配信対象" className={formStyles.audienceCards}>
                  {TARGET_MODES.map((mode) => (
                    <RadioCard
                      key={mode.value}
                      name="hq-broadcast-target"
                      value={mode.value}
                      checked={audience === mode.value}
                      onChange={() => {
                        if (mode.value === 'advanced') { setConditionDraft(condition); setConditionOpen(true) }
                        setAudience(mode.value)
                      }}
                      title={mode.label}
                      note={mode.value === 'tag' ? '選んだタグが付いている人' : mode.value === 'advanced' ? 'タグ・登録日・反応状態など' : mode.value === 'scenario' ? 'いまシナリオが流れている人' : mode.description}
                    />
                  ))}
                </RadioCardGroup></SaveErrorField>
                {chosen.length === 0 && audience !== 'all' ? <p className="text-xs text-ink-faint">先に送るアカウントを選ぶと、タグ・シナリオ・保存した条件を選べます。</p> : null}
                {tagStatus === 'loading' && audience !== 'all' ? <p className="text-xs text-ink-faint">選んだアカウントのタグ・シナリオを読み込んでいます…</p> : null}
                {tagStatus === 'error' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-warning">タグを読み込めませんでした。通信を確かめて、もう一度お試しください。</p>
                    <Button variant="secondary" size="compact" onClick={() => loadTags()} busyLabel="処理中…">もう一度読み込む</Button>
                  </div>
                ) : null}
                {audience === 'scenario' ? (
                  <div className="border-hairline border-t pt-4">
                    <p className="text-ink-secondary mb-1 block text-xs font-semibold">どのシナリオ</p>
                    <SaveErrorField names={["scenarioName","scenario_name"]}><EntityPickerField label="どのシナリオ" noun="シナリオ" icon={Workflow} items={byName(scenarioOptions)} value={scenarioName} onChange={setScenarioName}
                      clearable placeholder="（すべてのシナリオ：どれか1つでも購読中）" disabled={tagStatus !== 'ready' || chosen.length === 0} /></SaveErrorField>
                    {scenarioName && (scenarioOptions ?? []).some((t) => t.name === scenarioName && t.accounts < chosen.length) ? (
                      <p className="mt-1 text-xs text-warning">このシナリオが無いアカウントには送りません（最終確認で外します）。</p>
                    ) : null}
                  </div>
                ) : null}
                {audience === 'tag' ? (
                  <div className="border-hairline border-t pt-4">
                    <Field label="含めるタグ" requirement={fields.requirement('tagName')}>
                    <SaveErrorField names={["tagName","tag_name"]}><EntityPickerField label="含めるタグ" noun="タグ" icon={TagIcon} items={byName(tagOptions)} value={tagName} onChange={setTagName}
                      disabled={tagStatus !== 'ready' || chosen.length === 0} /></SaveErrorField></Field>
                    {tagStatus === 'ready' && chosen.length > 0 && (tagOptions ?? []).length === 0 ? <p className="mt-1 text-xs text-ink-faint">選んだアカウントにタグがありません。</p> : null}
                    {tagName && (tagOptions ?? []).some((t) => t.name === tagName && t.accounts < chosen.length) ? (
                      <p className="mt-1 text-xs text-warning">このタグが無いアカウントには送りません（最終確認で外します）。</p>
                    ) : null}
                  </div>
                ) : null}
                {audience === 'advanced' ? (
                  <div className="border-hairline border-t pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-ink">配信対象の条件{fields.requirement('target').required ? <RequiredBadge /> : null}</p>
                        <p className="mt-1 text-xs text-ink-faint">{pruneCondition(condition) ? '設定した詳細条件で絞り込みます。' : savedName ? '保存した条件で絞り込みます。' : '条件を1つ以上設定するか、保存した条件を選んでください。'}</p>
                      </div>
                      <Button type="button" onClick={() => { setConditionDraft(condition); setConditionOpen(true) }}>条件を編集</Button>
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className={formStyles.excludeTag}>
                    <SaveErrorField names={["savedName","savedSearchId","saved_name"]}><EntitySelect
                      aria-label="保存した条件から選ぶ"
                      value={savedName}
                      onChange={(value) => { setSavedName(value); if (value) setAudience('advanced') }}
                      disabled={tagStatus !== 'ready' || chosen.length === 0}
                      options={[{ value: '', label: '保存した条件から選ぶ' }, ...(savedOptions ?? []).map((t) => ({ value: t.name, label: `${t.name}（${t.accounts}/${chosen.length}アカウント）` }))]}
                      size="full"
                    /></SaveErrorField>
                  </span>
                </div>
                <BroadcastBlockedExclusion />
                <div className={formStyles.excludeTag}><span className={formStyles.labelRow}>除くタグ <span className="text-xs text-ink-faint">任意</span></span><SaveErrorField names={["excludeTag","exclude_tag"]}><EntityPickerField label="除くタグ" noun="タグ" icon={TagIcon} items={byName(tagOptions)} value={excludeTag} onChange={setExcludeTag} clearable placeholder="（除外なし）" disabled={tagStatus !== 'ready' || chosen.length === 0} /></SaveErrorField></div>
                <div className={formStyles.exclusion}>
                  <Checkbox checked={false} onCheckedChange={() => {}} disabled>この1週間に送った人を除く</Checkbox>
                  <small>現在、最近送った人を除外できません</small>
                </div>
                <div className={formStyles.audienceCount} aria-live="polite"><span><Send size={16} aria-hidden /> この条件で送る人数</span><strong>{peopleLabel}</strong></div>
                {audience !== 'all' && !totals ? <p className="text-xs text-ink-faint">絞った人数は、最終確認でアカウントごとに数えます</p> : null}
                <Notice tone="info"><strong>対象の確認ポイント</strong><br />人数は送る直前にもう一度数え直します</Notice>
              </section>
            ) : null}

            {/* ③ メッセージを作成（lLyFR） */}
            {shows('message') ? (
              <section id="broadcast-step-message" className={formStyles.section}>
                <MessageComposer
                  bubbleErrors={bubbles.map((_, index) => fields.error(`bubble-${index}`))}
                  bubbleFieldProps={(index) => fields.bind(`bubble-${index}`)}
                  bubbles={bubbles.map((item) => item.kind === 'text' ? { id: item.id, type: 'text', content: { text: item.body } } : toApiBubble(item, item.id) ?? { id: item.id, type: 'research', content: item.content })}
                  accountId={null}
                  busy={composerBusy} onBusyChange={setComposerBusy}
                  extraTokens={[...STORE_INSERT_CHIPS,...HQ_INSERT_CHIPS]}
                  inserts={(ref, value, change) => <HqInsertRow count={value.length} max={BODY_MAX} onInsert={token=>insertHqToken(ref,value,change,token,BODY_MAX)}/>}
                  unavailable={{ question: notYetText('question'), intro: notYetText('intro'), rich_video: '統括からリッチビデオはまだ送れません。' }}
                  onChange={(index, next) => { const item = fromApiBubble(next); if (item) setBubbles((items) => items.map((current, i) => i === index ? { ...current, ...item, id: current.id, ...(current.kind === item.kind ? { media: current.media, previewCard: current.previewCard } : {}) } : current)) }}
                  onMove={(index, direction) => { setBubbles((items) => { const next = [...items]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next }); setOpenBubble(index + direction) }}
                  onDelete={(index) => { setBubbles((items) => items.filter((_, i) => i !== index)); setOpenBubble(0) }}
                  onAdd={() => { setBubbles((items) => [...items, newBubble('text')]); setOpenBubble(bubbles.length) }}
                  onPickTemplate={(index, kind) => { setPickerKind(kind); setOpenBubble(index); setPickerOpen(true) }}
                  onSaveTemplate={(index) => { setOpenBubble(index); setSaveTplName(String(bubbles[index].content.templateName ?? bubbles[index].content.assetName ?? '') || title.trim()); setSaveTplError(''); setSaveTplOpen(true) }}
                  onCompose={(index, kind) => { setOpenBubble(index); setCarouselError(''); setComposer(kind === 'carousel' ? 'carousel' : 'rich') }}
                  extraFields={(index, item) => assetsError && item.type === 'coupon'?<ListState kind="error" title="クーポンを読み込めませんでした" onRetry={()=>setAssetsError(false)}/>:item.type === 'coupon' ? <SaveErrorField names={["assetId","item.content.assetId","content.assetId","bubbles","asset_id","item.content.asset_id","content.asset_id"]}><EntitySelect aria-label="クーポンを選ぶ" value={String(item.content.assetId ?? '')} onChange={(id) => { const asset = (assets ?? []).find((a) => a.id === id); setBubbles((items) => items.map((current, i) => i === index ? { ...current, content: asset ? assetContent(asset) : {} } : current)) }} options={[{ value: '', label: '選んでください' }, ...(assets ?? []).filter((a) => a.kind === 'coupon').map((a) => ({ ...entityOptionMetadata(a), value: a.id, label: a.name }))]} size="full" /></SaveErrorField> : item.type === 'flex' ? <p>選んだテンプレートのカードをそのまま送ります。</p> : null}
                />
              </section>
            ) : null}

            {/* ④ 送信設定（ZU4Ae） */}
            {shows('schedule') ? (
              <section id="broadcast-step-schedule" className={formStyles.section}>
                <h3>配信日</h3>
                <SaveErrorField names={["hq-broadcast-send-mode","when"]}><RadioCardGroup legend="配信日" className={formStyles.methodCards}>
                  <RadioCard name="hq-broadcast-send-mode" value="now" checked={when === 'now'} onChange={() => setWhen('now')} title="今すぐ配信" note="⑤の確認で「今すぐ送る」を押すと、確認画面のあとすぐに送ります" />
                  <RadioCard name="hq-broadcast-send-mode" value="later" checked={when === 'later'} onChange={() => setWhen('later')} title="日時を指定して予約" note="決めた日時に、全アカウント同じ時刻で送ります" />
                </RadioCardGroup></SaveErrorField>
                {when === 'later' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><Field label="送る日" htmlFor="hq-bc-date" requirement={fields.requirement('scheduledAt')}><SaveErrorField names={["date", "scheduledAt"]}><DateField id="hq-bc-date" value={date} onChange={setDate} aria-label="送る日" /></SaveErrorField></Field></div>
                    <div><Field label="時刻（日本時間）" htmlFor="hq-bc-time" requirement={fields.requirement('scheduledAt')}><SaveErrorField names={["time", "scheduledAt"]}><TimeField id="hq-bc-time" size="field" value={time} onChange={setTime} aria-label="時刻（日本時間）" /></SaveErrorField></Field></div>
                  </div>
                ) : null}
                <div className={formStyles.quota}>
                  <div className={formStyles.quotaHead}><strong>送信枠</strong><HelpTip label="送信枠の説明">LINE公式アカウントの月間送信枠です。アカウントごとに数えます</HelpTip><span>{totals ? `送る ${formatNumber(totals.sendPeople)} 通` : 'アカウントごと'}</span></div>
                  <p>今月の残りは最終確認でアカウントごとに確かめます。足りないアカウントは外して送ります</p>
                </div>
              </section>
            ) : null}

            {/* ⑤ 最終確認（H9eG3n）＋統括だけのアカウントごとの確かめ */}
            {shows('confirm') ? (
              <div id="broadcast-step-confirm" className={formStyles.section}>
                <h3>配信前チェック</h3>
                <div className={formStyles.checkList}>
                  {([
                    { key: 'basic', label: '配信名', value: title.trim() || '配信名を入力してください', done: steps[0].state === 'done' || Boolean(title.trim()), move: '基本設定へ戻る' },
                    { key: 'audience', label: '送るアカウント・配信対象', value: `${accountsLabel}・${audienceFull}・${peopleLabel}（ブロック中の人を除く）`, done: steps[1].state === 'done' || (chosen.length > 0 && (audience === 'all' || audience === 'scenario' || (audience === 'tag' && Boolean(tagName)) || (audience === 'advanced' && (Boolean(pruneCondition(condition)) || Boolean(savedName))))), move: '対象者へ戻る' },
                    { key: 'message', label: 'メッセージ', value: `${bubbles.length > 1 ? `${formatNumber(bubbles.length)} 件` : KIND_LABEL[kind]}・${previewConfirmed ? 'LINEプレビュー確認済み' : 'LINEプレビューが未確認です'}`, done: bubblesDone && previewConfirmed, move: 'メッセージへ戻る' },
                    { key: 'schedule', label: '送信設定', value: sendWhenLabel, done: when === 'now' || Boolean(scheduledAt), move: '送信設定へ戻る' },
                  ] as const).map((row) => (
                    <div className={formStyles.checkRow} key={row.key}>
                      {row.done ? <CheckCircle2 size={20} className="text-success" aria-hidden /> : <AlertTriangle size={20} className="text-warning" aria-hidden />}
                      <div><strong>{row.label}</strong><p>{row.value}</p></div>
                      <Button variant="secondary" className={formStyles.textButton} size="compact" onClick={() => changeStep(row.key)}>{row.move}</Button>
                    </div>
                  ))}
                </div>
                {(() => {
                  const left = [title.trim(), steps[1].state === 'done', bubblesDone && previewConfirmed, when === 'now' || scheduledAt].filter((ok) => !ok).length
                  return (
                    <Notice tone={left ? 'warn' : 'info'}>
                      {left ? `${left} 件の確認が残っています` : '配信する内容を確認してください'}
                    </Notice>
                  )
                })()}
                <h3>アカウントごとの確かめ</h3>
                {!checks || stale ? (
                  <div className={styles.checkEmpty}>
                    <span className="text-xs text-ink-faint">{stale ? '中身・送るアカウント・時刻を変えました。もう一度確かめてください。' : '送る人数・今月の送信枠の残り・LINE の接続・配信を止めていないかを、アカウントごとに確かめます。'}</span>
                    <Button onClick={() => void check()} busy={checking} busyLabel="確かめています…">送る前に確かめる</Button>
                  </div>
                ) : (
                  <>
                    <DataTable className={styles.table} data-design="hq-broadcast-preflight">
                      <thead>
                        <TableHeadRow className={styles.headRow}>
                          <Th className={styles.colStore}>アカウント</Th>
                          <Th className={styles.colPeople}>送る人数</Th>
                          <Th className={styles.colQuota}>今月の送信枠の残り</Th>
                          <Th className={styles.colCheck}>確かめ</Th>
                          <Th className={styles.colSend}>送るか</Th>
                          <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
                        </TableHeadRow>
                      </thead>
                      <tbody>
                        {shown.map((p) => {
                          const badge = preflightBadge(p, body)
                          const go = !p.excluded && p.blockedReasons.length === 0
                          return (
                            <Tr key={p.accountId} className={styles.row}>
                              <Td className={styles.colStore}><span className={styles.store} title={p.accountName}>{p.accountName}</span></Td>
                              <Td className={styles.colPeople}><span className={styles.num}>{p.audienceCount === null ? emptyValue('unknown') : `${formatNumber(p.audienceCount)}人`}</span></Td>
                              <Td className={styles.colQuota}><span className={styles.sub}>{p.remaining === null ? emptyValue('unknown') : `${formatNumber(p.remaining)}通`}</span></Td>
                              <Td className={styles.colCheck}><StatusBadge tone={badge.tone} title={p.blockedReasons.join('・') || undefined}>{badge.label}</StatusBadge></Td>
                              <Td className={styles.colSend}><StatusBadge tone={go ? 'success' : 'neutral'}>{go ? '送る' : '外す'}</StatusBadge></Td>
                              <Td className={styles.colMenu}>
                                <RowMenu
                                  subjectName={p.accountName}
                                  items={p.blockedReasons.length > 0
                                    ? [{ id: 'why', label: `外す理由：${p.blockedReasons.join('・')}`, disabled: true, disabledReason: '直すと次から送れます', onSelect: () => {} }]
                                    : [{ id: 'toggle', label: p.excluded ? 'このアカウントに送る' : 'このアカウントを外す', onSelect: () => void toggleExclude(p) }]}
                                />
                              </Td>
                            </Tr>
                          )
                        })}
                        {rest.length > 0 ? (
                          <Tr className={styles.row}>
                            <Td className={styles.colStore}><span className={styles.store}>{`ほか ${rest.length}アカウント`}</span></Td>
                            <Td className={styles.colPeople}><span className={styles.num}>{`${formatNumber(rest.reduce((sum, p) => sum + (p.audienceCount ?? 0), 0))}人`}</span></Td>
                            <Td className={styles.colQuota}><span className={styles.sub}>{emptyValue('unknown')}</span></Td>
                            <Td className={styles.colCheck}><StatusBadge tone="success">すべて足りる</StatusBadge></Td>
                            <Td className={styles.colSend}><StatusBadge tone="success">送る</StatusBadge></Td>
                            <Td className={styles.colMenu}>
                              <RowMenu subjectName={`ほか ${rest.length}アカウント`} items={[{ id: 'all', label: '1つずつ見る', onSelect: () => setShowAll(true) }]} />
                            </Td>
                          </Tr>
                        ) : null}
                      </tbody>
                    </DataTable>
                    {totals ? (
                      <p className={styles.totals}>
                        <span className={styles.totalSend}>{`送る：${formatNumber(totals.sendStores)}アカウント・${formatNumber(totals.sendPeople)} 人`}</span>
                        <span className={styles.totalSkip}>{`外す：${formatNumber(totals.skipStores)}アカウント・${formatNumber(totals.skipPeople)} 人`}</span>
                      </p>
                    ) : null}
                  </>
                )}
                {run && checks && !stale ? (
                  <HqApprovalBlock
                    run={run}
                    approval={approval}
                    requestOpen={approvalRequestOpen}
                    onRequestClose={() => setApprovalRequestOpen(false)}
                    onChanged={() => { void hqBroadcastsApi.get(run.id).then((res) => { setRun(res.data); setRunKey(key) }).catch(() => undefined) }}
                    scheduledLabel={scheduledAt ? jpDateTime(scheduledAt) : null}
                    messageSummary={`${formatNumber(bubbles.length)} 通`}
                  />
                ) : null}
                <p className="text-xs text-ink-faint">{when === 'later' ? '予約後も送る前までは、一括配信の詳細から止められます。' : '「今すぐ送る」で確認画面を開き、そこで送ると友だちに届きます。送信は取り消せません。'}</p>
              </div>
            ) : null}
        {inlineEditor}
    </CreatePage>

      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="一括配信の下書き"
        busy={checking || sending}
        onCancel={() => { if (!checking && !sending) cancelLeave() }}
        onConfirm={() => { confirmLeave() }}
      />

      {/* 共通の「送る前の確かめ」（U1・板 i7TdtN）。統括担当が 1 人だけで人数を入れて確かめるときは、下の窓を使う。 */}
      <SendConfirmDialog
        open={confirmOpen && gate !== 'single'}
        subtitle={`${title.trim() || '新しい一括配信'}・${formatNumber(totals?.sendStores ?? 0)} アカウントへ`}
        scheduled={when !== 'now'}
        state={sendPreview.state}
        onRetry={() => setPreviewSeq((value) => value + 1)}
        recipients={sendPreview.data?.recipients ?? null}
        recipientsNote={sendPreview.data ? describeExclusion(sendPreview.data.recipients, sendPreview.data.excluded) : undefined}
        perAccount={sendPreview.data?.perAccount?.map((row) => ({
          /* 口は店の ID だけを返す。名前は店の一覧から引く。 */
          name: (stores ?? []).find((store) => store.id === row.accountId)?.name ?? row.accountId,
          recipients: row.recipients,
          stopped: row.excluded.optedOut,
          narrowed: row.excluded.optedOut > 0,
        }))}
        accountCount={totals?.sendStores}
        purpose="marketing"
        whenLabel={when === 'now' ? '今すぐ送る' : `${sendWhenLabel} に送る（予約）`}
        whenNote={when === 'now' ? undefined : '予約は送る時刻の 1 分前まで［予約を取り消す］で止められます'}
        sender={sendPreview.data?.sender ?? null}
        bodyHead={sendPreview.data?.firstText ?? ''}
        allRecipients={audience === 'all'}
        confirmationFields={<OperationTargetSummary accounts={checks && !stale ? checks.filter((item) => !item.excluded && !item.blockedReasons.length).map((item) => ({ id: item.accountId, name: item.accountName })) : [{ id: '' }]} showAccountCount />}
        hidePrimary={approval.state === null && !stale}
        primaryDisabled={sending || stale || confirmChanged || !confirmedAudiences}
        error={error || undefined}
        primaryLabel={sendPreview.data ? `${totals ? `${formatNumber(totals.sendStores)} アカウント ` : ''}${formatNumber(sendPreview.data.recipients)} 人に${when === 'now' ? '送る' : '予約する'}` : '送る'}
        onConfirm={async () => { if (renderedConfirmTicket && renderedConfirmTicket === confirmTicket.current && openedInputScope.current === inputScope.current) await send() }}
        onBack={() => { if (!sending) closeSendConfirmation() }}
      />
      <ConfirmDialog
        open={confirmOpen && gate === 'single'}
        title={`${formatNumber(totals?.sendStores ?? 0)}アカウントに送ります`}
        description={`${confirmedAudiences ? `${formatNumber(sendPreview.data!.recipients)} 人` : '人数を確認しています'}に${when === 'now' ? 'すぐ' : `${sendWhenLabel} に`}送ります。送った LINE は取り消せません。${totals && totals.skipStores ? `外した${formatNumber(totals.skipStores)}アカウントには送りません。` : ''}`}
        confirmLabel={when === 'now' ? '送る' : '予約する'}
        busy={sending}
        confirmDisabled={stale || confirmChanged || !confirmedAudiences}
        confirmDisabledReason="閉じて、送る前の確かめをやり直してください。"
        warning
        onConfirm={gate !== 'single' || (approval.state && Number(confirmCount) === approval.state.gate.recipientCount) ? () => { if (renderedConfirmTicket && renderedConfirmTicket === confirmTicket.current && openedInputScope.current === inputScope.current) return send() } : undefined}
        error={error || undefined}
        onSuccess={closeSendConfirmation}
        onCancel={closeSendConfirmation}
      >
        <OperationTargetSummary
          accounts={checks && !stale ? checks.filter((item) => !item.excluded && !item.blockedReasons.length).map((item) => ({ id: item.accountId, name: item.accountName })) : [{ id: '' }]}
          showAccountCount
        />
        {gate === 'single' && approval.state ? <SingleOperatorFields recipientCount={approval.state.gate.recipientCount} value={confirmCount} onChange={setConfirmCount} /> : null}
      </ConfirmDialog>

      <HqTestSendDialog open={testOpen} accounts={chosen.filter((s) => !excluded.includes(s.id)).map((s) => ({ id: s.id, name: s.name }))} prepare={prepareForTest} onClose={() => setTestOpen(false)} />

      {/* 詳細条件（店の一斉配信と同じ部品。タグ・シナリオは名前で選び、各アカウントの同じ名前に直す） */}
      {basicPicker ? <HqBroadcastSourcePicker mode={basicPicker}
        initialId={basicPicker === 'template' ? selectedTemplate?.item.id ?? '' : copiedRun?.id ?? ''}
        onTemplate={async (item, folders) => {
          const why = await applyTemplate(item.id)
          if (!why) setSelectedTemplate({ item, folders })
          return why
        }}
        onBroadcast={duplicate}
        renderBroadcast={(source) => bubblesFromInput(source.input).map((item) => {
          const bubble = previewBubbleOf(item, item.body)
          return bubble ? <BubblePreview key={item.id} bubble={bubble} /> : null
        })}
        onClose={() => { setBasicPicker(null); requestAnimationFrame(() => basicPickerTrigger.current?.focus()) }} /> : null}
      {accountPickerOpen && stores && canManage ? <BroadcastAccountPicker accounts={stores} folders={folders} foldersFailed={foldersFailed} initialIds={accountIds} initialFolder={params.get('folder') ?? undefined}
        onConfirm={(ids) => { setAccountIds(ids); closeAccountPicker() }} onCancel={closeAccountPicker} /> : null}
      <HqTemplatePicker kind={pickerKind} open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={pickTemplate} />
      <Dialog
        open={saveTplOpen}
        title="テンプレートとして保存する"
        description={`${openBubble + 1} 通目の吹き出しを保存します。ほかの吹き出しは含みません。保存したテンプレートはアカウントへ配れます。`}
        confirmLabel="保存する"
        cancelLabel="やめる"
        busy={saveTplBusy}
        error={saveTplError || undefined}
        onConfirm={() => saveAsTemplate()}
        onCancel={() => setSaveTplOpen(false)}
      >
        <Field label="テンプレートの名前" required><SaveErrorField names={["saveTplName","save_tpl_name"]}><SharedTextField value={saveTplName} onChange={(event) => setSaveTplName(event.target.value)} className={formStyles.textInput} aria-label="テンプレートの名前" maxLength={100} /></SaveErrorField></Field>
      </Dialog>
      <Dialog
        open={conditionOpen}
        title="詳細条件で絞り込む"
        description="条件に当てはまる友だちに送ります。タグ・シナリオは、送るアカウントごとに同じ名前のものを使います。"
        confirmLabel="この条件にする"
        cancelLabel="やめる"
        onCancel={() => { setConditionOpen(false); if (!pruneCondition(condition) && !savedName) setAudience('all') }}
        onConfirm={() => { setCondition(conditionDraft); setConditionOpen(false); setAudience('advanced') }}
      >
        <ConditionBuilder
          value={conditionDraft}
          onChange={setConditionDraft}
          showCount={false}
          options={{ tags: (tagOptions ?? []).map((t) => ({ id: t.name, name: t.name })), scenarios: (scenarioOptions ?? []).map((t) => ({ id: t.name, name: t.name })), kinds: HQ_RULE_KINDS }}
        />
      </Dialog>
    </></SaveErrorScope></SaveErrorScope>
  )
}
