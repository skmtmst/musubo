'use client'

import { FolderDotName } from '@/components/shared/folder-dot'
import { RowNameLink } from '@/components/shared/table'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useFeatureAccess } from '@/lib/use-feature-access'
import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, CircleCheck, CircleSlash, Download, History, LogOut, Undo2 } from 'lucide-react'
import { ListPageBody, ListPagePagination } from '@/components/templates'
import { PageFrame } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import ListToolbar, { ListToolbarFrame } from '@/components/shared/list-toolbar'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import PageSizeSelect from '@/components/shared/page-size-select'
import Pagination from '@/components/shared/pagination'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import StatusBadge from '@/components/shared/status-badge'
import { RowMenu } from '@/components/shared/row-actions'
import {
  ApiError,
  downloadApiFile,
  webinarApi,
  type WebinarParticipantClassification,
  type WebinarParticipantPage,
} from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { DetailHead } from './chrome'
import {
  PARTICIPANTS_PAGE_SIZE,
  actionBadge,
  fmtJaDuration,
  fmtSec,
  joinKindLabel,
  joinNote,
  participantStateLabel,
  percent,
  shortDateTime,
  thisMonthReservations,
} from './helpers'
import type { DetailChrome, EditContext } from './types'
import styles from './participants.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'

/*
 * ★V8 ウェビナーの参加者（Pencil ）。
 * 頭（戻る・題・説明・CSV）→ タブ → 数の帯 → 案内の帯 → 道具の段 → 表 → ページ送り。
 * 口・権限・失敗の扱いは BEHAVIOR.md に記録。
 */

type LoadState = 'loading' | 'ready' | 'error' | 'denied'

const SAVED_OPTIONS: Array<{ value: '' | WebinarParticipantClassification; label: string }> = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'unviewed', label: '見ていない（申込のみ）' },
  { value: 'dropped_off', label: '途中で離れた' },
  { value: 'completed', label: '視聴完了' },
  { value: 'unmeasured', label: '計測外' },
]

