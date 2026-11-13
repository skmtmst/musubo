'use client'

import { downloadCsv } from '@/components/shared/csv-download'
import { jstDate } from '@/lib/jst-datetime'
import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import ListToolbar from '@/components/shared/list-toolbar'
import PageSizeSelect from '@/components/shared/page-size-select'
import Select from '@/components/shared/select'
import SectionHeader from '@/components/shared/section-header'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { Tabs } from '@/components/shared/tabs'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { restaurantGoogleApi, type GoogleChangeStatus, type GoogleHistoryData, type GoogleHistoryKind, type GoogleHistoryResult } from '@/lib/restaurant-google-api'
import { errorMessage, formatStampFull } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import { formatNumber } from '@/lib/format'

const STATUS_LABEL: Record<GoogleChangeStatus, { label: string; tone: StatusBadgeTone }> = {
  draft: { label: 'まだ反映していません', tone: 'warning' },
  pending_confirm: { label: '反映確認中', tone: 'warning' },
  accepted: { label: '反映確認中', tone: 'warning' },
  applied: { label: '反映済み', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  conflict: { label: '変更競合', tone: 'danger' },
  cancelled: { label: '取り消し', tone: 'neutral' },
}

const KIND_LABEL: Record<string, string> = { special_hours: '営業時間', regular_hours: '営業時間', profile: 'プロフィール', photo: 'プロフィール', review_reply: '口コミ返信' }
const HISTORY_KINDS: Array<{ key: GoogleHistoryKind; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'hours', label: '営業時間' },
  { key: 'profile', label: 'プロフィール' },
  { key: 'review_reply', label: '口コミ返信' },
]

