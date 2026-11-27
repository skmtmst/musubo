'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'

import { useListUrlValue, useListUrlJsonValue } from '@/components/shared/list-url-state'
import { createPageReturnHref } from '@/components/shared/create-page'
import { useSamePageUrl } from '@/lib/use-same-page-url'
import { Folder, Gauge, Plus, Send, Sparkles, Star, Upload } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ListPage } from '@/components/templates'
import { ListPageCards } from '@/components/templates/list-page'
import { PageContent } from '@/components/templates/page-frame'
import Card, { CardContent, CardHeader } from '@/components/shared/card'
import IconButton from '@/components/shared/icon-button'
import StatusBadge from '@/components/shared/status-badge'
import { RowNameButton } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import ListToolbar from '@/components/shared/list-toolbar'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import ActionMenu from '@/components/shared/action-menu'
import { notifyToast } from '@/components/shared/toast'
import SegmentedControl from '@/components/shared/segmented'
import ManagedFolderPanel, { managedFolderNavRows } from '@/components/shared/managed-folder-panel'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { Tabs } from '@/components/shared/tabs'
import { usePageTitle } from '@/components/shell/page-chrome'
import type { AccountWithStats } from '@/contexts/account-context'
import { api, ApiError } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import {
  SHAPE_FILTERS,
  nextMonthResetLabel,
  type BannerImage,
  type BannerPreset,
  type BannerProject,
  type BannerStats,
  type BannerUsage,
  type ShapeFilter,
} from '@/lib/hq-banners'
import { BannerImageDetailV8 } from './image-detail'
import { CreateProjectDialogV8, UploadDialogV8 } from './dialogs'
import BannerLimitNotice from './limit-notice'
import { bannerFailureMessage, monthDay, shortPresetLabel } from './words'
import styles from './list.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { ListToolbarRow, ListToolbarSort } from '@/components/shared/list-toolbar'
import { formatNumber } from '@/lib/format'
/*
 * ★V8 統括のバナー生成（Pencil  プロジェクト一覧・ 画像ライブラリ）。
 * 窓： プロジェクトを作る・ 画像を取り込む・画像の詳細（ と同じ窓）。
 *
 * 管理画面 の画面（app/hq/banners/page.tsx と components/hq/banners/*）と、読み書きの口・
 * 失敗時の扱い・`?tab=` は同じ。見た目だけを絵どおりに一から組んだ：
 * 頭（型 ListPage）・左の「見る」の列（型のフォルダの列＋共通 FolderPanel）・数のカード4枚・
 * 案内の帯・タブ・道具の段・カード（プロジェクト）／画像のます（ライブラリ）・件数と次へ。
 */

type Tab = 'projects' | 'library'
type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'
type ProjectView = 'all' | 'favorite' | 'running' | 'archived'
type ProjectSort = 'updated' | 'created' | 'name'
type LibraryView = 'all' | 'favorite' | 'delivered' | 'unused'

const PROJECT_SORTS: Array<{ value: ProjectSort; label: string }> = [
  { value: 'updated', label: '並び：更新が新しい順' },
  { value: 'created', label: '並び：作成が新しい順' },
  { value: 'name', label: '並び：名前順' },
]

/** 画像ライブラリは 12 枚ずつ（「1–12 件 / 23 件」「次の 12 件」）。 */
const LIBRARY_PAGE = 12

function isCursorHistory(value: unknown): value is Array<string | null> {
  return Array.isArray(value) && value.length > 0 && value[0] === null && value.every(item => item === null || typeof item === 'string')
}

export default function HqBannersListV8() {
  return (
    <Suspense fallback={null}>
      <BannersInner />
    </Suspense>
  )
}

