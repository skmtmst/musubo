'use client'
import { DetailContent } from '@/components/shared/detail-content'
import DetailActions from '@/components/shared/detail-actions'

import HeatmapTable from '@/components/shared/heatmap-table'
import { ListToolbarRow } from '@/components/shared/list-toolbar'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CustomerSegments } from '@line-crm/shared'
import { ListPageSection } from '@/components/templates/list-page'
import Button from '@/components/shared/button'
import Drawer from '@/components/shared/drawer'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifySaved } from '@/components/shared/toast'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { customerSegmentsApi } from '@/lib/api/helpers/gap3'
import { formatNumber } from '@/lib/format'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import styles from './segments.module.css'

/*
 * ★V8 分析「深く見る」の「お客さまの分け方」（G5-1 `RMajm`）。
 * 縦＝最後の来店・購入の日、横＝回数（または金額）の 5×5。マスに名前と人数。押すと右の引き出しで人の一覧。
 * 5×5 と「表の外（来店・購入なし）」の合計が全員。毎朝 4 時以降に作り直す控えを読む。
 * CSV の書き出しは受け口がまだ無いので、形を残して「現在準備中です」を出す。
 */

type Basis = 'both' | 'visit' | 'purchase'
type Measure = 'count' | 'amount'
type Cell = CustomerSegments['cells'][number]

const R_LABEL = ['30 日以内', '60 日以内', '90 日以内', '180 日以内', 'それより前']
const R_RANGE = ['30 日以内', '31〜60 日前', '61〜90 日前', '91〜180 日前', '181 日以上前']
const F_LABEL: Record<Measure, string[]> = {
  count: ['1 回', '2 回', '3〜4 回', '5〜9 回', '10 回以上'],
  amount: ['金額の下位 20%', '21〜40%', '41〜60%', '61〜80%', '上位 20%'],
}
const BASIS_WORD: Record<Basis, string> = { both: '来店・購入', visit: '来店', purchase: '購入' }
const BASIS_OPTIONS: Array<{ value: Basis; label: string }> = [
  { value: 'both', label: '来店と購入をまとめて数える' },
  { value: 'visit', label: '来店だけ' },
  { value: 'purchase', label: '購入だけ' },
]
const MEASURE_OPTIONS: Array<{ value: Measure; label: string }> = [
  { value: 'count', label: '回数で見る' },
  { value: 'amount', label: '金額で見る' },
]

type Friend = { id: string; display_name: string | null; activity_count: number; amount: number; last_activity_at?: string | null }
type FriendsPage = { items: Friend[]; total: number; optedOutCount: number; nextCursor: string | null }
type Pick = { r: number; f: number }

const md = (value?: string | null) => (value ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '—')

/** 人数の多さを 0〜4 の濃さにする（最大のマスを 4）。 */
function levelOf(count: number | null, max: number): number {
  if (!count || max <= 0) return 0
  const ratio = count / max
  return ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1
}

