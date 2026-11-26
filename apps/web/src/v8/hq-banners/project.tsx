'use client'

import { OverlayDepthContext, scrollMotion } from '@/components/shared/overlay-utils'
import { useUnsavedGuard, type UnsavedLeaveTarget } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useAttentionStarMotion } from '@/components/shared/use-attention-star-motion'
import { describeApiFailure } from '@/components/shared/api-error-message'
import ExportSizeChip from '@/components/hq/banners/export-size-chip'
import GenerationPanel from '@/components/hq/banners/generation-panel'
import ReferencePickerDialog from '@/components/hq/banners/reference-picker-dialog'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { accountAiFeaturesApi } from '@/lib/api/helpers/gap3'
import { emptyValue } from '@/components/shared/empty-value'
import SegmentedControl from '@/components/shared/segmented'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import { useListUrlValue } from '@/components/shared/list-url-state'
import MediaSlot from '@/components/shared/media-slot'
import Notice from '@/components/shared/notice'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField,SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import StickyBar, { StickyBarRegion } from '@/components/shared/sticky-bar'
import TargetMissing from '@/components/shared/target-missing'
import TruncatedText from '@/components/shared/truncated-text'
import { DetailColumns } from '@/components/templates/detail-columns'
import { usePageCrumbs,usePageTitle } from '@/components/shell/page-chrome'
import { ListPage } from '@/components/templates'
import { useAccount, type AccountWithStats } from '@/contexts/account-context'
import { api,ApiError } from '@/lib/api'
import {
activeGeneration,
BANNER_MAX_REFERENCE_IMAGES,
EMPTY_GENERATION_INPUT,
exportSizeText,
inputFromGeneration,
packedTextLines,
presetSizeLabel,
readFileAsBase64,
usageRefusal,
usageStatusText,
validateGenerationInput,
type BannerGeneration,
type BannerGenerationInput,
type BannerImage,
type BannerPreset,
type BannerProject,
type BannerReference,
type BannerReferenceMode,
type BannerUsage
} from '@/lib/hq-banners'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import { Archive,ArchiveRestore,Copy,Hourglass,LoaderCircle,Pencil,Send,Sparkles,Star,Upload,X } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useContext,useEffect,useId,useMemo,useRef,useState } from 'react'
import { useDistributionFolders } from '@/v8/hq-templates/public/distribution-accounts/index'
import { SavedDistributionDialog } from '@/v8/hq-templates/public/saved-distribution-dialog/index'
import { BANNER_UPLOAD_ACCEPT,BannerConfirmDialogV8,CreateProjectDialogV8,uploadRefusal } from './dialogs'
import { BannerImageDetailV8 } from './image-detail'
import { bannerLimitKind } from './limit-notice'
import { PendingTile,Thumb } from './project-tiles'
import styles from './project.module.css'
import ReferenceFrame from './reference-frame'
import { bannerFailureMessage,tileLabel } from './words'
import { formatNumber } from '@/lib/format'
import StatusBadge from '@/components/shared/status-badge'

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden' | 'notfound' | 'missing'
type Filter = 'all' | 'favorite' | 'delivered'

export default function HqBannerProjectV8() {
  return (
    <Suspense fallback={null}>
      <ProjectInner />
    </Suspense>
  )
}