function BannersInner() {
  usePageTitle('バナー生成')
  const samePageUrl = useSamePageUrl()
  const params = useSearchParams()
  const tab: Tab = params.get('tab') === 'library' ? 'library' : 'projects'
  const role = useStaffRole()
  // 役割が読めるまでは押せる形を出さない（閲覧のみに押せないボタンを置かない）。
  const canManage = canManageRole(role)

  const [stats, setStats] = useState<BannerStats | null>(null)
  const [usage, setUsage] = useState<BannerUsage | null>(null)
  const [presets, setPresets] = useState<BannerPreset[]>([])
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const summaryRequest = useRef(0)

  const loadSummary = useCallback(async (silent = false) => {
    const requestId = ++summaryRequest.current
    /* 形の違う応答は置かない（`stats.projects.active` で画面ごと落ちる。全ルート監査 A1）。数は「—」になる。 */
    if (!silent) setSummaryLoading(true)
    const [presetRes, statsRes] = await Promise.allSettled([api.hqBanners.presets(), api.hqBanners.stats()])
    if (requestId !== summaryRequest.current) return
    if (presetRes.status === 'fulfilled' && presetRes.value.success) {
      const data = presetRes.value.data as { presets?: unknown; usage?: BannerUsage | null }
      if (Array.isArray(data?.presets)) setPresets(data.presets as BannerPreset[])
      const next = data?.usage
      setUsage(next && typeof next.month?.used === 'number' ? next : null)
    }
    if (statsRes.status === 'fulfilled' && statsRes.value.success) {
      const data = statsRes.value.data as { projects?: { active?: unknown } } | null
      if (data && typeof data.projects?.active === 'number') setStats(statsRes.value.data)
    }
    setSummaryLoading(false)
  }, [])

  useEffect(() => {
    void loadSummary()
    void api.lineAccounts.list().then((res) => {
      if (res.success) setAccounts(res.data as AccountWithStats[])
    }).catch(() => {
      // アカウントが取れなくても一覧は使える。渡す先の一覧だけ空になる。
    })
  }, [loadSummary])

  // タブの切り替えは `?tab=` で、履歴を積まない（管理画面 と同じ）。
  const changeTab = (next: Tab) => samePageUrl.replace(next === 'library' ? '/hq/banners?tab=library' : '/hq/banners')

  const kpis = (
    <KpiBand data-design="KPIs">
      <KpiCard presentation="band" title="プロジェクト" icon={<Folder aria-hidden="true" />} value={stats ? stats.projects.active : null} unit="件" detail={summaryLoading ? '読み込んでいます' : stats ? `アーカイブ ${stats.projects.archived}` : '—'} loading={summaryLoading} />
      <KpiCard presentation="band" title="今月の生成" icon={<Sparkles aria-hidden="true" />} value={usage ? usage.month.used : null} unit="枚" detail={summaryLoading ? '読み込んでいます' : usage ? `今日 ${usage.today.used}枚・1日の上限 ${usage.today.limit}枚` : '—'} loading={summaryLoading} />
      <KpiCard presentation="band" title="今月の残り" icon={<Gauge aria-hidden="true" />} value={usage ? usage.month.remaining : null} unit="枚" detail={summaryLoading ? '読み込んでいます' : usage ? `上限 ${usage.month.limit}枚・${nextMonthResetLabel()} に戻る` : '—'} loading={summaryLoading} />
      <KpiCard presentation="band" title="アカウントへ配った画像" icon={<Send aria-hidden="true" />} value={stats ? stats.deliveredImages : null} unit="枚" detail={summaryLoading ? '読み込んでいます' : stats ? `${stats.deliveredAccounts}アカウント` : '—'} loading={summaryLoading} />
    </KpiBand>
  )

  const head: BannerHead = {
    stats: kpis,
    explanation: '作った画像は統括の登録メディアに保存されます。アカウントへ配ると、そのアカウントの配信・リッチメニュー・回答フォームから選べるようになります。',
    tabs: <Tabs label="バナー生成の表示" items={[
      { label: 'プロジェクト一覧', current: tab === 'projects', onClick: () => changeTab('projects') },
      { label: '画像ライブラリ', current: tab === 'library', onClick: () => changeTab('library') },
    ]} />,
  }

  return tab === 'projects'
    ? <ProjectsView head={head} canManage={canManage} usage={usage} archivedCount={stats?.projects.archived ?? null} onCreated={() => { setStats(current => current ? { ...current, projects: { ...current.projects, active: current.projects.active + 1 } } : current); void loadSummary(true) }} />
    : <LibraryView head={head} canManage={canManage} presets={presets} accounts={accounts} onChanged={() => void loadSummary()} />
}