export default function ParticipantsPane({ ctx, chrome }: { ctx: EditContext; chrome: DetailChrome }) {
  const { webinar, analytics, analyticsState } = ctx
  const [items, setItems] = useState<WebinarParticipantPage['items']>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [filter, setFilter] = useListUrlValue<'' | WebinarParticipantClassification>('filter', '')
  const [rule, setRule] = useState<WebinarParticipantPage['rule'] | null>(null)
  const [measurement, setMeasurement] = useState<WebinarParticipantPage['measurement'] | null>(null)
  const canExport = useFeatureAccess('webinars', 'export')
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvError, setCsvError] = useState('')
  const [query, setQuery] = useListUrlValue('q', '')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)
  const generation = useRef(0)
  const participantsLoadingRef = useRef(false)
  const csvLock = useRef(false)
  const moreLock = useRef(false)

  const retryParticipants = useCallback(() => {
    if (participantsLoadingRef.current) return
    participantsLoadingRef.current = true
    setAttempt((count) => count + 1)
  }, [])

  const downloadCsv = useCallback(() => {
    if (!canExport || csvLock.current) return
    csvLock.current = true
    const request = generation.current
    setCsvBusy(true)
    setCsvError('')
    void downloadApiFile(webinarApi.participantsCsvUrl(webinar.id, filter || undefined), csvFileName("動画セミナー参加者"))
      .catch(() => { if (request === generation.current) setCsvError('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。') })
      .finally(() => { csvLock.current = false; setCsvBusy(false) })
  }, [webinar.id, filter, canExport])

  useEffect(() => {
    let cancelled = false
    generation.current += 1
    participantsLoadingRef.current = true
    moreLock.current = false
    setLoadingMore(false)
    setRule(null)
    setMeasurement(null)
    setCsvError('')
    setState('loading')
    setItems([])
    setNextCursor(null)
    setMoreError('')
    setPage(1)
    /* 個人の参加履歴はオーナー・管理者だけの口。staff には 403 が返るので「見られない」とだけ覚え、集計は出し続ける。 */
    webinarApi
      .participants(webinar.id, undefined, PARTICIPANTS_PAGE_SIZE, filter || undefined)
      .then((res) => {
        if (cancelled) return
        participantsLoadingRef.current = false
        setItems(res.data.items)
        setNextCursor(res.data.nextCursor)
        setRule(res.data.rule ?? null)
        setMeasurement(res.data.measurement ?? null)
        setState('ready')
      })
      .catch((cause) => {
        if (cancelled) return
        participantsLoadingRef.current = false
        setState(cause instanceof ApiError && cause.status === 403 ? 'denied' : 'error')
      })
    return () => {
      cancelled = true
      participantsLoadingRef.current = false
      generation.current += 1
    }
  }, [webinar.id, attempt, filter])

  /* サーバーが nextCursor を返す限り、次の頁を読み足せる。重複は friendId で除く。 */
  const loadMore = async (): Promise<void> => {
    if (!nextCursor || moreLock.current) return
    moreLock.current = true
    const request = generation.current
    setLoadingMore(true)
    setMoreError('')
    try {
      const res = await webinarApi.participants(webinar.id, nextCursor, PARTICIPANTS_PAGE_SIZE, filter || undefined)
      if (request !== generation.current) return
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.friendId))
        return [...prev, ...res.data.items.filter((item) => !seen.has(item.friendId))]
      })
      setNextCursor(res.data.nextCursor)
      setRule(res.data.rule ?? null)
      setMeasurement(res.data.measurement ?? null)
    } catch {
      if (request !== generation.current) return
      setMoreError('続きを読み込めませんでした。もう一度お試しください。')
    } finally {
      if (request === generation.current) { moreLock.current = false; setLoadingMore(false) }
    }
  }

  const summary = analytics?.summary ?? null
  const analyticsError = analyticsState === 'error'
  const analyticsLoading = analyticsState === 'loading' || (!analytics && !analyticsError)
  const analyticsStatusDetail = analyticsError ? '読み込めませんでした' : analyticsLoading ? '読み込んでいます' : null
  const unviewed = summary && !analyticsError ? Math.max(0, summary.reservations - summary.registeredAndJoined) : null
  const dropped = summary && !analyticsError ? Math.max(0, summary.viewers - summary.completed) : null
  const searched = query.trim() === '' ? items : items.filter((item) => (item.friendName ?? '').includes(query.trim()))
  const pageCount = Math.max(1, Math.ceil(searched.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageItems = searched.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const from = searched.length === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const to = Math.min(searched.length, currentPage * pageSize)

  const kpis = [
    { key: 'reservations', title: '申込', icon: History, value: analyticsError ? null : (summary?.reservations ?? null), unit: '人', detail: summary && !analyticsError ? `今月 +${formatNumber(thisMonthReservations(analytics?.daily ?? []))}` : (analyticsStatusDetail ?? emptyValue('unknown')), help: '申し込んだ人の数です。今月の数はサーバーの集計日（UTC）を基準にしています。' },
    { key: 'completed', title: '視聴完了', icon: CircleCheck, value: analyticsError ? null : (summary?.completed ?? null), unit: '人', detail: summary && !analyticsError ? `申込の ${percent(summary.completed, summary.reservations)}` : (analyticsStatusDetail ?? emptyValue('unknown')), help: '動画の9割以上を見た人です。' },
    { key: 'dropped', title: '途中で離れた', icon: LogOut, value: dropped, unit: '人', detail: analyticsStatusDetail ?? '平均離脱時間 —', help: '入場した人から、視聴完了の人を引いた数です。途中で離れた人だけの平均離脱時間は、まだ数えていません。' },
    { key: 'unviewed', title: '見ていない', icon: Undo2, value: unviewed, unit: '人', detail: analyticsStatusDetail ?? '見逃し案内の対象', help: '申し込んだが入場の記録がない人です。' },
  ]

  const chips: Array<{ key: WebinarParticipantClassification; label: string; count: number | null; icon: typeof CircleCheck }> = [
    { key: 'completed', label: '視聴完了', count: analyticsError ? null : (summary?.completed ?? null), icon: CircleCheck },
    { key: 'dropped_off', label: '途中で離れた', count: dropped, icon: LogOut },
    { key: 'unviewed', label: '見ていない', count: unviewed, icon: CircleSlash },
  ]

  let body
  if (state === 'denied') {
    body = <ListState kind="forbidden" title="個人の参加履歴はオーナーと管理者だけが確認できます" description="友だちごとの視聴・申込の記録を出す権限がないため、表は出せません。集計は上の数と「分析」で確認できます。" />
  } else if (state === 'loading') {
    body = <ListState kind="loading" title="参加者を読み込んでいます" />
  } else if (state === 'error') {
    body = <ListState kind="error" title="参加者の一覧を読み込めませんでした" description="通信を確認して、もう一度読み込んでください。" onRetry={retryParticipants} />
  } else if (pageItems.length === 0) {
    body = <ListState kind="empty" emptyPreset={filter || query.trim() ? 'filtered' : 'readonly'} title={filter || query.trim() !== '' ? 'この条件に当てはまる人はいません' : 'まだ参加者はいません'} action={filter || query.trim() ? <Button onClick={() => { setFilter(''); setQuery(''); setPage(1) }}>条件を外す</Button> : undefined} />
  } else {
    body = (
      <DataTable columnLayout={{ headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--tpl-wb-col-gap)', padding: '0 var(--tpl-list-inset)' }} aria-label="参加者一覧">
        <thead>
          <TableHeadRow data-table-layout="columns">
            <Th grow>参加者</Th>
            <Th className={styles.colWhen}>最終参加</Th>
            <Th className={styles.colWatch}>視聴</Th>
            <Th className={styles.colAction}>アクション</Th>
            <Th className={styles.colDetail}>詳細</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {pageItems.map((participant) => {
            const name = participant.friendName ?? '名前未取得'
            const rate = Math.min(100, Math.round((participant.maxWatchedSeconds / Math.max(1, webinar.durationSeconds)) * 100))
            const badge = actionBadge(participant)
            return (
              <Tr data-row-id={participant.friendId} key={participant.friendId} data-table-layout="columns" href={`/friends/detail?id=${encodeURIComponent(participant.friendId)}`}>
                <Td grow><FolderDotName>
                  <RowNameLink href={`/friends/detail?id=${encodeURIComponent(participant.friendId)}`} title={name}>{name}</RowNameLink>

                </FolderDotName></Td>
                <Td className={styles.colWhen}><span className={styles.main} title={[joinNote(participant), joinKindLabel(participant)].filter(Boolean).join("・")}>{shortDateTime(participant.latestJoinedAt)}</span></Td>
                <Td className={styles.colWatch}>
                  <span className={styles.main}>{participant.maxWatchedSeconds > 0 ? `${fmtJaDuration(participant.maxWatchedSeconds)}（${rate}%）` : emptyValue('unknown')}</span>
                  <TruncatedText className={styles.sub} value={participantStateLabel(participant, webinar.durationSeconds)} />
                </Td>
                <Td className={styles.colAction}>
                  <StatusBadge tone={badge.done ? 'success' : 'neutral'}>{badge.label}</StatusBadge>
                </Td>
                <ActionCell className={styles.colDetail}>
                  <RowMenu label={`${name}の操作`} items={[{ id: 'open-chat', label: 'チャットを見る', href: `/chats?friend=${encodeURIComponent(participant.friendId)}` }]} />
                </ActionCell>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    )
  }

  const csvButton = canExport && state === 'ready'
    ? <Button onClick={downloadCsv} disabled={csvBusy} busy={csvBusy} busyLabel="書き出しています…"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>
    : null

  return (
    <PageFrame kind="list" boardId="uNsEy">
      <DetailHead {...chrome} current="participants" actions={csvButton} />
      <ListPageBody listHelpPlacement="end" listHelp={<> 名前から友だちの詳細、行の右端の「…」の「チャットを見る」からトークを開きます。
            {rule ? ` 視聴完了＝動画の9割（${fmtSec(rule.completionThresholdSeconds)}）以上を見た人。` : ''}
            {measurement?.state === 'unavailable' ? ` ${measurement.reason}。個人の分類は「計測外」になります。` : ''} </>}
        stats={<>
          {analyticsError ? (
            <div className={styles.statsNotice}>
              <Notice tone="info" action={<Button onClick={ctx.retryAnalytics} disabled={analyticsLoading} busy={analyticsLoading} busyLabel="読み込み中…">もう一度読み込む</Button>}>集計を読み込めませんでした。</Notice>
            </div>
          ) : null}
          <KpiBand>
            {kpis.map((kpi) => (
              <KpiCard key={kpi.key} presentation="band" title={kpi.title} icon={<kpi.icon size={16} aria-hidden="true" />} loading={analyticsLoading} value={kpi.value} unit={kpi.value === null ? '' : kpi.unit} detail={<span title={kpi.help}>{kpi.detail}</span>} detailLayout={analyticsStatusDetail ? 'single' : undefined} />
            ))}
          </KpiBand><Notice tone="info" icon={null} appearance="soft">「見ていない」は申込だけで入場の記録がない人です。「入場のみ」は入場したが再生を確かめられなかった人です。</Notice>
        </>}
        toolbar={<ListToolbarFrame>
          {csvError ? <Notice tone="danger">{csvError}</Notice> : null}
          <ListToolbar
            search={{ placeholder: '友だちの名前で探す', label: '友だちの名前で探す', width: 240, value: query, onChange: (value) => { setQuery(value); setPage(1) } }}
            filters={(
              <SegmentedControl
                aria-label="視聴の結果で絞り込む"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: '' as const, label: 'すべて' },
                  ...chips.map((chip) => ({ value: chip.key, label: chip.label, count: chip.count ?? undefined })),
                ]}
              />
            )}
            trailing={<>
              <Select size="content" icon={<Bookmark size={16} aria-hidden="true" />} aria-label="よく使う絞り込み" value={filter} onChange={(value) => setFilter(value as '' | WebinarParticipantClassification)} options={SAVED_OPTIONS} />
              <PageSizeSelect value={pageSize} onChange={(value) => { setPageSize(value); setPage(1) }} options={[10, 20, 50]} label={null} />
            </>}
          />
        </ListToolbarFrame>}
        pagination={<>
          {state === 'ready' && searched.length > 0 ? (
            <ListPagePagination>
              <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} ariaLabel="参加者一覧のページ送り" range={{ total: searched.length, first: from, last: to }} />
            </ListPagePagination>
          ) : null}
        </>}
      >
        {body}
        {state === 'ready' && (nextCursor || moreError) ? (
          <div className={styles.more}>
            {moreError ? <Notice tone="danger" className={styles.moreErrorNoticePlacement} >{moreError}</Notice> : null}
            {nextCursor ? <Button onClick={() => void loadMore()} disabled={loadingMore} busy={loadingMore} busyLabel="読み込み中…">続きを読み込む</Button> : null}
          </div>
        ) : null}
      </ListPageBody>
    </PageFrame>
  )
}
