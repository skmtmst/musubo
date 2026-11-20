'use client'

import PermissionGatedButton from '@/components/shared/permission-gated-button'
import SegmentedControl from '@/components/shared/segmented'

import { TAG_ADD_ACTION_LABEL } from '@/components/shared/action-words'
import { useListUrlJsonValue, useListUrlValue } from '@/components/shared/list-url-state'
import { jstDate } from '@/lib/jst-datetime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, Coins, Download, Plus, Trophy, Briefcase } from 'lucide-react'
import type { LineAccount, Scenario, Tag } from '@line-crm/shared'
import { api, type AffiliateOffer, type ConversionApprovalItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import Button from '@/components/shared/button'
import StatusBadge from '@/components/shared/status-badge'
import EmptyList from '@/components/shared/empty-list'
import ManagedFolderPanel, { managedFolderNavRows, useManagedFolders, folderDotFor } from '@/components/shared/managed-folder-panel'
import { useFolderMove } from '@/components/shared/use-folder-move'
import { FolderDotName } from '@/components/shared/folder-dot'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import ListPagination from '@/components/shared/list-pagination'
import { RowNameButton, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifyToast } from '@/components/shared/toast'
import { ListPagePagination } from '@/components/templates'
import {
  currentSettlementPeriod,
  deltaText,
  downloadCsv,
  formatDate,
  formatYen,
  jstMonthKey,
  listAllConversionApprovals,
  pageCountOf,
  pageOf,
  previousSettlementPeriod,
} from './display'
import { AFFILIATE_TABLE_LAYOUT, AffiliateFrame, useAffiliateShell } from './frame'
import OfferFormModal from './offer-form'
import OfferTermsDialog from './offer-terms'
import {
  AffiliateToolbar,
  PerPageSelect,
  RetryButton,
  RowMenu,
  SavedSelect,
  StateCard,
} from './parts'
import styles from './affiliates.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 成果とアフィリエイト「案件」（板 ）。
 *
 * app/affiliates/v8-offers-tab.tsx から動きを写し、見た目を一覧の型（ListPage）で
 * 組み直した。データの口は今と同じ（案件・アカウント・タグ・シナリオの名前・承認の全件）。
 * 行の「…」は 編集・決まり・公開を止める（公開する）・複製。複製は下書きで作る。
 *
 * フォルダの列：共通のフォルダ（kind `affiliate_offer`）。行の名前の前に色の丸、「…」の「フォルダへ移す」。
 * 成果が出たときの動き（タグ・シナリオ・マイル）での見え方は「よく使う絞り込み」から選ぶ（保存しない）。
 */

type FilterKey = 'open' | 'draft'
type FolderKey = 'all' | 'tag' | 'scenario' | 'miles' | 'none'
type LoadState = 'loading' | 'ready' | 'error'

/* 成果が出たときの動きで分けた見え方（保存しない）。「よく使う絞り込み」から選ぶ。 */
const FOLDERS: Array<{ key: FolderKey; label: string; match: (o: AffiliateOffer) => boolean }> = [
  { key: 'all', label: '動き：すべて', match: () => true },
  { key: 'tag', label: TAG_ADD_ACTION_LABEL, match: (o) => Boolean(o.tagId) },
  { key: 'scenario', label: 'シナリオを始める', match: (o) => !o.tagId && Boolean(o.scenarioId) },
  { key: 'miles', label: 'マイルを渡す', match: (o) => !o.tagId && !o.scenarioId && o.rewardMiles > 0 },
  { key: 'none', label: '動きが未設定', match: (o) => !o.tagId && !o.scenarioId && o.rewardMiles === 0 },
]

const SAVED_VIEWS: Array<{ value: string; label: string; filters: FilterKey[]; sort: 'newest' | 'name' | 'reward'; folder?: FolderKey }> = [
  { value: '', label: 'よく使う絞り込み', filters: [], sort: 'newest' },
  { value: 'open-reward', label: '公開中・報酬が高い順', filters: ['open'], sort: 'reward' },
  { value: 'draft', label: '下書きだけ', filters: ['draft'], sort: 'newest' },
  { value: 'tag', label: `${TAG_ADD_ACTION_LABEL}案件`, filters: [], sort: 'newest', folder: 'tag' },
  { value: 'scenario', label: 'シナリオを始める案件', filters: [], sort: 'newest', folder: 'scenario' },
  { value: 'miles', label: 'マイルを渡す案件', filters: [], sort: 'newest', folder: 'miles' },
  { value: 'name', label: '案件名の順', filters: [], sort: 'name' },
]

export default function OffersTab() {
  const saveErrors = useSaveFormErrors()
  const { readonly, narrow, setCount, accountId } = useAffiliateShell()
  const [folderId, setFolderId] = useListUrlValue('folderId', 'all')
  const settlementPeriod = useMemo(() => currentSettlementPeriod(), [])

  const [offers, setOffers] = useState<AffiliateOffer[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<(Scenario & { stepCount?: number })[]>([])
  const [approvals, setApprovals] = useState<ConversionApprovalItem[]>([])
  const [approvalState, setApprovalState] = useState<LoadState>('loading')
  /* WEB209：承認は5000件で読むのを止める。止めたときは数を言い切らない。 */
  const [approvalsTruncated, setApprovalsTruncated] = useState(false)
  const [monthly, setMonthly] = useState<{ count: number; delta: number | null } | null>(null)
  const [monthlyState, setMonthlyState] = useState<LoadState>('loading')

  const [query, setQuery] = useListUrlValue('q', '')
  const [filters, setFilters] = useListUrlJsonValue<FilterKey[]>('filters', [])
  const [folder, setFolder] = useListUrlValue<FolderKey>('action', 'all')
  const { folders, error: folderError, reload: reloadFolders } = useManagedFolders('affiliate_offer', accountId)
  const [sort, setSort] = useListUrlValue<'newest' | 'name' | 'reward'>('sort', 'newest')
  const [saved, setSaved] = useState('')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)

  const [formOpen, setFormOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AffiliateOffer | null>(null)
  const [termsTarget, setTermsTarget] = useState<AffiliateOffer | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadOffers = useCallback(async () => {
    setLoadState('loading')
    try {
      const res = await api.affiliateOffers.list()
      if (!mounted.current) return
      if (res.success && Array.isArray(res.data)) {
        setOffers(res.data)
        setLoadState('ready')
      } else {
        setOffers([])
        setLoadState('error')
      }
    } catch (saveFailure) {
      if (!mounted.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setOffers([])
      { if (!fieldFailure)
      setLoadState('error')
    }
  }
  }, [saveErrors]);


  const loadOptions = useCallback(async () => {
    try {
      const [accountsRes, tagsRes, scenariosRes] = await Promise.all([api.lineAccounts.list(), api.tags.list(), api.scenarios.list()])
      if (!mounted.current) return
      if (accountsRes.success && Array.isArray(accountsRes.data)) setAccounts(accountsRes.data as unknown as LineAccount[])
      if (tagsRes.success && Array.isArray(tagsRes.data)) setTags(tagsRes.data as unknown as Tag[])
      if (scenariosRes.success && Array.isArray(scenariosRes.data)) setScenarios(scenariosRes.data as unknown as (Scenario & { stepCount?: number })[])
    } catch (saveFailure) {
      saveErrors.capture(saveFailure) /* 名前が引けなくても一覧は出せる */ }
  }, [saveErrors]);


  const loadApprovals = useCallback(async () => {
    setApprovalState('loading')
    try {
      const results = await Promise.all((['pending', 'approved'] as const).map((status) => listAllConversionApprovals(status, 0, { accountId })))
      if (!mounted.current) return
      setApprovals(results.flatMap((result) => result.items))
      setApprovalsTruncated(results.some((result) => result.truncated))
      setApprovalState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (mounted.current) { if (!fieldFailure) setApprovalState('error')
    }
  }
  }, [accountId, saveErrors]);


  const loadMonthly = useCallback(async () => {
    setMonthlyState('loading')
    try {
      const prev = previousSettlementPeriod(settlementPeriod.periodFrom)
      const [res, prevRes] = await Promise.all([
        api.affiliates.allReport({ startDate: settlementPeriod.periodFrom, endDate: settlementPeriod.periodTo }),
        api.affiliates.allReport({ startDate: prev.periodFrom, endDate: prev.periodTo }),
      ])
      if (!res.success) throw new Error('monthly report failed')
      const total = (arr: unknown) => (arr as Array<{ totalConversions: number }>).reduce((sum, row) => sum + row.totalConversions, 0)
      const current = total(res.data)
      if (!mounted.current) return
      setMonthly({ count: current, delta: prevRes.success ? current - total(prevRes.data) : null })
      setMonthlyState('ready')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);

      if (mounted.current) { if (!fieldFailure) setMonthlyState('error')
    }
  }
  }, [settlementPeriod, saveErrors])

  useEffect(() => {
    void loadOffers()
    void loadOptions()
    void loadApprovals()
    void loadMonthly()
  }, [loadOffers, loadOptions, loadApprovals, loadMonthly])

  useEffect(() => {
    if (loadState === 'ready') setCount('offers', formatNumber(offers.length))
  }, [loadState, offers.length, setCount])

  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t.name])), [tags])
  const scenarioMap = useMemo(() => new Map(scenarios.map((sc) => [sc.id, sc.name])), [scenarios])
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts])

  /* 案件ごとの 紹介している人・成果・確定した報酬（認めた成果の報酬額の合計）。 */
  const offerStats = useMemo(() => {
    const result = new Map<string, { people: Set<string>; conversions: number; reward: number }>()
    for (const item of approvals) {
      if (!item.offerId) continue
      const current = result.get(item.offerId) ?? { people: new Set<string>(), conversions: 0, reward: 0 }
      current.people.add(item.affiliateId)
      current.conversions += 1
      if (item.approvalStatus === 'approved') current.reward += item.rewardAmount ?? 0
      result.set(item.offerId, current)
    }
    return result
  }, [approvals])

  const approvedThisMonth = useMemo(() => {
    const month = jstMonthKey()
    return approvals.filter((item) => item.approvalStatus === 'approved' && jstMonthKey(item.createdAt) === month)
  }, [approvals])
  const averageReward = approvedThisMonth.length > 0
    ? Math.round(approvedThisMonth.reduce((sum, item) => sum + (item.rewardAmount ?? 0), 0) / approvedThisMonth.length)
    : null

  const foldered = useMemo(() => offers
    .filter(FOLDERS.find((f) => f.key === folder)?.match ?? (() => true))
    .filter((offer) => folderId === 'all' || (folderId === 'unfiled' ? !offer.folderId : offer.folderId === folderId)), [offers, folder, folderId])
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return foldered
      .filter((offer) => {
        if (filters.includes('open') && !offer.isActive) return false
        if (filters.includes('draft') && offer.isActive) return false
        if (needle && !`${offer.name} ${offer.description ?? ''}`.toLowerCase().includes(needle)) return false
        return true
      })
      .toSorted((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name, 'ja')
        if (sort === 'reward') return (b.rewardAmount ?? 0) - (a.rewardAmount ?? 0)
        return b.createdAt.localeCompare(a.createdAt)
      })
  }, [filters, foldered, query, sort])

  const pageCount = pageCountOf(shown.length, pageSize)
  const currentPage = Math.min(page, pageCount)
  const paged = pageOf(shown, currentPage, pageSize)
  const ready = loadState === 'ready'
  const openCount = offers.filter((o) => o.isActive).length
  const draftCount = offers.length - openCount
  const milesCount = offers.filter((o) => o.rewardMiles > 0).length

  const resetPage = (change: () => void) => { change(); setPage(1) }
  const resetConditions = () => {
    setQuery('')
    setFilters([])
    setFolder('all')
    setFolderId('all')
    setSaved('')
    setPage(1)
  }

  const rewardText = (offer: AffiliateOffer) => (offer.rewardAmount && offer.rewardAmount > 0 ? `1件ごと ${formatYen(offer.rewardAmount)}` : '報酬なし')
  const actionText = (offer: AffiliateOffer) => {
    if (offer.tagId) return `タグ「${tagMap.get(offer.tagId) ?? '名前を確認できません'}」を付ける`
    if (offer.scenarioId) return `シナリオ「${scenarioMap.get(offer.scenarioId) ?? '名前を確認できません'}」を始める`
    if (offer.rewardMiles > 0) return `マイル ${formatNumber(offer.rewardMiles)} を渡す`
    return '—'
  }

  /*
   * 公開する・公開を止める：押した瞬間に札を変え、裏で保存する（触り心地 5 回目）。
   * 成功したら返ってきた中身に置き換える（一覧は読み直さない）。失敗したら元に戻してトーストで知らせる。
   */
  const togglePublish = async (offer: AffiliateOffer) => {
    const next = !offer.isActive
    const setActive = (isActive: boolean) => setOffers((current) => current.map((item) => (item.id === offer.id ? { ...item, isActive } : item)))
    setBusyId(offer.id)
    setActive(next)
    try {
      const res = await api.affiliateOffers.update(offer.id, { isActive: next })
      if (!res.success) throw new Error('update failed')
      if (res.data && res.data.id === offer.id) setOffers((current) => current.map((item) => (item.id === offer.id ? { ...item, ...res.data } : item)))
      notifyToast(next ? `「${offer.name}」を公開しました。` : `「${offer.name}」の公開を止めました。紹介リンクに出なくなります。`)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setActive(offer.isActive)
      { if (!fieldFailure)
      notifyToast(`「${offer.name}」を${next ? '公開でき' : '止められ'}ませんでした。元に戻しました。`, {
        tone: 'error',
        actionLabel: 'もう一度',
        onAction: () => { void togglePublish(offer) },
      }) }
    } finally {
      setBusyId(null)
    }
  }

  const duplicate = async (offer: AffiliateOffer) => {
    setBusyId(offer.id)
    try {
      /*
       * WEB210：複製は全部の条件を写す（数える期間・上限・受付の期間も）。今の版の決まりを
       * 読めなかったときは、決まりの抜けた複製を作らずに止める。
       */
      const cap = await api.affiliateOffers.capStatus(offer.id)
      if (!cap.success || !cap.data) throw new Error('terms unavailable')
      const version = cap.data.version
      const res = await api.affiliateOffers.create({
        ...(version ? {
          windowDays: version.windowDays ?? undefined,
          capTotal: version.capTotal ?? null,
          capMonthlyPerAffiliate: version.capMonthlyPerAffiliate ?? null,
          receptionFrom: version.receptionFrom ?? null,
          receptionTo: version.receptionTo ?? null,
        } : {}),
        name: `${offer.name}（コピー）`,
        description: offer.description,
        rewardAmount: offer.rewardAmount ?? 0,
        rewardMiles: offer.rewardMiles,
        lineAccountId: offer.lineAccountId,
        tagId: offer.tagId,
        scenarioId: offer.scenarioId,
        isActive: false,
        operationId: crypto.randomUUID(),
      })
      if (!res.success) throw new Error('create failed')
      notifyToast(`「${offer.name}」を下書きで複製しました。`)
      void loadOffers()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      notifyToast('複製できませんでした。もう一度お試しください。') }
    } finally {
      setBusyId(null)
    }
  }

  const exportCsv = () => {
    downloadCsv(csvFileName("アフィリエイト案件"), [
      ['案件名', '説明', '報酬（円）', 'マイル', '対象アカウント', '成果時のタグ', '開始するシナリオ', '状態', '作成日'],
      ...shown.map((offer) => [
        offer.name,
        offer.description ?? '',
        offer.rewardAmount ?? '',
        offer.rewardMiles,
        offer.lineAccountId ? accountMap.get(offer.lineAccountId) ?? '—（名前を確認できません）' : '',
        offer.tagId ? tagMap.get(offer.tagId) ?? '—（名前を確認できません）' : '',
        offer.scenarioId ? scenarioMap.get(offer.scenarioId) ?? '—（名前を確認できません）' : '',
        offer.isActive ? '公開中' : '下書き',
        formatDate(offer.createdAt),
      ]),
    ])
  }

  const openCreate = () => { setEditTarget(null); setFormOpen(true) }

  const loadingWord = '読み込んでいます'
  const errorWord = '読み込めませんでした'
  const stats = (
    <KpiBand>
      <KpiCard
        presentation="band"
        title="案件"
        icon={<Briefcase size={16} aria-hidden="true" />}
        value={ready ? offers.length : null}
        unit="件"
        detail={ready ? `公開中 ${formatNumber(openCount)}・下書き ${formatNumber(draftCount)}` : loadState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="今月の成果"
        icon={<Trophy size={16} aria-hidden="true" />}
        value={monthlyState === 'ready' && monthly ? monthly.count : null}
        unit="件"
        detail={monthlyState === 'ready' && monthly ? deltaText(monthly.delta) : monthlyState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="平均報酬"
        icon={<Banknote size={16} aria-hidden="true" />}
        value={null}
        valueText={approvalState === 'ready' && !approvalsTruncated && averageReward != null ? formatYen(averageReward) : emptyValue('unknown')}
        unit=""
        detail={approvalState === 'ready'
          ? (approvalsTruncated ? '件数が多く、全部は数えられませんでした' : averageReward == null ? '今月はまだ認めた成果がありません' : '1件あたり')
          : approvalState === 'loading' ? loadingWord : errorWord}
      />
      <KpiCard
        presentation="band"
        title="マイルあり"
        icon={<Coins size={16} aria-hidden="true" />}
        value={ready ? milesCount : null}
        unit="件"
        detail={ready ? '成果でマイルも付く' : loadState === 'loading' ? loadingWord : errorWord}
      />
    </KpiBand>
  )

  const createButton = (full: boolean) => (
    <PermissionGatedButton allowed={!readonly} variant="primary" className={full ? 'v8-folder-create w-full' : undefined} onClick={openCreate}>
        <Plus size={16} aria-hidden="true" /> 案件を作る
      </PermissionGatedButton>
  )

  const chooseFolder = (id: string) => resetPage(() => setFolderId(id))
  const folderPanel = (
    <ManagedFolderPanel kind="affiliate_offer" accountId={accountId} folders={folders}
      onChanged={async () => { await reloadFolders(); await loadOffers() }} canManage={!readonly} createAction={createButton(true)}
      reserveCreateSpace={false} itemLabel="案件" activeId={folderId} onSelect={chooseFolder}
      allCount={ready ? offers.length : null} error={folderError}
      unfiledCount={ready ? offers.filter((offer) => !offer.folderId).length : null}
      countOf={(item) => ready ? offers.filter((offer) => offer.folderId === item.id).length : null}
      onDeleted={(id) => { if (folderId === id) chooseFolder('all'); void loadOffers() }} />
  )
  const folderMove = useFolderMove({ accountId, canEdit: !readonly, items: paged, folders,
    move: async (offer, targetId) => { const result = await api.affiliateOffers.update(offer.id, { folderId: targetId }); if (!result.success) throw new Error('案件をフォルダへ移せませんでした') },
    onChanged: async () => { await loadOffers(); await reloadFolders() },
  })

  const chips = (
    <SegmentedControl<FilterKey | 'all' | ''> aria-label="状態で絞り込む" fit="content" onClear={() => resetPage(() => { setSaved(''); setFilters([]) })} value={filters.length === 0 ? 'all' : filters.length === 1 ? filters[0] : ''} onChange={(value) => resetPage(() => { setSaved(''); setFilters(value === 'all' || value === '' ? [] : [value]) })} options={[
      { value: 'all', label: 'すべて' }, { value: 'open', label: '公開中', count: ready ? openCount : undefined }, { value: 'draft', label: '下書き', count: ready ? draftCount : undefined },
    ]} />
  )

  const trailing = (
    <>
      <SavedSelect
        value={saved}
        options={SAVED_VIEWS.map((view) => ({ value: view.value, label: view.label }))}
        onChange={(value) => {
          const view = SAVED_VIEWS.find((v) => v.value === value)
          if (!view) return
          resetPage(() => {
            setSaved(value)
            setFilters([...view.filters])
            setSort(view.sort)
            setFolder(view.folder ?? 'all')
          })
        }}
      />
      <PerPageSelect value={pageSize} onChange={(value) => resetPage(() => setPageSize(value))} />
    </>
  )

  const toolbar = (
    <AffiliateToolbar
      narrow={narrow}
      notices={null}
      search={{ placeholder: '案件名・説明で探す', value: query, onChange: (value) => resetPage(() => setQuery(value)) }}
      chips={chips}
      trailing={trailing}
      narrowLead={createButton(false)}
    />
  )

  const table = (
    <div className={styles.tableWrap}>
      <DataTable columnLayout={AFFILIATE_TABLE_LAYOUT}>
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>案件</Th>
            <Th className={styles.colOfferReward}>報酬</Th>
            <Th collapseAt="narrow" className={styles.colOfferAction}>成果が出たときの動き</Th>
            <Th collapseAt="narrow" align="right" className={styles.colOfferPeople}>紹介している人</Th>
            <Th align="right" className={styles.colOfferConv}>成果</Th>
            <Th align="right" className={styles.colOfferState}>状態</Th>
            <Th className={styles.colOfferOps}>操作</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {paged.map((offer) => {
            const stat = offerStats.get(offer.id)
            return (
              <Tr key={offer.id} data-table-layout="columns" data-row-id={offer.id}>
                <Td grow>
                  <span className={narrow ? styles.stack : `${styles.stack} ${styles.dotStack}`}>
                    <FolderDotName folder={folderDotFor(folders, offer.folderId)} dot={!narrow}>
                      {readonly ? (
                        <span><TruncatedText value={String(offer.name ?? '')} /></span>
                      ) : (
                        <RowNameButton title={offer.name}  onClick={() => { setEditTarget(offer); setFormOpen(true) }}>{offer.name}</RowNameButton>
                      )}
                    </FolderDotName>

                  </span>
                </Td>
                <Td className={styles.colOfferReward}>
                  <span className={styles.stack}>
                    <span className={styles.cellNum}>{rewardText(offer)}</span>
                    {offer.rewardMiles > 0 ? <span className={styles.rowPlan}>{`＋${formatNumber(offer.rewardMiles)}マイル`}</span> : null}
                  </span>
                </Td>
                <Td collapseAt="narrow" className={styles.colOfferAction}>
                  <span className={styles.cellNum} title={actionText(offer)}>{actionText(offer)}</span>
                </Td>
                <Td collapseAt="narrow" align="right" className={styles.colOfferPeople}>
                  <span className={styles.cellNum}>{approvalState === 'ready' ? `${formatNumber(stat?.people.size ?? 0)}人${approvalsTruncated ? '以上' : ''}` : emptyValue('unknown')}</span>
                </Td>
                <Td align="right" className={styles.colOfferConv}>
                  <span className={styles.stackEnd}>
                    <span className={styles.cellNum}>{approvalState === 'ready' ? (stat ? `${formatNumber(stat.conversions)}件${approvalsTruncated ? '以上' : ''}` : emptyValue('unknown')) : emptyValue('unknown')}</span>
                    {stat ? <span className={styles.rowPlan}>{`確定 ${formatYen(stat.reward)}`}</span> : null}
                  </span>
                </Td>
                <Td align="right" className={styles.colOfferState}><StatusBadge tone={offer.isActive ? 'success' : 'neutral'}>{offer.isActive ? '公開中' : '下書き'}</StatusBadge></Td>
                <Td className={styles.colOfferOps}>
                  <span className={styles.rowActions}>

                    <RowMenu
                      label={`${offer.name}の操作`}
                      items={[
                        ...(readonly ? [] : [{ id: 'edit', label: '編集', onSelect: () => { setEditTarget(offer); setFormOpen(true) } }]),
                        { id: 'terms', label: '決まり（受付期間・上限・数える期間）', onSelect: () => setTermsTarget(offer) },
                        ...(readonly ? [] : [
                          { id: 'publish', label: offer.isActive ? '公開を止める' : '公開する', disabled: busyId !== null, disabledReason: 'ほかの操作を反映しています', onSelect: () => { void togglePublish(offer) } },
                          { id: 'move', label: 'フォルダへ移す', onSelect: () => folderMove.open(offer) },
                          { id: 'duplicate', label: '複製（下書きで作る）', disabled: busyId !== null, disabledReason: 'ほかの操作を反映しています', onSelect: () => { void duplicate(offer) } },
                        ]),
                      ]}
                    />
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </div>
  )

  const body = loadState === 'loading' ? (
    <ListState kind="loading" title="案件を読み込んでいます" />
  ) : loadState === 'error' ? (
    <StateCard tone="error" title="案件を読み込めませんでした" description="数の帯は「—」にしています。道具はそのまま使えます。" action={<RetryButton onRetry={() => { void loadOffers() }} />} />
  ) : shown.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      icon={<Briefcase aria-hidden="true" />}
      title="まだ案件がありません"
      description="何をしたら成果になり、いくら払うかを決めて、紹介してもらいます。"
      create={{ label: '最初の案件を作る', onClick: openCreate }}
      canCreate={!readonly}
      filtered={offers.length > 0}
      onClearFilters={resetConditions}
    />
  ) : (
    <>
      {table}
    </>
  )

  const pager = ready ? (
    <ListPagePagination>
      <ListPagination total={shown.length} page={currentPage} pageSize={pageSize} unit="件" onPageChange={setPage} />
    </ListPagePagination>
  ) : undefined

  return (
    <SaveErrorScope errors={saveErrors}><AffiliateFrame
      explanation="アフィリエイターは「紹介する人」、案件は「何を紹介すると、いくら払うか」の決まりです。1人のアフィリエイターが、いくつもの案件を紹介できます。"
      help={readonly ? '行の「…」から 決まり（受付期間・上限・数える期間）を見る。' : '行の「…」から 編集・決まり・公開を止める・複製。'}
      actions={<Button onClick={exportCsv} disabled={shown.length === 0}><Download size={16} aria-hidden="true" /> CSVで書き出す</Button>}
      stats={stats}
      folderNav={{ rows: managedFolderNavRows('affiliate_offer', folders), activeId: folderId, onSelect: chooseFolder, createAction: createButton(false) }}
      folders={folderPanel}
      toolbar={toolbar}
      pagination={pager}
      overlays={<>
        {formOpen ? (
          <OfferFormModal
            initial={editTarget}
            accounts={accounts}
            tags={tags}
            scenarios={scenarios}
            onClose={() => setFormOpen(false)}
            onSaved={() => { void loadOffers() }}
          />
        ) : null}
        {folderMove.overlays}
        {termsTarget ? <OfferTermsDialog offer={termsTarget} onClose={() => setTermsTarget(null)} /> : null}
      </>}
    >
      {body}
    </AffiliateFrame></SaveErrorScope>
  )
}