/* ───────── プロジェクト一覧 ───────── */

type BannerHead = { stats: React.ReactNode; tabs: React.ReactNode; explanation: string }

function ProjectsView({ head, canManage, usage, archivedCount, onCreated }: {
  head: BannerHead
  canManage: boolean
  usage: BannerUsage | null
  archivedCount: number | null
  onCreated: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const [projects, setProjects] = useState<BannerProject[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, BannerImage[]>>({})
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [view, setView] = useListUrlValue<ProjectView>('view', 'all')
  const [query, setQuery] = useListUrlValue('q', '')
  const [sort, setSort] = useListUrlValue<ProjectSort>('sort', 'updated')
  const [actionError, setActionError] = useState('')
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const requestRef = useRef(0)
  const requestPending = useRef(false)
  const archivedMode = view === 'archived'

  const load = useCallback(async (activeOnly = false, silent = false) => {
    const requestId = ++requestRef.current
    requestPending.current = true
    if (!silent) setStatus('loading')
    setRefreshFailed(false)
    setActionError('')
    try {
      const [projectRes, imageRes] = await Promise.all([
        api.hqBanners.projects.list({ archived: activeOnly ? false : archivedMode }),
        api.hqBanners.images.list({ limit: 100 }),
      ])
      if (requestId !== requestRef.current) return
      if (!projectRes.success) throw new Error(projectRes.error)
      setProjects(projectRes.data)
      if (imageRes.success) {
        const byProject: Record<string, BannerImage[]> = {}
        for (const image of imageRes.data) {
          const list = (byProject[image.projectId] ??= [])
          if (list.length < 3) list.push(image)
        }
        setThumbnails(byProject)
      }
      setStatus('ready')
    } catch (caught) {
      if (requestId !== requestRef.current) return
      saveErrors.capture(caught);

      if (silent) { setRefreshFailed(true); setActionError('一覧を更新できませんでした。もう一度読み込んでください。') }
      else setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    } finally {
      if (requestId === requestRef.current) requestPending.current = false
    }
  }, [archivedMode, saveErrors])

  useEffect(() => {
    void load();

    return () => { requestRef.current += 1 }
  }, [load])

  const create = async (input: { name: string; description: string }) => {
    setFormBusy(true)
    setFormError('')
    try {
      const res = await api.hqBanners.projects.create({ name: input.name, description: input.description || null })
      if (!res.success) throw new Error(res.error)
      const wasLoading = requestPending.current
      requestRef.current += 1
      requestPending.current = false
      if (status === 'ready' && !wasLoading && !archivedMode) {
        setProjects(previous => [res.data, ...previous.filter(item => item.id !== res.data.id)])
        void load(true, true)
      } else if (!archivedMode) {
        void load()
      }
      setView('all')
      setQuery('')
      setFormOpen(false)
      onCreated()
      router.push(createPageReturnHref('/hq/banners', res.data.id))
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // M022：原文のまま出さず、共通の状態別案内へ渡す。窓は開いたまま送り直せる。
      { if (!fieldFailure)
      setFormError(bannerFailureMessage(caught, 'プロジェクトの作成')) }
    } finally {
      setFormBusy(false)
    }
  }

  /* お気に入りは押した瞬間に変え、裏で保存する（動きの点検・7）。失敗したら戻して知らせる。 */
  const toggleFavorite = async (project: BannerProject) => {
    const next = !project.isFavorite
    setActionError('')
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, isFavorite: next } : p)))
    try {
      const res = await api.hqBanners.projects.update(project.id, { isFavorite: next })
      if (!res.success) throw new Error(res.error)
      setProjects((prev) => prev.map((p) => (p.id === project.id ? res.data : p)))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, isFavorite: project.isFavorite } : p)))
      { if (!fieldFailure)
      notifyToast('お気に入りを変えられませんでした。', { tone: 'error', actionLabel: 'もう一度', onAction: () => { void toggleFavorite(project) } }) }
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects
      .filter((p) => (q ? `${p.name}\n${p.description ?? ''}`.toLowerCase().includes(q) : true))
      .filter((p) => (view === 'favorite' ? p.isFavorite : view === 'running' ? p.runningCount > 0 : true))
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'ja')
        if (sort === 'created') return b.createdAt.localeCompare(a.createdAt)
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [projects, query, view, sort])

  const ready = status === 'ready' && !archivedMode
  /*
   * お気に入り・生成中・アーカイブは作ったフォルダではなく状態なので、左の列ではなく上の絞り込みの札に置く。
   * 左の列は共通の ManagedFolderPanel。プロジェクトのフォルダの口（API）がまだ無いので「すべて」だけ。
   */
  const viewChips: Array<{ key: ProjectView; label: string; count: number | null }> = [
    { key: 'favorite', label: 'お気に入り', count: ready ? projects.filter((p) => p.isFavorite).length : null },
    { key: 'running', label: '生成中', count: ready ? projects.filter((p) => p.runningCount > 0).length : null },
    { key: 'archived', label: 'アーカイブ', count: archivedCount },
  ]

  const createProject = (
    <PermissionGatedButton allowed={canManage} need="tenantWide" variant="primary" onClick={() => { setFormError(''); setFormOpen(true) }}>
      <Plus aria-hidden="true" className={styles.buttonIcon} />プロジェクトを作る
    </PermissionGatedButton>
  )
  const folders = (
    <>
      <ManagedFolderPanel
        kind={null}
        folders={[]}
        onChanged={() => undefined}
        canManage={canManage}
        itemLabel="プロジェクト"
        createAction={createProject}
        activeId="all"
        onSelect={() => setView('all')}
        allCount={ready ? projects.length : null}
      />
    </>
  )
  const viewFilter = (
    <ViewChips chips={viewChips} active={view} onChange={(next) => setView((next ?? 'all') as ProjectView)} />
  )

  const body = status === 'loading' ? (
    <ListState permissionScope="hq" kind="loading" title="プロジェクトを読み込んでいます" />
  ) : status === 'forbidden' ? (
    <ListState permissionScope="hq" kind="forbidden" description="バナー生成は統括の管理者・オーナーだけが使えます。" />
  ) : status === 'error' ? (
    <ListState permissionScope="hq"
      kind="error"
      title="一覧を読み込めませんでした"
      description="通信の状態を確認して、もう一度お試しください。何度も続く場合はお問い合わせから知らせてください。"
      onRetry={() => void load()}
    />
  ) : projects.length === 0 ? (
    archivedMode ? (
      <ListState permissionScope="hq" kind="empty" title="アーカイブしたプロジェクトはありません" description="進行中の一覧でアーカイブすると、ここに移ります。" />
    ) : (
      <ListState permissionScope="hq"
        kind="empty"
        title="まだプロジェクトがありません"
        description="案件やキャンペーンごとにプロジェクトを作り、その中で画像を生成します。作った画像はアカウントへ配れます。"
        action={<PermissionGatedButton allowed={canManage} need="tenantWide" variant="primary" onClick={() => setFormOpen(true)}>
          <Plus aria-hidden="true" className={styles.buttonIcon} />最初のプロジェクトを作る
        </PermissionGatedButton>}
      />
    )
  ) : visible.length === 0 ? (
    // R605: 検索・絞り込みの結果が0件。条件を外す口を付ける（作る口は出さない）。
    <ListState permissionScope="hq" kind="empty" emptyPreset="filtered" action={<Button onClick={() => { setQuery(''); setView('all') }}>条件を外す</Button>} />
  ) : (
    <ListPageCards>
      {visible.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          thumbnails={thumbnails[project.id] ?? []}
          busy={busyId === project.id}
          canManage={canManage}
          onOpen={() => router.push(`/hq/banners/project?id=${encodeURIComponent(project.id)}`)}
          onToggleFavorite={() => void toggleFavorite(project)}
        />
      ))}
    </ListPageCards>
  )

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      boardId="B9ZAr"
      title="バナー生成"
      help="配信やリッチメニューに使う画像を AI で作り、各アカウントの登録メディアへ配ります。"
      folders={folders}
      folderNav={{ rows: managedFolderNavRows(null, []), activeId: 'all', onSelect: () => setView('all'), createAction: createProject }}
      stats={<PageContent layout="stats">{head.stats}</PageContent>}
      tabs={head.tabs}
      explanation={head.explanation}
      contentInset
      toolbar={<>
        <BannerLimitNotice usage={usage} />
        <ListToolbar search={{placeholder:'プロジェクト名・説明で探す',label:'プロジェクト名・説明で探す',value:query,onChange:setQuery}}
          filters={viewFilter} trailing={<SaveErrorField names={["sort"]}><ListToolbarSort aria-label="プロジェクトの並び順" value={sort} onChange={(value) => setSort(value as ProjectSort)} options={PROJECT_SORTS} /></SaveErrorField>} />
        {actionError ? <Notice tone="danger" message={actionError} action={refreshFailed ? <Button onClick={() => void load(true, true)}>もう一度読み込む</Button> : undefined} /> : null}
      </>}
    >
      {body}
      <CreateProjectDialogV8
        open={formOpen}
        busy={formBusy}
        error={formError}
        onSubmit={(input) => void create(input)}
        onCancel={() => {
          if (formBusy) return
          setFormOpen(false)
          setFormError('')
        }}
      />
    </ListPage></SaveErrorScope>
  )
}

