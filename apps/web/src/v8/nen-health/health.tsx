'use client'
import SegmentedControl from '@/components/shared/segmented'

import { useListUrlJsonValue, useListUrlValue } from '@/components/shared/list-url-state';


import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bookmark, CalendarCheck, CalendarDays, FileText, History, PawPrint } from 'lucide-react';
import { ListPage } from '@/components/templates';
import Button from '@/components/shared/button'
import ActionMenu, { type ActionMenuItem } from '@/components/shared/action-menu';
import FilterChip from '@/components/shared/filter-chip'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table';
import { Tabs } from '@/components/shared/tabs';
import { usePageCrumbs } from '@/components/shell/page-chrome';
import { ApiError } from '@/lib/api';
import { nenPetsApi, petAnimalTypeLabel, type NenHealthKpis, type NenHealthListData, type NenHealthRow, type NenHealthSort, type NenHealthSummaryData } from '@/lib/nen-pets-api';
import HealthItemsV8 from './items'
import SummaryDrawerV8, { SummarySheet } from './summary';
import { EMPTY_FILTERS, Pill, RowMenu, WeightBars, changeBadges, md, type HealthFilters, type HealthTabKey } from './parts';
import styles from './health.module.css'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import { ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd } from '@/components/shared/list-toolbar';
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select';