export default function SegmentsV8({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const router = useRouter()
  const preparing = usePreparingDialog()
  const [basis, setBasis] = useState<Basis>('both')
  const [measure, setMeasure] = useState<Measure>('count')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [actionError, setActionError] = useState('')
  const [data, setData] = useState<CustomerSegments | null>(null)
  const [pick, setPick] = useState<Pick | null>(null)
  useEffect(() => setActionError(''), [pick])

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const response = await customerSegmentsApi.get(accountId, basis, measure)
      if (!response.success) throw new Error('segments_failed')
      setData(response.data)
      setStatus('ready')
    } catch (reason) {
      setError(reason)
      setStatus('error')
    }
  }, [accountId, basis, measure])

  useEffect(() => { void load() }, [load])

  const max = useMemo(() => Math.max(0, ...(data?.cells ?? []).map((cell) => cell.count ?? 0)), [data])
  const cellAt = (r: number, f: number): Cell | undefined => data?.cells.find((cell) => cell.r === r && cell.f === f)

  if (status === 'loading' && !data) return <ListPageSection><ListState kind="loading" title="お客さまの分け方を読み込んでいます" /></ListPageSection>
  if (status === 'error') return <ListPageSection><ListState kind="error" error={error} onRetry={() => void load()} /></ListPageSection>
  if (!data) return null

  const notComputed = data.status === 'not_computed' || data.computedAt === null
  const outside = data.outside.count

  return (
    <ListPageSection><section className={styles.panel} aria-label="お客さまの分け方">
      {notComputed ? (
        <Notice tone="info" message="まだ集計していません。毎朝 4 時以降に、前の日までの来店・購入から作ります。" />
      ) : data.status !== 'ready' ? (
        <Notice tone="warn" message="今朝の集計に失敗しました。昨日までの数を出しています。" />
      ) : null}
      <div className={styles.summary}>
        <span>
          <span className={styles.summaryStrong}>{`全員 ${data.total === null ? '—' : formatNumber(data.total)} 人`}</span>
          {outside === null ? '' : `（${BASIS_WORD[basis]}なし ${formatNumber(outside)} 人は表の外）`}
        </span>
        <Button variant="secondary" onClick={() => setPick({ r: 0, f: 0 })} disabled={notComputed}>全員を見る</Button>
      </div>
      <ListToolbarRow>
        <SegmentedControl aria-label="数える物" options={BASIS_OPTIONS} value={basis} onChange={(next) => { setPick(null); setBasis(next) }} />
        <SegmentedControl aria-label="見る数" options={MEASURE_OPTIONS} value={measure} onChange={(next) => { setPick(null); setMeasure(next) }} />
      </ListToolbarRow>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>RFM の表</h3>
          <HelpTip label="RFM の表の説明">縦は最後に来店・購入した日、横は{measure === 'count' ? '来店・購入した回数' : '合計金額の順位'}です。直近 1 年を数えます。マスを押すと、その人たちを見{canManage ? 'て LINE を送れます' : 'られます'}。</HelpTip>
          <span className={styles.cardNote}>濃いほど人が多い</span>
        </div>
        <HeatmapTable label="お客さまの分け方の表" columns={F_LABEL[measure]}
          rows={R_LABEL.map((label, row) => ({ key: String(row + 1), label, cells: [1, 2, 3, 4, 5].map(f => { const cell = cellAt(row + 1, f); return { key: String(f), name: cell?.name ?? '—', count: cell?.count ?? null } }) }))}
          selected={pick ? `${pick.r}:${pick.f}` : undefined} onSelect={(r, f) => setPick({ r: Number(r), f: Number(f) })} />
      </div>
      <Drawer
        open={pick !== null && !notComputed}
        title={pick ? pickTitle(pick, data, cellAt) : ''}
        description={pick ? pickRange(pick, basis, measure) : undefined}
        closeAppearance="box"
        heightMode="viewport"
        onClose={() => setPick(null)}
        band={actionError ? <Notice tone="danger" message={actionError} /> : undefined}
        footerLayout="actions"
        footer={pick ? <PickFooterHost onFailure={setActionError} accountId={accountId} pick={pick} basis={basis} measure={measure} data={data} cellAt={cellAt} canManage={canManage} onPrepare={preparing.open} onOpenBroadcast={(condition) => router.push(`/broadcasts/new?condition=${encodeURIComponent(JSON.stringify(condition))}`)} /> : undefined}
      >
<DetailContent>
        {pick ? <PickBody accountId={accountId} pick={pick} basis={basis} measure={measure} /> : null}

</DetailContent>
</Drawer>
      {preparing.dialog}
    </section></ListPageSection>
  )
}

function pickTitle(pick: Pick, data: CustomerSegments, cellAt: (r: number, f: number) => Cell | undefined): string {
  if (pick.r === 0) return `全員 ${data.total === null ? '—' : formatNumber(data.total)} 人`
  const cell = cellAt(pick.r, pick.f)
  return `${cell?.name ?? ''} ${cell?.count === null || cell?.count === undefined ? '' : `${formatNumber(cell.count)} 人`}`.trim()
}

function pickRange(pick: Pick, basis: Basis, measure: Measure): string {
  if (pick.r === 0) return '来店・購入のない人も含めた、すべてのお客さまです。'
  const word = BASIS_WORD[basis]
  return `最後の${word}が ${R_RANGE[pick.r - 1]}・${measure === 'count' ? `${word} ${F_LABEL.count[pick.f - 1]}` : `金額 ${F_LABEL.amount[pick.f - 1]}`}`
}

