'use client'

import { clearHqRichMenuDraft } from '@/lib/hq-rich-menu-draft-store'
import { useListSnapshot } from '@/lib/use-list-snapshot'

import { formDistributedLine,formStatusLine } from './form-status-line'
export { hostContentOf,hostDefinition } from './console-content'
export type { DefinitionEditorProps } from './console-types'
export { formDistributedLine,formStatusLine } from './form-status-line'

import type { ConsoleProps,DefinitionEditorProps } from './console-types'

import { hqFormDefinitionToEditor,hqFormEditorToDefinition } from '@/components/forms/hq-form-definition-adapter'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { DistributionAccountName,DistributionProgress,DistributionTable,DistributionToolbar } from '@/components/shared/distribution-table'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import FolderSelect from '@/components/shared/folder-select'
import { Field } from '@/components/shared/form-controls'
import { FormLeaveGuard } from '@/components/shared/form-leave-guard'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useListNavigationHref,useListReturnHref,useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { flushListUrlState,notifyListLocation,useListLocation,useListUrlValue } from '@/components/shared/list-url-state'
import Notice from '@/components/shared/notice'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { SaveConflictBand,SaveConflictCompareDialog,useSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import TagPill from '@/components/shared/tag-pill'
import { notifySaved } from '@/components/shared/toast'
import TruncatedText from '@/components/shared/truncated-text'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { DistributionPage } from '@/components/templates/distribution-page'
import { PageFrame,PageHeading } from '@/components/templates/page-frame'
import { useAccount } from '@/contexts/account-context'
import { fetchHqDistributionTargets } from '@/lib/api/helpers/hq-distribution-targets'
import { hqMediaApi } from '@/lib/api/helpers/hq-media'
import { formatNumber } from '@/lib/format'
import { HqRichMenuCompatibilityError,hqRichMenuDefinitionFromSeed,hqRichMenuSeedFromDefinition } from '@/lib/hq-rich-menu-create'
import { readScenarioEditorDraft } from '@/lib/hq-scenario-editor-draft'
import { readFormEditorDraft } from '@/lib/hq-form-editor-draft'
import { freshDefinition } from '@/lib/hq-template-authoring'
import { creationStorageKey,clearCreationAttempt,clearEditorDraft,loadCreationAttempt,loadEditorDraft,persistCreationAttempt,persistEditorDraft,sameCreationScope,type CreationAttempt,type CreationScope,type EditorDraftContent } from '@/lib/hq-template-create-attempt'
import { hqTemplatesApi,type DistributionMode,type DistributionResult,type FormDefinition,type HqAccount,type HqTemplate,type HqTemplateListItem,type MessageTemplateDefinition,type Preflight,type RichMenuDefinition,type TagDefinition,type TemplateDefinition,type TemplateDetail,type TemplateInput,type TemplateType } from '@/lib/hq-templates-api'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { useStaffRole,useTenantWideAccess } from '@/lib/staff-role'
import { useFormErrors } from '@/lib/use-form-errors'
import { FormEditV8 } from '@/v8/form-edit/public/edit/index'
import type { FormEditHost } from '@/v8/form-edit/public/host/index'
import { TemplateAssetEditor } from '@/v8/template-edit/public/asset/index'
import type { TemplateEditHost,TemplateHostContent } from '@/v8/template-edit/public/host/index'
import { TemplateMessageEditor } from '@/v8/template-edit/public/message/index'
import { TemplateRichEditor } from '@/v8/template-edit/public/rich/index'
import { TemplateRichVideoEditor } from '@/v8/template-edit/public/rich-video/index'
import { CarouselV8 } from '@/v8/templates/public/carousel/index'
import { QuestionNewV8 } from '@/v8/templates/public/question-new/index'
import { templateKind,type HqTemplateFolder,type HqTemplateListStats,type HqTemplateReceivedVersion,type HqTemplateVersionDisplay,type TemplateKind } from '@line-crm/shared'
import { ArrowLeft,Check,Plus,Send } from 'lucide-react'
import { useEffect,useRef,useState,type ComponentType } from 'react'
import HqAccountPicker from './account-picker'
import { useAttributeTab } from './attribute-tabs'
import HqAttributes from './attributes'
import { hostContentOf,hostDefinition } from './console-content'
import styles from './console.module.css'
import { choiceKey,contentSummary,definitionError,definitionForName,definitionName,failedStores,referenceCount,resolvedItems,uploadedKeysIn } from './definition'
import HqTemplateDetail from './detail'
import { ALL_ACCOUNTS,DistributionFolderPanel,accountsInFolder,distributionFolderRows,useDistributionFolders } from './distribution-accounts'
import DistributionResultDialog from './distribution-result-dialog'
import { assertTargets,distributeFolder,failedStatus,folderResultRows,settledResult,type FolderRun } from './folder-distribution'
import FolderDistributionDialog from './folder-distribution-dialog'
import FolderDistributionResult from './folder-distribution-result'
import MessageForm from './message-form'
import SavedDistributionDialog from './saved-distribution-dialog'
import HqStoreList,{ KIND_TABS } from './store-list'
import HqTagEditorV8 from './tag-editor'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'


/*
 * ★V8-B 統括のテンプレート（一覧 ・メッセージのひな形を作る ・アカウントへ配る ）。
 *
 * 2026-10-07 src/v8 に一から書いた。読み書き・権限・失敗時の扱いは今の画面
 * （app/hq/templates/template-console.tsx）と同じ：一覧・分類（フォルダ）・複製・削除、
 * 新規保存の依頼ID（応答不明は同じ依頼を固定して「前回の保存を再確認」）、配る前の確認
 * （preflight）と重複の配り方、配る（preflightId＝配布番号・応答不達は GET で復元・再POSTしない）、
 * URL の hash からの復元、失敗アカウントだけの再確認。動きの一覧は同じ場所の BEHAVIOR.md。
 *
 * メッセージ（type=template）の作る画面は絵どおりに書き直した（message-form.tsx）。
 * タグ・リッチメニュー・回答フォーム・シナリオのひな形の中身は、入口（app/hq/templates/page.tsx）
 * が今の編集部品を `DefinitionEditor` として渡す（src/v8 から @/app を読まないため）。
 */

const PAGE_TITLES: Record<TemplateType, string> = { tag: 'タグ', template: 'テンプレート', rich_menu: 'リッチメニュー', form: '回答フォーム', scenario: 'シナリオ' }
/** 一覧の段の住所（上の帯のパンくずの行き先）。シナリオのひな形はテンプレートの住所の中にある。 */
const LIST_HREFS: Record<TemplateType, string> = { tag: '/hq/friend-attributes', template: '/hq/templates', rich_menu: '/hq/rich-menus', form: '/hq/form-submissions', scenario: '/hq/templates?type=scenario' }
const EDIT_TITLES: Record<TemplateType, string> = { tag: 'タグのひな形', template: 'メッセージのひな形', rich_menu: 'リッチメニューのひな形', form: '回答フォームのひな形', scenario: 'シナリオのひな形' }
const MODE_LABELS: Record<DistributionMode, string> = { create: '新しく作る', overwrite: '上書き', alias: '別名で作る' }

type Stage = 'saved' | 'list' | 'detail' | 'edit' | 'accounts' | 'duplicates' | 'result'
const errorText = (error: unknown) => describeApiFailure(error, '読み込み', { scope: 'hq' })
/* メッセージ系の復元タブ。タグ・回答フォームは固有の初期値を下で復元する。 */
const DRAFT_RESTORE_KINDS = ['message', 'carousel', 'question', 'rich_message', 'rich_video', 'coupon', 'research'] as const

export default function HqTemplatesV8(props: ConsoleProps) {
  const attribute = useAttributeTab('/hq/friend-attributes')
  if (props.type === 'tag' && (attribute.tab === 'fields' || attribute.tab === 'marks')) return <HqAttributes key={attribute.tab} type={attribute.tab === 'fields' ? 'friend_field' : 'mark'} tab={attribute.tab} onTab={attribute.select} />
  return <HqTemplatesBody {...props} />
}

function HqTemplatesBody({ type, DefinitionEditor, RichMenuCreate }: {
  type: TemplateType
  DefinitionEditor?: ComponentType<DefinitionEditorProps>
  /** 店のリッチメニューの作る画面（入口が渡す。src/v8 は @/app を読まないため）。host 付きで統括のひな形を作る（gobhu〜gQabc）。 */
  RichMenuCreate?: ComponentType<{ host: RichMenuCreateHost }>
}) {
  const saveErrors = useSaveFormErrors()
  const staffRole = useStaffRole()
  const canEdit = useTenantWideAccess()
  const router = useRouter()
  const { setSelectedAccountId } = useAccount()
  const location = useListLocation()
  const listPath = location.split('?')[0].split('#')[0] || ({ template: '/hq/templates', tag: '/hq/friend-attributes', form: '/hq/form-submissions', rich_menu: '/hq/rich-menus', scenario: '/hq/templates' }[type])
  const destination = useListNavigationHref()
  const returnHref = useListReturnHref(listPath)
  const entryHandled = useRef('')
  const entryHref = (id: string, mode: 'detail' | 'edit') => `${listPath}?item=${encodeURIComponent(id)}&mode=${mode}`
  /* 作る画面にも URL を付ける（H-18）。読み直しても入力が消えないよう mode=create で開き直せる。 */
  /* 一覧の種別（?type=）を引き継ぐ。指定が無い時は種別を付けない。 */
  const inheritedTypeParam = () => new URLSearchParams(location.split('?')[1]?.split('#')[0] ?? '').get('type') ?? ''
  const createHref = () => {
    const query = new URLSearchParams()
    const inherited = inheritedTypeParam()
    if (inherited) query.set('type', inherited)
    if (folderFilter !== 'all') query.set('folderFilter', folderFilter)
    query.set('mode', 'create')
    return `${listPath}?${query.toString()}`
  }
  const listHrefKeepingType = (href: string) => {
    const inherited = inheritedTypeParam()
    if (!inherited) return href
    const url = new URL(href, 'http://localhost')
    url.searchParams.set('type', inherited)
    return `${url.pathname}${url.search}${url.hash}`
  }
  const showCreateUrl = () => { entryHandled.current = 'create'; window.history.replaceState(window.history.state, '', destination(createHref())); notifyListLocation() }
  const [folderDistribution, setFolderDistribution] = useState<{ name: string; templates: HqTemplate[] } | null>(null)
  const [folderBatch, setFolderBatch] = useState<{ name: string; runs: FolderRun[]; index: number; history: FolderRun[] } | null>(null)
  const folderBatchRef = useRef(folderBatch)
  folderBatchRef.current = folderBatch
  const [stage, setStage] = useState<Stage>('list')
  const [folders, setFolders] = useState<HqTemplateFolder[]>([])
  const [folderLoadFailed, setFolderLoadFailed] = useState(false)
  const [foldersReady, setFoldersReady] = useState(false)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useListUrlValue<string>('folderFilter', 'all')
  const [textOverrides, setTextOverrides] = useState<Record<string, string>>({})
  const [overrideOpen, setOverrideOpen] = useState<string | null>(null)
  const duplicateAttempts = useRef(new Map<string, string>())
  const [templates, setTemplates] = useState<HqTemplate[]>([])
  const [accounts, setAccounts] = useState<HqAccount[]>([])
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [name, setName] = useState('')
  /* H-18原文の再読込対策：子画面の通常入力の一時下書きの復元（message先行、他は未完）。 */
  const [restoreDraft, setRestoreDraft] = useState<EditorDraftContent | null>(null)
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState<TemplateDefinition>(() => freshDefinition(type))
  const editBaseline = useRef(JSON.stringify({ name, description, definition, folderId }))
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useListUrlValue('q', '')
  const [accountFolder, setAccountFolder] = useState(ALL_ACCOUNTS)
  const accountFolders = useDistributionFolders(stage === 'accounts' || stage === 'duplicates' || stage === 'result' || stage === 'saved' || folderDistribution !== null)
  /* テンプレートの7種類（店と同じ上のタブ・API-17）。タブを替えたらその種類だけ読む。 */
  const [kind, setKind] = useState<TemplateKind>('message')
  /* 初期セットの画面のタブから `?kind=` で戻ったときは、その種類のタブを開く。 */
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('kind')
    if (KIND_TABS.some((tab) => tab.kind === wanted)) setKind(wanted as TemplateKind)
  }, [])
  const { value: kindRows, setValue: setKindRows } = useListSnapshot<HqTemplate[] | null>(kind, null)
  const [kindCounts, setKindCounts] = useState<Partial<Record<TemplateKind, number>> | null>(null)
  /* 一覧の集計（API-18：今月送った数・新しい版を未配布）。取れなければ null（数の帯は「—」か行から数える）。 */
  const [listStats, setListStats] = useState<HqTemplateListStats | null>(null)
  /* 詳細の版の履歴と配った先ごとの版（API-18）。null は読み込み中・読めなかった。 */
  const [versions, setVersions] = useState<HqTemplateVersionDisplay[] | null>(null)
  const [versionsFailed, setVersionsFailed] = useState(false)
  /** 確認の前に読む「配布先が今受け取っている版」（組1：distribution-targets）。同名の有無・上書き可否は決めない。 */
  const [targetVersions, setTargetVersions] = useState<Map<string, { version: number | null; status: string }> | null>(null)
  const [received, setReceived] = useState<HqTemplateReceivedVersion[] | null>(null)
  const [receivedFailed, setReceivedFailed] = useState(false)
  const versionsRequest = useRef(0)
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [choices, setChoices] = useState<Record<string, DistributionMode>>({})
  const [bulkMode, setBulkMode] = useState<'' | DistributionMode>('')
  const [result, setResult] = useState<DistributionResult | null>(null)
  const [resultDialogFor, setResultDialogFor] = useState<string | null>(null)
  const [pendingRun, setPendingRun] = useState<string | null>(null)
  /** 配った結果の窓（★V8-B ）。結果が出たら開く。閉じても同じ画面の進み具合と操作は残る。 */
  const [requestBusy, setBusy] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const busy = requestBusy || uploadBusy
  const [ready, setReady] = useState(false)
  /* R119: 参照先に選べる別種類の目録。null は未取得か取得失敗（0件とは区別する）。 */
  const [catalog, setCatalog] = useState<HqTemplate[] | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [message, setMessage] = useState('')
  const [remove, setRemove] = useState<HqTemplate | null>(null)
  const [now, setNow] = useState(Date.now())
  /** R561: 連続作成のたびに正規編集部品を掛け直す番号。 */
  const [formKey, setFormKey] = useState(0)
  const lock = useRef(false)
  /** R568: この編集で送ったが、まだ保存内容に残っていない画像の保存先。 */
  const sessionUploads = useRef<string[]>([])
  const createAttempt = useRef<CreationAttempt | null>(null)
  const creationScope = useRef<CreationScope | null>(null)
  const createSettlement = useRef<{ kind: 'saved'; detail: TemplateDetail } | { kind: 'rejected' } | null>(null)
  const [createUncertain, setCreateUncertain] = useState(false)
  const lastDraftEdit = useRef(0)
  const [draftFailure, setDraftFailure] = useState(false)
  const persistDraft = (scope: CreationScope, draftType: TemplateType, draftKind: string, content: EditorDraftContent) => {
    lastDraftEdit.current = Math.max(Date.now(), lastDraftEdit.current + 1)
    const saved = persistEditorDraft(window.sessionStorage, scope, draftType, draftKind, { ...content, lastEditedAt: lastDraftEdit.current })
    if (!saved) setDraftFailure(true)
  }
  const alive = useRef(true)
  /** リッチメニューの作る④で選んだ配るアカウント。 */
  const [menuTargets, setMenuTargets] = useState<string[]>([])
  /* ③④の右の列「出る人（合計）」。選んだアカウントの友だちの合計（読めないときは null）。 */
  const [menuFriendTotal, setMenuFriendTotal] = useState<number | null>(0)
  /* ④「配ったときの扱い」で選んだ初めの選択。配る前の確認（重複の一覧）を開いたときに、その扱いを選べる行へ入れる。 */
  const preferredBulkMode = useRef<'' | DistributionMode>('')

  const reconcileSessionUploads = (keep: readonly string[]) => {
    const kept = new Set(keep)
    for (const key of sessionUploads.current) if (!kept.has(key)) void hqTemplatesApi.deleteImage(key).catch(() => undefined)
    sessionUploads.current = []
  }
  const noteSessionUpload = (media: { r2Key: string }) => {
    if (!sessionUploads.current.includes(media.r2Key)) sessionUploads.current.push(media.r2Key)
  }

  const editTitle = `${EDIT_TITLES[type]}を${detail ? '編集' : '作る'}`
  /* 絵（ の進み具合・ の窓の後ろ）：配っている間も結果のあとも題は「アカウントへ配る：名前」のまま。 */
  const pageTitle = (stage === 'list' || stage === 'saved') ? PAGE_TITLES[type] : stage === 'edit' ? editTitle : `アカウントへ配る：${detail?.template.name ?? ''}`
  /* 絵（・）：店の作る・編集の画面を使うときは、上の帯は「ホーム › テンプレート／回答フォーム」だけ。 */
  /*
   * 一覧の段より先（詳細・作る・配る）は、上の帯のパンくずに一覧（テンプレートなど）を置き、押したら一覧の段へ戻す。
   * 同じ URL のまま段だけ替えるので、リンクではなく段の切り替えで戻す（板の頭の「← テンプレートへ」は
   * 2026-10-08 に無くした。#1625 の「同じ URL へのリンクでは戻れない」もこれで扱う）。
   */
  const toListRef = useRef<() => void>(() => {})
  usePageTitle((stage === 'list' || stage === 'saved') ? PAGE_TITLES[type] : stage === 'edit' ? editTitle : stage === 'detail' ? (detail?.template.name ?? PAGE_TITLES[type]) : pageTitle)
  /* 回答フォームの編集は、編集画面が上の帯の題を「回答フォーム」にする。一覧の段を重ねると「回答フォーム › 回答フォーム」になるので足さない。 */
  usePageCrumbs(stage === 'list' || stage === 'saved' || (stage === 'edit' && type === 'form')
    ? [{ label: 'ホーム', href: '/' }]
    : [{ label: PAGE_TITLES[type], href: LIST_HREFS[type], onSelect: () => toListRef.current() }])

  const distributionTemplateId = stage === 'accounts' || stage === 'saved' ? detail?.template.id ?? '' : ''
  useEffect(() => {
    if (!distributionTemplateId) { setTargetVersions(null); return }
    let live = true
    void fetchHqDistributionTargets(distributionTemplateId).then((res) => {
      if (live && Array.isArray(res.data?.stores)) setTargetVersions(new Map(res.data.stores.map((row) => [row.accountId, { version: row.targetVersion.version, status: row.targetVersion.status }])))
    }, () => { if (live) setTargetVersions(null) })
    return () => { live = false }
  }, [distributionTemplateId])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let current = true
    void hqTemplatesApi.folders.list().then((rows) => { if (current) { setFolders(rows); setFoldersReady(true) } }).catch(() => { if (current) setFolderLoadFailed(true) })
    return () => { current = false }
  }, [])
  useEffect(() => {
    let current = true
    setBusy(true)
    void Promise.all([hqTemplatesApi.list(type), hqTemplatesApi.accounts(), hqTemplatesApi.context()]).then(([rows, stores, scope]) => {
      if (!current) return
      const attempt = loadCreationAttempt(window.sessionStorage, scope, type)
      creationScope.current = scope
      if (attempt) {
        createAttempt.current = attempt; setCreateUncertain(true); setDetail(null)
        if (type === 'template' && 'template' in attempt.input.definition) setKind(templateKind(attempt.input.definition))
        setName(attempt.input.name); setDescription(attempt.input.description ?? ''); setDefinition(attempt.input.definition); setFolderId(attempt.input.folderId ?? null); setStage('edit')
      }
      setTemplates(rows); setAccounts(stores); setReady(true)
    }).catch((e) => { if (current) setError(errorText(e)) }).finally(() => { if (current) setBusy(false) })
    void hqTemplatesApi.listStats(type).then((stats) => { if (current) setListStats(stats ?? null) }).catch(() => { if (current) setListStats(null) })
    // R119: 目録だけの失敗で一覧や保存まで止めない。
    void hqTemplatesApi.list().then(
      (rows) => { if (current) { setCatalog(rows); setCatalogFailed(false) } },
      () => { if (current) { setCatalog(null); setCatalogFailed(true) } },
    )
    return () => { current = false }
  }, [type])
  useEffect(() => {
    if (type !== 'template' || (stage !== 'list' && stage !== 'saved')) return
    let current = true
    void hqTemplatesApi.listByKind(kind).then((rows) => { if (current) setKindRows(rows) }).catch(() => { if (current) setKindRows(null) })
    void hqTemplatesApi.kindCounts().then((counts) => { if (current) setKindCounts(counts) }).catch(() => undefined)
    return () => { current = false }
  }, [type, kind, stage, setKindRows])
  /* 詳細・回答フォームの編集を開いたら、版の履歴と配った先ごとの版を読む（API-18）。読めなくても画面は出す。 */
  const detailId = detail?.template.id ?? null
  const detailRevision = detail?.template.revision ?? null
  const loadVersions = (id: string) => {
    const request = ++versionsRequest.current
    setVersions(null); setVersionsFailed(false)
    setReceived(null); setReceivedFailed(false)
    void hqTemplatesApi.versions(id).then((rows) => { if (alive.current && request === versionsRequest.current) setVersions(rows) }, () => { if (alive.current && request === versionsRequest.current) setVersionsFailed(true) })
    void hqTemplatesApi.receivedVersions(id).then((rows) => { if (alive.current && request === versionsRequest.current) setReceived(rows) }, () => { if (alive.current && request === versionsRequest.current) { setReceived(null); setReceivedFailed(true) } })
  }
  useEffect(() => {
    if (!detailId || (stage !== 'detail' && stage !== 'saved' && !(stage === 'edit' && type === 'form'))) return
    loadVersions(detailId)
    // 開いたひな形と版が変わったときだけ読み直す。
  }, [detailId, detailRevision, stage, type])
  useEffect(() => {
    if (stage !== 'duplicates') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [stage])

  const freshFormBaseline = useRef(freshDefinition('form') as FormDefinition)
  const tagDraft = useRef<TemplateDefinition | null>(null)
  /* H-18原文の再読込対策：タグの作る画面の通常入力の一時下書き。結果不明の送信依頼とは別キーで所属・種別を区別し、保存・取消・作り直しで消す。 */
  const TAG_DRAFT_KIND = 'tag'
  const persistTagCreateDraft = (next: TagDefinition) => {
    const scope = creationScope.current
    /* 編集・結果不明の復旧中は作る画面の下書きに混ぜない（衝突表示は tagDraft が今までどおり持つ）。 */
    if (!scope || detail !== null || createUncertain) return
    try {
      const draftName = definitionName('tag', next)
      if (!draftName.trim() && JSON.stringify(next) === JSON.stringify(freshDefinition('tag'))) {
        clearEditorDraft(window.sessionStorage, scope, 'tag', TAG_DRAFT_KIND)
        return
      }
      persistDraft(scope, 'tag', TAG_DRAFT_KIND, { kind: TAG_DRAFT_KIND, name: draftName, definition: next })
    } catch { /* 下書きの保存失敗は本機能を止めない */ }
  }
  const clearScenarioCreateDraft = () => {
    if (type === 'scenario' && creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, 'scenario', 'scenario')
  }
  useEffect(() => {
    const scope = creationScope.current
    if (type !== 'scenario' || stage !== 'edit' || !canEdit || !scope || detail || createUncertain || createAttempt.current) return
    try {
      if (JSON.stringify({ name, description, definition, folderId }) === editBaseline.current) {
        clearEditorDraft(window.sessionStorage, scope, 'scenario', 'scenario')
        return
      }
      persistDraft(scope, 'scenario', 'scenario', { kind: 'scenario', name, description, definition, folderId })
    } catch { /* 一時保存できなくても入力を続けられる。 */ }
  }, [type, stage, canEdit, detail, createUncertain, name, description, definition, folderId])
  const clearFormCreateDraft = () => {
    if (type === 'form' && creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, 'form', 'form')
  }
  const clearTagCreateDraft = () => {
    if (creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, 'tag', TAG_DRAFT_KIND)
  }
  const conflictScope = JSON.stringify([type, detail?.template.id, creationScope.current?.tenantId])
  const conflictScopeRef = useRef(conflictScope)
  conflictScopeRef.current = conflictScope
  const collision = useSaveConflict<TemplateDetail>({
    contextKey: conflictScope,
    fetchLatest: async () => detail ? hqTemplatesApi.get(detail.template.id) : null,
    reload: async () => {
      if (!detail) return
      const scope = conflictScope
      const latest = await hqTemplatesApi.get(detail.template.id)
      if (!alive.current || scope !== conflictScopeRef.current) return
      loadDetailIntoForm(latest)
      tagDraft.current = null
      setFormKey(key => key + 1)
      setConflict(false); setError(''); collision.clear()
    },
  })

  const perform = async (action: () => Promise<void>) => {
    if (lock.current || !ready) return
    lock.current = true; setBusy(true); setError(''); setConflict(false); setMessage('')
    try { await action(); return true } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (alive.current) {
        { if (!fieldFailure)

        setError(errorText(e));

        const collided = Boolean(e && typeof e === 'object' && 'status' in e && e.status === 409)
        setConflict(collided)
        if (collided) collision.mark()
        }
      }
      return false
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const toList = () => {
    if (folderBatchRef.current?.runs.some((run) => run.runId && !settledResult(run.result))) { setError('配布結果を確認してから一覧へ戻ってください。'); return }
    const batchKey = batchStorageKey()
    if (batchKey) window.sessionStorage.removeItem(batchKey)
    setFolderBatch(null); setFolderDistribution(null)
    if (createUncertain) return
    if (!detail && type === 'rich_menu' && creationScope.current) void clearHqRichMenuDraft(creationStorageKey(creationScope.current, 'rich_menu')).catch(() => setDraftFailure(true))
    setDraftFailure(false)
    reconcileSessionUploads(detail ? uploadedKeysIn(detail.definition) : [])
    createAttempt.current = null; preferredBulkMode.current = ''; setStage('list'); setPreflight(null); setChoices({}); setBulkMode(''); setPendingRun(null); setResult(null); setError(''); setConflict(false); setRestoreDraft(null)
    /* 下書きは新規作成の分だけ消す。editKind は一覧の描画では未初期化のため kind を使う（新規では同値）。 */
    if (!detail && creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, type, kind); clearTagCreateDraft(); if (!detail) { clearFormCreateDraft(); clearScenarioCreateDraft() }
    flushListUrlState()
    entryHandled.current = ''
    window.history.replaceState(window.history.state, '', listHrefKeepingType(returnHref))
    notifyListLocation()
  }
  toListRef.current = toList
  const reloadCatalog = () => {
    setCatalogFailed(false)
    void hqTemplatesApi.list().then(
      (rows) => { if (alive.current) { setCatalog(rows); setCatalogFailed(false) } },
      () => { if (alive.current) { setCatalog(null); setCatalogFailed(true) } },
    )
  }
  const referenceOptions = (kind: TemplateType) => (catalog ?? []).filter((item) => item.template_type === kind).map((item) => ({ id: item.id, name: item.name }))
  const loadDetailIntoForm = (loaded: TemplateDetail) => {
    if (loaded.template.template_type !== type || loaded.definition.schemaVersion !== 1 || !definitionName(type, loaded.definition)) throw new Error('ひな形の種類または保存内容を確認できません。')
    editBaseline.current = JSON.stringify({ name: loaded.template.name, description: loaded.template.description ?? '', definition: loaded.definition, folderId: loaded.template.folder_id ?? null })
    setFolderId(loaded.template.folder_id ?? null); setDetail(loaded); setName(loaded.template.name); setDescription(loaded.template.description ?? ''); setDefinition(loaded.definition)
  }
  const open = (id: string, next: Stage) => {
    const href = destination(entryHref(id, next === 'edit' ? 'edit' : 'detail'))
    return void perform(async () => {
      sessionUploads.current = []
      const loaded = await hqTemplatesApi.get(id)
      if (!alive.current) return
      loadDetailIntoForm(loaded); setSelected([]); setTextOverrides({}); setSearch(''); setAccountFolder(ALL_ACCOUNTS); setPreflight(null); setChoices({}); setBulkMode(''); setStage(next)
      if (next === 'detail' || next === 'edit') {
        flushListUrlState()
        entryHandled.current = `${id}:${next}`
        window.history.replaceState(window.history.state, '', href)
        notifyListLocation()
      }
    })
  }
  useEffect(() => {
    if (!ready || busy || lock.current || !location) return
    const params = new URLSearchParams(location.split('?')[1]?.split('#')[0] ?? '')
    if (params.get('mode') === 'create') {
      if (!canEdit || entryHandled.current === 'create') return
      entryHandled.current = 'create'
      /* 結果不明の復旧依頼がある再読込では、依頼と入力を保持する。 */
      if (createAttempt.current) return
      /* H-18原文：子画面の通常入力の一時下書きがあれば initial として戻す。別タブの下書きはタブごと戻す。 */
      const creation = creationScope.current
      let restored: { kind: TemplateKind; draft: EditorDraftContent } | null = null
      if (creation) {
        for (const draftKind of DRAFT_RESTORE_KINDS) {
          const loaded = loadEditorDraft(window.sessionStorage, creation, type, draftKind, () => setDraftFailure(true))
          if (loaded && loaded.kind === draftKind && (!restored || Number(loaded.lastEditedAt ?? 0) > Number(restored.draft.lastEditedAt ?? 0))) restored = { kind: draftKind, draft: loaded }
        }
      }
      if (restored) {
        setKind(restored.kind); setRestoreDraft(restored.draft); setDetail(null); setFolderId(typeof restored.draft.folderId === 'string' ? restored.draft.folderId : null); setName(''); setDescription(''); setStage('edit'); setError(''); setConflict(false)
        return
      }
      if (type === 'scenario' && creation) {
        const draft = readScenarioEditorDraft(loadEditorDraft(window.sessionStorage, creation, 'scenario', 'scenario', () => setDraftFailure(true)))
        if (draft) {
          editBaseline.current = JSON.stringify({ name: '', description: '', definition: freshDefinition('scenario'), folderId: null })
          setDetail(null); setFolderId(draft.folderId); setName(draft.name); setDescription(draft.description); setDefinition(draft.definition); setStage('edit'); setError(''); setConflict(false)
          return
        }
      }
      if (type === 'form' && creation) {
        const loaded = loadEditorDraft(window.sessionStorage, creation, 'form', 'form', () => setDraftFailure(true))
        if (readFormEditorDraft(loaded)) {
          setRestoreDraft(loaded); setDetail(null); setFolderId(typeof loaded?.folderId === 'string' ? loaded.folderId : null); setName(''); setDescription(''); setDefinition(freshFormBaseline.current); setStage('edit'); setError(''); setConflict(false)
          return
        }
      }
      /* H-18原文：タグの作る画面の一時下書きがあれば戻す（編集・結果不明の復旧は対象外）。 */
      if (type === 'tag' && creation) {
        const loaded = loadEditorDraft(window.sessionStorage, creation, 'tag', TAG_DRAFT_KIND, () => setDraftFailure(true))
        const tagDef = loaded && loaded.kind === TAG_DRAFT_KIND && loaded.definition && typeof loaded.definition === 'object' && 'tag' in (loaded.definition as Record<string, unknown>) ? loaded.definition as TagDefinition : null
        if (tagDef) {
          const restoredFolder = typeof tagDef.tag.folderId === 'string' ? tagDef.tag.folderId : null
          editBaseline.current = JSON.stringify({ name: '', description: '', definition: freshDefinition('tag'), folderId: null })
          setDetail(null); setFolderId(restoredFolder); setName(String(loaded?.name ?? '')); setDescription(''); setDefinition(tagDef); setStage('edit'); setError(''); setConflict(false)
          return
        }
      }
      startCreate()
      return
    }
    const id = params.get('item')
    const next = params.get('mode') === 'edit' && canEdit ? 'edit' : 'detail'
    const key = `${id}:${next}`
    if (!id || entryHandled.current === key) return
    entryHandled.current = key
    open(id, next)
    // 読み直し・別タブも、同じ既存の詳細・編集を開く。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, busy, location, canEdit])
  const startCreate = () => {
    createAttempt.current = null; sessionUploads.current = []; sharedDraft.current = null; sharedDraftBaseline.current = null; setMenuTargets([]); setRestoreDraft(null)
    if (creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, type, kind); clearTagCreateDraft(); clearFormCreateDraft(); clearScenarioCreateDraft()
    const fresh = freshDefinition(type), nextFolder = folderFilter !== 'all' && folderFilter !== 'none' ? folderFilter : null
    if (type === 'form') freshFormBaseline.current = fresh as FormDefinition
    editBaseline.current = JSON.stringify({ name: '', description: '', definition: fresh, folderId: nextFolder })
    setDetail(null); setFolderId(nextFolder); setName(''); setDescription(''); setDefinition(fresh); setStage('edit'); setError(''); setConflict(false)
    showCreateUrl()
  }
  /* 店のひな形（テキスト・カード）の保存で落ちた欄。MessageForm が欄ごとに検査し、1つ目へ移る。 */
  const messageFields = useFormErrors()
  const sharedDraft = useRef<TemplateHostContent | null>(null)
  const sharedDraftBaseline = useRef<{ content: string; folderId: string | null } | null>(null)
  const persistSharedDraft = (content: TemplateHostContent, nextFolder: string | null) => {
    sharedDraft.current = content
    const serialized = JSON.stringify(content)
    sharedDraftBaseline.current ??= {
      content: serialized,
      folderId: restoreDraft?.emptyAtBaseline === true ? (typeof restoreDraft.baselineFolderId === 'string' ? restoreDraft.baselineFolderId : null) : nextFolder,
    }
    const baseline = sharedDraftBaseline.current
    const scope = creationScope.current
    if (!scope || detail !== null || createUncertain) return
    const body = 'messageContent' in content ? content.messageContent : JSON.stringify(content)
    const emptyAtBaseline = !content.name.trim() && (!restoreDraft || restoreDraft.emptyAtBaseline === true) && baseline.content === serialized
    const untouched = emptyAtBaseline && baseline.folderId === nextFolder
    if (!content.name.trim() && (untouched || (!body.trim() && !nextFolder && baseline.folderId === null))) clearEditorDraft(window.sessionStorage, scope, type, kind)
    else persistDraft(scope, type, kind, { ...content, folderId: nextFolder, emptyAtBaseline, baselineFolderId: baseline.folderId })
  }
  /** 今の画面の MessageForm で作っているか。店の作る画面（共通）のときは、その画面が欄を検査する。 */
  const sharedEditorRef = useRef(false)
  const sharedEditorNow = () => sharedEditorRef.current
  const usesMessageForm = () => stage === 'edit' && type === 'template' && 'template' in definition && !sharedEditorNow()
  const save = (distribute: boolean, sourceDefinition = definition, sourceName = name, sourceDescription = description, andAnother = false, options: { folderId?: string | null; preselect?: string[]; onSaved?: () => void } = {}) => (usesMessageForm() && messageFields.submit().length > 0 ? Promise.resolve() : perform(async () => {
    const preparedDefinition = definitionForName(type, sourceDefinition, sourceName.trim(), sourceDescription.trim())
    const validation = !sourceName.trim() ? 'ひな形の名前を入力してください。' : definitionError(type, preparedDefinition, creationScope.current?.tenantId)
    if (validation) throw new Error(validation)
    const createFolderId = !detail && foldersReady && !folderLoadFailed && !folders.some(folder => folder.id === folderId) ? null : folderId
    const input = { type, name: sourceName.trim(), description: sourceDescription.trim(), folderId: options.folderId !== undefined ? options.folderId : createFolderId, definition: preparedDefinition } as TemplateInput
    let saved: TemplateDetail
    let continueToAccounts = distribute
    if (detail) {
      saved = await hqTemplatesApi.update(detail.template.id, { ...input, expectedRevision: detail.template.revision })
    } else {
      const scope = await hqTemplatesApi.context()
      if (!creationScope.current || !sameCreationScope(creationScope.current, scope)) throw new Error('ログイン中の所属先または利用者が変わりました。元のアカウントで再ログインしてから再読み込みしてください。')
      const attempt = createAttempt.current ?? { requestId: crypto.randomUUID(), input, distribute }
      // POST の前に残す。再読み込み・ログインへの移動も結果不明になりうる。
      persistCreationAttempt(window.sessionStorage, scope, type, attempt)
      createAttempt.current = attempt
      continueToAccounts = attempt.distribute
      const retainAttempt = () => {
        setCreateUncertain(true)
        setName(attempt.input.name); setDescription(attempt.input.description ?? ''); setDefinition(attempt.input.definition)
      }
      const clearReceipt = () => {
        try { clearCreationAttempt(window.sessionStorage, scope, type, attempt.requestId) } catch (cause) {
          saveErrors.capture(cause); retainAttempt(); throw cause }
      }
      if (createSettlement.current?.kind === 'rejected') {
        clearReceipt()
        createSettlement.current = null; createAttempt.current = null; setCreateUncertain(false); setRestoreDraft(null)
        setMessage('前回の保存は受け付けられていません。内容を確認して保存し直してください。')
        return
      }
      if (createSettlement.current?.kind === 'saved') saved = createSettlement.current.detail
      else {
        try {
          // 応答が失われたら、同じ鍵と同じ中身で送り直す。
          saved = await hqTemplatesApi.create(attempt.input, attempt.requestId)
        } catch (cause) {
          saveErrors.capture(cause);

          if (!createUncertain && cause && typeof cause === 'object' && 'requestNotApplied' in cause && cause.requestNotApplied === true) {
            createSettlement.current = { kind: 'rejected' }
            clearReceipt()
            createSettlement.current = null; createAttempt.current = null
          } else {
            // 後の拒否は、前の結果不明を打ち消さない。
            retainAttempt()
          }
          throw cause
        }
        createSettlement.current = { kind: 'saved', detail: saved }
      }
      clearReceipt()
      clearEditorDraft(window.sessionStorage, scope, type, kind)
      if (type === 'rich_menu') void clearHqRichMenuDraft(creationStorageKey(scope, 'rich_menu')).catch(() => setDraftFailure(true))
      clearTagCreateDraft()
      clearScenarioCreateDraft()
      if (type === 'form') { clearFormCreateDraft(); setRestoreDraft(null) }
      createSettlement.current = null
    }
    if (!alive.current) return
    const isNew = !detail
    setDraftFailure(false)
    loadDetailIntoForm(saved)
    reconcileSessionUploads(uploadedKeysIn(saved.definition))
    createAttempt.current = null
    setCreateUncertain(false)
    setTemplates((current) => [saved.template, ...current.filter((row) => row.id !== saved.template.id)])
    refreshStats()
    options.onSaved?.()
    notifySaved(continueToAccounts ? '' : 'ひな形を保存しました。')
    if (continueToAccounts) {
      setSelected(options.preselect ?? []); setTextOverrides({}); setSearch('')
      setAccountFolder(ALL_ACCOUNTS)
      setPreflight(null); setChoices({}); setBulkMode(''); setReceived(null)
      setStage('saved')
    }
    // R561: 「保存して続けて作る」は新規作成のときだけ、空の新規入力へ戻る。
    else if (andAnother && isNew) { setRestoreDraft(null); if (creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, type, kind); clearTagCreateDraft(); setDetail(null); setFolderId(null); setName(''); setDescription(''); setDefinition(freshDefinition(type)); setFormKey((current) => current + 1); setStage('edit') }
    else if (isNew) { setRestoreDraft(null); if (creationScope.current) clearEditorDraft(window.sessionStorage, creationScope.current, type, kind); clearTagCreateDraft(); flushListUrlState(); entryHandled.current = ''; window.history.replaceState(window.history.state, '', listHrefKeepingType(returnHref)); notifyListLocation(); setStage('list') }
    else {
      setStage('edit')
      flushListUrlState()
      entryHandled.current = `${saved.template.id}:edit`
      window.history.replaceState(window.history.state, '', destination(entryHref(saved.template.id, 'edit')))
      notifyListLocation()
    }
  }))
  const textMessage = type === 'template' && 'template' in definition && definition.template.messageType === 'text'
  const batchStorageKey = () => creationScope.current ? `hq-folder-distribution:${creationScope.current.tenantId}:${creationScope.current.actorId}:${type}` : null
  const rememberBatch = (batch: NonNullable<typeof folderBatch>) => {
    const key = batchStorageKey()
    if (!key) throw new Error('所属先を確認できません。再読み込みしてください。')
    // 保存するのはひな形・アカウント・配布のIDだけ。POST前に必ず残す。
    window.sessionStorage.setItem(key, JSON.stringify([...batch.history, ...batch.runs].map((run) => ({ templateId: run.template.id, accountIds: run.accountIds, runId: run.runId }))))
  }
  const loadBatchConfirmation = async (batch: NonNullable<typeof folderBatch>, index: number) => {
    const task = batch.runs[index]
    const loaded = await hqTemplatesApi.get(task.template.id)
    const checked = await hqTemplatesApi.preflight(task.template.id, task.accountIds)
    assertTargets(checked, task.accountIds)
    if (!alive.current) return
    loadDetailIntoForm(loaded); setSelected(task.accountIds); setTextOverrides({}); setSearch(''); setAccountFolder(ALL_ACCOUNTS)
    setPendingRun(null); setPreflight(checked); setChoices({}); setBulkMode(''); setNow(Date.now()); setStage('duplicates')
    setFolderBatch({ ...batch, index })
  }
  const startFolderDistribution = (folderName: string, rows: HqTemplate[], ids: string[]) => void perform(async () => {
    if (!canEdit || !rows.length || !ids.length || ids.some((id) => !accounts.some((account) => account.id === id))) return
    const batch = { name: folderName, runs: rows.map((template) => ({ template, accountIds: [...ids] })), index: 0, history: [] }
    await loadBatchConfirmation(batch, 0)
    if (alive.current) setFolderDistribution(null)
  })
  const executeFolder = async (batch: NonNullable<typeof folderBatch>) => {
    setStage('result'); setPreflight(null); setResult(null)
    try {
      await distributeFolder(batch.runs, (runs) => {
        const next = { ...batch, runs }
        rememberBatch(next)
        if (alive.current) setFolderBatch(next)
      })
    } catch (cause) {
      saveErrors.capture(cause)
      throw new Error(`${errorText(cause)} 配布結果が未確認の行は再配布せず「結果を再確認」を押してください。`)
    }
  }
  const confirmFolder = () => void perform(async () => {
    const batch = folderBatchRef.current
    if (!batch || !preflight) return
    const resolved = resolvedItems(preflight, choices)
    if (!resolved || !Number.isFinite(Date.parse(preflight.expiresAt)) || Date.parse(preflight.expiresAt) <= Date.now()) throw new Error('確認の有効期限、または未選択の項目を確認してください。')
    const runs = batch.runs.map((run, index) => index === batch.index ? { ...run, preflight, resolutions: resolved } : run)
    const next = { ...batch, runs }
    if (batch.index + 1 < runs.length) await loadBatchConfirmation(next, batch.index + 1)
    else {
      setFolderBatch(next)
      await executeFolder(next)
    }
  })
  const retryFolder = (unsubmitted = false) => void perform(async () => {
    const batch = folderBatchRef.current
    if (!batch || batch.runs.some((run) => run.runId && !settledResult(run.result))) return
    const rows = folderResultRows([...batch.history, ...batch.runs])
    const tasks = new Map<string, FolderRun>()
    for (const row of rows) {
      if (!(unsubmitted ? !row.store : row.store && failedStatus(row.store.status))) continue
      const task = tasks.get(row.template.id) ?? { template: row.template, accountIds: [] }
      task.accountIds.push(row.accountId); tasks.set(row.template.id, task)
    }
    if (!tasks.size) return
    await loadBatchConfirmation({ name: batch.name, runs: [...tasks.values()], index: 0,
      history: [...batch.history, ...batch.runs.filter((run) => Boolean(run.runId))] }, 0)
  })
  const checkStores = (ids: string[]) => void perform(async () => {
    if (folderBatch) { await loadBatchConfirmation(folderBatch, folderBatch.index); return }
    if (!detail || !ids.length) return
    const overrides = textMessage ? ids.filter((id) => textOverrides[id] !== undefined).map((accountId) => ({ accountId, text: textOverrides[accountId] })) : undefined
    const checked = await (overrides?.length ? hqTemplatesApi.preflight(detail.template.id, ids, overrides) : hqTemplatesApi.preflight(detail.template.id, ids))
    // 選んだ配り先と一致しない確認は、決して実行しない。
    if (checked.stores.length !== ids.length || new Set(checked.stores.map((s) => s.accountId)).size !== ids.length || checked.stores.some((s) => !ids.includes(s.accountId))) throw new Error('配布先を確認できませんでした。もう一度アカウントを選択してください。')
    if (!alive.current) return
    if (stage === 'saved') { setSearch(''); setAccountFolder(ALL_ACCOUNTS) }
    const preferred = preferredBulkMode.current
    preferredBulkMode.current = ''
    const preset: Record<string, DistributionMode> = {}
    if (preferred) for (const store of checked.stores) for (const item of store.items) if (item.duplicate && item.allowedModes.includes(preferred)) preset[choiceKey(store.accountId, item.sourceId)] = preferred
    setPendingRun(null); setPreflight(checked); setChoices(preset); setBulkMode(preferred); setSelected(ids); setNow(Date.now()); setStage('duplicates')
  })
  const applyBulk = (mode: '' | DistributionMode) => {
    setBulkMode(mode)
    if (!preflight || busy || !mode) return
    setChoices((current) => {
      const next = { ...current }
      for (const store of preflight.stores) for (const item of store.items) if (item.duplicate && item.allowedModes.includes(mode)) next[choiceKey(store.accountId, item.sourceId)] = mode
      return next
    })
  }
  const chooseForStore = (accountId: string, mode: DistributionMode) => {
    const store = preflight?.stores.find((row) => row.accountId === accountId)
    if (!store) return
    setChoices((current) => {
      const next = { ...current }
      for (const item of store.items) if (item.duplicate && item.allowedModes.includes(mode)) next[choiceKey(accountId, item.sourceId)] = mode
      return next
    })
  }
  const rememberRun = (templateId: string, runId: string) => {
    // ひな形IDと配布番号だけ。中身・認証情報は書かない。
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${new URLSearchParams({ template: templateId, run: runId })}`)
  }
  const run = () => void perform(async () => {
    if (!detail || !preflight || pendingRun) return
    const resolutions = resolvedItems(preflight, choices)
    if (!resolutions || Date.parse(preflight.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(preflight.expiresAt))) throw new Error('確認の有効期限、または未選択の項目を確認してください。')
    setPendingRun(preflight.preflightId); setResult(null); setStage('result'); rememberRun(detail.template.id, preflight.preflightId)
    try {
      const completed = await hqTemplatesApi.distribute(detail.template.id, preflight.preflightId, resolutions)
      if (completed.runId !== preflight.preflightId) throw new Error('配布番号が一致しません。結果を再確認してください。')
      if (alive.current) setResult(completed)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      // 途切れた POST は結果不明。送り直さず、成功・失敗を作らない。
      try {
        const recovered = await hqTemplatesApi.result(detail.template.id, preflight.preflightId);

        if (recovered.runId !== preflight.preflightId) throw new Error('配布番号が一致しません。')
        if (alive.current) { if (!fieldFailure) setResult(recovered)
      }
      } catch (saveFailure) {
        saveErrors.capture(saveFailure); throw new Error('配布結果をまだ確認できません。再配布せず「結果を再確認」を押してください。') }
    }
  });

  const refreshResult = () => void perform(async () => {
    if (!detail || !pendingRun)

 return
    const loaded = await hqTemplatesApi.result(detail.template.id, pendingRun)
    if (loaded.runId !== pendingRun) throw new Error('配布番号が一致しません。')
    if (alive.current) setResult(loaded)
  })
  useEffect(() => {
    if (!ready || createAttempt.current) return
    const batchKey = batchStorageKey()
    const journal = batchKey ? window.sessionStorage.getItem(batchKey) : null
    if (journal) {
      void perform(async () => {
        const saved = JSON.parse(journal) as Array<{ templateId: string; accountIds: string[]; runId?: string }>
        if (!Array.isArray(saved) || !saved.length || saved.some((row) => typeof row.templateId !== 'string' || !Array.isArray(row.accountIds) || row.accountIds.some((id) => !accounts.some((account) => account.id === id)))) throw new Error('配布の記録を確認できません。')
        const runs: FolderRun[] = []
        for (const row of saved) {
          const loaded = await hqTemplatesApi.get(row.templateId)
          if (loaded.template.template_type !== type) throw new Error('配布の種類を確認できません。')
          runs.push({ template: loaded.template, accountIds: row.accountIds, runId: row.runId })
        }
        const batch = { name: '配布結果の再確認', runs, index: 0, history: [] }
        if (!alive.current) return
        setFolderBatch(batch); setStage('result')
        await executeFolder(batch)
      })
      return
    }
    const params = new URLSearchParams(window.location.hash.slice(1))
    const id = params.get('template'), runId = params.get('run')
    if (!id || !runId) return
    void perform(async () => {
      const loaded = await hqTemplatesApi.get(id)
      if (!alive.current) return
      loadDetailIntoForm(loaded); setPendingRun(runId); setStage('result')
      const restored = await hqTemplatesApi.result(id, runId)
      if (restored.runId !== runId) throw new Error('配布番号が一致しません。')
      if (alive.current) setResult(restored)
    })
    // 権限のある一覧・アカウントを読んだあとに一度だけ戻す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  const reloadFolders = async () => setFolders(await hqTemplatesApi.folders.list())
  /* フォルダを選ぶ欄からその場で作る（dLffh）。左の列の「フォルダを追加」と同じ口。名前と色を保存する。 */
  const createFolder = async (folderName: string, color: string | null) => {
    const created = await hqTemplatesApi.folders.create(folderName, color)
    setFolders((current) => [...current.filter((folder) => folder.id !== created.id), created])
    return { value: created.id, label: created.name, color: created.color }
  }
  const refreshStats = () => { void hqTemplatesApi.listStats(type).then((stats) => { if (alive.current) setListStats(stats ?? null) }).catch(() => undefined) }
  const reloadKind = async () => {
    refreshStats()
    if (type !== 'template') return
    const [rows, counts] = await Promise.all([hqTemplatesApi.listByKind(kind), hqTemplatesApi.kindCounts().catch(() => null)])
    if (!alive.current) return
    setKindRows(rows)
    if (counts) setKindCounts(counts)
  }
  const expiry = preflight ? Date.parse(preflight.expiresAt) : NaN
  const expired = !Number.isFinite(expiry) || expiry <= now
  const resolutions = preflight ? resolvedItems(preflight, choices) : null
  const shownAccounts = accountsInFolder(accounts, accountFolder, accountFolders.membership).filter((account) => account.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const accountFolderRows = distributionFolderRows({ accounts, ...accountFolders, selected, onChange: setSelected, disabled: busy || stage !== 'accounts' })
  useEffect(() => {
    if (result && result.status !== 'running') setResultDialogFor(`${result.runId}:${result.status}`)
  }, [result])
  const done = result && result.status !== 'running'
  const failures = result ? failedStores(result) : []
  const successes = result?.stores.filter((store) => store.status === 'succeeded') ?? []
  const validation = definitionError(type, definitionForName(type, definition, name.trim(), description.trim()), creationScope.current?.tenantId)
  const canonicalEditorOwnsSave = type === 'tag' || type === 'form'
  const saveCanonicalDefinition = async (next: TemplateDefinition, andAnother = false) => {
    const nextName = definitionName(type, next)
    const nextDescription = 'tag' in next ? next.tag.description ?? '' : 'form' in next ? next.form.description ?? '' : description
    setDefinition(next); setName(nextName); setDescription(nextDescription)
    await save(false, next, nextName, nextDescription, andAnother)
  }
  const summary = contentSummary(type, definition)
  const tagFolder = 'tag' in definition
    ? definition.folders.find((folder) => folder.id === definition.tag.folderId)
    : null
  const templateFolder = folders.find((folder) => folder.id === (detail?.template.folder_id ?? folderId))
  const colorFolder = folders.find((folder) => folder.id === tagFolder?.id) ?? tagFolder ?? templateFolder
  const tagColor = colorFolder ? folderDisplayColor(colorFolder) : null

  const conflictNotice = conflict && detail ? <>
    <SaveConflictBand title="ほかの人が統括のひな形を先に保存しました" description={error || undefined} compareBusy={collision.compareBusy} onCompare={collision.compare} onReload={collision.reloadLatest} />
    <SaveConflictCompareDialog open={collision.compareOpen} busy={collision.compareBusy} error={collision.compareError} onCancel={collision.closeCompare} onReload={collision.reloadLatest}
      lines={collision.latest ? [
        { text: `名前：入力 ${type === 'tag' && tagDraft.current ? definitionName(type, tagDraft.current) : name} ／ 最新 ${collision.latest.template.name}` },
        { text: `説明：入力 ${description} ／ 最新 ${collision.latest.template.description ?? ''}` },
        { text: `内容：入力 ${JSON.stringify(type === 'tag' ? tagDraft.current ?? definition : definition)} ／ 最新 ${JSON.stringify(collision.latest.definition)}` },
      ] : null} />
  </> : null

  const draftFailureNotice = draftFailure ? <Notice tone="danger" message="一時保存できなかった入力があります。この画面の内容を確認し、再読み込み前に控えるか下書きを保存してください。" /> : null
  const notices = <>
    {!canEdit && stage === 'list' ? <div className={styles.readonlyBand}><ReadOnlyNotice role="note">閲覧のみで見ています。変える操作は統括の管理者に頼んでください。</ReadOnlyNotice></div> : null}
    {draftFailureNotice}
    {conflictNotice}
    {error && !conflictNotice && stage !== 'saved' ? <Notice tone="danger" message={error} /> : null}
    {message ? <Notice tone="success" message={message} onClose={() => setMessage('')} /> : null}
  </>

  /* ───── 一覧（店の同じ機能の一覧と同じ形・ /  /  / 。2026-10-08 オーナー） ───── */
  if (stage === 'list' || stage === 'saved') {
    const listRows = type === 'template' ? kindRows ?? templates.filter((row) => (row.kind ?? 'message') === kind) : templates
    const duplicateRow = (row: HqTemplate) => void perform(async () => {
      const key = `${row.id}:${row.revision}`
      const requestId = duplicateAttempts.current.get(key) ?? crypto.randomUUID()
      duplicateAttempts.current.set(key, requestId)
      await hqTemplatesApi.duplicate(row.id, `${row.name}のコピー`, row.revision, requestId)
      duplicateAttempts.current.delete(key)
      setTemplates(await hqTemplatesApi.list(type))
      await reloadKind()
      setMessage('ひな形を複製しました。')
    })
    return (
      <SaveErrorScope errors={saveErrors}><HqStoreList
        type={type}
        rows={listRows}
        ready={ready}
        busy={busy}
        canEdit={canEdit}
        accountTotal={accounts.length}
        stats={listStats}
        kind={type === 'template' ? kind : undefined}
        kindCounts={kindCounts}
        onKindChange={type === 'template' ? setKind : undefined}
        folders={folders}
        folderLoadFailed={folderLoadFailed}
        folderFilter={folderFilter}
        onFolderFilter={setFolderFilter}
        onAddFolder={async (folderName, color) => { await hqTemplatesApi.folders.create(folderName, color); await reloadFolders() }}
        onRenameFolder={async (folder, folderName, color) => { await hqTemplatesApi.folders.update(folder.id, folderName, folder.revision, color); await reloadFolders() }}
        onReloadFolders={reloadFolders}
        onDeleteFolder={async (folder) => {
          await hqTemplatesApi.folders.remove(folder.id, folder.revision)
          await reloadFolders(); setTemplates(await hqTemplatesApi.list(type)); await reloadKind(); setFolderFilter('all')
          setMessage('フォルダを消しました。ひな形は未分類に残ります。')
        }}
        onCreate={startCreate}
        onEdit={(row) => open(row.id, 'edit')}
        itemHref={(row) => entryHref(row.id, type === 'template' || type === 'tag' || !canEdit ? 'detail' : 'edit')}
        onOpen={type === 'template' || type === 'tag' ? (row) => open(row.id, 'detail') : undefined}
        folderContents={templates}
        onDistributeFolder={(id, folderName) => void perform(async () => {
          if (!canEdit || type === 'scenario') return
          const all = await hqTemplatesApi.list(type)
          if (!alive.current) return
          setTemplates(all)
          const contents = all.filter((row) => id === 'none' ? !row.folder_id : row.folder_id === id)
          if (!contents.length) throw new Error('このフォルダには配るひな形がありません。')
          setFolderDistribution({ name: folderName, templates: contents })
        })}
        onDistribute={(row) => open(row.id, 'accounts')}
        onDuplicate={duplicateRow}
        onRemove={(row) => { setError(''); setRemove(row) }}
        notices={notices}
        overlays={(
          <>
          {folderDistribution ? <FolderDistributionDialog name={folderDistribution.name} templates={folderDistribution.templates} templateFolders={folders} accounts={accounts} accountFolders={accountFolders} busy={busy} error={error}
            onCancel={() => { if (!busy) { setFolderDistribution(null); setError('') } }}
            onConfirm={(rows, ids) => startFolderDistribution(folderDistribution.name, rows, ids)} /> : null}
          {stage === 'saved' ? <SavedDistributionDialog accounts={accounts} folders={accountFolders} selected={selected} onChange={setSelected}
            filter={accountFolder} onFilter={setAccountFolder} search={search} onSearch={setSearch} received={received} receivedFailed={receivedFailed} busy={busy}
            notice={type === 'tag' ? <TagPill name={name} color={tagColor} /> : undefined}
            error={error} onLater={toList} onDistribute={() => checkStores(selected)} /> : null}
          <ConfirmDialog
            open={!!remove}
            title="ひな形を削除"
            deleteName={remove?.name ?? ''}
            description={`「${remove?.name ?? ''}」を削除します。配布済みのアカウントデータは残ります。`}
            destructive
            confirmLabel="削除する"
            busy={busy}
            onCancel={() => { if (!busy) setRemove(null) }}
            error={error || undefined} onSuccess={() => setRemove(null)} onConfirm={() => perform(async () => {
              if (!remove) return
              await hqTemplatesApi.remove(remove.id, remove.revision)
              setTemplates((current) => current.filter((t) => t.id !== remove.id))
              setKindRows((current) => current ? current.filter((t) => t.id !== remove.id) : current)
              refreshStats()
              setRemove(null); setMessage('ひな形を削除しました。')
            })}
          ><OperationTargetSummary accounts={[]} externalTarget={{ label: '統括ひな形', name: remove?.name }} /></ConfirmDialog>
          </>
        )}
      /></SaveErrorScope>
    )
  }

  /* ───── 詳細：店のテンプレートの詳細と同じ形に「配った先」と［配る］ ───── */
  if (stage === 'detail' && detail) {
    const listRow = [...(kindRows ?? []), ...templates].find((item) => item.id === detail.template.id) as HqTemplateListItem | undefined
    return (
      <SaveErrorScope errors={saveErrors}><HqTemplateDetail
        detail={detail}
        row={listRow}
        accounts={accounts}
        folderName={folders.find((folder) => folder.id === detail.template.folder_id)?.name ?? '未分類'}
        folderColor={templateFolder ? folderDisplayColor(templateFolder) : null}
        canEdit={canEdit}
        busy={busy}
        notices={notices}
        versions={versions}
        versionsError={versionsFailed}
        received={received}
        onReloadVersions={() => loadVersions(detail.template.id)}
        onCompare={(from, to) => hqTemplatesApi.compareVersions(detail.template.id, from, to)}
        onRestore={async (version) => {
          const restored = await hqTemplatesApi.restoreVersion(detail.template.id, version, detail.template.revision)
          if (!alive.current) return
          loadDetailIntoForm(restored)
          setTemplates((current) => current.map((item) => (item.id === restored.template.id ? { ...item, ...restored.template } : item)))
          void reloadKind()
          setMessage(`版${version}の内容で新しい版を作りました。配るまで、配った先は今の版のままです。`)
        }}
        onBack={toList}
        onEdit={() => { if (detail) open(detail.template.id, 'edit') }}
        onDistribute={() => { preferredBulkMode.current = ''; setSelected([]); setTextOverrides({}); setSearch(''); setAccountFolder(ALL_ACCOUNTS); setPreflight(null); setChoices({}); setBulkMode(''); setStage('accounts') }}
        onDuplicate={() => void perform(async () => {
          const requestId = crypto.randomUUID()
          await hqTemplatesApi.duplicate(detail.template.id, `${detail.template.name}のコピー`, detail.template.revision, requestId)
          setTemplates(await hqTemplatesApi.list(type)); await reloadKind()
          setMessage('ひな形を複製しました。')
        })}
        onEnterAccount={(accountId) => { setSelectedAccountId(accountId); router.push('/templates') }}
        onRemove={canEdit ? () => { setError(''); setRemove(detail.template) } : undefined}
      />
      <ConfirmDialog
        open={!!remove}
        title="ひな形を削除"
        deleteName={remove?.name ?? ''}
        description={`「${remove?.name ?? ''}」を削除します。配布済みのアカウントデータは残ります。`}
        destructive
        confirmLabel="削除する"
        busy={busy}
        onCancel={() => { if (!busy) setRemove(null) }}
        error={error || undefined} onSuccess={() => setRemove(null)} onConfirm={() => perform(async () => {
          if (!remove) return
          await hqTemplatesApi.remove(remove.id, remove.revision)
          setTemplates((current) => current.filter((t) => t.id !== remove.id))
          setKindRows((current) => current ? current.filter((t) => t.id !== remove.id) : current)
          refreshStats()
          setRemove(null); setMessage('ひな形を削除しました。')
          toList()
        })}
      ><OperationTargetSummary accounts={[]} externalTarget={{ label: '統括ひな形', name: remove?.name }} /></ConfirmDialog></SaveErrorScope>
    )
  }

  /*
   * ───── 作る・編集：店のテンプレートの作る画面を使い、下の帯をキャンセル・下書きを保存・保存するにする（G-3）─────
   * 絵：メッセージ ・クーポン ・リサーチ 。保存した中身は統括のひな形（同じ形の payload）にして、
   * ［保存する］は保存成功のあと配るか尋ねる窓を開き、選んだ先を確かめるへ渡す。
   * 前回の保存が結果不明のときは、入力を固定した今の画面（下）で再確認する。
   */
  const editKind: TemplateKind = detail && 'template' in detail.definition ? templateKind(detail.definition) : kind
  const current = ('template' in definition ? definition : freshDefinition('template')) as MessageTemplateDefinition
  /* 編集で中身を店の画面の形に戻せないもの（古い形のカード等）は、空で開いて上書きしないよう今の画面で直す。 */
  const editContent = detail && type === 'template' && editKind !== 'message' ? hostContentOf(editKind, name, current) : undefined
  const sharedEditor = type === 'template' && !createUncertain && ['message', 'coupon', 'research', 'carousel', 'question', 'rich_message', 'rich_video'].includes(editKind)
    && (!detail || editKind === 'message' || Boolean(editContent))
  sharedEditorRef.current = sharedEditor
  if (stage === 'edit' && sharedEditor) {
    const host: TemplateEditHost = {
      backHref: '/hq/templates',
      description: '保存後に、配るアカウントを選べます。一覧の「…」からも配れます。',
      primaryLabel: '保存する',
      folders: folders.map((folder) => ({ value: folder.id, label: folder.name, color: folder.color })),
      folder: folderId ?? '',
      onFolderChange: (value) => {
        const nextFolder = value || null
        setFolderId(nextFolder)
        if (sharedDraft.current) persistSharedDraft(sharedDraft.current, nextFolder)
      },
      createFolder: canEdit ? createFolder : undefined,
      busy,
      notice: notices,
      onSave: async (content, distribute) => {
        const next = hostDefinition(current, content)
        setName(content.name); setDefinition(next)
        let saved = false
        await save(distribute, next, content.name, description, false, {onSaved: () => {saved = true}})
        return saved
      },
      onCancel: toList,
      onDraftChange: (content) => persistSharedDraft(content, folderId),
      initialMessage: detail && editKind === 'message'
        ? { name, messageType: current.template.messageType, messageContent: current.template.messageContent }
        : restoreDraft?.kind === 'message'
          ? { name: String(restoreDraft.name ?? ''), messageType: String(restoreDraft.messageType ?? 'text'), messageContent: String(restoreDraft.messageContent ?? '') }
          : undefined,
      /* 編集：カルーセル・質問・クーポン・リサーチ・リッチメッセージも店の作る画面で直す。新規の一時下書きは保存と同じ形で戻す。 */
      initialContent: editContent ?? (restoreDraft && restoreDraft.kind !== 'message' ? restoreDraft as unknown as TemplateHostContent : undefined),
      readOnly: !canEdit,
      uploadCarouselImage: async (file) => {
        setUploadBusy(true)
        try {
          const media = await hqTemplatesApi.uploadImage(file, 'message')
          noteSessionUpload(media)
          return media
        } finally {
          if (alive.current) setUploadBusy(false)
        }
      },
      uploadRichVideo: async (file) => {
        setUploadBusy(true)
        try {
          const media = await hqMediaApi.upload(file, 'video')
          noteSessionUpload(media)
          return media
        } finally {
          if (alive.current) setUploadBusy(false)
        }
      },
      uploadRichVideoPreview: async (file) => {
        setUploadBusy(true)
        try {
          const preview = await hqMediaApi.uploadRichVideoPreview(file)
          for (const media of preview.media) noteSessionUpload(media)
          return preview
        } finally {
          if (alive.current) setUploadBusy(false)
        }
      },
      /* ：画像は統括の置き場へ送り5サイズを作る（API-17）。保存されなかった画像は一覧へ戻るときに片付ける（R568）。 */
      uploadRichImage: async (file) => {
        setUploadBusy(true)
        try {
          const uploadedImage = await hqTemplatesApi.uploadRichMessageImage(file)
          for (const media of uploadedImage.media) noteSessionUpload(media)
          return uploadedImage
        } finally {
          if (alive.current) setUploadBusy(false)
        }
      },
    }
    const editorKey = `${editKind}-${detail?.template.id ?? 'new'}-${formKey}`
    if (editKind === 'rich_video') return <TemplateRichVideoEditor key={editorKey} host={host} />
    if (editKind === 'rich_message') return <SaveErrorScope errors={saveErrors}><TemplateRichEditor key={editorKey} host={host} /></SaveErrorScope>
    if (editKind === 'message') return <SaveErrorScope errors={saveErrors}><TemplateMessageEditor key={editorKey} id={null} visual={false} host={host} /></SaveErrorScope>
    if (editKind === 'carousel') return <SaveErrorScope errors={saveErrors}><CarouselV8 key={editorKey} host={host} /></SaveErrorScope>
    if (editKind === 'question') return <SaveErrorScope errors={saveErrors}><QuestionNewV8 key={editorKey} host={host} /></SaveErrorScope>
    return <SaveErrorScope errors={saveErrors}><TemplateAssetEditor key={editorKey} kind={editKind as 'coupon' | 'research'} host={host} /></SaveErrorScope>
  }

  /*
   * ───── リッチメニュー：店のリッチメニューの作る画面（①〜④）を使い、④を「配る」（配るアカウント）にする─────
   * 絵：① gobhu・② egdGx・③ K0gu1・④ gQabc。手順の間は画面の中に持ち、［下書きを保存］［保存する］で一度に保存する。
   * 自由に置いた面・シナリオの参照など、作る画面の形に戻せない古い中身は今の画面（下）で直す。
   */
  const menuSeed = (() => {
    if (type !== 'rich_menu' || !detail || !('richMenu' in detail.definition)) return undefined
    const menu = (detail.definition as RichMenuDefinition).richMenu
    if (menu.pages.some((page) => page.areas.some((area) => area.scenarioId))) return null
    return hqRichMenuSeedFromDefinition(detail.definition as RichMenuDefinition, detail.template.folder_id ?? null)
  })()
  if (stage === 'edit' && type === 'rich_menu' && RichMenuCreate && !createUncertain && menuSeed !== null) {
    const host: RichMenuCreateHost = {
      backHref: '/hq/rich-menus',
      draftKey: !detail && creationScope.current ? creationStorageKey(creationScope.current, 'rich_menu') : undefined,
      restoreSelectedIds: ids => setMenuTargets(ids.filter(id => accounts.some(account => account.id === id))),
      restoreUploadedKeys: keys => keys.forEach(r2Key => noteSessionUpload({ r2Key })),
      uploadedKeys: [...sessionUploads.current],
      onCancel: toList,
      canOperate: canEdit,
      folders: folders.map((folder) => ({ id: folder.id, name: folder.name, color: folder.color })),
      createFolder: canEdit ? async (folderName, color) => { const created = await createFolder(folderName, color); return { id: created.value, name: created.label, color: created.color } } : undefined,
      references: { tags: referenceOptions('tag'), templates: referenceOptions('template'), forms: referenceOptions('form') },
      initial: menuSeed,
      uploadImage: async (file, menuSize) => {
        setUploadBusy(true)
        try {
          const media = await hqTemplatesApi.uploadImage(file, 'rich_menu', menuSize === 'large' ? { width: 2500, height: 1686 } : { width: 2500, height: 843 })
          noteSessionUpload(media)
          return { r2Key: media.r2Key }
        } finally {
          if (alive.current) setUploadBusy(false)
        }
      },
      imageUrl: (r2Key) => `${process.env.NEXT_PUBLIC_API_URL ?? ''}/images/${r2Key.split('/').map(encodeURIComponent).join('/')}`,
      distribute: (
        <Card variant="form" gap="normal">
          <HqAccountPicker
            title="配るアカウント"
            help="選んだアカウントへ、このリッチメニューを下書きとして届けます。LINE に出すのは各アカウントで公開したときです。"
            allowed={accounts}
            selected={menuTargets}
            onChange={setMenuTargets}
            onFriendTotal={setMenuFriendTotal}
            disabled={busy || !canEdit}
          />
        </Card>
      ),
      selectedCount: menuTargets.length,
      selectedIds: menuTargets,
      friendTotal: menuFriendTotal,
      busy,
      notice: notices,
      onSave: (seed, distribute, duplicateMode) => {
        let next: RichMenuDefinition
        try {
          next = hqRichMenuDefinitionFromSeed(seed)
        } catch (cause) {
          const fieldFailure = saveErrors.capture(cause)

          { if (!fieldFailure)

          setError(cause instanceof HqRichMenuCompatibilityError ? cause.reason : japaneseDetailOf(cause) || 'リッチメニューの中身を保存できる形にできませんでした。ボタンの動きと画像を確かめてください。') }
          return
        }
        setDefinition(next); setName(seed.name); setFolderId(seed.folderId)
        preferredBulkMode.current = distribute ? duplicateMode ?? '' : ''
        void save(distribute, next, seed.name, description, false, { folderId: seed.folderId, preselect: distribute ? menuTargets : undefined })
      },
    }
    return <SaveErrorScope errors={saveErrors}><RichMenuCreate key={`menu-${detail?.template.id ?? 'new'}-${formKey}`} host={host} /></SaveErrorScope>
  }

  /*
   * ───── 回答フォーム：店の回答フォームの編集画面を使い、右の列に「配った先」、主ボタンを［保存する］にする（G-3）─────
   * 絵：中身 ・答え終わったあと ・受付と見た目 ・予約ブロック 。前回の保存が結果不明のときは下の今の画面で再確認する。
   */
  if (stage === 'edit' && type === 'form' && !createUncertain && 'form' in definition) {
    const value = hqFormDefinitionToEditor(definition)
    const listRow = detail ? templates.find((item) => item.id === detail.template.id) as HqTemplateListItem | undefined : undefined
    const host: FormEditHost = {
      backHref: '/hq/form-submissions',
      initial: (!detail && readFormEditorDraft(restoreDraft)) || { name: value.name, description: value.description, layout: value.layout, onSubmitTagId: value.onSubmitTagId },
      baseline: !detail ? hqFormDefinitionToEditor(freshFormBaseline.current) : undefined,
      onDraftChange: (content) => {
        const scope = creationScope.current
        if (!scope || detail || createUncertain || !canEdit) return
        // 初回描画の空入力は保存しない。名前が空でも設問・見た目の変更は残す。
        const baseline = hqFormDefinitionToEditor(freshFormBaseline.current)
        if (JSON.stringify(content, (key, value) => key === 'id' ? undefined : value) === JSON.stringify({ name: baseline.name, description: baseline.description, layout: baseline.layout, onSubmitTagId: baseline.onSubmitTagId }, (key, value) => key === 'id' ? undefined : value)) { clearFormCreateDraft(); return }
        persistDraft(scope, 'form', 'form', { kind: 'form', ...content, folderId })
      },
      // 配った先で直せる参照先だけ（統括のタグのひな形）。友だち情報・テンプレート・リマインダは店ごとの ID なので選ばせない。
      refs: { tags: referenceOptions('tag'), friendFields: [], scenarios: [], reminders: [], templates: [] },
      accountName: '公式アカウント',
      statusLine: formStatusLine(listRow, versions),
      distributedLine: formDistributedLine(listRow),
      busy,
      notice: notices,
      onSave: async (content, distribute) => {
        let next: FormDefinition
        try {
          next = hqFormEditorToDefinition({ ...value, ...content })
        } catch (cause) {
          const fieldFailure = saveErrors.capture(cause)

          { if (!fieldFailure)

          setError(errorText(cause)) }
          return false
        }
        setDefinition(next); setName(next.form.name); setDescription(next.form.description ?? '')
        let saved = false
        await save(distribute, next, next.form.name, next.form.description ?? '', false, { folderId: !detail && foldersReady && !folderLoadFailed && !folders.some(folder => folder.id === folderId) ? null : folderId, onSaved: () => { saved = true } })
        return saved
      },
      onCancel: toList,
      readOnly: !canEdit,
    }
    return <SaveErrorScope errors={saveErrors}><FormEditV8 key={`form-${detail?.template.id ?? 'new'}-${formKey}`} host={host} /></SaveErrorScope>
  }

  /* ───── 作る・編集（：前回の保存の再確認・カード型・カルーセル・質問・リッチメッセージ） ───── */
  if (stage === 'edit' && type === 'tag' && 'tag' in definition && !createUncertain) {
    /* 所属フォルダは統括のフォルダ（左の列）から選ぶ。選んだフォルダに、一覧でもこのひな形を置く。 */
    const folderOf = (next: TagDefinition) => folders.some((folder) => folder.id === next.tag.folderId) ? next.tag.folderId ?? null : !detail && foldersReady && !folderLoadFailed ? null : next.tag.folderId ? folderId : null
    return <SaveErrorScope errors={saveErrors}><HqTagEditorV8 key={formKey} definition={definition} folders={folders} onCreateFolder={canEdit ? createFolder : undefined} editing={Boolean(detail)} saving={busy} readOnly={!canEdit}
      onSaveDraft={async (next) => { const nextName = definitionName(type, next); const nextFolder = folderOf(next); setDefinition(next); setName(nextName); setFolderId(nextFolder); await save(false, next, nextName, description, false, { folderId: nextFolder }) }}
      conflictNotice={conflictNotice} onDraftChange={(next) => { tagDraft.current = next; persistTagCreateDraft(next) }} conflict={conflict} onReloadLatest={detail ? () => { void open(detail.template.id, 'edit') } : undefined}
      error={error} draftNotice={draftFailureNotice} notice={message || undefined} onCancel={toList} onSave={async (next) => { const nextName = definitionName(type, next); const nextFolder = folderOf(next); setDefinition(next); setName(nextName); setFolderId(nextFolder); await save(true, next, nextName, description, false, { folderId: nextFolder }) }} /></SaveErrorScope>
  }

  if (stage === 'edit') {
    const uncertainNotice = createUncertain ? <Notice tone="warn" message="前回の保存結果がまだ確定していません。重複を防ぐため入力を固定しています。同じ依頼を再確認し、保存済みならその結果を読み込みます。" /> : null
    const footer = createUncertain
      ? <Button variant="primary" disabled={busy} onClick={() => save(false)} busy={Boolean(busy)} busyLabel="処理中…">前回の保存を再確認</Button>
      : canonicalEditorOwnsSave ? null : <>
        <Button disabled={busy} onClick={toList}>キャンセル</Button>
        {/* テキスト・カードは押せるままにし、足りない欄は保存で欄ごとに知らせる（B-139）。 */}
        <Button disabled={busy || (Boolean(validation) && !usesMessageForm())} onClick={() => save(false)} busy={Boolean(busy)} busyLabel="処理中…">下書きを保存</Button>
        <Button variant="primary" disabled={busy || (Boolean(validation) && !usesMessageForm())} onClick={() => save(true)} busy={Boolean(busy)} busyLabel="処理中…">保存する</Button>
      </>
    return (
      <SaveErrorScope errors={saveErrors}><PageFrame kind="wizard" boardId="X4JcOf">
        <FormLeaveGuard dirty={JSON.stringify({ name, description, definition, folderId }) !== editBaseline.current} busy={busy} />
        <PageHeading title={type === 'template' ? editTitle : editTitle} help="保存したひな形は、一覧の「配る」で各 LINE アカウントへ配ります。" />
        <div className={styles.body}>
          {notices}
          {type === 'template' && 'template' in definition ? (
            <MessageForm
              key={formKey}
              name={name}
              onNameChange={setName}
              value={definition}
              onChange={(next: MessageTemplateDefinition) => setDefinition(next)}
              folders={folders}
              folderId={folderId}
              onFolderChange={setFolderId}
              onCreateFolder={canEdit ? createFolder : undefined}
              folderLoadFailed={folderLoadFailed}
              disabled={busy || createUncertain || !canEdit}
              catalogFailed={catalogFailed}
              onReloadCatalog={reloadCatalog}
              onBusyChange={setUploadBusy}
              onReceipt={noteSessionUpload}
              notice={uncertainNotice}
              fields={messageFields}
            />
          ) : (
            <section className={styles.editPanel} aria-label="ひな形の中身">
              <div className={styles.twoCol}>
                {(createUncertain || !canonicalEditorOwnsSave) && type !== 'rich_menu' ? (
                  <Field label="ひな形の名前"><SaveErrorField names={["name"]}><SharedTextField aria-label="ひな形の名前" className={styles.input} value={name} maxLength={200} disabled={busy || createUncertain} onChange={(event) => setName(event.target.value)} /></SaveErrorField></Field>
                ) : null}
                {/* タグは中の「所属フォルダ」で分けるので、上のフォルダは出さない（同じ物が2つに見える・オーナー 10-08）。一覧での分けは「…」の「フォルダへ移す」。 */}
                {type !== 'tag' ? <div className={styles.field}>
                  <span className={styles.label}>フォルダ</span>
                  <SaveErrorField names={["folderId","folder","folder_id"]}><FolderSelect aria-label="フォルダ" size="full" value={folderId ?? ''} disabled={busy || createUncertain || folderLoadFailed} onChange={(next) => setFolderId(next || null)} folders={folders.map((folder) => ({ value: folder.id, label: folder.name, color: folder.color }))} onCreate={canEdit ? createFolder : undefined} /></SaveErrorField>
                </div> : null}
              </div>
              {(createUncertain || !canonicalEditorOwnsSave) && type !== 'rich_menu' ? (
                <Field label="説明"><SaveErrorField names={["description"]}><SharedTextArea className={styles.textarea} value={description} maxLength={2000} rows={2} disabled={busy || createUncertain} onChange={(event) => setDescription(event.target.value)} /></SaveErrorField></Field>
              ) : null}
              {catalogFailed ? <Notice tone="warn" message="参照先の候補を読み込めませんでした。タグ・テンプレート・回答フォームは選べません。" action={<Button onClick={reloadCatalog}>もう一度読み込む</Button>} /> : null}
              {canonicalEditorOwnsSave && createUncertain ? uncertainNotice : DefinitionEditor ? (
                <DefinitionEditor
                  key={formKey}
                  type={type}
                  value={definition}
                  disabled={busy || createUncertain}
                  editing={Boolean(detail)}
                  tenantId={creationScope.current?.tenantId}
                  onChange={setDefinition}
                  onBusyChange={setUploadBusy}
                  onMediaUploaded={noteSessionUpload}
                  onCanonicalCancel={toList}
                  onCanonicalSave={saveCanonicalDefinition}
                  onRichMenuNameChange={setName}
                  richMenuReferences={{ tags: referenceOptions('tag'), templates: referenceOptions('template'), forms: referenceOptions('form') }}
                  formReferences={{ tags: referenceOptions('tag'), friendFields: [], scenarios: [], reminders: [], templates: [] }}
                />
              ) : <Notice tone="danger" >この種類のひな形は、ここでは編集できません。</Notice>}
              {!canonicalEditorOwnsSave ? uncertainNotice : null}
              {!canonicalEditorOwnsSave ? <p className={styles.note}>{`参照先 ${referenceCount(type, definition)} 件を含めて配布します。`}</p> : null}
            </section>
          )}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </PageFrame></SaveErrorScope>
    )
  }

  if (stage === 'result' && folderBatch) return <SaveErrorScope errors={saveErrors}><FolderDistributionResult name={folderBatch.name} runs={[...folderBatch.history, ...folderBatch.runs]}
    accounts={accounts} folders={folders} busy={busy} error={error}
    onBack={toList} onRefresh={() => void perform(() => executeFolder(folderBatch))}
    onRetry={() => retryFolder()} onRecheck={() => retryFolder(true)} /></SaveErrorScope>

  /* ───── アカウントへ配る：選ぶ → 重複の配り方 → 配る（進み具合） ───── */
  const storeOf = (accountId: string) => preflight?.stores.find((store) => store.accountId === accountId)
  const resultOf = (accountId: string) => result?.stores.find((store) => store.accountId === accountId)
  const storeMode = (accountId: string): DistributionMode | '' => {
    const store = storeOf(accountId)
    if (!store) return ''
    const duplicates = store.items.filter((item) => item.duplicate)
    if (!duplicates.length) return 'create'
    const modes = new Set(duplicates.map((item) => choices[choiceKey(accountId, item.sourceId)] ?? ''))
    return modes.size === 1 ? [...modes][0] as DistributionMode | '' : ''
  }
  const storeVersion = (accountId: string) => {
    const store = storeOf(accountId)
    if (!store) {
      const target = targetVersions?.get(accountId)
      if (!target) return '—'
      return target.version == null ? 'まだない' : `版 ${target.version}${target.status === 'latest' ? '（最新）' : ''}`
    }
    const main = store.items[0]
    /* 絵：ひな形と同じ版が配布先にあれば「版 2（最新）」。 */
    return main?.duplicate ? (main.expectedRevision != null ? `版 ${main.expectedRevision}${detail && main.expectedRevision === detail.template.revision ? '（最新）' : ''}` : '配布済み') : '未配布'
  }
  const rowsForTable = shownAccounts
  const targetIds = stage === 'accounts' ? selected : preflight?.stores.map((store) => store.accountId) ?? selected
  const finished = successes.length + failures.length
  const progressTotal = result?.stores.length ?? targetIds.length
  const progressLabel = (accountId: string) => {
    const store = resultOf(accountId)
    if (!store) return stage === 'result' ? '待っています' : ''
    return store.status === 'succeeded' ? '完了' : failures.includes(store) ? '失敗' : '作成中'
  }
  const shortName = (accountName: string) => accountName.replace(/^然\s*-NEN-\s*/, '')

  return (
    <DistributionPage boardId={stage === 'result' && done ? 'dEvJM' : 'meBRB'} title={type === 'tag' ? <>アカウントへ配る：<TagPill name={name} color={tagColor} /></> : pageTitle}
        help="1つのアカウントだけ、または複数のアカウントを選んで一括で配れます。アカウントのフォルダで絞り込むこともできます。"
      stats={<KpiBand>
        <KpiCard title="配布先" value={accounts.length} unit="アカウント" detail="配ることのできるアカウント" />
        <KpiCard title="選んだアカウント" value={selected.length} unit="アカウント" detail="この内容を配る先" />
        <KpiCard title="配る版" value={detail?.template.revision} unit="版" detail="保存済みのひな形" />
        <KpiCard title="配布完了" value={result ? successes.length : null} unit="アカウント" detail={result? '今回の配布結果': '配布前'}
      />
    </KpiBand>}
      notices={ <>
      {folderBatch ? <p className={styles.note}>{`フォルダ「${folderBatch.name}」：${folderBatch.index + 1} / ${formatNumber(folderBatch.runs.length)} 件目の配布方法を確かめています。`}</p> : null}
      {error || message ?notices : null}
        </>}
        toolbar={<DistributionToolbar>
          <strong className={styles.distSelected}>{`選んだ ${selected.length} アカウント`}</strong>
          <span className={styles.distSearch}><SaveErrorField names={["search"]}><SearchField aria-label="アカウントを検索" placeholder="アカウント名で探す" value={search} onChange={setSearch} onClear={() => setSearch('')} /></SaveErrorField></span>
          <span className={styles.bulkPick}>
            <SaveErrorField names={["bulkMode","bulk_mode"]}><Select
              aria-label="一括の配布方法"
              size="full"
              disabled={stage !== 'duplicates' || busy}
              value={bulkMode}
              onChange={(next) => applyBulk(next as '' | DistributionMode)}
              options={[{ value: '', label: '一括の配布方法：選ぶ' }, { value: 'overwrite', label: '一括の配布方法：上書き' }, { value: 'alias', label: '一括の配布方法：別名で作る' }]}
            /></SaveErrorField>
          </span>
          {accountFolderRows.length > 1 ? null : accountFolders.failed ? <Notice tone="warn" message="フォルダを読み込めませんでした。" /> : null}
        </DistributionToolbar>}
      /* 絵 ：アカウントのフォルダは左の列（数とまとめて選ぶ印）。狭い板では選ぶ欄に畳む。 */
      folders={accountFolderRows.length > 1 ? <DistributionFolderPanel rows={accountFolderRows} activeId={accountFolder} onSelect={setAccountFolder} failed={Boolean(accountFolders.failed)} /> : undefined}
      collapsedFolders={accountFolderRows.length > 1 ? <Select aria-label="アカウントのフォルダ" label="フォルダ" value={accountFolder} onChange={setAccountFolder} options={accountFolderRows.map((row) => ({ value: row.id, label: row.label }))}/> : undefined}
      actions={<>
{stage === 'accounts' ? <>
            <Button disabled={busy} onClick={toList}>キャンセル</Button>
            <Button aria-label={`${selected.length}アカウントの重複を確認`} variant="primary" disabled={busy || !selected.length} onClick={() => checkStores(selected)}><Check size={16} aria-hidden="true" />{selected.length === 1 ? '選んだ1アカウントを確かめる' : `選んだ${selected.length}アカウントを確かめる`}</Button>
          </> : stage === 'duplicates' && preflight ? <>
            <Button disabled={busy} onClick={() => { if (folderBatch) toList(); else { setPreflight(null); setStage('accounts') } }}><ArrowLeft size={16} aria-hidden="true" />戻る</Button>
            {expired ? <Button disabled={busy} onClick={() => checkStores(selected)}>現在版を再確認</Button> : null}
            <Button variant="primary" disabled={busy || expired || !resolutions || !!pendingRun} onClick={folderBatch ? confirmFolder : run}><Send size={16} aria-hidden="true" /> < TruncatedText value ={folderBatch && folderBatch.index + 1 < folderBatch.runs.length ? `次のひな形を確かめる（${folderBatch.index + 1}/${formatNumber(folderBatch.runs.length)}）` : folderBatch ? `${formatNumber(folderBatch.runs.length)} 件を ${selected.length} アカウントへ配る` : `この内容で${preflight.stores.length}アカウントへ配る`}/></Button>
          </> : <>
            <Button disabled={busy} onClick={toList}>{done ? 'ひな形一覧へ' : 'キャンセル'}</Button>
            {!done ? <Button variant="primary" disabled><Plus size={16} aria-hidden="true" />{`配っています（${finished}/${progressTotal}）`}</Button> : null}
            {done || !result ? <Button disabled={busy} onClick={refreshResult } busyLabel = "処理中…">結果を再確認</Button> : null}
            {done && failures.length > 0 ? <Button variant="primary" disabled={busy} onClick={() => checkStores(failures.map((s) => s.accountId))}>{`失敗${failures.length}アカウントを再確認`}</Button> : null}
          </>}
      </>}
      overlays={<DistributionResultDialog
        open={Boolean(result && done && resultDialogFor === `${result.runId}:${result.status}`)}
        title={`配った結果：${detail?.template.name ?? ''}`}
        tag={type === 'tag' ? { name, color: tagColor } : undefined}
        summary={result ? `${result.stores.length} アカウントへ配りました。成功 ${successes.length}・失敗 ${failures.length}。${successes.length ? '成功した所はもう使えます。' : ''}` : ''}
        rows={(result?.stores ?? []).map((store) => ({ key: store.accountId, name: store.accountName ?? accountName(accounts, store.accountId), store }))}
        busy={busy} onClose={() => setResultDialogFor(null)}
        onRetry={() => { setResultDialogFor(null); checkStores(failures.map((store) => store.accountId)) }}
      />}
      >
        <div className={styles.distributionContent}>
        <DistributionTable selectAll={<SaveErrorField names={["length","shownAccounts.length","selected","shown_accounts.length"]}><Checkbox aria-label="表示中のアカウントをすべて選ぶ" checked={shownAccounts.length > 0 && shownAccounts.every((account) => selected.includes(account.id))}
                indeterminate={shownAccounts.some((account) => selected.includes(account.id)) && !shownAccounts.every((account) => selected.includes(account.id))}
                disabled={busy || stage !== 'accounts' || shownAccounts.length === 0}
                onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, ...shownAccounts.map((account) => account.id)])] : current.filter((id) => !shownAccounts.some((account) => account.id === id)))} /></SaveErrorField>}>
              {rowsForTable.map((account) => {
                const on = selected.includes(account.id)
                const store = storeOf(account.id)
                const extraItems = store?.items.slice(1).filter((item) => item.duplicate) ?? []
                const mode = storeMode(account.id)
                const allowed = store ? [...new Set(store.items.filter((item) => item.duplicate).flatMap((item) => item.allowedModes))] : []
                return [
                  <tr key={account.id} data-selected={on || undefined}>
                    <td><SaveErrorField names={["on","selected"]}><Checkbox id={`hq-dist-${account.id}`} aria-label={account.name} checked={on} disabled={busy || stage !== 'accounts'} onCheckedChange={(checked) => setSelected((current) => checked ? [...current, account.id] : current.filter((id) => id !== account.id))} /></SaveErrorField></td>
                    <td>
                      <DistributionAccountName name={account.name} folder={accountFolders.membership?.get(account.id)?.folder} htmlFor={`hq-dist-${account.id}`} note={on ? (stage === 'result' ? progressLabel(account.id) || '配る' : '配る') : '配らない'} />{store?.warnings?.map(warning=><Notice key={warning} tone="warn">{warning}</Notice>)}
                    </td>
                    <td>
                      {on ? <span className={styles.cellLine}>
                        <span className={styles.cell}>{type === 'tag' ? <TagPill name={name} color={tagColor} size="sm" /> : `${summary}（${textOverrides[account.id] !== undefined || store?.textOverride !== undefined ? '個別の本文' : '一括と同じ'}）`}</span>
                        {textMessage && stage === 'accounts' ? <Button size="compact" variant="text" disabled={busy} onClick={() => setOverrideOpen(overrideOpen === account.id ? null : account.id)}>本文を変更する</Button> : null}
                      </span> : <span className={`${styles.cell} ${styles.cellEmpty}`}>—</span>}
                    </td>
                    <td><span className={on ? styles.cell : `${styles.cell} ${styles.cellEmpty}`}>{on ? storeVersion(account.id) : '—'}</span></td>
                    <td>
                      {!on ? <span className={`${styles.cell} ${styles.cellEmpty}`}>—</span> : !store ? <span className={styles.cell}>確認のあとで選ぶ</span>
                        : allowed.length === 0 ? <span className={styles.modePick}><Select aria-label={`${account.name}の配布方法`} size="full" disabled value="create" onChange={() => undefined} options={[{ value: 'create', label: MODE_LABELS.create }]} /></span>
                        : <span className={styles.modePick}><SaveErrorField names={["mode"]}><Select
                          aria-label={`${account.name}の配布方法`}
                          size="full"
                          disabled={busy || stage !== 'duplicates'}
                          value={mode}
                          onChange={(next) => chooseForStore(account.id, next as DistributionMode)}
                          options={[{ value: '', label: '選んでください' }, ...(['overwrite', 'alias'] as const).filter((m) => allowed.includes(m)).map((m) => ({ value: m, label: store.items.some((item) => item.operation === 'reuse') && m === 'overwrite' ? '既存を使う' : MODE_LABELS[m] }))]}
                        /></SaveErrorField></span>}
                    </td>
                  </tr>,
                  overrideOpen === account.id && on && textMessage && stage === 'accounts' ? (
                    <tr key={`${account.id}-text`} className={styles.subRow}><td /><td colSpan={4}>
                      < label className={styles.field}><span className={styles.label}>{`${account.name}に配る本文`}</span><SaveErrorField names={["messageContent","definition.template.messageContent","template.messageContent","textOverrides","message_content","definition.template.message_content","template.message_content","text_overrides"]}><SharedTextArea aria-label={`${account.name}に配る本文`} className={styles.textarea} disabled={busy} maxLength={5000} value={textOverrides[account.id] ?? ('template' in definition ? definition.template.messageContent : '')} onChange={(event) => setTextOverrides((current) => ({ ...current, [account.id]: event.target.value }))} /></SaveErrorField></label>
                    </td></tr>
                  ) : null,
                  ...extraItems.map((item) => (
                    <tr key={choiceKey(account.id, item.sourceId)} className={styles.subRow}>
                      <td /><td><span className={styles.sub}>参照先：{item.itemKind === 'tag' ? <TagPill name={item.name} size="sm" /> : item.name}</span></td>
                      <td><span className={styles.cell}>{item.itemKind === 'folder' ? 'タググループ' : item.itemKind === 'rich_menu' ? 'リッチメニュー' : item.itemKind === 'form' ? '回答フォーム' : item.itemKind === 'media' ? '登録メディア' : item.itemKind === 'template' ? 'テンプレート' : item.itemKind}</span></td>
                      <td><span className={styles.cell}>{item.expectedRevision != null ? `版 ${item.expectedRevision}` : '新規'}</span></td>
                      <td><span className={styles.modePick}><SaveErrorField names={["choices"]}><Select aria-label={`${account.name} ${item.name}の配布方法`} size="full" disabled={busy || stage !== 'duplicates'} value={choices[choiceKey(account.id, item.sourceId)] ?? ''} onChange={(next) => setChoices((current) => ({ ...current, [choiceKey(account.id, item.sourceId)]: next as DistributionMode }))} options={[{ value: '', label: '選んでください' }, ...(item.operation === 'reuse' ? ['overwrite'] as const : ['overwrite', 'alias'] as const).filter((m) => item.allowedModes.includes(m)).map((m) => ({ value: m, label: item.operation === 'reuse' && m === 'overwrite' ? '既存を使う' : MODE_LABELS[m] }))]} /></SaveErrorField></span></td>
                    </tr>
                  )),
                ]
              })}
            </DistributionTable>
          {!rowsForTable.length && <p className={styles.empty}>選択できるアカウントがありません。</p>}
        {stage === 'duplicates' && expired ? <Notice tone="warn" message="確認の有効期限が切れました。アカウントの現在版をもう一度確認してください。" /> : null}
        {stage === 'result' || stage === 'duplicates' ? (
          <DistributionProgress finished={finished} total={progressTotal} action={stage=== 'result' && !done && result ?<Button size="inline" variant="text" disabled={busy} onClick={refreshResult } busy = { Boolean ( busy )} busyLabel = "処理中…">結果を再確認</Button> : undefined}>
            <p className={styles.note}>{stage === 'duplicates'
              ? '配布直前に版を再確認します。配布先で編集があれば、そのアカウントの変更を取り消します。成功したアカウントは保持され、失敗分だけ再確認できます。'
              : (result ? result.stores.map((store) => `${shortName(store.accountName ?? accountName(accounts, store.accountId))}：${store.status === 'succeeded' ? '完了' : failures.includes(store) ? '失敗' : '作成中'}`).join('・') : `配布番号：${pendingRun ?? '—'} の結果を確認しています。確認できるまでは再配布しません。`)}</p>
            {result && failures.length ? failures.map((store) => <Notice key={store.accountId} tone="danger" message={`${store.accountName ?? accountName(accounts, store.accountId)}：${store.reason || '配布できませんでした。アカウントの現在版を再確認してください。'}${store.cleanupPending ? '（画像の後片付けを自動で再試行中です）' : ''}`} action={done ? <Button disabled={busy} onClick={() => checkStores([store.accountId])}>このアカウントだけ再確認して配布</Button> : undefined} />) : null}
            {result && done ? <p className={styles.note}>{`新規 ${formatNumber(successes.reduce((sum, s) => sum + s.counts.created, 0))}件・上書き ${formatNumber(successes.reduce((sum, s) => sum + s.counts.overwritten, 0))}件・別名 ${formatNumber(successes.reduce((sum, s) => sum + s.counts.aliased, 0))}件`}</p> : null}
          </DistributionProgress>
        ) : null}
        </div>
      </DistributionPage>
  )
}

function accountName(accounts: HqAccount[], id: string): string {
  return accounts.find((account) => account.id === id)?.name ?? id
}
