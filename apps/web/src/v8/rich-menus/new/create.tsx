'use client'
import { useListNavigationRouter } from '@/components/shared/list-navigation'
import { useMenuMediaScope } from './use-menu-media-scope'
import { useMenuShapeDraft } from './use-menu-shape-draft'
import { useHqRichMenuDraft } from './use-hq-rich-menu-draft'
import { makeHqMenuSeed } from './hq-menu-seed'

import { publishMenuNow } from './create-publish-actions'
import { reloadMenuGroup } from './create-reload-group'
import { seedMenuShape } from './create-seed-shape'
import { applyMenuTabCount,requestMenuTabCount } from './create-tab-actions'
import { renderAudienceStep,renderHqAudienceStep } from './create-audience-step'
import { renderButtonsStep } from './create-buttons-step'
import { hydrateMenuDraft } from './create-hydration'
import { getSlotImage,renderSingleImageSlot,renderTabSlot } from './create-image-slots'
import { firstUnconfiguredArea, groupFromSeed, publishConfirmNoteFor, publishEffectNoteFor } from './create-model'
import { renderMenuLinePreview,renderPreviewRail } from './create-preview-rail'
import { renderHqPublishStep,renderPublishStep } from './create-publish-step'
import { createMenuDraft,persistMenuDraft,saveMenuDraft } from './create-save-actions'
import { renderShapeStep } from './create-shape-step'

import { imageUploadErrorText } from './image-upload-error'


import { type Group,type Page,type PendingImage,type PrepublishState } from './create-types'

import { HQ_NEXT_LABEL,HQ_STEP_LABEL,NEXT_LABEL,STEP_KEYS,STEP_LABEL,V8_LAYOUT_KEYS,type StepKey } from './create-options'

import ListState from '@/components/shared/list-state'