function PickBody({ accountId, pick, basis, measure }: { accountId: string; pick: Pick; basis: Basis; measure: Measure }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [page, setPage] = useState<FriendsPage | null>(null)
  const [more, setMore] = useState(false)

  const first = useCallback(async () => {
    setStatus('loading')
    try {
      const response = await customerSegmentsApi.friends(accountId, pick.r, pick.f, basis, measure)
      if (!response.success) throw new Error('friends_failed')
      setPage(response.data as FriendsPage)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [accountId, pick.r, pick.f, basis, measure])

  useEffect(() => { void first() }, [first])

  const loadMore = async () => {
    if (!page?.nextCursor) return
    setMore(true)
    try {
      const response = await customerSegmentsApi.friends(accountId, pick.r, pick.f, basis, measure, page.nextCursor)
      if (!response.success) throw new Error('friends_failed')
      const next = response.data as FriendsPage
      setPage({ ...next, items: [...page.items, ...next.items] })
    } catch {
      setStatus('error')
    } finally {
      setMore(false)
    }
  }

  if (status === 'loading') return <ListState kind="loading" title="お客さまを読み込んでいます" />
  if (status === 'error' || !page) return <ListState kind="error" onRetry={() => void first()} />
  return (
    <div className={styles.drawerBody}>
      <DataTable>
        <thead>
          <TableHeadRow>
            <Th grow>お客さま</Th>
            <Th>最後の来店・購入</Th>
            <Th align="right">回数</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {page.items.map((friend) => (
            <Tr key={friend.id}>
              <Td grow><span className={styles.nameCell}>{friend.display_name || '（名前なし）'}</span></Td>
              <Td>{md(friend.last_activity_at)}</Td>
              <Td align="right">{`${formatNumber(friend.activity_count)} 回`}</Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>
      {page.nextCursor ? (
        <Button variant="secondary" onClick={() => void loadMore()} busy={more}>{`ほか ${formatNumber(page.total - page.items.length)} 人を見る`}</Button>
      ) : null}
      <p className={styles.mute}>{`宣伝を止めている人 ${formatNumber(page.optedOutCount)} 人（LINE を送るときは除きます）`}</p>
    </div>
  )
}

/** 下の操作。人数は一覧と同じ控えから読む。 */
function PickFooterHost({ onFailure, accountId, pick, basis, measure, data, cellAt, canManage, onPrepare, onOpenBroadcast }: {
  onFailure: (message: string) => void
  accountId: string
  pick: Pick
  basis: Basis
  measure: Measure
  data: CustomerSegments
  cellAt: (r: number, f: number) => Cell | undefined
  canManage: boolean
  onPrepare: (feature: string) => void
  onOpenBroadcast: (condition: unknown) => void
}) {
  const [busy, setBusy] = useState(false)
  const setMessage = onFailure
  const errors = useSaveFormErrors()
  const total = pick.r === 0 ? data.total : cellAt(pick.r, pick.f)?.count ?? null
  const whole = pick.r === 0
  const cell = whole ? null : cellAt(pick.r, pick.f)
  const name = whole ? '全員' : cell?.name ?? ''

  const condition = whole
    ? null
    : { operator: 'AND', rules: [{ type: 'customer_segment', value: { r: pick.r, f: pick.f, basis, measure } }] }

  const saveSearch = async () => {
    if (whole) return
    setBusy(true)
    setMessage('')
    try {
      const response = await customerSegmentsApi.saveSearch(accountId, pick.r, pick.f, { name: `${name}（${BASIS_WORD[basis]}）`, basis, measure })
      if (!response.success) throw new Error('save_failed')
      notifySaved('保存した検索にしました。友だち一覧の「保存した検索」から開けます。')
    } catch (reason) {
      if (!errors.capture(reason)) setMessage('保存した検索にできませんでした。時間をおいてもう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={errors}><>
      <DetailActions
        secondary={<Button variant="secondary" onClick={() => onPrepare('CSVの書き出し')}>CSVで書き出す</Button>}
        primaryAllowed={canManage} primary={!whole ? <Button variant="primary" disabled={total === null || total === 0} disabledReason={total === null ? '人数を確認できません' : total === 0 ? '送る相手がいません' : undefined} onClick={() => condition && onOpenBroadcast(condition)}>{`この ${total === null ? '' : formatNumber(total)} 人に LINE を送る`}</Button> : null}
        menuItems={!whole ? [{ allowed: canManage, id: 'save-search', label: '保存した検索にする', disabled: busy, onSelect: () => void saveSearch() }] : []}
      />
    </></SaveErrorScope>
  )
}