/*
 * ★V8-B 健康日記（Pencil「★V8-B 画面の地図」専用機能の組：
 * 一覧 ・30日のまとめ（引き出し）・記録の項目 ）。
 *
 * 外枠（見出し・獣医師向け PDF・タブ・数の帯）は3つのタブで同じ。型は ListPage。
 * データの口（health・healthSummary・印刷）は今の画面と同じ。
 * 健康日記はお客さまがマイページで付けるので、ここに変える操作は無い（閲覧のみでも同じ画面）。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

export type { HealthTabKey } from './parts'

const BOARD: Record<HealthTabKey, string> = { logs: 'mIwA4', concern: 'mIwA4', items: 'z2tvtX' }
const PAGE_SIZES = STANDARD_PAGE_SIZES
type ListStatus = 'loading' | 'ready' | 'error' | 'forbidden'
type SummaryState = { accountId: string; petId: string; data: NenHealthSummaryData }

export default function HealthV8({
  accountId,
  tab,
  onChangeTab,
}: {
  accountId: string | null
  tab: HealthTabKey
  onChangeTab: (next: HealthTabKey) => void
}) {
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const [kpis, setKpis] = useState<NenHealthKpis | null>(null)
  const [kpisFailed, setKpisFailed] = useState(false)
  const [filters, setFilters] = useListUrlJsonValue<HealthFilters>('filters', EMPTY_FILTERS)

  /*
   * 「30日のまとめ」は対象スナップショットとして持つ（今の画面の DEEP-23 と同じ）。
   * 表示名・集計・印刷面はすべてこの1つから出すので、別ペットの遅い応答が届いても
   * 選択中のペットの面だけが出る。要求世代で古い応答を捨てる。
   */
  const [summaryPetId, setSummaryPetId] = useState<string | null>(null)
  // 一覧の「気になる変化」で体重が当たっているペットは、まとめの体重の増減も注意の色にする。
  const [summaryWeightWarn, setSummaryWeightWarn] = useState(false)
  const [summaryStatus, setSummaryStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [summaryError, setSummaryError] = useState<unknown>(null)
  const [summary, setSummary] = useState<SummaryState | null>(null)
  const requestRef = useRef(0)

  // アカウントを替えたら、まとめを閉じて前のアカウントの数・絞り込みを捨てる。
  const [seenAccount, setSeenAccount] = useState(accountId)
  if (seenAccount !== accountId) {
    setSeenAccount(accountId)
    requestRef.current += 1
    setSummaryPetId(null)
    setSummary(null)
    setSummaryError(null)
    setKpis(null)
    setKpisFailed(false)
    setFilters(EMPTY_FILTERS)
  }

  const loadSummary = useCallback(async () => {
    if (!accountId || !summaryPetId) return
    const request = ++requestRef.current
    const account = accountId
    const petId = summaryPetId
    setSummaryStatus('loading')
    setSummaryError(null)
    try {
      const res = await nenPetsApi.healthSummary(account, petId)
      if (!res.success) throw new Error(res.error)
      if (requestRef.current !== request) return
      setSummary({ accountId: account, petId, data: res.data })
      setSummaryStatus('ready')
    } catch (caught) {
      if (requestRef.current !== request) return
      // 失敗そのままを残す。共通の失敗面が403（再試行なし）と429（待ち案内）を言い分ける（M034）。
      setSummaryError(caught)
      setSummaryStatus('error')
    }
  }, [accountId, summaryPetId])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  // 記録の項目のタブでも数の帯は出す。1件だけ取って数を読む。
  useEffect(() => {
    if (!accountId || tab !== 'items') return
    let active = true
    setKpisFailed(false)
    void nenPetsApi.health(accountId, { pageSize: 1 }).then((res) => {
      if (!active) return
      if (res.success) setKpis(res.data.kpis)
      else setKpisFailed(true)
    }).catch(() => { if (active) setKpisFailed(true) })
    return () => { active = false }
  }, [accountId, tab])

  const closeSummary = () => {
    requestRef.current += 1
    setPrintPetId(null)
    setSummaryPetId(null)
    setSummary(null)
    setSummaryError(null)
  }
  const activeSummary = summary && summaryPetId !== null && summary.accountId === accountId && summary.petId === summaryPetId ? summary.data : null
  const canPrint = summaryPetId !== null && summaryStatus === 'ready' && activeSummary !== null

  /* 行の「獣医師向け PDF」：まとめが読めたら一度だけ印刷の窓を出す。 */
  const [printPetId, setPrintPetId] = useState<string | null>(null)
  useEffect(() => {
    if (!printPetId || !canPrint || summaryPetId !== printPetId) return
    setPrintPetId(null)
    /*
     * WEB224：紙の面（SummarySheet）は、まとめが読めた同じ描画で初めて置かれ、次の描画で中身が入る。
     * ここですぐ印刷すると、紙の面がまだ無いまま印刷の窓が開く。面が置かれるのを待ってから開く。
     */
    const printWhenReady = (tries: number) => {
      if (document.querySelector('[data-print-sheet]') || tries >= 20) {
        window.print()
        return
      }
      window.setTimeout(() => printWhenReady(tries + 1), 16)
    }
    printWhenReady(0)
  }, [printPetId, canPrint, summaryPetId])

  const tabs = (
    <div className={styles.tabs}>
      <Tabs
        label="健康日記の切り替え"
        items={[
          { label: kpis ? `記録のあるペット ${kpis.petsWithRecords}` : '記録のあるペット', current: tab === 'logs', onClick: () => onChangeTab('logs') },
          { label: kpis ? `気になる変化 ${kpis.concerning}` : '気になる変化', current: tab === 'concern', onClick: () => onChangeTab('concern') },
          { label: '記録の項目', current: tab === 'items', onClick: () => onChangeTab('items') },
        ]}
      />
    </div>
  )

  const pending = kpis === null
  const missing = kpisFailed ? '読み込めませんでした' : '読み込んでいます'
  const stats = accountId ? (
    <KpiBand data-design="KPIs" aria-label="健康日記の数の帯">
      <KpiCard presentation="band" title="記録のあるペット" icon={<History size={16} aria-hidden="true" />} value={pending ? null : kpis.petsWithRecords} unit="匹" loading={pending && !kpisFailed} detail={pending ? missing : `登録 ${kpis.petsTotal} 匹のうち`} />
      <KpiCard presentation="band" title="気になる変化" icon={<Activity size={16} aria-hidden="true" />} value={pending ? null : kpis.concerning} unit="匹" loading={pending && !kpisFailed} detail="体重 ±10%（8週）など" />
      <KpiCard presentation="band" title="今週の記録" icon={<CalendarCheck size={16} aria-hidden="true" />} value={pending ? null : kpis.recordsThisWeek} unit="件" loading={pending && !kpisFailed} detail="直近7日に付いた記録" />
      <KpiCard presentation="band" title="30日 記録なし" icon={<PawPrint size={16} aria-hidden="true" />} value={pending ? null : kpis.silent30} unit="匹" loading={pending && !kpisFailed} detail="声をかけられます" />
    </KpiBand>
  ) : undefined

  return (
    <ListPage
      skeleton
      boardId={BOARD[tab]}
      headingSize="regular"
      title="健康日記"
      help="お客さまがマイページで付けたペットの記録（体重・食事・うんち・元気）を見ます。気になる変化を見つけて声をかけられます。"
      explanation="「気になる変化」は、体重が8週で±10%以上変わった・便の異常が3回続いた・食いつき不良が3回続いた、のどれかに当てはまるペットです。行の「…」から 30日のまとめ を開けます。"
      actions={(
        <Button type="button" onClick={() => window.print()} disabled={!canPrint} title={canPrint ? 'ブラウザの印刷で PDF に保存します' : '一覧の行の「…」から「30日のまとめ」を開くと書き出せます'}>
          <FileText size={16} aria-hidden="true" />獣医師向け PDF を書き出す
        </Button>
      )}
      tabs={tabs}
      stats={stats}
      overlays={summaryPetId !== null ? (
        <SummaryDrawerV8 status={summaryStatus} summary={activeSummary} weightWarn={summaryWeightWarn} error={summaryError} onClose={closeSummary} onRetry={() => void loadSummary()} onPrint={() => window.print()} />
      ) : null}
    >
      {!accountId ? (
        <ListState kind="empty" title="LINEアカウントを選んでください" description="上のバーから、記録を見るLINEアカウントを選びます。" />
      ) : tab === 'items' ? (
        <HealthItemsV8 />
      ) : (
        <HealthListV8
          key={`${accountId}-${tab}`}
          accountId={accountId}
          concernOnly={tab === 'concern'}
          filters={filters}
          onFiltersChange={setFilters}
          onKpis={setKpis}
          onKpisFailed={setKpisFailed}
          onOpenSummary={(petId, weightWarn) => { setSummaryWeightWarn(weightWarn); setSummaryPetId(petId) }}
          onOpenPdf={(petId, weightWarn) => { setSummaryWeightWarn(weightWarn); setPrintPetId(petId); setSummaryPetId(petId) }}
        />
      )}
      {canPrint && activeSummary ? <SummarySheet summary={activeSummary} /> : null}
    </ListPage>
  )
}