import { MediaPickerDialog } from '@/v8/contents/public/media-picker-dialog/index'
import { ManualPublishAttempt } from '@/v8/rich-menus/edit/manual-publish-attempt'
import {
DEFAULT_PUBLISH_PLAN,
clearPublishPlanDraft,
loadPublishPlanDraft,
savePublishPlanDraft,
type PublishPlanInput,
} from '@/v8/rich-menus/edit/publish-plan-draft'
import { useScheduleSubmit } from '@/v8/rich-menus/edit/schedule-submit'
import { isAreaActionConfigured,pruneStaleAreaTags,pruneStaleAreaTemplates } from '@/components/rich-menus/action-drafts'
import { intentLabelOf,intentOf } from '@/components/rich-menus/area-properties'
import { areaDisplayName } from '@/components/rich-menus/canvas-editor'
import { type Area } from '../../../components/rich-menus/area-types'
import { describeCondition } from '@/components/scenarios/scenario-dialogs'
import { describeApiFailure,
isForbidden,
isForbiddenOrRateLimited,
loadFailureNotice } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import NumberInput from '@/components/shared/number-field'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import TargetMissing from '@/components/shared/target-missing'
import VersionCompare from '@/components/shared/version-compare'
import { usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import { Steps } from '@/components/templates/steps'
import { useAccount } from '@/contexts/account-context'
import {
ApiError,
api,
type RichMenuGroupListItem,
type RichMenuScheduleInput,
type RichMenuTargetPreview,
} from '@/lib/api'
import { previewHqRichMenu,type HqRichMenuDraft,type HqRichMenuPreview } from '@/lib/api/helpers/hq-authoring'
import { formatNumber } from '@/lib/format'
import { hqRichMenuDefinitionFromSeed,type HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import { datetimeLocalJstToUtcIso } from '@/lib/jst-datetime'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { TEMPLATES,type RichMenuTemplate } from '@/lib/rich-menu-templates'
import {
isEmptyCondition,
pruneCondition,
type SegmentCondition,
} from '@/lib/segment-condition'
import { useStaffRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useFormErrors } from '@/lib/use-form-errors'
import ValidationSummary from '@/components/shared/validation-summary'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { orderTargetingGroups } from '@/v8/rich-menus/targeting-order'
import {
type Folder,
type MediaItem
} from '@line-crm/shared'
import {
ArrowRight,
CalendarClock,
Send,
Upload
} from 'lucide-react'
import { useCallback,useEffect,useRef,useState } from 'react'
import { describeMenuAudience,describeMenuSummary,isGroupResponse,mediaToFile,parseStoredCondition,projectAreaForDraft } from './create-draft'
import styles from '../../../app/rich-menus/new/create-v8.module.css'

/* ---------- 本体 ---------- */

/**
 * URL の手順の名前を、作るウィザードの手順へ読み替える。
 * 編集画面（/rich-menus/edit）は昔から `targeting`・`publish` を使っているので、同じ指定で同じ所を開く。
 */
function stepFromParam(key: string | null): StepKey | null {
  if (!key) return null
  if ((STEP_KEYS as readonly string[]).includes(key)) return key as StepKey
  if (key === 'targeting') return 'audience'
  if (key === 'actions' || key === 'areas') return 'buttons'
  return null
}

/**
 * `editGroupId` を渡すと、その下書き（またはいまのメニュー）を読み込んで同じウィザードで直す
 * （/rich-menus/edit の V8）。読み込むまでは手順の中身を出さず、すべての手順へ戻れる。
 */
export default function RichMenuCreateV8({ editGroupId, host }: { editGroupId?: string; host?: RichMenuCreateHost } = {}) {
  const router = useListNavigationRouter()
  const saveErrors = useSaveFormErrors()
  usePageTitle(host ? 'リッチメニュー' : 'リッチメニューを作る')
  /*
   * 統括のひな形（host）：手順の間は画面の中に持ち、最後に一度だけ保存する（店はこれまでどおり手順ごとに下書きを保存）。
   * 統括の画面で持てない欄（登録メディア・計測リンク・トークを開いたとき・出す相手の条件・公開の確かめ）は出さない。
   */
  /* 統括（・・）：③は「配る先」、④は「確かめて配る」。 */
  /* 統括の④「配ったときの扱い」（同じ名前があるとき）。配る前の確認の初めの選択として渡す。 */
  const [hqDuplicateMode, setHqDuplicateMode] = useState<'overwrite' | 'alias'>('overwrite')
  const stepLabel = (key: StepKey) => (host ? HQ_STEP_LABEL[key] : STEP_LABEL[key])
  const nextLabel = (key: Exclude<StepKey, 'publish'>) => (host ? HQ_NEXT_LABEL[key] : NEXT_LABEL[key])
  const { selectedAccount } = useAccount()
  const publishAttempt = useRef(new ManualPublishAttempt())
  /* ①の画像の枠ごとのファイル入力（タブの順）。 */

  /*
   * 重ねの撮影用に `?step=buttons|audience|publish` で最初の手順を指定できる。
   * 後の移動は中の状態だけ（URLは書かない）。
   */
  const [step, setStep] = useState<StepKey>(() => {
    if (typeof window === 'undefined') return 'shape'
    return stepFromParam(new URLSearchParams(window.location.search).get('step')) ?? 'shape'
  })
  /* 直すときは、すでに下書きがあるので全部の手順へ戻れる。 */
  const [maxStepIndex, setMaxStepIndex] = useState(editGroupId || host?.initial ? STEP_KEYS.length - 1 : 0)
  /* 直すとき：下書きを読み込めたか（読み込むまで中身を出さない）。 */
  const [editLoad, setEditLoad] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'forbidden' | 'error'>(editGroupId ? 'loading' : 'idle')

  /* 作った下書き。手順①の「次へ」で create → get で埋まる。 */
  const [group, setGroup] = useState<Group | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [imageGuideOpen, setImageGuideOpen] = useState(false)
  const [imageVersion, setImageVersion] = useState(0)

  /* 手順① */
  const { name, setName, chatBarText, setChatBarText, folderId, setFolderId, size, setSize, tabCount, setTabCount, templateKey, setTemplateKey, pendingImages, setPendingImages, tabNames, setTabNames, pendingTabCount, setPendingTabCount } = useMenuShapeDraft()





  /* 作る前のタブごとの画像と名前（タブの順。0 は最初に見せるページ）。作った後はページが持つ。 */


  /* ①でタブを減らすとき、消えるタブに設定があれば確かめる（その間の次の数）。 */


  /* 手順③ */
  const [audience, setAudience] = useState<'all' | 'targeted' | 'none' | 'tag'>(host ? 'targeted' : 'none')
  /* 統括のひな形だけ：「タグが付いた人」のタグ名（配った先の同じ名前の有効なタグで出す）。 */
  const [hqTagName, setHqTagName] = useState(host?.initial?.displayTagName ?? '')
  const [targetingCondition, setTargetingCondition] = useState<SegmentCondition | null>(null)
  const [targetingPriority, setTargetingPriority] = useState(0)
  const [priorityOpen, setPriorityOpen] = useState(false)
  const [priorityInput, setPriorityInput] = useState('1')
  const [defaultOpen, setDefaultOpen] = useState(true)

  /* 手順④ */
  const [publishPlan, setPublishPlan] = useState<PublishPlanInput>(DEFAULT_PUBLISH_PLAN)
  const [publishBaseline, setPublishBaseline] = useState<PublishPlanInput>(DEFAULT_PUBLISH_PLAN)
  const [endEnabled, setEndEnabled] = useState(false)
  const [checks, setChecks] = useState<PrepublishState | null>(null)
  const [checksLoading, setChecksLoading] = useState(false)
  const [checksError, setChecksError] = useState(false)
  const [validating, setValidating] = useState(false)
  const [recording, setRecording] = useState(false)
  const [restoreMenus, setRestoreMenus] = useState<Array<{ id: string; name: string }>>([])

  /* 候補・他メニュー・権限 */
  const [folders, setFolders] = useState<Folder[]>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])
  const [templates, setTemplates] = useState<Array<{ id: string; name: string }>>([])
  const [forms, setForms] = useState<Array<{ id: string; name: string; folderId?: string | null; updatedAt?: string | null }>>([])
  const [trackedLinks, setTrackedLinks] = useState<Array<{ id: string; name: string }>>([])
  const [otherMenus, setOtherMenus] = useState<RichMenuGroupListItem[]>([])
  const staffRole = useStaffRole()
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadFailedKinds, setLoadFailedKinds] = useState<string[]>([])
  const [candidateScope, setCandidateScope] = useState<{
    accountId: string | null; tags: Set<string> | null; templates: Set<string> | null
  } | null>(null)
  const candidateLoadGeneration = useRef(0)
  const candidateAccountRef = useRef<string | null>(null)
  const [candidatePruneNotice, setCandidatePruneNotice] = useState('')

  /* 状態 */
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [discardingDraft, setDiscardingDraft] = useState(false)
  const [discardDraftError, setDiscardDraftError] = useState('')
  const [discardUnknown, setDiscardUnknown] = useState(false)
  const discardDraftLock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  /*
   * ★V8 ：なおし中にほかの人が先に保存した（409）。
   * 入力は残したまま、帯で知らせる。名前・時刻は API に無いので出さない。
   */
  const [conflict, setConflict] = useState(false)
  const [conflictLatest, setConflictLatest] = useState<Group | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false)
  /** 登録メディアから選ぶ画像の入れ先（①のタブの順）。 */
  const [imagePickTarget, setImagePickTarget] = useState(0)
  const [done, setDone] = useState<'published' | 'scheduled' | null>(null)
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false)

  const accountId = selectedAccount?.id ?? null
  const publishScopeKey = JSON.stringify([accountId, group?.id])
  const publishScope = useRef({ key: publishScopeKey }), publishDialogScope=useRef<object>({})
  if (publishScope.current.key !== publishScopeKey) publishScope.current = { key: publishScopeKey }
  const [publishTarget, setPublishTarget] = useState<{ accountId: string; name: string | null; scope: object;dialogScope:object;version:number;generation:number;signature:string;images:Array<{orderIndex:number;imageR2Key:string|null;imageContentType:string|null}> } | null>(null)
  const publishAlive = useRef(true)
  useEffect(() => { publishAlive.current = true; return () => { publishAlive.current = false } }, [])
  useEffect(() => { setPublishConfirmOpen(false); setPublishTarget(null); setPriorityOpen(false) }, [accountId, group?.id])
  candidateAccountRef.current = accountId
  useMenuMediaScope(accountId, Boolean(host), setPendingImages, setMediaPickerOpen)
  const aggregateOnly = staffRole === 'staff' || staffRole === 'viewer'
  const storeCanOperate = useFeatureAccess('richMenus')
  const canOperate = host ? host.canOperate : storeCanOperate
  const hqDraft = useHqRichMenuDraft(host?.draftKey, {
    version: 1, step, maxStepIndex, group, pages, activePageId, selectedAreaId, name, chatBarText, folderId, size, tabCount, templateKey,
    pendingImages, tabNames, audience, hqTagName, targetingPriority, defaultOpen, selectedIds: host?.selectedIds ?? [], uploadedKeys: host?.uploadedKeys ?? [], duplicateMode: hqDuplicateMode,
  }, draft => {
    setStep(draft.step); setMaxStepIndex(draft.maxStepIndex); setGroup(draft.group); setPages(draft.pages); setActivePageId(draft.activePageId); setSelectedAreaId(draft.selectedAreaId)
    setName(draft.name); setChatBarText(draft.chatBarText); setFolderId(draft.folderId); setSize(draft.size); setTabCount(draft.tabCount); setTemplateKey(draft.templateKey)
    setPendingImages(draft.pendingImages); setTabNames(draft.tabNames); setAudience(draft.audience); setHqTagName(draft.hqTagName); setTargetingPriority(draft.targetingPriority)
    setDefaultOpen(draft.defaultOpen); setHqDuplicateMode(draft.duplicateMode); host?.restoreSelectedIds?.(draft.selectedIds); host?.restoreUploadedKeys?.(draft.uploadedKeys)
  })
  const canOperateRef = useRef(canOperate)
  canOperateRef.current = canOperate

  /* ---------- 署名（未保存の検知） ---------- */

  /** 作成前の入力一式。初期値と違えば未保存。 */
  const createInputSignature = useCallback(
    () =>
      JSON.stringify({
        name,
        chatBarText,
        folderId,
        size,
        tabCount,
        templateKey,
        defaultOpen,
        audience,
        targetingCondition: audience === 'targeted' ? targetingCondition : null,
        targetingPriority,
        tabNames,
        images: pendingImages.map((image) =>
          image ? image.media?.id ?? (image.file ? `${image.file.name}:${image.file.size}` : null) : null,
        ),
      }),
    [name, chatBarText, folderId, size, tabCount, templateKey, defaultOpen, audience, targetingCondition, targetingPriority, pendingImages, tabNames],
  )

  /**
   * 作成後（下書きあり）の署名。persistDraft に送る形と同じ投影にする
   * （条件は保存と同じく prune 済みで出す——空行があると常に未保存になる）。
   */
  const draftSignature = useCallback(
    () =>
      JSON.stringify({
        name,
        chatBarText,
        isDefaultForAll: audience === 'all',
        targetingEnabled: audience === 'targeted',
        targetingPriority,
        targetingCondition:
          audience === 'targeted' && targetingCondition
            ? JSON.stringify(pruneCondition(targetingCondition))
            : null,
        folderId: folderId || null,
        defaultOpen,
        hqTag: audience === 'tag' ? hqTagName.trim() : null,
        pages: pages.map((p, i) => ({
          id: p.id,
          name: p.name,
          orderIndex: i,
          areas: p.areas.map(projectAreaForDraft),
        })),
      }),
    [name, chatBarText, audience, targetingPriority, targetingCondition, folderId, defaultOpen, hqTagName, pages],
  )

  /*
   * 統括だけ：配る前の確認の口（組1・POST /api/hq/templates/rich-menu-preview）。保存・配布はしない。
   * ②の右「各アカウントで使うもの」と③の右「同じ名前のメニューがある」の数を、選んだアカウントについて読む。
   * 中身が保存できる形でないとき（画像が無いなど）は、定義なしで名前の重なりだけ読む。
   */
  const [hqPreview, setHqPreview] = useState<HqRichMenuPreview | null>(null)
  const hqPreviewIds = host?.selectedIds ?? []
  const hqPreviewKey = host && (step === 'buttons' || step === 'audience' || step === 'publish') ? `${hqPreviewIds.join(',')}|${name.trim()}|${draftSignature()}` : ''
  useEffect(() => {
    if (!hqPreviewKey || hqPreviewIds.length === 0 || !name.trim()) { setHqPreview(null); return }
    let live = true
    const timer = setTimeout(() => {
      let definition: HqRichMenuDraft | undefined
      try { definition = hqRichMenuDefinitionFromSeed(seedNow()) as unknown as HqRichMenuDraft } catch { definition = undefined }
      void previewHqRichMenu({ name: name.trim(), accountIds: hqPreviewIds, ...(definition ? { definition } : {}) })
        .then((result) => { if (live) setHqPreview(result) })
        .catch(() => { if (live) setHqPreview(null) })
    }, 400)
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hqPreviewKey])

  const signatureNow = useCallback(
    () => (group ? draftSignature() : createInputSignature()),
    [group, draftSignature, createInputSignature],
  )

  const [baselineSignature, setBaselineSignature] = useState<string | null>(null)
  // 初期署名は1回だけ（最初のレンダーの値）。useState 初期化で一度だけ計算。
  useEffect(() => {
    // 統括で直すとき（host.initial）は、読み込んだ中身で基準を取る（hydrate）。開発時の二度目の実行で上書きしない。
    if (baselineSignature === null && !host?.initial) setBaselineSignature(signatureNow())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const publishDirty = JSON.stringify(publishPlan) !== JSON.stringify(publishBaseline)
  const dirty = baselineSignature !== null && (signatureNow() !== baselineSignature || publishDirty)
  const createdDraft = !host && !editGroupId && !done && group?.status === 'draft' ? group : null
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({
    dirty: dirty || Boolean(createdDraft),
    busy: saving || publishing || discardingDraft,
  })

  function confirmLeaveAndDiscard() {
    if (group && !host) clearPublishPlanDraft(group.id)
    setPublishPlan(DEFAULT_PUBLISH_PLAN)
    setPublishBaseline(DEFAULT_PUBLISH_PLAN)
    setEndEnabled(false)
    confirmLeave()
  }

  async function discardCreatedDraft() {
    if (!createdDraft || discardDraftLock.current) return
    if (createdDraft.accountId !== candidateAccountRef.current) {
      setDiscardDraftError('作成したアカウントに戻してから、下書きを消してください。')
      return
    }
    discardDraftLock.current = true
    setDiscardingDraft(true)
    setDiscardDraftError('')
    try {
      const response = await api.richMenuGroups.delete(createdDraft.id, createdDraft.version)
      if (createdDraft.accountId !== candidateAccountRef.current) return
      if (!response.success) throw new Error(response.error)
      confirmLeaveAndDiscard()
    } catch (cause) {
      setDiscardUnknown(!(cause instanceof ApiError && (cause.code === 'rich_menu_delete_blocked' || cause.status === 409)))
      setDiscardDraftError(cause instanceof ApiError && cause.code === 'rich_menu_delete_blocked'
        ? '公開状態や使われている場所を確認してから、一覧で削除してください。'
        : cause instanceof ApiError && cause.status === 409
        ? '下書きの状態が変わったため消せません。編集を続けて最新の状態を確かめてください。'
        : '下書きの削除結果を確認できません。一覧で下書きが残っているか確認してください。移動すると未保存の変更は失われます。')
    } finally {
      discardDraftLock.current = false
      setDiscardingDraft(false)
    }
  }

  /* ---------- 読み込み ---------- */

  const load = useCallback(async () => {
    const generation = ++candidateLoadGeneration.current
    setLoadError(null)
    setLoadFailedKinds([])
    if (host) {
      // 統括：候補は統括のひな形（タグ・テンプレート・回答フォーム）とフォルダ。店のメニュー・計測リンクは無い。
      setFolders(host.folders.map((folder) => ({ id: folder.id, name: folder.name }) as unknown as Folder))
      setTags(host.references.tags)
      setTemplates(host.references.templates)
      setForms(host.references.forms)
      setTrackedLinks([])
      setOtherMenus([])
      return
    }
    const [folderRes, tagRes, templateRes, formRes, linkRes, menuRes] =
      await Promise.allSettled([
        api.folders.list('rich_menu'),
        api.tags.list(accountId ? { accountId } : undefined),
        api.templates.list(undefined, accountId ?? undefined),
        accountId ? api.forms.list(accountId) : Promise.resolve({ success: true as const, data: [] }),
        api.trackedLinks.list(),
        accountId ? api.richMenuGroups.list(accountId) : Promise.resolve({ success: true as const, data: [] }),
      ])
    if (generation !== candidateLoadGeneration.current || candidateAccountRef.current !== accountId) return
    setCandidateScope({
      accountId,
      tags: tagRes.status === 'fulfilled' && tagRes.value.success ? new Set(tagRes.value.data.map(({ id }) => id)) : null,
      templates: templateRes.status === 'fulfilled' && templateRes.value.success ? new Set(templateRes.value.data.map(({ id }) => id)) : null,
    })
    const failed: string[] = []
    let firstError: unknown = null
    const noteFailure = (label: string, res: unknown) => {
      failed.push(label)
      if (firstError === null) {
        firstError =
          typeof res === 'object' && res !== null && 'reason' in res
            ? (res as { reason: unknown }).reason
            : new Error(`${label}の読み込みに失敗しました`)
      }
    }
    if (folderRes.status === 'fulfilled' && folderRes.value.success) setFolders(folderRes.value.data)
    else noteFailure('フォルダ', folderRes)
    if (tagRes.status === 'fulfilled' && tagRes.value.success)
      setTags(tagRes.value.data.map(({ id, name }) => ({ id, name })))
    else noteFailure('タグ', tagRes)
    if (templateRes.status === 'fulfilled' && templateRes.value.success)
      setTemplates(templateRes.value.data.map(({ id, name }) => ({ id, name })))
    else noteFailure('テンプレート', templateRes)
    if (formRes.status === 'fulfilled' && formRes.value.success)
      setForms(formRes.value.data.map((row) => {
        // 選ぶ窓（Pen dJZ7Q）の左のフォルダ列と行の更新日に使う。一覧と同じ応答の項目。
        const extra = row as { folderId?: string | null; updatedAt?: string | null }
        return { id: row.id, name: row.name, folderId: extra.folderId, updatedAt: extra.updatedAt }
      }))
    else noteFailure('フォーム', formRes)
    if (linkRes.status === 'fulfilled' && linkRes.value.success)
      setTrackedLinks(linkRes.value.data.map(({ id, name }) => ({ id, name })))
    else noteFailure('計測リンク', linkRes)
    if (menuRes.status === 'fulfilled' && menuRes.value.success) setOtherMenus(menuRes.value.data)
    else noteFailure('メニュー一覧', menuRes)
    if (failed.length > 0) {
      const caught = firstError
      setLoadError(caught)
      setLoadFailedKinds(failed)
      setError(
        isForbiddenOrRateLimited(caught)
          ? loadFailureNotice(caught, '候補')
          : `候補の読み込みに失敗しました（${failed.join('・')}）。もう一度読み込んでください。`,
      )
    }
    // host の候補は開いたときに一度だけ読む（親が描き直しても入力を消さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (host || !candidateScope || candidateScope.accountId !== accountId) return
    const drafts = Object.fromEntries(pages.map((page) => [page.id, page.areas]))
    const tagsPruned = candidateScope.tags ? pruneStaleAreaTags(drafts, candidateScope.tags) : { next: drafts, removed: 0 }
    const templatesPruned = candidateScope.templates ? pruneStaleAreaTemplates(tagsPruned.next, candidateScope.templates) : { next: tagsPruned.next, removed: 0 }
    const removed = tagsPruned.removed + templatesPruned.removed
    if (!removed) return
    setPages(pages.map((page) => ({ ...page, areas: templatesPruned.next[page.id] })))
    setCandidatePruneNotice(`選んでいた候補のうち${removed}件は、今のアカウントにないため外しました。選び直してください。`)
  }, [accountId, candidateScope, host, pages])

  /* 統括：直すときは保存してある中身を、画面の中の下書きにする（サーバーの下書きは作らない）。 */
  const hostSeeded = useRef(false)
  useEffect(() => {
    if (!host?.initial || hostSeeded.current) return
    hostSeeded.current = true
    hydrate(groupFromSeed(host.initial))
    // 開いたときに一度だけ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 直すとき：下書きを読み込み、手順①〜④の入力に入れる。基準の署名も読み込んだ内容で取り直す。 */
  const loadEditGroup = useCallback(async () => {
    if (!editGroupId) return
    setEditLoad('loading')
    try {
      const res = await api.richMenuGroups.get(editGroupId)
      if (!res.success || !isGroupResponse(res.data)) {
        setEditLoad('missing')
        return
      }
      hydrate(res.data)
      setEditLoad('ready')
    } catch (caught) {
      saveErrors.capture(caught)
      setEditLoad(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : caught instanceof ApiError && caught.status === 404 ? 'missing' : 'error')
    }
    // hydrate は state の setter だけを使う。
  }, [editGroupId, saveErrors])

  useEffect(() => {
    void loadEditGroup()
  }, [loadEditGroup])

  /* ---------- 下書きの作成・保存 ---------- */

  /** 作る前のタブの名前（空なら決まりの名前）。 */
  function defaultTabName(index: number, count: number): string {
    if (host && count > 0) return `タブ ${String.fromCharCode(65 + index)}`
    return index === 0 ? 'トップ' : `タブ ${String.fromCharCode(65 + index - 1)}`
  }
  function tabNameAt(index: number): string {
    return tabNames[index]?.trim() || defaultTabName(index, tabCount)
  }

  /** 作る前に選んだタブの画像を外す（ローカルの見本の URL も返す）。 */
  function clearPendingImage(index: number) {
    setPendingImages((prev) => {
      const current = prev[index]
      if (current?.url) URL.revokeObjectURL(current.url)
      const next = [...prev]
      next[index] = null
      return next
    })
  }
  function setPendingImageAt(index: number, image: PendingImage) {
    setPendingImages((prev) => {
      const current = prev[index]
      if (current?.url && current.url !== image.url) URL.revokeObjectURL(current.url)
      const next = [...prev]
      next[index] = image
      return next
    })
  }

  /*
   * 保存で落ちた欄。名前・トーク画面の下の文言は①、切り替えの行き先は②の面。
   * 帯ではなく欄を赤くして真下に理由を出し、別の手順・タブ・面ならそこを開いて移る。面の一覧に赤い丸。
   */
  saveErrors.define('name', 'メニュー名', () => null, { required: true, reveal: () => setStep('shape') })
  saveErrors.define('chatBarText', 'トーク画面の下の文言', () => null, { required: true, reveal: () => setStep('shape') })
  const unnamedArea = pages.flatMap(page => page.areas.map(area => ({ page, area }))).find(({ area }) => !area.label?.trim())
  const publishLabelErrors = useSaveFormErrors()
  publishLabelErrors.define('label', 'ボタン名', () => null, { reveal: () => {
    if (!unnamedArea) return
    setStep('buttons')
    setActivePageId(unnamedArea.page.id)
    setSelectedAreaId(unnamedArea.area.id)
  } })
  const fields = useFormErrors()
  fields.define('name', 'メニュー名', () => (name.trim() ? null : '名前を入力してください。'), { required: true, reveal: () => setStep('shape') })
  fields.define('chatbar', 'トーク画面の下の文言', () => (chatBarText.trim() ? null : 'トーク画面の下の文言を入力してください。'), { required: true, reveal: () => setStep('shape') })
  if (group) {
    pages.forEach((page, pageIndex) => {
      page.areas.forEach((area, areaIndex) => {
        if (area.actionType !== 'richmenuswitch') return
        fields.define(`area-${area.id}`, `タブ${pageIndex + 1}の面 ${String.fromCharCode(65 + areaIndex)} の切り替え先`, () => (
          String(area.actionData?.targetPageId ?? '').trim() ? null : '「メニューを切り替える」面の行き先ページが決まっていません。切り替え先を選んでください。'
        ), { required: true, reveal: () => { setStep('buttons'); setActivePageId(page.id); setSelectedAreaId(area.id) }, group: `area-${area.id}` })
      })
    })
  }

  function validateBasics(): boolean {
    if (fields.submit().length > 0) {
      setError(null)
      return false
    }
    return true
  }

  function hydrate(g: Group) { return hydrateMenuDraft({ host, setActivePageId, setAudience, setBaselineSignature, setChatBarText, setDefaultOpen, setFolderId, setGroup, setName, setPages, setSelectedAreaId, setSize, setTabCount, setTargetingCondition, setTargetingPriority, setTemplateKey }, g) }

  function reloadGroup(groupId: string) { return reloadMenuGroup({ hydrate }, groupId) }

  /*
   * `?id=<下書き>` で作りかけの下書きを開き直す（手順②〜④へ直接来る・撮影の作る② ・）。
   * 開けたら手順はどれでも選べる（①で作った後と同じ）。開けなければ理由を出し、新しく作る道は残す。
   */
  const resumeIdRef = useRef<string | null>(
    host || editGroupId || typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('id'),
  )
  useEffect(() => {
    const id = resumeIdRef.current
    if (!id) return
    resumeIdRef.current = null
    reloadGroup(id)
      // 開いた手順より前は済み（①は下書きがある＝済み）。後ろは未着手のまま。
      .then(() => setMaxStepIndex(Math.max(1, STEP_KEYS.indexOf(step))))
      .catch(() => setError('作りかけの下書きを開けませんでした。一覧から開き直してください。'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 統括：手順①の内容から画面の中の下書きを作る。ファイルを選んでいたら統括の置き場へ上げて最初のページの画像にする。 */
  function hostSeedFromShape(): Promise<HqRichMenuSeed | null> { return seedMenuShape({ audience, chatBarText, defaultOpen, folderId, host, hqTagName, name, pendingImages, saveErrors, setError, size, tabCount, tabNameAt, targetingPriority, templateKey, validateBasics }) }

  /** 手順①の内容で下書きを作る。作れたら true。 */
  function createDraft(): Promise<boolean> { return createMenuDraft({ accountId, audience, chatBarText, defaultOpen, folderId, host, hostSeedFromShape, hydrate, name, pendingImages, reloadGroup, saveErrors, setError, setPendingImages, size, tabCount, tabNameAt, targetingCondition, targetingPriority, templateKey, validateBasics }) }

  /** 作成後の保存（PATCH）。 */
  function persistDraft(): Promise<void> { return persistMenuDraft({ accountId, audience, chatBarText, defaultOpen, folderId, group, host, name, pages, targetingCondition, targetingPriority }) }

  /** 保存して読み直す。戻り値は成否。 */
  function saveDraft(): Promise<boolean> { return saveMenuDraft({ createDraft, group, host, persistDraft, reloadGroup, saveErrors, saving, setCompareOpen, setConflict, setConflictLatest, setError, setNotice, setSaving, validateBasics }) }

  /** 「次へ」。内容を保存してから次の手順へ進む。 */
  async function goNext() {
    const idx = STEP_KEYS.indexOf(step)
    if (idx >= STEP_KEYS.length - 1) return
    const missing = step === 'buttons' ? firstUnconfiguredArea(pages) : null
    if (missing) {
      setActivePageId(missing.pageId)
      setSelectedAreaId(missing.areaId)
      setError(missing.reason)
      return
    }
    const ok = await saveDraft()
    if (!ok) return
    const next = STEP_KEYS[idx + 1]
    setMaxStepIndex((m) => Math.max(m, idx + 1))
    setStep(next)
  }

  /** 手順の見出しの左へ戻る（入力はメモリに残る）。 */
  function goToStep(key: StepKey) {
    setStep(key)
    setError(null)
  }

  /** ★V8 「最新を読み込んで続ける」。最新で入力を置き換える。 */
  function acceptLatestAndContinue() {
    if (!conflictLatest) return
    hydrate(conflictLatest)
    setConflict(false)
    setConflictLatest(null)
    setCompareOpen(false)
    setNotice('最新の内容を読み込みました。直していた所は最新の内容に置き換わっています。')
  }

  const currentSummary = describeMenuSummary({
    name,
    chatBarText,
    audience,
    forHq: Boolean(host),
    pages,
  })
  const latestSummary = conflictLatest
    ? describeMenuSummary({
        name: conflictLatest.name,
        chatBarText: conflictLatest.chatBarText,
        audience: conflictLatest.targetingEnabled ? 'targeted' : conflictLatest.isDefaultForAll ? 'all' : 'none',
        forHq: Boolean(host),
        pages: conflictLatest.pages,
      })
    : ''

  /* ---------- ページ（切替タブ） ---------- */

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null
  const selectedArea = activePage?.areas.find((a) => a.id === selectedAreaId) ?? null

  function updatePage(pageId: string, patch: Partial<Page>) {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, ...patch } : p)))
  }

  function updateArea(pageId: string, areaId: string, patch: Partial<Area>) {
    setPages((prev) =>
      prev.map((p) =>
        p.id === pageId
          ? { ...p, areas: p.areas.map((a) => (a.id === areaId ? { ...a, ...patch } : a)) }
          : p,
      ),
    )
  }

  function addArea(pageId: string, area: Area) {
    setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, areas: [...p.areas, area] } : p)))
    setSelectedAreaId(area.id)
  }

  function deleteArea(pageId: string, areaId: string) {
    setPages((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, areas: p.areas.filter((a) => a.id !== areaId) } : p)),
    )
    setSelectedAreaId(null)
  }

  /** 消えるページを行き先にしている切替ボタンがあれば、その理由（残るページの中から探す）。 */
  function removePageBlockers(removed: Page[], remaining: Page[]): string[] {
    const removedIds = new Set(removed.map((p) => p.id))
    const referrers = remaining.filter((p) =>
      p.areas.some(
        (a) =>
          a.actionType === 'richmenuswitch' &&
          removedIds.has(String((a.actionData as { targetPageId?: string }).targetPageId ?? '')),
      ),
    )
    if (referrers.length === 0) return []
    return [
      `${referrers.map((p) => `「${p.name}」`).join('、')}のタブ切替ボタンが、消えるタブを行き先にしています。先に手順②で行き先を変えてください。`,
    ]
  }
  /** 画像か、決めた動きがあるページ（消すときに確かめる）。 */
  function pageHasSettings(page: Page): boolean {
    return Boolean(page.imageR2Key) || page.areas.some(isAreaActionConfigured)
  }
  /** ①の切替タブの数（0＝なし・1＝2つ・2＝3つ）を変える。消えるタブに設定があれば確かめの窓を出す。 */
  function requestTabCount(next: number) { return requestMenuTabCount({ applyTabCount, group, pageHasSettings, pages, pendingImages, removePageBlockers, setPendingTabCount, tabCount }, next) }
  function applyTabCount(next: number) { return applyMenuTabCount({ activePageId, group, host, pages, removePageBlockers, setActivePageId, setPages, setPendingImages, setPendingTabCount, setSelectedAreaId, setTabCount, setTabNames, templateKey }, next) }
  /* ---------- 画像 ---------- */

  async function uploadPageImage(pageId: string, file: File) {
    if (!group) return
    setError(null)
    if (host) {
      try {
        const uploaded = await host.uploadImage(file, group.size)
        updatePage(pageId, { imageR2Key: uploaded.r2Key, imageContentType: file.type })
        setImageVersion((v) => v + 1)
      } catch (e) {
        const fieldFailure = saveErrors.capture(e)

        { if (!fieldFailure)

        setError(describeApiFailure(e, '画像の登録')) }
      }
      return
    }
    try {
      if(!Number.isSafeInteger(group.publishingGeneration))throw new Error('画像の版を確認できません。読み直してください。')
      const res = await api.richMenuGroups.uploadImage(group.id, pageId, file,group.publishingGeneration)
      if(res.data.publishingGeneration!==group.publishingGeneration+1)throw new Error('画像の版を確認できません。読み直してください。')
      setGroup(current=>current&&current.id===group.id&&current.publishingGeneration===group.publishingGeneration?{...current,publishingGeneration:res.data.publishingGeneration!}:current)
      updatePage(pageId, {
        imageR2Key: res.data.imageR2Key,
        imageContentType: res.data.imageContentType,
      })
      setImageVersion((v) => v + 1)
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(imageUploadErrorText(e)) }
    }
  }

  /** 登録メディアの中身を取り寄せて、ページ画像として上げる。 */
  async function uploadMediaToPage(pageId: string, item: MediaItem) {
    if (!group || !accountId) return
    setError(null)
    try {
      await uploadPageImage(pageId, await mediaToFile(item, accountId))
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(e instanceof ApiError ? imageUploadErrorText(e) : '登録メディアの画像を読み込めませんでした。もう一度お試しください。') }
    }
  }

  /** ①の画像の枠（タブの順）にファイルを入れる。作る前は持っておき、作った後はそのページへ上げる。 */
  function handlePickedFile(file: File | null, tabIndex: number) {
    if (!file) return
    if (!group) {
      const url = URL.createObjectURL(file)
      setPendingImageAt(tabIndex, { file, url, dims: null, media: null })
      const img = new Image()
      img.onload = () =>
        setPendingImages((prev) => {
          if (prev[tabIndex]?.url !== url) return prev
          const next = [...prev]
          next[tabIndex] = { ...prev[tabIndex]!, dims: { w: img.naturalWidth, h: img.naturalHeight } }
          return next
        })
      img.src = url
      return
    }
    const target = pages[tabIndex]
    if (!target) return
    if (target.id.startsWith('tmp-') && !host) {
      setError('新しいタブは、先に下書きを保存してから画像を入れてください。')
      return
    }
    void uploadPageImage(target.id, file)
  }

  function handlePickedMedia(item: MediaItem) {
    setMediaPickerOpen(false)
    if (!group) {
      setPendingImageAt(imagePickTarget, { file: null, url: null, dims: null, media: item })
      return
    }
    const target = pages[imagePickTarget]
    if (!target) return
    if (target.id.startsWith('tmp-')) {
      setError('新しいタブは、先に下書きを保存してから画像を入れてください。')
      return
    }
    void uploadMediaToPage(target.id, item)
  }

  /* ---------- 手順③：出る人数 ---------- */

  const [targetPreview, setTargetPreview] = useState<RichMenuTargetPreview | null>(null)
  const [targetPreviewLoading, setTargetPreviewLoading] = useState(false)
  const [targetPreviewError, setTargetPreviewError] = useState('')

  const reloadTargetPreview = useCallback(async () => {
    if (!group) return
    setTargetPreviewLoading(true)
    setTargetPreviewError('')
    try {
      if (aggregateOnly) {
        // staff は集計だけ。保存途中の条件ではなく、保存済みの条件で数える。
        const response = await api.richMenuGroups.audienceSummary(group.id)
        if (!response.success) throw new Error(response.error)
        setTargetPreview({
          matched: response.data.targeted,
          overlap: response.data.excluded,
          effective: response.data.effective,
          higherMenus: [],
          priority: targetingPriority,
        })
        return
      }
      const response = await api.richMenuGroups.previewTargets(
        group.id,
        audience === 'targeted' ? targetingCondition : null,
      )
      if (!response.success) throw new Error(response.error)
      setTargetPreview(response.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setTargetPreview(null)
      { if (!fieldFailure)
      setTargetPreviewError('対象人数を確認できませんでした。条件は保存できます。') }
    } finally {
      setTargetPreviewLoading(false)
    }
  }, [group, audience, targetingCondition, aggregateOnly, targetingPriority, saveErrors])

  useEffect(() => {
    if (step !== 'audience' && step !== 'publish') return
    if (!group || host) return
    const timer = window.setTimeout(() => void reloadTargetPreview(), 250)
    return () => window.clearTimeout(timer)
  }, [step, group, reloadTargetPreview])

  /* ---------- 手順④：公開 ---------- */

  const loadChecks = useCallback(async () => {
    if (!group) return
    setChecksLoading(true)
    try {
      const res = await api.richMenuGroups.prepublishCheck(group.id)
      if (!res.success) throw new Error(res.error)
      const data = res.data
      /* 形が違う応答（古い口・途中の応答）で画面ごと落とさない。読めなかったものとして扱う。 */
      if (!data || typeof data.selfCheck !== 'object' || data.selfCheck === null || typeof data.pageCount !== 'number') {
        throw new Error('prepublish-check response malformed')
      }
      setChecks((prev) => ({
        self: { state: data.selfCheck.ok ? 'ok' : 'ng', message: data.selfCheck.ok ? null : data.selfCheck.message },
        // LINEの検査結果は別口（validatePublish）で確かめた分だけ残す。
        line: prev?.line ?? { state: 'yet', message: null },
        device: { state: data.deviceConfirmed ? 'ok' : 'yet', at: data.deviceConfirmedAt },
        pages: { state: data.pageCount <= data.maxPages ? 'ok' : 'ng', count: data.pageCount, max: data.maxPages },
      }))
      setChecksError(false)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setChecksError(true) }
    } finally {
      setChecksLoading(false)
    }
  }, [group, saveErrors])

  useEffect(() => {
    if (step === 'publish' && group && !host) void loadChecks()
  }, [step, group, loadChecks, host])

  // 「終わりを決める」の戻し先候補：公開中のほかのメニュー。
  useEffect(() => {
    if (!group) return
    setRestoreMenus(
      otherMenus
        .filter((item) => item.id !== group.id && item.status === 'published')
        .map((item) => ({ id: item.id, name: item.name })),
    )
  }, [group, otherMenus])

  /*
   * 公開予定は下書きとしてブラウザへ控える（編集画面と同じ仕組み。
   * 再読込しても「いつ公開するか」の入力が消えない）。
   * 下書きができたタイミングで一度だけ読み、以後は入力のたびに書く。
   */
  const groupId = group?.id ?? null
  const planLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!groupId || planLoadedRef.current === groupId) return
    planLoadedRef.current = groupId
    const saved = loadPublishPlanDraft(groupId) ?? DEFAULT_PUBLISH_PLAN
    setPublishPlan(saved)
    setPublishBaseline(DEFAULT_PUBLISH_PLAN)
    setEndEnabled(saved.mode === 'period')
  }, [groupId])

  // 入力したメニューの控えだけを更新する。切替の途中の古い入力を別のIDへ書かない。
  function updatePublishPlan(next: PublishPlanInput) {
    setPublishPlan(next)
    if (groupId && !host) savePublishPlanDraft(groupId, next)
  }

  async function validateWithLine() {
    if (!group || validating) return
    setValidating(true)
    setError(null)
    try {
      const res = await api.richMenuGroups.validatePublish(group.id)
      if (!res.success) throw new Error(res.error)
      const line = res.data.checks.find((c) => c.key === 'line')
      const self = res.data.checks.find((c) => c.key === 'self')
      setChecks((prev) =>
        prev
          ? {
              ...prev,
              self: self && !self.ok ? { state: 'ng', message: self.message } : prev.self,
              line: { state: line?.ok ? 'ok' : 'ng', message: line?.ok ? 'LINEの受付に通りました。' : (line?.message ?? 'LINEの検査を通りませんでした。') },
            }
          : prev,
      )
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('LINEの検査を通せませんでした。しばらくおいてから、もう一度お試しください。') }
    } finally {
      setValidating(false)
    }
  }

  async function recordSeen() {
    if (!group || recording) return
    setRecording(true)
    setError(null)
    try {
      const res = await api.richMenuGroups.confirmDevice(group.id)
      if (!res.success) throw new Error(res.error)
      setChecks((prev) => (prev ? { ...prev, device: { state: 'ok', at: res.data.confirmedAt } } : prev))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('実機で見た記録を残せませんでした。もう一度お試しください。') }
    } finally {
      setRecording(false)
    }
  }

  const checksAllOk =
    checks !== null &&
    checks.self.state === 'ok' &&
    checks.line.state === 'ok' &&
    checks.device.state === 'ok' &&
    checks.pages.state === 'ok'

  /*
   * 予約公開は実行係（schedule executor）があとでLINEへ出す。
   * 実機確認は「いま押す」の保全なので、予約時は自前+LINEの検査だけ求める。
   * （確定内容は保存時点の下書きスナップショットとして固定される）
   */
  const scheduleGateOk =
    checks !== null &&
    checks.self.state === 'ok' &&
    checks.line.state === 'ok' &&
    checks.pages.state === 'ok'

  const scheduleSubmit = useScheduleSubmit({
    groupId: group?.id ?? '',
    persistDraft: () => persistDraft(),
    onSaving: setSaving,
    onSaved: (message) => {
      setError(null)
      setNotice(message)
      setPublishBaseline(publishPlan)
      setDone('scheduled')
      if (group) {
        setBaselineSignature(draftSignature())
        clearPublishPlanDraft(group.id)
      }
      void reloadGroup(group?.id ?? '')
    },
    onFailed: (message) => {
      setNotice('')
      setError(message)
    },
  })

  function validatePublishLabels() {
    if (!unnamedArea) return true
    publishLabelErrors.fail('label', 'ボタン名（読み上げラベル）を入力してください')
    return false
  }
  function handlePublish() {
    if(!publishTarget||!group||group.version!==publishTarget.version||group.publishingGeneration!==publishTarget.generation||draftSignature()!==publishTarget.signature||JSON.stringify(pages.map((page,index)=>({orderIndex:index,imageR2Key:page.imageR2Key,imageContentType:page.imageContentType})))!==JSON.stringify(publishTarget.images)){setError('公開内容が変わりました。閉じてもう一度確認してください。');return}
    if (validatePublishLabels()) return publishMenuNow({ audience, group, confirmedImages:publishTarget.images, loadChecks, persistDraft, publishAttempt, publishing, reloadGroup, saveErrors, saving, setDone, setError, setNotice, setPublishing })
  }

  /** 「公開する」/「予約する」。時刻を決めた公開は予約口へ。 */
  async function handlePublishSubmit() {
    if (!validatePublishLabels()) return
    const timingIsScheduled = publishPlan.mode !== 'now'
    if (timingIsScheduled) {
      const startsAt = publishPlan.startsAt
      if (!startsAt) {
        if (!saveErrors.fail("startsAt", '公開を始める日時を選んでください。'))
        setError('公開を始める日時を選んでください。')
        return
      }
      if (publishPlan.mode === 'period' && !publishPlan.endsAt) {
        if (!saveErrors.fail("publishPlan.endsAt", '終わる日時を選んでください。'))
        setError('終わる日時を選んでください。')
        return
      }
      const input: RichMenuScheduleInput = {
        mode: publishPlan.mode === 'period' ? 'period' : 'scheduled',
        startsAt: datetimeLocalJstToUtcIso(startsAt),
        endsAt: publishPlan.mode === 'period' ? datetimeLocalJstToUtcIso(publishPlan.endsAt) : null,
        restoreGroupId: publishPlan.mode === 'period' ? publishPlan.restoreGroupId || null : null,
      }
      void scheduleSubmit(input)
      return
    }
    if (!group || !accountId || group.accountId !== accountId || !canOperateRef.current) return
    if(!Number.isSafeInteger(group.publishingGeneration)){setError('公開内容の版を確認できません。読み直してください。');return}
    publishDialogScope.current={};setError(null); setPublishTarget({ accountId: group.accountId, name: selectedAccount?.id === group.accountId ? selectedAccount.name : null, scope: publishScope.current,dialogScope:publishDialogScope.current,version:group.version,generation:group.publishingGeneration,signature:draftSignature(),images:pages.map((page,index)=>({orderIndex:index,imageR2Key:page.imageR2Key,imageContentType:page.imageContentType})) }); setPublishConfirmOpen(true)
  }

  /* ---------- 派生値 ---------- */

  const locked = group !== null // 形（大きさ・面・タブ数）は create 後は変えられない
  const template = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0]
  const shownLayouts = V8_LAYOUT_KEYS[size]
    .map((key) => TEMPLATES.find((t) => t.key === key))
    .filter((t): t is RichMenuTemplate => Boolean(t))

  /*
   * 右のスマホ見本：手順②はいま編集中のページ、それ以外は最初に見せる
   * ページ（既定ページ）の見え方を出す。
   */
  const previewPage = !group
    ? null
    : step === 'buttons'
      ? activePage
      : pages.find((p) => p.id === group.defaultPageId) ?? pages[0] ?? null

  const previewImageUrl = !group
    ? pendingImages[0]?.media && accountId
      ? api.media.contentUrl(pendingImages[0].media.id, accountId)
      : pendingImages[0]?.url ?? null
    : previewPage?.imageR2Key
      ? host ? host.imageUrl(previewPage.imageR2Key) : `${api.richMenuGroups.imageUrl(previewPage.imageR2Key)}?v=${imageVersion}`
      : null

  const previewAreas = !group
    ? template.areas
    : previewPage
      ? previewPage.areas.map((a, i) => ({ x: a.boundsX, y: a.boundsY, w: a.boundsWidth, h: a.boundsHeight, label: areaDisplayName(a, i), intent: a.intent }))
      : null

  const previewPages = !group
    ? Array.from({ length: tabCount + 1 }, (_, i) => ({
        id: String(i),
        name: tabNameAt(i),
      }))
    : pages.map((p) => ({ id: p.id, name: p.name }))

  const currentDefaultMenu = otherMenus.find(
    (m) => m.id !== group?.id && m.isDefaultForAll && m.status === 'published',
  )

  /*
   * 出す順番の並び：条件つきメニューが順番（小さいほど先）に並び、
   * 既定（すべての友だち）はいちばん下。自分は targeted なら順番の位置へ、
   * all なら末尾の「既定」として置く。
   */
  const targetedMenus = orderTargetingGroups(
    otherMenus.filter((m) => m.targetingEnabled && m.id !== group?.id),
  )
  const selfRow = {
    id: '__self__',
    label:
      audience === 'all'
        ? `${name || '（名前未入力）'}（このメニュー・既定）`
        : `${name || '（名前未入力）'}（このメニュー）`,
    isSelf: true,
  }
  const orderRows: Array<{ id: string; label: string; isSelf: boolean }> = (() => {
    const rows = targetedMenus.map((m) => ({
      id: m.id,
      label: `${m.name}（${describeCondition(parseStoredCondition(m.targetingCondition))}）`,
      isSelf: false,
    }))
    if (audience === 'all') return [...rows, selfRow]
    const before = targetedMenus.filter((m) => m.targetingPriority < targetingPriority).length
    rows.splice(before, 0, selfRow)
    return rows
  })()

  const conditionEmpty = isEmptyCondition(targetingCondition)
  const conditionUnsaved = Boolean(group) && JSON.stringify(audience === 'targeted' ? targetingCondition : null)
    !== JSON.stringify(group?.targetingEnabled ? parseStoredCondition(group.targetingCondition) : null)
  const conditionCount = targetingCondition?.rules.length ?? 0
  const nowNote = audience === 'all'
    ? '保存したらすぐ、個別に指定した人を除くすべての友だちの既定メニューになります'
    : audience === 'none'
      ? 'LINEへの登録だけで、友だちの画面は変わりません。出す相手は一覧の「表示先」で決めてください'
      : conditionEmpty
        ? 'いまの条件では誰にも出ません（今0人）。条件を決めてから出してください'
        : '保存するとLINEに登録され、条件に当てはまる人の画面に出来事のタイミングで順次出ます'
  const publishEffectNote = publishEffectNoteFor(audience, conditionEmpty)
  const publishConfirmNote = publishConfirmNoteFor(audience, conditionEmpty)
  /*
   * 面の数：作成前は選んだ面の分けかたの数、作成後は全ページの面の合計。
   * 作成前の面はまだ動きが未設定（0設定済み）なので、分けかたの枚数だけ数える。
   */
  const totalAreaCount = group
    ? pages.reduce((count, p) => count + p.areas.length, 0)
    : template.areas.length * (tabCount + 1)
  const configuredCount = group
    ? pages.reduce((count, p) => count + p.areas.filter(isAreaActionConfigured).length, 0)
    : 0

  const pageImageUrl = activePage?.imageR2Key
    ? host ? host.imageUrl(activePage.imageR2Key) : `${api.richMenuGroups.imageUrl(activePage.imageR2Key)}?v=${imageVersion}`
    : null

  const areaActionSummary = (area: Area): string => {
    if (!isAreaActionConfigured(area)) return ''
    const intent = intentOf(area)
    if (intent === 'switch') {
      const target = pages.find((p) => p.id === String(area.actionData?.targetPageId ?? ''))
      return target ? `${target.name}を開く` : 'メニューを切り替える'
    }
    return intentLabelOf(area)
  }

  /* ---------- 手順ごとの中身 ---------- */

  const stepIndex = STEP_KEYS.indexOf(step)
  /*
   * 居場所は currentKey が決める。state は「済みか」だけを表すので、
   * いまいる段は done にしない（まだ入力中）。最後の「公開」は押して出すまで済みにしない
   * （開き直した下書きで、まだ公開していないのに済みの印が付いていた。）。
   */
  const stepperSteps = STEP_KEYS.map((key, i) => ({
    key,
    label: stepLabel(key),
    /* 統括（・・）：今の手順より先は、直すときに押して進めても番号のまま（済みの印は前の手順だけ）。まだ公開していない「公開」の段は番号のまま。 */
    state: (host ? i < stepIndex : i !== stepIndex && i <= maxStepIndex && (key !== 'publish' || done !== null)) ? 'done' as const : 'todo' as const,
    onSelect: i !== stepIndex && i <= maxStepIndex ? () => goToStep(key) : undefined,
    reachable: i !== stepIndex && i <= maxStepIndex,
  }))

  const headNote =
    step === 'shape'
      ? host ? 'いまは下書きとして作ります。最後の「配る」で選んだアカウントへ届けます。' : 'いまは下書きとして作ります。最後の「公開」で LINE に出します。'
      : `名前：${name || emptyValue('unconfigured')}・いまは下書きです`
  const conditionHelp = audience === 'targeted' && conditionEmpty
    ? '条件が空のままだと、公開しても誰にも出ません。条件を1つ以上足してください。'
    : ''

  /* ---------- 描画 ---------- */

  const busy = saving || publishing || Boolean(host?.busy)

  /** 統括：画面の中の下書きを一度に保存する（手順の途中でも同じ）。 */
  async function hostSave(distribute: boolean) {
    if (!host || saving) return
    setError(null)
    if (!group) {
      setSaving(true)
      try {
        const seed = await hostSeedFromShape()
        if (!seed) return
        hydrate(groupFromSeed(seed))
        host.onSave(seed, distribute, hqDuplicateMode)
      } finally {
        setSaving(false)
      }
      return
    }
    if (!validateBasics()) return
    host.onSave(seedNow(), distribute, hqDuplicateMode)
  }
  function seedNow(): HqRichMenuSeed { return makeHqMenuSeed({ host, name, chatBarText, folderId, size, group, audience, hqTagName, defaultOpen, targetingPriority, pages }) }

  if (!hqDraft.ready) return <ListState kind="loading" title="作りかけを確認しています" />
  if (editGroupId && editLoad !== 'ready') {
    if (editLoad === 'forbidden') {
      return <SaveErrorScope errors={saveErrors}><ListState kind="forbidden"
        permissionScope="store"
        action={<Button href="/rich-menus">リッチメニュー一覧へ戻る</Button>} /></SaveErrorScope>
    }
    if (editLoad === 'missing') {
      return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このリッチメニューは見つかりません" description="削除されたか、別の LINE アカウントのものです。一覧から選び直してください。" backHref="/rich-menus" backLabel="リッチメニュー一覧へ戻る" /></SaveErrorScope>
    }
    if (editLoad === 'error') {
      return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="リッチメニューを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void loadEditGroup()} /></SaveErrorScope>
    }
    return <SaveErrorScope errors={saveErrors}><p className={styles.editLoading} role="status">読み込み中…</p></SaveErrorScope>
  }

  if (!host && !canOperate && !editGroupId && !group) return <CreatePage boardId="JeINq" title="リッチメニューを作る" readOnly footerActions={<Button href="/rich-menus">一覧へ戻る</Button>} dirty={false}>{null}</CreatePage>

  return (
    <SaveErrorScope errors={saveErrors}><fieldset disabled={busy} className="contents">
    <CreatePage step={stepIndex} dirty={false} readOnly={!host && !canOperate} boardId={
        host ? (step === 'shape' ? 'gobhu' : step === 'buttons' ? 'egdGx' : step === 'audience' ? 'K0gu1' : 'gQabc')
          : step === 'shape' ? 'JeINq' : step === 'buttons' ? 'Z0uO6' : step === 'audience' ? 'OxEMM' : 'F4gELj'
      } headingSize="large" title={<>リッチメニューを作る</>} help={<>{headNote}{conditionHelp ? <p>{conditionHelp}</p> : null}</>} notice={conflict ? (
          /* 板 ：帯は頭の説明の下に横いっぱい（右の列の上まで）。見た目は共通部品（save-conflict）。比べる窓はこの画面の要約の比べ（VersionCompare）。 */
          <div className={styles.conflictSlot}>
            <SaveConflictBand reloadVariant="primary"
              title="ほかの人がこのメニューを更新しました"
              description="あなたが直した所はまだ保存されていません。このまま保存すると、ほかの人の変更が消えます。"
              designNode="r8dGXT"
              compareBusy={!conflictLatest}
              onCompare={() => setCompareOpen(true)}
              onReload={acceptLatestAndContinue}
            />
          </div>
        ) : null} noticeSpacing="band" identity={undefined} steps={<Steps label="リッチメニューを作る手順" steps={stepperSteps} currentKey={step} readOnly={!host && !canOperate} summaries={{ shape: `${name}・${tabCount}タブ`, buttons: `${pages.reduce((total, page) => total + page.areas.length, 0)}個のボタン`, audience: describeMenuAudience(audience, Boolean(host)) }} />}  preview={(inDialog) => renderRail(inDialog)} previewCompactWhenNarrow footerActions={
          !host && !canOperate ? <Button href="/rich-menus">一覧へ戻る</Button> : host ? (
            <>
              <Button type="button" onClick={host.onCancel} disabled={busy}>キャンセル</Button>
              {step === 'publish' ? (
                <>
                  <Button type="button" disabled={busy || !host.canOperate} busy={saving || host.busy} busyLabel="保存中…" onClick={() => void hostSave(false)}>
                    下書きを保存
                  </Button>
                  <Button type="button" variant="primary" disabled={busy || !host.canOperate} title="保存したあとに、配る前の確認へ進みます" busy={saving || host.busy} busyLabel="保存しています…" onClick={() => void hostSave(true)}>
                    <Upload size={16} aria-hidden="true" />
                    {host.selectedCount > 0 ? `${formatNumber(host.selectedCount)} アカウントへ配る` : 'アカウントへ配る'}
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" disabled={busy || !host.canOperate} busy={saving} busyLabel="保存中…" onClick={() => void hostSave(false)}>
                    下書きを保存
                  </Button>
                  <Button type="button" variant="primary" disabled={busy} busy={saving} busyLabel="保存中…" onClick={() => void goNext()}>
                    {nextLabel(step as Exclude<StepKey, 'publish'>)}
                    <ArrowRight size={16} aria-hidden="true" />
                  </Button>
                </>
              )}
            </>
          ) : <>
            <Button href="/rich-menus">キャンセル</Button>
            {step === 'publish' ? (
              done ? (
                <Button href="/rich-menus">一覧へ戻る</Button>
              ) : (
                <>
                  <Button type="button" disabled={busy || !canOperate} busy={saving} busyLabel="保存中…" onClick={() => void saveDraft()}>
                    下書きを保存
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={
                      busy ||
                      !canOperate ||
                      (checks !== null && publishPlan.mode === 'now' && !checksAllOk) ||
                      (checks !== null && publishPlan.mode !== 'now' && !scheduleGateOk)
                    }
                    title={!canOperate ? '公開する権限がありません' : busy ? '処理が終わるまでお待ちください' : checks !== null && publishPlan.mode === 'now' && !checksAllOk ? '公開前の確認で未完了の項目があります。確認結果を直してください' : checks !== null && publishPlan.mode !== 'now' && !scheduleGateOk ? '予約公開の確認に通っていません。確認結果を直してください' : undefined}
                    busy={publishing || saving} icon={publishPlan.mode === 'now' ? <Send size={16} aria-hidden="true" /> : <CalendarClock size={16} aria-hidden="true" />}
                    busyLabel={publishPlan.mode === 'now' ? '公開しています…' : '予約しています…'}
                    onClick={() => void handlePublishSubmit()}
                  >
                    {publishPlan.mode === 'now' ? <Send size={16} aria-hidden="true" /> : <CalendarClock size={16} aria-hidden="true" />}
                    {publishPlan.mode === 'now' ? '公開する' : '予約する'}
                  </Button>
                </>
              )
            ) : (
              <>
                <Button type="button" disabled={busy} busy={saving} busyLabel="保存中…" onClick={() => void saveDraft()}>
                  下書きを保存
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={busy}
                  busy={saving}
                  busyLabel="保存中…"
                  onClick={() => void goNext()}
                >
                  {NEXT_LABEL[step as Exclude<StepKey, 'publish'>]}
                  <ArrowRight size={16} aria-hidden="true" />
                </Button>
              </>
            )}
          </>
        } status={dirty ? '未保存の変更があります' : undefined} >
      {hqDraft.failed ? <Notice tone="danger" message="一時保存できません。再読み込み前に入力を控えるか、下書きを保存してください。" /> : null}
      {host?.notice}
      <ValidationSummary problems={fields.listProblems()} onFocusFirst={fields.focusFirst} minProblems={2} />

      {error ? (
        <Notice
          tone="danger"
          message={error}
          className="mb-1"
          action={
            loadFailedKinds.length > 0 && !isForbidden(loadError) ? (
              <Button type="button" onClick={() => { setError(null); return load() }} busyLabel="処理中…">
                もう一度読み込む
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {notice ? <Notice tone="success" message={notice} className="mb-1" onClose={() => setNotice('')} /> : null}
      {candidatePruneNotice ? <Notice tone="warn" message={candidatePruneNotice} onClose={() => setCandidatePruneNotice('')} /> : null}

          {step === 'shape' ? renderShape() : null}
          {step === 'buttons' ? renderButtons() : null}
          {step === 'audience' ? renderAudience() : null}
          {step === 'publish' ? renderPublish() : null}

      {host ? null : <MediaPickerDialog
        open={mediaPickerOpen}
        accountId={accountId}
        kind="image"
        title="リッチメニューの画像を選ぶ"
        description={
          tabCount > 0 || pages.length > 1
            ? `タブ${imagePickTarget + 1}「${group ? pages[imagePickTarget]?.name ?? '' : tabNameAt(imagePickTarget)}」の画像として登録します。`
            : group
              ? '最初に見せるページの画像として登録します。'
              : '作成したメニューの最初に見せるページへ登録します。'
        }
        onClose={() => setMediaPickerOpen(false)}
        onSelect={handlePickedMedia}
      />}

      {/* ①でタブを減らすとき：消えるタブの画像・動きを黙って捨てない。行き先にされているタブは消せない。 */}
      {(() => {
        const next = pendingTabCount
        const removed = next === null ? [] : group ? pages.slice(next + 1) : []
        const blockers = next === null || !group ? [] : removePageBlockers(removed, pages.slice(0, next + 1))
        const names = next === null
          ? []
          : group
            ? removed.map((p, i) => `タブ${next + 2 + i}「${p.name}」`)
            : Array.from({ length: tabCount - next }, (_, i) => `タブ${next + 2 + i}「${tabNameAt(next + 1 + i)}」`)
        return (
          <ConfirmDialog
            open={next !== null}
            title={blockers.length > 0 ? 'タブの数をいま減らせません' : `タブの数を${next === 0 ? emptyValue('none') : `${(next ?? 0) + 1}つ`}にしますか？`}
            description={
              blockers.length > 0
                ? '消えるタブを行き先にしている切替ボタンがあります。理由を直してから、もう一度お試しください。'
                : `${names.join('・')}の画像と面の動きは消えます。`
            }
            confirmLabel="タブを減らす"
            destructive
            // 減らせないときは押し口ごと出さない。
            onConfirm={blockers.length === 0 && next !== null ? () => applyTabCount(next) : undefined}
            onCancel={() => setPendingTabCount(null)}
          >
            {blockers.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </ConfirmDialog>
        )
      })()}

      <Dialog open={imageGuideOpen} title="画像の作り方" cancelLabel="閉じる" onCancel={() => setImageGuideOpen(false)}>
        <div className="space-y-3 text-sm">
          <p>大きい画像は2500×1686px、小さい画像は2500×843pxで作ります。PNGかJPEGで、1MB以下にしてください。</p>
          <p>選んだ面の分け方に合わせて文字や絵を置きます。大切な文字や絵は面の区切りから離して、押す場所が分かるようにしてください。</p>
          <p>手順②で画像の上から面を選び、押したときの動きを設定します。公開前に「LINEでの見え方」と実際のスマートフォンで確認してください。</p>
        </div>
      </Dialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="メニューの入力"
        title={discardUnknown ? '下書きの確認' : createdDraft ? '下書きをどうしますか？' : undefined}
        description={discardUnknown ? discardDraftError : createdDraft ? '保存された下書きがあります。残すか、消して移るか選んでください。' : undefined}
        saveLabel={discardUnknown ? '一覧で確認する' : createdDraft ? '下書きを残して移る' : undefined}
        discardLabel={createdDraft ? '下書きを消して移る' : undefined}
        discardDisabled={discardUnknown}
        busy={saving || discardingDraft} error={discardUnknown ? undefined : discardDraftError}
        onSave={discardUnknown ? async () => true : createdDraft ? async () => !dirty || await saveDraft() : undefined}
        onSavedLeave={discardUnknown ? () => { disarm(); router.push('/rich-menus') } : confirmLeave} onConfirm={createdDraft ? () => void discardCreatedDraft() : confirmLeaveAndDiscard}
        onCancel={() => { setDiscardDraftError(''); setDiscardUnknown(false); cancelLeave() }} />
      <Dialog open={priorityOpen} title="出す順番" description="一覧で上にあるメニューが優先されます。1がいちばん先です。"
        confirmLabel="順番を変える" onConfirm={() => {
          setTargetingPriority(Math.max(0, (parseInt(priorityInput, 10) || 1) - 1))
          setPriorityOpen(false)
        }} onCancel={() => setPriorityOpen(false)}>
        <Field label="出す順番" htmlFor="rm-edit-priority"><NumberInput numericText id="rm-edit-priority" inputMode="numeric" min={1} step={1} unit="番目" value={priorityInput} onChange={event => setPriorityInput(event.target.value)} /></Field>
      </Dialog>
      <ConfirmDialog
        open={publishConfirmOpen && publishTarget?.scope === publishScope.current}
        title="公開の確認"
        description={publishConfirmNote}
        confirmLabel="公開する"
        busy={publishing || saving}
        error={error || undefined} onSuccess={() => {publishDialogScope.current={};setPublishConfirmOpen(false)}} onConfirm={() => { if (publishAlive.current && publishTarget?.scope === publishScope.current && publishTarget.dialogScope===publishDialogScope.current && canOperateRef.current) return handlePublish() }}
        onCancel={() => {publishDialogScope.current={};setPublishConfirmOpen(false)}}
      >
        {publishTarget ? <OperationTargetSummary accounts={[{ id: publishTarget.accountId, name: publishTarget.name }]} /> : null}
      </ConfirmDialog>

      {/* ★V8 `r8dGXT`「違いを比べる」の窓。最新と入力中の設定の要約を比べる。 */}
      <Dialog
        open={compareOpen}
        title="違いを比べる"
        description="ほかの人が保存した最新の内容と、あなたが直している内容を比べます。"
        cancelLabel="閉じる"
        onCancel={() => setCompareOpen(false)}
        footer={
          <DialogActions><Button type="button" variant="primary" onClick={acceptLatestAndContinue}>
            最新を読み込んで続ける
          </Button></DialogActions>
        }
      >
        <VersionCompare before={latestSummary} after={currentSummary} />
      </Dialog>
    </CreatePage>
    </fieldset></SaveErrorScope>
  )

  /* ======== 手順①：形と画像 ======== */
  function renderShape() { return renderShapeStep({ accountId, busy, canOperate, chatBarText, defaultTabName, fields, folderId, folders, group, host, locked, name, pages, renderSingleImage, renderTabImageSlot, requestTabCount, setChatBarText, setFolderId, setFolders, setName, setSize, setTabNames, setTemplateKey, shownLayouts, size, tabCount, tabNames, templateKey, updatePage }) }

  /** ①の画像の枠（タブの順）に入っている画像。作る前は選んだもの、作った後はページの画像。 */
  function slotImage(index: number): { src: string; name: string; dims: { w: number; h: number } | null; kb: number | null; removable: boolean } | null { return getSlotImage({ accountId, group, host, imageVersion, pages, pendingImages }, index) }

  /*
   * 画像の枠は共通の「画像を追加する所」（MediaSlot・Z7vd2・）。
   * 入れ方は今のまま（ファイル・登録メディア）。作る前は選んだファイルを手元に置き、作った後はページへ送る（handlePickedFile）。
   */
  function renderSingleImage() { return renderSingleImageSlot({ accountId, busy, clearPendingImage, handlePickedFile, host, setImageGuideOpen, setImagePickTarget, setMediaPickerOpen, size, slotImage }) }

  /** タブがあるときの画像の枠（タブ〇「名前」の見出し付き）。 */
  function renderTabImageSlot(index: number) { return renderTabSlot({ accountId, busy, clearPendingImage, group, handlePickedFile, host, pages, setImagePickTarget, setMediaPickerOpen, size, slotImage, tabNameAt }, index) }

  /* ======== 手順②：ボタンの動き ======== */
  function renderButtons() { return renderButtonsStep({ activePage, addArea, areaActionSummary, deleteArea, fields, forms, goToStep, group, host, pageImageUrl, pages, publishLabelErrors, selectedArea, selectedAreaId, setActivePageId, setSelectedAreaId, size, tags, templates, trackedLinks, updateArea }) }

  /*
   * ======== 統括の手順③：配る先========
   * 配るアカウント（統括が渡す1行の欄）→ 各アカウントで誰に出すか。
   * 統括のひな形が持てるのは「全員（配った先の既定）」か「決めない（各アカウントで決める）」の2つ。
   * 「タグが付いた人」（displayTagName）と「トークを開いたとき」（defaultOpen）は組1の口（保存・配布）で持つ。
   */
  function renderHqAudience() { return renderHqAudienceStep({ audience, defaultOpen, host, hqTagName, setAudience, setDefaultOpen, setHqTagName }) }

  /* ======== 手順③：誰に出すか ======== */
  function renderAudience() { return renderAudienceStep({ aggregateOnly, audience, canOperate, conditionCount, conditionEmpty, conditionUnsaved, currentDefaultMenu, defaultOpen, editGroupId, host, orderRows, renderHqAudience, setAudience, setDefaultOpen, setPriorityInput, setPriorityOpen, setTargetingCondition, setTargetingPriority, targetedMenus, targetingCondition, targetingPriority }) }

  /*
   * ======== 統括の手順④：確かめて配る========
   * 確かめる（形と面ごとの動き）→ 足りないもの（画面の中で分かる所だけ）→ 配ったときの扱い（同じ名前があるとき）。
   * アカウントごとの足りないもの（そのアカウントに無いタグなど）と同じ名前のメニューの数は、
   * 保存したあとの「配る前の確認」で口（preflight）が返すので、ここでは数を作らない（機能待ち）。
   */
  function renderHqPublish() { return renderHqPublishStep({ areaActionSummary, goToStep, group, host, hqDuplicateMode, pages, setHqDuplicateMode, size, tabCount, totalAreaCount }) }

  /* ======== 手順④：公開 ======== */
  function renderPublish() { return renderPublishStep({ accountId, aggregateOnly, areaActionSummary, audience, canOperate, checks, checksError, checksLoading, conditionEmpty, conditionUnsaved, done, endEnabled, goToStep, group, host, loadChecks, nowNote, pages, previewAreas, previewImageUrl, publishEffectNote, publishPlan, recording, recordSeen, renderHqPublish, restoreMenus, setActivePageId, setEndEnabled, setSelectedAreaId, size, staffRole, targetPreview, totalAreaCount, updatePublishPlan, validateWithLine, validating }) }
  /* ======== 右の列 ======== */
  /* LINEでの見え方（スマホの見本）。広い板は右の列に、狭い板は右の列のボタンから窓で開く。 */
  function renderLinePreview() { return renderMenuLinePreview({ activePage, chatBarText, group, host, previewAreas, previewImageUrl, previewPage, previewPages, selectedAccount, size }) }
  function renderRail(inDialog = false) { return renderPreviewRail({ activePage, audience, conditionEmpty, conditionUnsaved, configuredCount, currentDefaultMenu, group, host, hqPreview, pages, previewImageUrl, renderLinePreview, selectedArea, step, tabCount, targetPreview, targetPreviewError, targetPreviewLoading, totalAreaCount }, inDialog) }
}