export function HistoryScreen({ accountId, initialResult, go }: { accountId: string; initialResult?: GoogleHistoryResult | null; go: GoogleNav }) {
  const requestVersion = useRef(0)
  const exportLock = useRef(false)
  const [kind, setKind] = useState<GoogleHistoryKind>('all')
  const [result, setResult] = useState<GoogleHistoryResult>(initialResult ?? 'all')
  const [days, setDays] = useState('30')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(20)
  const [data, setData] = useState<GoogleHistoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    try {
      const response = await restaurantGoogleApi.history(accountId, { kind, result, days: Number.parseInt(days, 10), q: applied || undefined, page, perPage })
      if (version === requestVersion.current) setData(response)
    } catch (err) {
      if (version === requestVersion.current) setError(errorMessage(err, '変更履歴を読み込めませんでした。'))
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [accountId, applied, days, kind, page, perPage, result])

  useEffect(() => { void load(); return () => { requestVersion.current += 1 } }, [load])
  useEffect(() => {
    if (search === applied) return
    const timer = setTimeout(() => { setApplied(search); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [applied, search])

  const exportCsv = async () => {
    if (exportLock.current || !data || data.total === 0) return
    exportLock.current = true
    setExporting(true)
    try {
      const rows: string[][] = [['日時', '内容', 'スタッフ', '種類', '結果', '備考']]
      for (let p = 1; p <= 25; p += 1) {
        const chunk = await restaurantGoogleApi.history(accountId, { kind, result, days: Number.parseInt(days, 10), q: applied || undefined, page: p, perPage: 100 })
        for (const e of chunk.changes) rows.push([e.createdAt, e.summary, e.staffName ?? '', KIND_LABEL[e.kind] ?? e.kind, STATUS_LABEL[e.status].label, e.error ?? ''])
        if (p * chunk.perPage >= chunk.total) break
      }
      const csv = `﻿${rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`
      downloadCsv(csv, `google-business-changes-${jstDate()}.csv`)
    } catch (err) {
      setError(errorMessage(err, 'CSVを書き出せませんでした。'))
    } finally {
      exportLock.current = false
      setExporting(false)
    }
  }

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1

  return (
    <>
      <SectionHeader title="変更履歴" description="このLINEアカウントの店舗に対して、Googleへ送った変更の記録です。Google側で直接行われた変更は含みません。"
        actions={<Button onClick={() => void exportCsv()} disabled={exporting || !data || data.total === 0} busy={exporting} busyLabel="書き出し中…">CSVで書き出す</Button>} />
      <Tabs size="compact" label="変更の種類" items={HISTORY_KINDS.map((k) => ({ label: k.label, count: data?.counts[k.key], current: kind === k.key, onClick: () => { setKind(k.key); setPage(1) } }))} />
      <ListToolbar search={{ placeholder: '内容で検索', label: '内容で検索', value: search, onChange: setSearch }} filters={<>
        <Select aria-label="結果で絞り込み" value={result} onChange={(value) => { setResult(value as GoogleHistoryResult); setPage(1) }} options={[{ value: 'all', label: '結果：すべて' }, { value: 'applied', label: '反映済み' }, { value: 'pending', label: '反映確認中' }, { value: 'failed', label: '失敗・取り消し' }]} />
        <Select size="page-size" aria-label="期間" value={days} onChange={(value) => { setDays(value); setPage(1) }} options={[{ value: '7', label: '期間：7日' }, { value: '30', label: '期間：30日' }, { value: '90', label: '期間：90日' }, { value: '365', label: '期間：1年' }]} />
      </>} trailing={<PageSizeSelect value={perPage} onChange={(next) => { setPerPage(next); setPage(1) }} />} />
      {loading && !data ? <ListState kind="loading" title="変更履歴を読み込んでいます" /> : null}
      {error ? <ListState kind="error" title="変更履歴を表示できませんでした" description={error} onRetry={() => void load()} /> : null}
      {data && data.total === 0 && !loading ? <ListState kind="empty" title="この期間の記録はありません" description="Googleへ送った変更（営業時間・プロフィール・口コミ返信）がここに残ります。" emptyPreset="readonly" /> : null}
      {data && data.total > 0 ? <Card appearance="outlined" padding="none">
        <DataTable label="変更履歴" density="records">
          <thead><TableHeadRow><Th truncate>日時</Th><Th truncate grow>内容</Th><Th truncate>スタッフ</Th><Th truncate>種類</Th><Th truncate>結果</Th></TableHeadRow></thead>
          <tbody>{data.changes.map((entry) => {
            const status = STATUS_LABEL[entry.status]
            const open = entry.changeId ? () => go({ tab: 'profile', view: 'confirm', id: entry.changeId! }) : undefined
            return <Tr key={entry.id} onOpen={open} aria-label={entry.summary}>
              <Td title={formatStampFull(entry.createdAt)}>{formatStampFull(entry.createdAt)}</Td>
              <Td grow><TruncatedText value={entry.summary} /></Td>
              <Td><TruncatedText value={entry.staffName ?? '—'} /></Td>
              <Td><StatusBadge tone={entry.kind === 'special_hours' || entry.kind === 'regular_hours' ? 'warning' : 'neutral'}>{KIND_LABEL[entry.kind] ?? entry.kind}</StatusBadge></Td>
              <Td><StatusBadge tone={status.tone}>{status.label}{entry.status === 'failed' && entry.error ? `（${entry.error}）` : ''}</StatusBadge></Td>
            </Tr>
          })}</tbody>
        </DataTable>
      </Card> : null}
      {data && data.total > 0 ? <>
        {pageCount <= 1 ? <p className={styles.muted}>1–{formatNumber(data.total)} / {formatNumber(data.total)}件</p> : null}
        <Pagination page={page} pageCount={pageCount} onPageChange={setPage} summary={`${(page - 1) * data.perPage + 1}–${Math.min(page * data.perPage, data.total)} / ${formatNumber(data.total)}件`} spacing="restaurant" />
        <p className={styles.muted}>記録は削除できません。各行を押すと、変更前後の内容とGoogleからの応答を確認できます。失敗した変更は、その画面で内容を確認できます。</p>
      </> : null}
    </>
  )
}