/**
 * 記録のあるペット／気になる変化。
 * 案内の帯 → 道具の段（探す・よく使う札3つ・よく使う絞り込み・件数）→ 表 → 件数 → ヒント。
 */
function HealthListV8({
  accountId,
  concernOnly,
  filters,
  onFiltersChange,
  onKpis,
  onKpisFailed,
  onOpenSummary,
  onOpenPdf,
}: {
  accountId: string
  concernOnly: boolean
  filters: HealthFilters
  onFiltersChange: (next: HealthFilters) => void
  onKpis: (kpis: NenHealthKpis) => void
  onKpisFailed: (failed: boolean) => void
  onOpenSummary: (petId: string, weightWarn: boolean) => void
  /** 「獣医師向け PDF」：まとめを開き、読めたら印刷の窓を出す。 */
  onOpenPdf: (petId: string, weightWarn: boolean) => void
}) {
  const [status, setStatus] = useState<ListStatus>('loading')
  const [data, setData] = useState<NenHealthListData | null>(null)
  const [draft, setDraft] = useState(filters.q)
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [savedOpen, setSavedOpen] = useState(false)
  const savedRef = useRef<HTMLSpanElement | null>(null)
  const requestRef = useRef(0)
  const change = concernOnly ? 'concern' : filters.change

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setStatus('loading')
    onKpisFailed(false)
    try {
      const res = await nenPetsApi.health(accountId, { q: filters.q, change, last: filters.last, sort: filters.sort, page, pageSize })
      if (request !== requestRef.current) return
      if (!res.success) throw new Error(res.error)
      setData(res.data)
      onKpisFailed(false)
      onKpis(res.data.kpis)
      setStatus('ready')
    } catch (caught) {
      if (request !== requestRef.current) return
      onKpisFailed(true)
      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [accountId, filters.q, change, filters.last, filters.sort, page, pageSize, onKpis, onKpisFailed])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * WEB223：探す言葉が外から変わったとき（数の帯の「すべてのペットを出す」など）は、欄の中身も合わせる。
   * 合わせないと、0.3秒後に欄に残った前の言葉がまた当たる。打っている間（欄＝条件）は触らない。
   */
  useEffect(() => {
    setDraft((current) => (current.trim() === filters.q ? current : filters.q))
  }, [filters.q])

  // 探す欄は打ち終わってから（0.3秒）取り直す。

  const set = (patch: Partial<HealthFilters>) => { onFiltersChange({ ...filters, ...patch }); setPage(1) }
  const filtering = filters.q !== '' || (!concernOnly && filters.change !== '') || filters.last !== ''
  const clear = () => { onFiltersChange({ ...filters, q: '', change: '', last: '' }); setDraft(''); setPage(1) }
  const kpis = data?.kpis

  const savedItems: ActionMenuItem[] = [
    ...(concernOnly ? [] : [
      { id: 'none', label: '変化なしのペット', onSelect: () => set({ change: 'none' }) },
    ]),
    { id: 'last30', label: '30日以内に記録あり', onSelect: () => set({ last: '30' }) },
    { id: 'over30', label: '最後の記録が30日より前', onSelect: () => set({ last: 'over30' }) },
    ...([
      ['concern', '並び：気になる順'],
      ['recent', '並び：最終記録が新しい順'],
      ['records_desc', '並び：30日の記録が多い順'],
    ] as Array<[NenHealthSort, string]>).map(([value, label], index) => ({
      id: `sort-${value}`, label: filters.sort === value ? `${label}（いま）` : label, sectionBefore: index === 0 ? '並び' : undefined, onSelect: () => set({ sort: value }),
    })),
    ...(filtering ? [{ id: 'clear', label: '絞り込みを外す', dividerBefore: true, onSelect: clear }] : []),
  ]

  return (
    <>


      <ListToolbarRow data-design="ListControls">
        <ListToolbarSearchSlot>
          <SearchField aria-label="ペットを探す" placeholder="ペットを探す" value={draft} onChange={(value: string) => { setDraft(value); onFiltersChange({ ...filters, q: value.trim() }); setPage(1) }} onClear={() => { setDraft(''); onFiltersChange({ ...filters, q: '' }); setPage(1) }} />
        </ListToolbarSearchSlot>
        {concernOnly ? null : (
          <span className={styles.chips} role="group" aria-label="よく使う絞り込み">
            <SegmentedControl<HealthFilters['change']> aria-label="記録の変化" fit="content" value={filters.change} onClear={() => set({ change: '' })} onChange={(value) => set({ change: value })} options={[
              { value: '', label: 'すべて' },
              { value: 'concern', label: '気になる変化', count: kpis?.concerning, title: '体重の±10%の変化・便の異常・食いつき不良が3回続いたペットだけ出します' },
              { value: 'silent', label: '30日 記録なし', count: kpis?.silent30, title: '30日以上 記録のないペットだけ出します' },
            ]} />
            <FilterChip selected={filters.last === '7'} onChange={(next) => set({ last: next ? '7' : '' })} icon={<CalendarDays size={16} aria-hidden="true" />} title="7日以内に記録が付いたペットだけ出します">
              今週 記録あり
            </FilterChip>
          </span>
        )}
        <ListToolbarEnd>
          <span ref={savedRef} className={styles.savedBox}>
            <Button type="button" aria-haspopup="menu" aria-expanded={savedOpen} onClick={() => setSavedOpen((current) => !current)}>
              <Bookmark size={16} aria-hidden="true" />よく使う絞り込み
            </Button>
            <ActionMenu
              open={savedOpen}
              onClose={() => setSavedOpen(false)}
              anchorRef={savedRef}
              ariaLabel="よく使う絞り込み"
              items={savedItems.map((item) => ({ ...item, onSelect: () => { setSavedOpen(false); item.onSelect?.() } }))}
            />
          </span>
          <SaveErrorField names={["pageSize","page_size"]}><Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size}件表示` }))} /></SaveErrorField>
        </ListToolbarEnd>
      </ListToolbarRow>

      {status === 'loading' && !data ? (
        <ListState kind="loading" title="健康日記を読み込んでいます" />
      ) : status === 'forbidden' ? (
        <ListState kind="forbidden" onRetry={() => void load()} />
      ) : status === 'error' ? (
        <ListState kind="error" title="健康日記を読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={() => void load()} />
      ) : data && data.items.length === 0 ? (
        filtering ? (
          <ListState kind="empty" title="条件に合うペットはいません" description="検索や絞り込みを外すと、すべて出ます。" action={<Button onClick={clear}>条件を外す</Button>} />
        ) : concernOnly ? (
          <ListState kind="empty" emptyPreset="readonly" title="気になる変化はありません" description="体重が8週で±10%、便の異常や食いつき不良が3回続くと、ここに並びます。" />
        ) : (
          <ListState kind="empty" emptyPreset="readonly" title="まだ記録がありません" description="お客さまがマイページで健康日記を付けると、ここに並びます。" />
        )
      ) : data ? (
        <>
          <DataTable className={styles.table}>
            <thead>
              <TableHeadRow className={styles.headRow} data-table-layout="columns">
                <Th className={styles.colPet}>ペット</Th>
                <Th className={styles.colOwner}>飼い主</Th>
                <Th className={styles.colLast}>最終記録</Th>
                <Th className={styles.colCount}>30日の記録</Th>
                <Th className={styles.colWeight}>体重の推移（8週）</Th>
                <Th className={styles.colStool}>便・食いつき</Th>
                <Th className={styles.colChange}>気になる変化</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <HealthRow key={row.pet.id} row={row} onOpenSummary={onOpenSummary} onOpenPdf={onOpenPdf} />
              ))}
            </tbody>
          </DataTable>
          <div className={styles.pagerRow}>
            <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} onPageChange={setPage} range={{ total: data.total, first: (data.page - 1) * data.pageSize + 1, last: Math.min(data.total, data.page * data.pageSize) }} />
          </div>
          <p className={styles.hint}>行の「…」から 30日のまとめ・獣医師向け PDF・飼い主にトークで声をかける。</p>
        </>
      ) : null}
    </>
  )
}

function HealthRow({ row, onOpenSummary, onOpenPdf }: { row: NenHealthRow; onOpenSummary: (petId: string, weightWarn: boolean) => void; onOpenPdf: (petId: string, weightWarn: boolean) => void }) {
  const router = useRouter()
  const kind = petAnimalTypeLabel(row.pet.animalType)
  const name = row.pet.name || row.pet.callName || '（名前なし）'
  const kindLine = row.pet.breed ? `${kind}・${row.pet.breed}` : kind
  const weightWarn = row.changes.some((c) => c.key === 'weight_drop' || c.key === 'weight_gain')
  const friendId = encodeURIComponent(row.owner.friendId)
  const items: ActionMenuItem[] = [
    { id: 'summary', label: '30日のまとめ', onSelect: () => onOpenSummary(row.pet.id, weightWarn) },
    /* 1匹の PDF は「30日のまとめ」を開いてから印刷する（開いた引き出しの「印刷・PDF に保存する」）。 */
    { id: 'pdf', label: '獣医師向け PDF', onSelect: () => onOpenPdf(row.pet.id, weightWarn) },
    { id: 'owner', label: '飼い主を開く', external: false, href: `/friends/detail?id=${friendId}`, onSelect: () => { router.push(`/friends/detail?id=${friendId}`) } },
    { id: 'talk', label: '飼い主にトークで声をかける', external: false, href: `/chats?friend=${friendId}`, onSelect: () => { router.push(`/chats?friend=${friendId}`) } },
  ]
  return (
    <Tr className={styles.row} data-table-layout="columns">
      <Td className={styles.colPet}>
        <span className={styles.petCell}>
          {row.pet.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- お客様がマイページで登録した写真
            <img width={28} height={28} src={row.pet.imageUrl} alt="" className={styles.face} />
          ) : (
            <span aria-hidden="true" className={styles.face}>{name.slice(0, 1)}</span>
          )}
          <span className={styles.stack}>
            <span className={styles.nameText} title={row.pet.callName || name}>{name}</span>
            <span className={styles.sub} title={row.pet.ageLabel === '—' ? kindLine : `${kindLine}・${row.pet.ageLabel}`}>{kindLine}</span>
          </span>
        </span>
      </Td>
      <Td className={styles.colOwner}><span className={styles.cell} title={row.owner.name}>{row.owner.name || '（名前なし）'}</span></Td>
      <Td className={styles.colLast}><span className={styles.cell} title={row.lastLoggedLabel}>{row.lastLoggedOn ? md(row.lastLoggedOn) : emptyValue('unknown')}</span></Td>
      <Td className={styles.colCount}><span className={styles.num}>{`${row.count30d} 日`}</span></Td>
      <Td className={styles.colWeight}><WeightBars series={row.weightSeries} warn={weightWarn} /></Td>
      <Td className={styles.colStool}><span className={styles.cell}>{row.latestStool && row.latestAppetite ? `${row.latestStool}・${row.latestAppetite}` : emptyValue('unknown')}</span></Td>
      <Td className={styles.colChange}>
        <span className={styles.badges}>
          {changeBadges(row).map((badge) => <Pill key={badge.key} tone={badge.tone} title={badge.detail}>{badge.label}</Pill>)}
        </span>
      </Td>
      <Td className={styles.colMenu}><RowMenu subject={name} items={items} /></Td>
    </Tr>
  )
}