/** 上の絞り込みの札（見る：お気に入り・状態）。もう一度押すと外れて「すべて」に戻る。 */
function ViewChips<K extends string>({ chips, active, onChange }: {
  chips: Array<{ key: K; label: string; count: number | null }>
  active: string
  onChange: (next: K | null) => void
}) {
  return (
    <ListToolbarRow>
      <span className={styles.toolLabel}>見る</span>
      <SegmentedControl
        aria-label="見るもので絞り込む"
        value={active}
        onChange={(next) => onChange(next === 'all' ? null : next as K)}
        options={[
          { value: 'all', label: 'すべて' },
          ...chips.map((chip) => ({ value: chip.key as string, label: chip.label, count: chip.count ?? undefined })),
        ]}
      />
    </ListToolbarRow>
  )
}

/** プロジェクトのカード（絵の「プロジェクト 秋のキャンペーン」）。上に3枚、下に名前・説明・枚数と更新。 */
function ProjectCard({ project, thumbnails, busy, canManage, onOpen, onToggleFavorite }: {
  project: BannerProject
  thumbnails: BannerImage[]
  busy: boolean
  canManage: boolean
  onOpen: () => void
  onToggleFavorite: () => void
}) {
  const running = project.runningCount > 0
  const meta = running && project.imageCount === 0
    ? '—・いま作成中'
    : `${formatNumber(project.imageCount)} 枚・${monthDay(project.updatedAt)} 更新`
  return (
    <Card padding="rows" layout="media" overflow="hidden" aria-label={project.name}>
      <button type="button" className={styles.mosaic} onClick={onOpen} aria-label={`${project.name} を開く`}>
        {[0, 1, 2].map((i) => <Thumb key={i} image={thumbnails[i] ?? null} />)}
      </button>
      <CardContent><CardHeader size="content" headingLevel={3} title={<RowNameButton onClick={onOpen} title={project.name}>{project.name}</RowNameButton>}
        meta={<><TruncatedText value={project.description || '説明はまだありません'} /><TruncatedText value={meta} />
          {running ? <StatusBadge tone="info">生成中</StatusBadge> : null}
          {project.archivedAt ? <StatusBadge tone="neutral">アーカイブ</StatusBadge> : null}</>}
        action={canManage ? <IconButton variant="plain" size="small" onClick={onToggleFavorite} disabled={busy}
          title={busy ? 'お気に入りを変更しています' : undefined} pressed={project.isFavorite}
          aria-label={project.isFavorite ? `${project.name} をお気に入りから外す` : `${project.name} をお気に入りにする`}>
          <Star aria-hidden="true" className={project.isFavorite ? styles.starOn : styles.starOff} />
        </IconButton> : project.isFavorite ? <Star aria-label="お気に入り" className={`${styles.starStatic} ${styles.starOn}`} /> : null}
      /></CardContent>
    </Card>
  )
}