function ProjectInner() {
  const attentionMotion = useAttentionStarMotion()
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const { setSelectedAccountId } = useAccount()
  const params = useSearchParams()
  const projectId = params.get('id') ?? ''
  const fromImageId = params.get('from')
  const role = useStaffRole()
  const canManage = canManageRole(role)

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [project, setProject] = useState<BannerProject | null>(null)
  const [images, setImages] = useState<BannerImage[]>([])
  const [generations, setGenerations] = useState<BannerGeneration[]>([])
  const [presets, setPresets] = useState<BannerPreset[]>([])
  const [maxCount, setMaxCount] = useState(4)
  const [usage, setUsage] = useState<BannerUsage | null>(null)
  const [engineReady, setEngineReady] = useState(true)
  const [accountsFailed, setAccountsFailed] = useState(false)
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [aiAccounts, setAiAccounts] = useState<AccountWithStats[]>([])
  const [aiAccountsStatus, setAiAccountsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [aiAccountId, setAiAccountId] = useState('')
  const [settingsAccountId, setSettingsAccountId] = useState('')
  const [input, setInput] = useState<BannerGenerationInput>(EMPTY_GENERATION_INPUT)
  const [inputBaseline, setInputBaseline] = useState<BannerGenerationInput>(EMPTY_GENERATION_INPUT)
  const inputRef = useRef(input)
  inputRef.current = input
  const [inputTouched, setInputTouched] = useState(false)
  const [filter, setFilter] = useListUrlValue<Filter>('filter', 'all')
  const [selectedImages, setSelectedImages] = useState<string[]>([])
  const [distributionOpen, setDistributionOpen] = useState(false)
  const [distributionAccounts, setDistributionAccounts] = useState<string[]>([])
  const [distributionFilter, setDistributionFilter] = useListUrlValue('distributionFilter', 'all')
  const [distributionSearch, setDistributionSearch] = useState('')
  const [distributionBusy, setDistributionBusy] = useState(false)
  const [distributionError, setDistributionError] = useState('')
  const [distributionProgress, setDistributionProgress] = useState('')
  const distributionLock = useRef(false)
  const distributionFolders = useDistributionFolders(distributionOpen)
  const distributionTargets = useMemo(() => accounts.filter((account) => !account.archivedAt).map((account) => ({ id: account.id, name: account.displayName ?? account.name })), [accounts])
  const [actionError, setActionError] = useState('')
  const [generationError, setGenerationError] = useState('')
  // 用途寸法へ整形できなかった生成があった（binding の無い環境）。R120。
  const [sizeNotice, setSizeNotice] = useState(false)
  const [running, setRunning] = useState<BannerGeneration | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [openImage, setOpenImage] = useState<BannerImage | null>(null)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formDirty, setFormDirty] = useState(false)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  // 画像のますの枠（section）が指す見出し。板の `KWlQY` をそのまま見出しに使う。
  const galleryHeadId = useId()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // 参照に選んだ画像の実体。他プロジェクトの画像も選べるので、この一覧に関係なく手元に置く。
  const [referencePool, setReferencePool] = useState<BannerImage[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [allProjects, setAllProjects] = useState<BannerProject[]>([])
  const cancelRef = useRef(false)
  const loopRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const [panelRequest, setPanelRequest] = useState(0)
  useEffect(() => { if (panelRequest) panelRef.current?.scrollIntoView({ behavior: scrollMotion(), block: 'start' }) }, [panelRequest])
  const revealPanel = () => { setPanelExpanded(true); setPanelRequest(n => n + 1) }
  const fileRef = useRef<HTMLInputElement>(null)

  usePageTitle(project?.name ?? null)
  // ★V8 パンくずは「ホーム › バナー生成 › プロジェクト名」。
  usePageCrumbs([{ label: 'バナー生成', href: '/hq/banners' }])

  const loadUsage = useCallback(async () => {
    const res = await api.hqBanners.usage().catch(() => null)
    if (res?.success) setUsage(res.data)
  }, [])

  const load = useCallback(async () => {
    if (!projectId) {
      setStatus('missing')
      return
    }
    setStatus('loading')
    try {
      const [detailRes, presetRes] = await Promise.all([api.hqBanners.projects.get(projectId), api.hqBanners.presets()])
      if (!detailRes.success) throw new Error(detailRes.error)
      setProject(detailRes.data.project)
      setImages(detailRes.data.images)
      setSelectedImages([])
      setGenerations(detailRes.data.generations)
      if (presetRes.success) {
        setPresets(presetRes.data.presets)
        setMaxCount(presetRes.data.maxCount)
        setUsage(presetRes.data.usage)
        setEngineReady(presetRes.data.engineReady)
        setInput((cur) => (cur.presetKey ? cur : { ...cur, presetKey: presetRes.data.presets[0]?.key ?? '' }))
        setInputBaseline((cur) => (cur.presetKey ? cur : { ...cur, presetKey: presetRes.data.presets[0]?.key ?? '' }))
      }
      setStatus('ready')
    } catch (caught) {
      saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404)
 setStatus('notfound')
      else if (caught instanceof ApiError && caught.status === 403)
 setStatus('forbidden')
      else setStatus('error')
    }
  }, [projectId, saveErrors])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false
    let accountListLoaded = false
    void (async () => {
      try {
        const res = await api.lineAccounts.list()
        if (!res.success) throw new Error(res.error)
        const all = res.data as AccountWithStats[]
        if (cancelled) return
        accountListLoaded = true
        setAccounts(all)
        setAccountsFailed(false)
        const active = all.filter(account => account.isActive && !account.archivedAt)
        const settings = await Promise.all(active.map(account => accountAiFeaturesApi.get(account.id)))
        if (settings.some(result => !result.success)) throw new Error('AI settings unavailable')
        const eligible = active.filter((_, index) => settings[index].success && settings[index].data.items.some(item => item.feature === 'banner' && item.enabled))
        if (cancelled) return
        setAiAccounts(eligible)
        let saved = ''
        try { saved = localStorage.getItem('lh_hq_banner_ai_account') ?? '' } catch { /* storage unavailable */ }
        const selected = eligible.some(account => account.id === saved) ? saved : eligible.length === 1 ? eligible[0].id : ''
        setAiAccountId(selected)
        if (selected) try { localStorage.setItem('lh_hq_banner_ai_account', selected) } catch { /* storage unavailable */ }
        setAiAccountsStatus('ready')
      } catch {
        if (!cancelled) { if (!accountListLoaded) setAccountsFailed(true); setAiAccountsStatus('error') }
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 「同じ設定でもう一度生成」で戻ってきたとき、その画像の条件をパネルへ入れる。
  useEffect(() => {
    if (!fromImageId || status !== 'ready') return
    const original = inputRef.current
    void api.hqBanners.images.get(fromImageId).then((res) => {
      if (res.success && res.data.generation && inputRef.current === original) {
        const loaded = inputFromGeneration(res.data.generation)
        setInput(loaded)
        setInputBaseline(loaded)
      }
    }).catch(() => {
      // 元の画像が無くても、空のパネルから作れる。
    })
  }, [fromImageId, status])

  /**
   * サーバーの生成状態を読み直す。画面を閉じても、保存済みの条件で定期処理が続きを作る。
   * 切り抜き位置は最初の生成条件と一緒に保存し、サーバーで続きを作る。
   */
  const runLoop = useCallback(async (generation: BannerGeneration) => {
    if (loopRef.current === generation.id) return
    loopRef.current = generation.id
    cancelRef.current = false
    setCancelling(false)
    setRunning(generation)
    setGenerationError('')
    try {
      let current = generation
      while (!cancelRef.current) {
        const res = await api.hqBanners.generations.get(current.id)
        if (!res.success) throw new Error(res.error)
        current = res.data
        setRunning(current)
        const detail = await api.hqBanners.projects.get(generation.projectId)
        if (detail.success) setImages(detail.data.images)
        if (!['queued', 'running'].includes(current.status)) break
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      void loadUsage()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setGenerationError(describeApiFailure(caught, '生成状態の確認', { scope: 'hq' })) }
      void loadUsage()
    } finally {
      // 先に最新の状態を読み直してから止める（順を逆にすると、古い「生成中」を見た再開がもう一度状態確認を始める）。
      const res = await api.hqBanners.projects.get(generation.projectId).catch(() => null)
      if (res?.success) {
        setProject(res.data.project)
        setImages(res.data.images)
        setGenerations(res.data.generations)
      }
      loopRef.current = null
      setRunning(null)
    }
  }, [loadUsage, saveErrors])

  // 画面を離れて戻ってきたとき、途中の生成があれば状態確認を再開する。
  useEffect(() => {
    if (status !== 'ready' || running) return
    const pending = activeGeneration(generations)
    if (pending && loopRef.current !== pending.id) void runLoop(pending)
  }, [status, generations, running, runLoop])

  const validation = validateGenerationInput(input, maxCount)
  // 左に［配る］の帯が出ている間は、札を寸法だけの短い形にして左の帯へ重ねない（絵 「1040 × 1040」）。
  const sizePreset = presets.find((preset) => preset.key === input.presetKey)
  const sizeChipText = selectedImages.length > 0 && sizePreset ? presetSizeLabel(sizePreset) : exportSizeText(presets, input.presetKey)
  const refusal = usageRefusal(usage, input.count)
  const settingsAccounts = accounts.filter(account => account.isActive && !account.archivedAt)
  const settingsTarget = settingsAccounts.length === 1 ? settingsAccounts[0].id : settingsAccountId
  const accountReason = aiAccountsStatus === 'loading' ? 'AI を使うアカウントを確認しています' : aiAccountsStatus === 'error' ? 'AI を使うアカウントを確認できませんでした。ページを再読み込みしてください' : aiAccounts.length === 0 ? 'AI を使えるアカウントがありません' : !aiAccountId ? 'AI を使うアカウントを選んでください' : null
  const blockedReason = accountReason ?? (!engineReady
    ? '画像生成の接続設定がまだありません。運営にお問い合わせください'
    : project?.archivedAt
      ? 'アーカイブ済みのプロジェクトでは生成できません。復元してからお試しください'
      : validation ?? refusal)

  /*
   * WEB205：作り始める要求が返るまでは、もう一度押せない（連打で別の生成が2つ並ばない）。
   * 同じ依頼を見分ける鍵を口に渡すのは Codex に依頼（口が鍵を受けない）。
   */
  const startingRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const pendingLeave = useRef<UnsavedLeaveTarget | null>(null)
  const localActions = useRef(new WeakSet<() => void>())
  const generationDirty = JSON.stringify(input) !== JSON.stringify(inputBaseline)
  const guard = useUnsavedGuard({ dirty: generationDirty || formDirty || starting || formBusy, busy: starting || formBusy, onDiscard: () => {
    const target = pendingLeave.current
    if (target?.kind !== 'action' || !localActions.current.has(target.run)) setInput(inputBaseline)
    setFormDirty(false)
    setFormOpen(false)
  } })
  pendingLeave.current = guard.leaveTarget
  const closeForm = () => {
    if (formBusy) return
    if (!formDirty) { setFormOpen(false); return }
    const close = () => setFormOpen(false)
    localActions.current.add(close)
    guard.guarded(close)
  }
  const startGeneration = async () => {
    if (!project || blockedReason || running || startingRef.current) return
    startingRef.current = true
    setStarting(true)
    setGenerationError('')
    setActionError('')
    const submittedInput = input
    try {
      const res = await api.hqBanners.projects.createGeneration(project.id, {
        ...input,
        // 空の行を落とすときは「強調」も同じ行と一緒に落とす。
        ...packedTextLines(input),
        customPrompt: input.customPrompt.trim(),
        freePrompt: input.freePrompt.trim(),
      }, { accountId: aiAccountId })
      if (!res.success) throw new Error(res.error)
      setInputBaseline(submittedInput)
      setGenerations((prev) => [res.data, ...prev])
      void runLoop(res.data)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setGenerationError(describeApiFailure(caught, '生成の開始', { scope: 'hq' })) }
      void loadUsage()
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }

  const cancelGeneration = async () => {
    if (!running) return
    cancelRef.current = true
    setCancelling(true)
    try {
      await api.hqBanners.generations.cancel(running.id)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      // 止められなくても、次の run で finished が返る。
    }
  }

  const patchProject = async (label: string, patch: { name?: string; description?: string | null; isFavorite?: boolean; archived?: boolean }) => {
    if (!project) return null
    setBusyAction(label)
    setActionError('')
    try {
      const res = await api.hqBanners.projects.update(project.id, patch)
      if (!res.success) throw new Error(res.error)
      setProject(res.data)
      return res.data
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setActionError(describeApiFailure(caught, '保存', { scope: 'hq' })) }
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const duplicate = async () => {
    if (!project) return
    setBusyAction('複製する')
    setActionError('')
    try {
      const res = await api.hqBanners.projects.duplicate(project.id)
      if (!res.success) throw new Error(res.error)
      router.push(`/hq/banners/project?id=${encodeURIComponent(res.data.id)}`)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('複製できませんでした。もう一度お試しください。') }
    } finally {
      setBusyAction(null)
    }
  }

  const replaceImage = (next: BannerImage) => {
    setImages((prev) => prev.map((i) => (i.id === next.id ? next : i)))
    setOpenImage((cur) => (cur?.id === next.id ? next : cur))
  }

  const toggleImageFavorite = async (image: BannerImage) => {
    setModalError('')
    try {
      const res = await api.hqBanners.images.update(image.id, { isFavorite: !image.isFavorite })
      if (!res.success) throw new Error(res.error)
      replaceImage(res.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('お気に入りを変更できませんでした。もう一度お試しください。') }
    }
  }

  const deliver = async (image: BannerImage, ids: string[]): Promise<boolean> => {
    setModalBusy(true)
    setModalError('')
    try {
      const res = await api.hqBanners.images.deliver(image.id, ids)
      if (!res.success) throw new Error(res.error)
      replaceImage(res.data.image)
      return true
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setModalError(bannerFailureMessage(caught, 'アカウントへの配布')) }
      return false
    } finally {
      setModalBusy(false)
    }
  }

  // 成功した画像は選択から外し、失敗した画像だけを同じ配り先へ送り直せる。
  const distributeSelected = async () => {
    if (distributionLock.current || !canManage || selectedImages.length === 0 || distributionAccounts.length === 0) return
    const batch = images.filter((image) => selectedImages.includes(image.id))
    const ids = [...distributionAccounts]
    distributionLock.current = true
    setDistributionBusy(true)
    setDistributionError('')
    const succeeded: string[] = []
    const failures: string[] = []
    try {
      for (const [index, image] of batch.entries()) {
        setDistributionProgress(`${formatNumber(batch.length)} 枚中 ${index + 1} 枚目を配っています（${ids.length}アカウント）`)
        try {
          const response = await api.hqBanners.images.deliver(image.id, ids)
          if (!response.success) throw new Error(response.error)
          replaceImage(response.data.image)
          succeeded.push(image.id)
        } catch (caught) {
          saveErrors.capture(caught)
          failures.push(`選んだ画像 ${index + 1}：${bannerFailureMessage(caught, 'アカウントへの配布')}`)
        }
      }
      setSelectedImages((current) => current.filter((id) => !succeeded.includes(id)))
      setDistributionProgress(`${formatNumber(batch.length)} 枚中 ${formatNumber(succeeded.length)} 枚を${ids.length}アカウントへ配りました。${failures.length > 0 ? `失敗 ${formatNumber(failures.length)} 枚。失敗した画像を選んだままにしています。` : ''}`)
      if (failures.length > 0) setDistributionError(failures.join(' ／ '))
    } finally {
      distributionLock.current = false
      setDistributionBusy(false)
    }
  }

  const openDistribution = () => {
    setDistributionAccounts([])
    setDistributionFilter('all')
    setDistributionSearch('')
    setDistributionError('')
    setDistributionProgress('')
    setDistributionOpen(true)
  }

  const removeImage = async (image: BannerImage): Promise<boolean> => {
    setModalBusy(true)
    setModalError('')
    try {
      const res = await api.hqBanners.images.remove(image.id)
      if (!res.success) throw new Error(res.error)
      setImages((prev) => prev.filter((i) => i.id !== image.id))
      setOpenImage(null)
      setSelectedImages((current) => current.filter((id) => id !== image.id))
      setProject((p) => (p ? { ...p, imageCount: Math.max(p.imageCount - 1, 0) } : p))
      return true
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setModalError(bannerFailureMessage(caught, '一覧からの削除')) }
      return false
    } finally {
      setModalBusy(false)
    }
  }

  const upload = async (file: { filename: string; mimeType: string; data: string }) => {
    if (!project) return
    const res = await api.hqBanners.projects.upload(project.id, file)
    if (!res.success) throw new Error(res.error)
    setImages((prev) => [res.data, ...prev])
    setProject((p) => (p ? { ...p, imageCount: p.imageCount + 1 } : p))
    return res.data
  }

  /** 「画像を取り込む」。PNG・JPEG・WebP、10MB まで（手元で先に確かめる）。 */
  const takeIn = async (file: File | undefined) => {
    if (!file) return
    const refused = uploadRefusal(file)
    if (refused) return setActionError(refused)
    setUploading(true)
    setActionError('')
    try {
      const data = await readFileAsBase64(file)
      await upload({ filename: file.name, mimeType: file.type, data })
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setActionError(describeApiFailure(caught, '取り込み', { scope: 'hq' })) }
    } finally {
      setUploading(false)
    }
  }

  /** 参照画像に 1 枚足す（3 枚まで）。 */
  const addReference = (image: BannerImage, mode: BannerReferenceMode = 'inspire') => {
    if (input.references.some((reference) => reference.imageId === image.id)) return
    if (input.references.length >= BANNER_MAX_REFERENCE_IMAGES) {
      setGenerationError(`参照画像は ${BANNER_MAX_REFERENCE_IMAGES} 枚までです。入れ替えるときは、どれかを外してください。`)
      return
    }
    setReferencePool((prev) => [image, ...prev.filter((candidate) => candidate.id !== image.id)])
    setInput((cur) => ({ ...cur, references: [...cur.references, { imageId: image.id, mode }] }))
  }

  /** 参照画像の窓で選び終わったとき。選んだ実体を手元に置き、入力をそのまま置き換える。 */
  const applyReferences = (references: BannerReference[], picked: BannerImage[]) => {
    setReferencePool((prev) => [...picked, ...prev.filter((candidate) => !picked.some((image) => image.id === candidate.id))])
    setInput((cur) => ({ ...cur, references }))
    setPickerOpen(false)
  }

  /** 手元のファイルを参照にする：プロジェクトへ取り込んでから参照にする（画像はライブラリにも残る）。 */
  const uploadReference = async (file: File) => {
    const refused = uploadRefusal(file)
    if (refused) return setGenerationError(refused.replace('画像は', '参照画像は').replace('取り込めます', '使えます'))
    setReferenceBusy(true)
    setGenerationError('')
    try {
      const data = await readFileAsBase64(file)
      const uploaded = await upload({ filename: file.name, mimeType: file.type, data })
      if (uploaded) addReference(uploaded)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setGenerationError(describeApiFailure(caught, '取り込み', { scope: 'hq' })) }
    } finally {
      setReferenceBusy(false)
    }
  }

  const openPicker = () => {
    setPickerOpen(true)
    if (allProjects.length === 0) {
      void api.hqBanners.projects.list().then((res) => { if (res.success) setAllProjects(res.data) }).catch(() => undefined)
    }
  }

  const referenceImages = useMemo(() => {
    const byId = new Map<string, BannerImage>()
    for (const image of referencePool) byId.set(image.id, image)
    for (const image of images) byId.set(image.id, image)
    return input.references.map((reference) => byId.get(reference.imageId)).filter((image): image is BannerImage => image !== undefined)
  }, [images, input.references, referencePool])

  const pendingCount = running ? Math.max(running.requestedCount - running.doneCount - running.failedCount, 0) : 0
  const visible = useMemo(
    () => images.filter((i) => (filter === 'favorite' ? i.isFavorite : filter === 'delivered' ? i.deliveredAccountIds.length > 0 : true)),
    [images, filter],
  )

  if (status === 'loading') return <SaveErrorScope errors={saveErrors}><ListState permissionScope="hq" kind="loading" title="プロジェクトを読み込んでいます" /></SaveErrorScope>
  if (status === 'missing') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="開くプロジェクトが指定されていません" description="一覧から、開きたいプロジェクトを選び直してください。" backHref="/hq/banners" backLabel="プロジェクト一覧へ戻る" /></SaveErrorScope>
  }
  if (status === 'notfound') {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="プロジェクトが見つかりません" description="アーカイブされたか、別の統括のものかもしれません。一覧から選び直してください。" backHref="/hq/banners" backLabel="プロジェクト一覧へ戻る" /></SaveErrorScope>
  }
  if (status === 'forbidden') {
    return <SaveErrorScope errors={saveErrors}><ListState permissionScope="hq" kind="forbidden" description="バナー生成は統括の管理者・オーナーだけが使えます。" action={<Button href="/hq/banners">プロジェクト一覧へ戻る</Button>} /></SaveErrorScope>
  }
  if (status === 'error' || !project) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="プロジェクトを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => void load()} /></SaveErrorScope>
  }

  const busy = busyAction !== null || distributionBusy
  const archived = Boolean(project.archivedAt)
  const limited = bannerLimitKind(usage) !== null
  const boardId = running ? 'p03ImY' : limited ? 'zOpMG' : 'iMnph'
  const description = `${project.description ? `${project.description.replace(/。$/, '')}。` : ''}生成パネルで用途とテキストを決めて生成し、気に入った画像をアカウントへ配ります。`
  const favoriteCount = images.filter((i) => i.isFavorite).length
  const deliveredCount = images.filter((i) => i.deliveredAccountIds.length > 0).length
  const doneSoFar = running ? running.doneCount + running.failedCount : 0

  /*
   * 頭の操作は承認済み ★BG-B `qIp42` の `e3LG3u`「操作ボタン群」どおり、5つを横並びで出す
   * （画像を取り込む／お気に入り／複製／名前と説明を変える／アーカイブ）。
   * 「…」の畳んだメニューに入れていたが、板はどのボタンも開いた姿で描いている。
   * `docs/v8-design-rules.md` §1 は「板」＞「共通部品」なので、板に合わせる。
   */
  const actions = canManage ? (
    <div className={styles.headActions}>
      {images.length > 0 && !archived ? <RowMenu label={`プロジェクト「${project.name}」の操作`} triggerProps={{ disabled: busy }} items={[
        { id: 'distribute-project', label: 'このプロジェクトの画像を配る', icon: <Send size={16} aria-hidden="true" />, emphasis: true,
          onSelect: () => { setSelectedImages(images.map((image) => image.id)); openDistribution() } },
      ]} /> : null}
      <MediaSlot title="画像を取り込む" accept={BANNER_UPLOAD_ACCEPT.join(',')} fileInputRef={fileRef} busy={uploading} disabled={busy || archived}
        renderTrigger={(choose) => <Button onClick={choose} disabled={busy || archived || uploading} busy={uploading} busyLabel="取り込み中…"><Upload aria-hidden="true" className={styles.icon} />画像を取り込む</Button>}
        onFile={(file) => { void takeIn(file) }} />
      <Button onClick={() => void patchProject('お気に入り', { isFavorite: !project.isFavorite })} disabled={busy}>
        <Star aria-hidden="true" className={project.isFavorite ? styles.starOn : styles.icon} />{project.isFavorite ? 'お気に入りから外す' : 'お気に入り'}
      </Button>
      <Button onClick={() => guard.guarded(() => { void duplicate() })} disabled={busy} busy={Boolean(busy)} busyLabel="処理中…">
        <Copy aria-hidden="true" className={styles.icon} />複製
      </Button>
      <Button onClick={() => { setFormError(''); setFormOpen(true) }} disabled={busy}>
        <Pencil aria-hidden="true" className={styles.icon} />名前と説明を変更する
      </Button>
      {archived ? (
        <Button onClick={() => void patchProject('復元', { archived: false })} disabled={busy}>
          <ArchiveRestore aria-hidden="true" className={styles.icon} />復元
        </Button>
      ) : (
        <Button onClick={() => setArchiveConfirm(true)} disabled={busy || Boolean(running)}>
          <Archive aria-hidden="true" className={styles.icon} />アーカイブ
        </Button>
      )}
    </div>
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><ListPage boardId={boardId} title={project.name} help={description} actions={actions}>
      {/* ページ内の戻るリンク（プロジェクト一覧 › …）は置かない。戻るは上のパンくずだけ（決まり 2026-10-08）。 */}
      <div className={styles.body}>
        {actionError ? <Notice tone="danger" message={actionError} onClose={() => setActionError('')} /> : null}
        <DetailColumns presentation="card" asideLabel="用途とテキストの設定" toggleLabel="用途とテキストを設定" expanded={panelExpanded} onExpandedChange={setPanelExpanded}
          aside={canManage ? <div ref={panelRef}>
            <GenerationPanel v8Layout accountSelector={<div className="flex flex-col gap-1.5">
              <span className="text-caption font-semibold text-ink">AI を使うアカウント</span>
              {aiAccountsStatus === 'ready' && aiAccounts.length === 1 ? <p className="truncate text-caption text-ink" title={aiAccounts[0].displayName ?? aiAccounts[0].name}>{aiAccounts[0].displayName ?? aiAccounts[0].name}</p> : aiAccountsStatus === 'ready' && aiAccounts.length > 1 ? <EntitySelect aria-label="AI を使うアカウント" noun="アカウント" placeholder="選んでください" size="full" value={aiAccountId} options={aiAccounts.map(account => ({ ...entityOptionMetadata(account), value: account.id, label: account.displayName ?? account.name }))} onChange={id => { setAiAccountId(id); try { localStorage.setItem('lh_hq_banner_ai_account', id) } catch { /* storage unavailable */ } }} disabled={busy} /> : aiAccountsStatus === 'ready' && aiAccounts.length === 0 ? <Notice tone="danger" statusWord={false}>
                AI を使えるアカウントがありません。店舗の 設定 › 機能設定 で「バナー生成」をオンにしてください。
                <div className={styles.aiSettingsActions}>
                  {settingsAccounts.length > 1 ? <EntitySelect size="full" aria-label="設定する店舗" noun="店舗" placeholder="店舗を選んでください" value={settingsAccountId} options={settingsAccounts.map(account => ({ value: account.id, label: account.displayName ?? account.name }))} onChange={setSettingsAccountId} /> : null}
                  {settingsAccounts.length > 0 ? <Button variant="secondary" size="compact" disabled={!settingsTarget} disabledReason={!settingsTarget ? '店舗を選んでください' : undefined} onClick={() => { if (settingsTarget) guard.guarded(() => { setSelectedAccountId(settingsTarget); router.push('/settings#ai-features') }) }}>機能設定を開く</Button> : <Button href="/hq" variant="secondary" size="compact">アカウント一覧を確認</Button>}
                </div>
              </Notice> : <p className="text-caption text-ink-secondary">{accountReason}</p>}
            </div>} presets={presets} maxCount={maxCount} value={input}
              onChange={(next) => { setInputTouched(true); setInput(next) }} disabled={Boolean(running) || archived || !engineReady}
              referenceImages={referenceImages} onPickReference={openPicker} onUploadReference={(file) => void uploadReference(file)}
              referenceBusy={referenceBusy} usage={usage} onReloadUsage={loadUsage} usageHeading monthRemaining />
          </div> : null}>
          <section className={styles.gallery} aria-labelledby={galleryHeadId}>
            {/* G-6（sr0Po）：画像を押すと詳細、選ぶ操作はその下の右端。 */}
            <div className={styles.galleryHead}>
              <h3 id={galleryHeadId} className={styles.galleryTitle}>このプロジェクトの画像</h3>
              <span className={styles.hint}>{`${formatNumber(images.length)} 枚`}</span>
              <span className={styles.hint}>画像を押すと詳細</span>
            </div>
            <div className={styles.galleryTools}>
              <SegmentedControl<Filter>
                aria-label="画像の絞り込み"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'すべて', count: images.length },
                  { value: 'favorite', label: 'お気に入り', count: favoriteCount },
                  { value: 'delivered', label: '配布済み', count: deliveredCount },
                ]}
              />
              {canManage ? <div className={styles.selectionTools}>
                <SaveErrorField names={["length","visible.length","selectedImages","selected_images"]}><Checkbox checked={visible.length > 0 && visible.every((image) => selectedImages.includes(image.id))}
                  indeterminate={visible.some((image) => selectedImages.includes(image.id)) && !visible.every((image) => selectedImages.includes(image.id))}
                  disabled={distributionBusy || visible.length === 0}
                  onCheckedChange={(checked) => setSelectedImages((current) => checked ? [...new Set([...current, ...visible.map((image) => image.id)])] : current.filter((id) => !visible.some((image) => image.id === id)))}>すべて選ぶ</Checkbox></SaveErrorField>
                <span className={styles.hint}>選ぶと右下からまとめて配れます</span>
              </div> : null}
            </div>

            {/*
              * 生成中の注記（承認済み `qIp42` の `k7sbSR`「注記 生成中のとき」）。
              * 止める操作は下の帯（`An26R` の `CzXI2`「生成をやめる」）だけに置く。
              * 同じ操作のボタンを2か所に出すと、どちらを押したか分からなくなる。
              */}
            {running ? (
              <Notice tone="info" role="status" aria-live="polite" icon={<Hourglass aria-hidden="true" />}>
                <span className={styles.runningText}>{`${Math.min(doneSoFar + 1, running.requestedCount)} / ${formatNumber(running.requestedCount)} 枚目を作っています。閉じても作り続けます`}</span>
              </Notice>
            ) : null}
            {generationError ? <Notice tone="danger" message={generationError} onClose={() => setGenerationError('')} /> : null}
            {sizeNotice ? <Notice tone="info" message="大きさの調整は検証環境で確認してください。この画像は生成時の大きさのまま保存されています。" onClose={() => setSizeNotice(false)} /> : null}

            {images.length === 0 && pendingCount === 0 ? (
              <ListState permissionScope="hq"
                kind="empty"
                title="まだ画像がありません"
                description="生成パネルで用途とテキストを決めて「生成する」を押すと、ここに並びます。手持ちの画像は「画像を取り込む」から入れられます。"
              />
            ) : visible.length === 0 && pendingCount === 0 ? (
              <ListState permissionScope="hq" kind="empty" emptyPreset="filtered" action={<Button onClick={() => setFilter('all')}>条件を外す</Button>} />
            ) : (
              <div className={styles.grid}>
                {/* 絵 p03ImY：いま作っている生成でできた画像 → 作っている1枚 → 待っている枚 → それより前の画像。 */}
                {[...visible.filter((image) => running && image.generationId === running.id), ...(filter === 'all' ? Array.from({ length: pendingCount }, (_, i) => i) : []), ...visible.filter((image) => !(running && image.generationId === running.id))].map((item, index) => typeof item === 'number' ? (
                  <PendingTile key={`pending-${item}`} running={item === 0} label={tileLabel(presets.find((p) => p.key === running?.presetKey), { generation: running, source: 'generated' })} />
                ) : (() => { const image = item; return (
                  <article key={image.id} className={styles.tile} data-selected={selectedImages.includes(image.id) || undefined}>
                    {canManage ? <div className={styles.tileSelect}><SaveErrorField names={["id","image.id","selectedImages","imageId","selected_images"]}><Checkbox aria-label={`画像 ${index + 1} を選ぶ`} checked={selectedImages.includes(image.id)} disabled={distributionBusy}
                      onCheckedChange={(checked) => setSelectedImages((current) => checked ? [...new Set([...current, image.id])] : current.filter((id) => id !== image.id))} /></SaveErrorField></div> : null}
                    <button type="button" className={styles.tileImage} onClick={() => { setModalError(''); setOpenImage(image) }} aria-label={`画像 ${index + 1} を開く`}>
                      <Thumb image={image} />
                    </button>
                    <div className={styles.tileMeta}>
                      <TruncatedText className={styles.metaText} value={tileLabel(presets.find((p) => p.key === image.generation?.presetKey), image)} />
                      <span className={styles.spacer} />
                      {image.deliveredAccountIds.length > 0 ? <StatusBadge tone="success">配布済み</StatusBadge> : null}
                      {canManage ? (
                        <button type="button" data-part="attention-star" className={styles.star} onClick={(event) => attentionMotion(event, () => toggleImageFavorite(image))} aria-pressed={image.isFavorite} aria-label={image.isFavorite ? 'お気に入りから外す' : 'お気に入りにする'}>
                          <Star aria-hidden="true" className={image.isFavorite ? styles.starOn : styles.starOff} />
                        </button>
                      ) : null}
                    </div>
                  </article>
                ) })())}
              </div>
            )}

          </section>

        </DetailColumns>
            <StickyBarRegion gap="var(--tpl-hb-gallery-gap)" feedback={accountReason && aiAccountsStatus === 'ready' && aiAccounts.length === 0 ? <p className={styles.errorText}>AI を使えるアカウントがありません。</p> : !accountReason && blockedReason && input.presetKey && !running && (inputTouched || !validation) ? <p className={styles.warnText}>{blockedReason}</p> : null}>
            {/* 入力が足りないだけの理由は、開いたばかりでは出さない（触ってから）。接続・アーカイブ・上限はすぐ出す。 */}

            {/* G-6（sr0Po）：左は選んだ画像の配布、右は生成の操作。0枚なら左の帯は出さない。 */}
            {canManage ? (
              <StickyBar
                outlined
                className={styles.footer}
                /* 1つの帯：左に選んだ画像の操作か残りの枚数、右に書き出しの大きさと生成の操作。上限の枚数は右の欄の知らせと title にあるので、帯では1行に収まる短い形。入らない幅では文の切れ目で2行に折る。 */
                destructive={selectedImages.length > 0 ? <>
                  <span className={styles.selectionCount} aria-live="polite">{`${formatNumber(selectedImages.length)} 枚を選んでいます`}</span>
                  <Button variant="text" disabled={distributionBusy} onClick={() => setSelectedImages([])}><X aria-hidden="true" className={styles.icon} />選択するのをやめる</Button>
                  <Button variant="primary" disabled={busy || archived} onClick={openDistribution}><Send aria-hidden="true" className={styles.icon} />{`${formatNumber(selectedImages.length)} 枚をアカウントへ配る`}</Button>
                </> : undefined}
                status={selectedImages.length > 0 ? undefined : running ? `${formatNumber(running.requestedCount)}枚中${doneSoFar}枚できました・今月の残り${usage?.month.remaining ?? emptyValue('unknown')}枚` : usage && input.count > usage.month.remaining
                  ? <span className={styles.limitText} title={`今月の上限 ${usage.month.limit}枚に達しています（必要 ${formatNumber(input.count)}枚）`}>今月の上限に達しています<span className={styles.nowrap}>{`（必要 ${formatNumber(input.count)}枚）`}</span></span>
                  : usageStatusText(usage, input.count)}
                info={sizeChipText ? <ExportSizeChip text={sizeChipText} /> : <span className={styles.generationInfo}>寸法 —</span>}
                actions={
                  running ? (
                    <>
                      <Button onClick={() => void cancelGeneration()} disabled={cancelling} busy={cancelling} busyLabel="止めています…">生成をやめる</Button>
                      {/* key：生成する→生成中で同じボタンを使い回すと、前の言葉の幅のまま固まり文字が切れた（p03ImY）。 */}
                      <Button key="running" variant="primary" disabled>
                        <LoaderCircle aria-hidden="true" className={`${styles.icon} ${styles.spin}`} />
                        生成中… 画面を離れても続きます
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={() => setInput({ ...EMPTY_GENERATION_INPUT, presetKey: presets[0]?.key ?? '' })} disabled={busy}>条件をクリア</Button>
                      <Button variant="primary" onClick={() => void startGeneration()} disabled={busy || starting || Boolean(blockedReason)} disabledReason={aiAccountsStatus === 'ready' && aiAccounts.length === 0 ? undefined : accountReason ?? undefined} busy={starting}>
                        <Sparkles aria-hidden="true" className={styles.icon} />
                        {/* 板 `b1So7a`「生成する（2枚）」＝v7 と同じ言葉。パネルの見出し `S0ay0i`「画像を生成」とは別。 */}
                        生成する（{formatNumber(input.count)} 枚）
                      </Button>
                    </>
                  )
                }
              />
            ) : null}
            </StickyBarRegion>

      </div>

      {distributionOpen ? <SavedDistributionDialog
        title={`${selectedImages.length > 0 ? `${formatNumber(selectedImages.length)} 枚の画像を` : '画像を'}アカウントへ配る`}
        help="選んだ画像は、アカウントの登録メディア（フォルダ「02_バナー」）に入ります。配布済みの画像は増えません。"
        accounts={distributionTargets} folders={distributionFolders}
        selected={distributionAccounts} onChange={setDistributionAccounts}
        filter={distributionFilter} onFilter={setDistributionFilter} search={distributionSearch} onSearch={setDistributionSearch}
        received={null} receivedFailed={false} busy={distributionBusy} error={accountsFailed ? 'アカウントを読み込めませんでした。ページを再読み込みしてください。' : distributionError}
        accountState={(id) => {
          const selected = images.filter((image) => selectedImages.includes(image.id))
          const count = selected.filter((image) => image.deliveredAccountIds.includes(id)).length
          return <span className={styles.hint}>{selected.length > 0 ? `${formatNumber(selected.length)}枚中 ${formatNumber(count)}枚を配布済み` : emptyValue('unknown')}</span>
        }}
        notice={distributionProgress ? <p className={styles.distributionProgress} role="status" aria-live="polite">{distributionProgress}</p> : null}
        canDistribute={selectedImages.length > 0}
        onLater={() => { if (!distributionBusy) setDistributionOpen(false) }}
        onDistribute={() => void distributeSelected()}
      /> : null}

      <CreateProjectDialogV8
        open={formOpen}
        project={project}
        busy={formBusy}
        error={formError}
        onDraftChange={setFormDirty}
        onRequestClose={closeForm}
        onSubmit={(next) => {
          setFormBusy(true)
          setFormError('')
          void patchProject('名前と説明の変更', { name: next.name, description: next.description || null }).then((updated) => {
            setFormBusy(false)
            if (updated) setFormOpen(false)
            else setFormError('保存できませんでした。もう一度お試しください。')
          })
        }}
        onCancel={() => { if (!formBusy) setFormOpen(false) }}
      />
      <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={starting || formBusy} /></OverlayDepthContext.Provider>

      <BannerConfirmDialogV8
        open={archiveConfirm}
        title={`「${project.name}」をアーカイブしますか？`}
        description="一覧から見えなくなります。画像は消えず、アカウントへ配った画像もそのまま使えます。「アーカイブを見る」からいつでも復元できます。"
        confirmLabel="アーカイブする"
        tone="primary"
        busy={busy}
        designNode="I0w2e"
        onConfirm={() => guard.guarded(() => {
          void patchProject('アーカイブ', { archived: true }).then((updated) => {
            setArchiveConfirm(false)
            if (updated) router.push('/hq/banners')
          })
        })}
        onCancel={() => setArchiveConfirm(false)}
      />

      {openImage ? (
        <BannerImageDetailV8
          key={openImage.id}
          image={openImage}
          presets={presets}
          accounts={accounts}
          canManage={canManage}
          busy={modalBusy}
          error={modalError}
          onClose={() => { if (!modalBusy) setOpenImage(null) }}
          onToggleFavorite={() => void toggleImageFavorite(openImage)}
          onDeliver={(ids) => deliver(openImage, ids)}
          onRemove={() => removeImage(openImage)}
          onRegenerate={openImage.generation ? () => {
            const generation = openImage.generation
            if (generation) setInput(inputFromGeneration(generation))
            setOpenImage(null)
            revealPanel()
          } : undefined}
          onUseAsReference={() => {
            addReference(openImage)
            setOpenImage(null)
            revealPanel()
          }}
        />
      ) : null}

      <ReferencePickerDialog
        frame={ReferenceFrame}
        hqLayout
        open={pickerOpen}
        projectId={project.id}
        presets={presets}
        projects={allProjects.length > 0 ? allProjects : [project]}
        selected={input.references}
        onClose={() => setPickerOpen(false)}
        onPick={applyReferences}
        /* ：押したその場で参照に入る。窓は×で閉じる。 */
        onLivePick={(references, picked) => {
          setReferencePool((prev) => [...picked, ...prev.filter((candidate) => !picked.some((image) => image.id === candidate.id))])
          setInput((cur) => ({ ...cur, references }))
        }}
        onUpload={(file) => { setPickerOpen(false); void uploadReference(file) }}
      />
    </ListPage></SaveErrorScope>
  )
}