/** 画像の1枚。読めない画像は壊れた印を出さず、地の色のままにする。 */
function Thumb({ image }: { image: BannerImage | null }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={styles.thumb}>
      {image && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img width={240} height={126} src={image.media.url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : null}
    </span>
  )
}

/* ───────── 画像ライブラリ ───────── */

function LibraryView({ head, canManage, presets, accounts, onChanged }: {
  head: BannerHead
  canManage: boolean
  presets: BannerPreset[]
  accounts: AccountWithStats[]
  onChanged: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const [images, setImages] = useState<BannerImage[]>([])
  const [counts, setCounts] = useState<import('@line-crm/shared').HqBannerImageCounts | null>(null)
  const [projects, setProjects] = useState<Record<string, BannerProject>>({})
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [view, setView] = useListUrlValue<LibraryView>('view', 'all')
  const [shape, setShape] = useListUrlValue<ShapeFilter | null>('shape', null)
  const [query, setQuery] = useListUrlValue('q', '')
  /** ページごとの「この日時より前」。1ページ目は null。 */
  const [cursors, setCursors] = useListUrlJsonValue<Array<string | null>>('libraryCursors', [null], isCursorHistory)
  const [storedPageSize, setPageSize] = useListUrlValue('libraryPageSize', LIBRARY_PAGE)
  const pageSize = [12, 10, 20, 50].includes(storedPageSize) ? storedPageSize : LIBRARY_PAGE
  const [pageSizeOpen, setPageSizeOpen] = useState(false)
  const pageSizeAnchor = useRef<HTMLSpanElement>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [openImage, setOpenImage] = useState<BannerImage | null>(null)
  const [modalBusy, setModalBusy] = useState(false)
  const [modalError, setModalError] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const requestRef = useRef(0)
  const page = cursors.length - 1
  const before = cursors[page]

  const filters = useMemo(() => ({
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(shape ? { shape } : {}),
    ...(view === 'delivered' || view === 'unused' ? { delivered: view === 'delivered' } : {}),
    favorite: view === 'favorite',
    withCounts: true,
  }), [query, shape, view])

  const load = useCallback(async () => {
    const requestId = ++requestRef.current
    setStatus('loading')
    setActionError('')
    try {
      const [imageRes, activeRes, archivedRes] = await Promise.all([
        api.hqBanners.images.list({ ...filters, limit: pageSize, ...(before ? { before } : {}) }),
        api.hqBanners.projects.list(),
        api.hqBanners.projects.list({ archived: true }),
      ])
      if (requestId !== requestRef.current) return
      if (!imageRes.success) throw new Error(imageRes.error)
      if(!activeRes.success || !archivedRes.success)throw new Error('projects unavailable')
      setImages([...new Map(imageRes.data.map((image) => [image.id, image])).values()])
      setCounts(imageRes.counts ?? null)
      setNextBefore(imageRes.nextBefore ?? null)
      const map: Record<string, BannerProject> = {}
      for (const p of [...activeRes.data, ...archivedRes.data]) map[p.id] = p
      setProjects(map)
      setStatus('ready')
    } catch (caught) {
      if (requestId !== requestRef.current) return
      saveErrors.capture(caught);

      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [filters, before, pageSize, saveErrors])

  useEffect(() => {
    void load();

    return () => { requestRef.current += 1 }
  }, [load])

  // 条件を変えたら1ページ目へ戻す。
  const resetPage = () => setCursors([null])

  const replaceImage = (next: BannerImage) => {
    setImages((prev) => prev.map((i) => (i.id === next.id ? next : i)))
    setOpenImage((cur) => (cur?.id === next.id ? next : cur))
  }

  const toggleFavorite = async (image: BannerImage) => {
    setActionError('')
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

  const deliver = async (image: BannerImage, lineAccountIds: string[]): Promise<boolean> => {
    setModalBusy(true)
    setModalError('')
    try {
      const res = await api.hqBanners.images.deliver(image.id, lineAccountIds)
      if (!res.success) throw new Error(res.error)
      replaceImage(res.data.image)
      onChanged()
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

  const remove = async (image: BannerImage): Promise<boolean> => {
    setModalBusy(true)
    setModalError('')
    try {
      const res = await api.hqBanners.images.remove(image.id)
      if (!res.success) throw new Error(res.error)
      setImages((prev) => prev.filter((i) => i.id !== image.id))
      setOpenImage(null)
      onChanged()
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

  const ready = status === 'ready'
  /* お気に入り・配布済み・未使用は状態なので上の絞り込みの札へ。左の列は共通の ManagedFolderPanel（画像のフォルダの口が無いので「すべて」だけ）。 */
  const viewChips: Array<{ key: LibraryView; label: string; count: number | null }> = [
    { key: 'favorite', label: 'お気に入り', count: ready ? counts?.favorite ?? null : null },
    { key: 'delivered', label: '配布済み', count: ready ? counts?.delivered ?? null : null },
    { key: 'unused', label: '未使用', count: ready ? counts?.unused ?? null : null },
  ]

  const uploadImage = (
    <PermissionGatedButton allowed={canManage} need="tenantWide" variant="primary" onClick={() => setUploadOpen(true)}>
      <Upload aria-hidden="true" className={styles.buttonIcon} />画像を取り込む
    </PermissionGatedButton>
  )
  const selectView = (id: string) => { setView(id as LibraryView); resetPage() }
  const folders = (
    <>
      <ManagedFolderPanel
        kind={null}
        folders={[]}
        onChanged={() => undefined}
        canManage={canManage}
        itemLabel="画像"
        createAction={uploadImage}
        activeId="all"
        onSelect={() => selectView('all')}
        allCount={ready ? counts?.all ?? images.length : null}
      />
    </>
  )

  const total = counts ? (view === 'all' ? counts.all : counts[view]) : null
  const first = images.length === 0 ? 0 : page * pageSize + 1
  const last = page * pageSize + images.length

  const pager = (
      <div className={styles.pager}>
        <span className={styles.range} ref={pageSizeAnchor} role="button" tabIndex={0} aria-label="画像の取得件数" aria-haspopup="menu" aria-expanded={pageSizeOpen}
          onClick={() => setPageSizeOpen((open) => !open)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPageSizeOpen((open) => !open) } }}>
          {total === null ? `${first}–${last} 件` : `${first}–${last} 件 / ${formatNumber(total)} 件`}
        </span>
        <ActionMenu open={pageSizeOpen} onClose={() => setPageSizeOpen(false)} anchorRef={pageSizeAnchor} ariaLabel="画像の取得件数"
          note="一度に読み込む画像の枚数です。変えると最初のページへ戻ります。"
          items={[12, 10, 20, 50].map((size) => ({ id: String(size), label: `${size}枚`, onSelect: () => { setPageSize(size); resetPage(); setPageSizeOpen(false) } }))} />
        <span className={styles.spacer} />
        {page > 0 ? <Button onClick={() => setCursors((prev) => prev.slice(0, -1))}>{`前の ${pageSize} 件`}</Button> : null}
        {nextBefore ? <Button onClick={() => setCursors((prev) => [...prev, nextBefore])}>{`次の ${pageSize} 件`}</Button> : null}
      </div>
  )

  const body = status === 'loading' ? (
    <><ListState permissionScope="hq" kind="loading" title="画像を読み込んでいます" />{images.length > 0 ? pager : null}</>
  ) : status === 'forbidden' ? (
    <ListState permissionScope="hq" kind="forbidden" description="バナー生成は統括の管理者・オーナーだけが使えます。" />
  ) : status === 'error' ? (
    <ListState permissionScope="hq"
      kind="error"
      title="一覧を読み込めませんでした"
      description="通信の状態を確認して、もう一度お試しください。何度も続く場合はお問い合わせから知らせてください。"
      onRetry={() => void load()}
    />
  ) : images.length === 0 ? (
    query || shape || view !== 'all'
      ? <ListState permissionScope="hq" kind="empty" emptyPreset="filtered" action={<Button onClick={() => { setQuery(''); setShape(null); setView('all'); resetPage() }}>条件を外す</Button>} />
      : <ListState permissionScope="hq" kind="empty" title="まだ画像がありません" description="プロジェクトの中で生成した画像と、取り込んだ画像がここに並びます。" />
  ) : (
    <>
      <ListPageCards columns={4}>
        {images.map((image) => {
          const preset = image.generation ? presets.find((p) => p.key === image.generation?.presetKey) : null
          return (
            <article key={image.id} className={styles.tile}>
              <button type="button" className={styles.tileImage} onClick={() => { setModalError(''); setOpenImage(image) }} aria-label={`${projects[image.projectId]?.name ?? 'プロジェクト'} の画像を開く`}>
                <Thumb image={image} />
              </button>
              <div className={styles.tileMeta}>
                <span className={styles.metaText}>{image.source === 'upload' ? '取り込み' : shortPresetLabel(preset, image)}</span>
                <span className={styles.spacer} />
                {image.deliveredAccountIds.length > 0 ? <StatusBadge tone="success">配布済み</StatusBadge> : null}
                {canManage ? (
                  <IconButton size="small" variant="plain" onClick={() => void toggleFavorite(image)} pressed={image.isFavorite} aria-label={image.isFavorite ? 'お気に入りから外す' : 'お気に入りにする'}>
                    <Star aria-hidden="true" className={image.isFavorite ? styles.starOn : styles.starOff} />
                  </IconButton>
                ) : null}
              </div>
              <p className={styles.tileProject}>{projects[image.projectId]?.name ?? emptyValue('unknown')}</p>
            </article>
          )
        })}
      </ListPageCards>
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      skeleton
      boardId="W5Wxr"
      title="バナー生成"
      help="配信やリッチメニューに使う画像を AI で作り、各アカウントの登録メディアへ配ります。"
      folders={folders}
      folderNav={{ rows: managedFolderNavRows(null, []), activeId: 'all', onSelect: () => selectView('all'), createAction: uploadImage }}
      stats={<PageContent layout="stats">{head.stats}</PageContent>}
      tabs={head.tabs}
      explanation={head.explanation}
      contentInset
      pagination={images.length > 0 && status === 'ready' ? pager : undefined}
      toolbar={<>
        <ListToolbar search={{placeholder:'テキスト・指示で探す',label:'テキスト・指示で探す',value:query,onChange:(value)=>{setQuery(value);resetPage()}}}
          filters={<><ViewChips chips={viewChips} active={view} onChange={(next) => selectView((next ?? 'all') as LibraryView)} /><SegmentedControl
            aria-label="用途"
            value={shape ?? 'all'}
            onChange={(next) => { setShape(next === 'all' ? null : next as ShapeFilter); resetPage() }}
            options={[
              { value: 'all', label: 'すべて' },
              ...SHAPE_FILTERS.map((item) => ({ value: item.key as string, label: item.label })),
            ]}
          /></>} />
        {actionError ? <Notice tone="danger" message={actionError} /> : null}
      </>}
    >
      {body}

      <UploadDialogV8
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onDone={(projectId) => {
          setUploadOpen(false)
          router.push(`/hq/banners/project?id=${encodeURIComponent(projectId)}`)
        }}
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
          onToggleFavorite={() => void toggleFavorite(openImage)}
          onDeliver={(ids) => deliver(openImage, ids)}
          onRemove={() => remove(openImage)}
          onRegenerate={openImage.generation
            ? () => router.push(`/hq/banners/project?id=${encodeURIComponent(openImage.projectId)}&from=${encodeURIComponent(openImage.id)}`)
            : undefined}
        />
      ) : null}
    </ListPage></SaveErrorScope>
  )
}
