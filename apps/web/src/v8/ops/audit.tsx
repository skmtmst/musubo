'use client'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { Download } from 'lucide-react'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type OpsAuditRow } from '@/lib/api'
import { formatNumber, formatDate as polishFormatDate } from '@/lib/format'
import { AUDIT_ACTION_LABEL, formatDateTime, opsCall } from '@/components/ops/ops-ui'
import Button from '@/components/shared/button'
import DateField from '@/components/shared/date-field'
import { Tabs } from '@/components/shared/tabs'
import LogEntryDetails, { type LogEntryFacts } from '@/components/shared/log-entry-details'
import { useAuditCounts } from './use-audit-counts'
import { DataTable, TableHeadRow, Th, Tr, Td, RowNameButton } from '@/components/shared/table'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import { OpsHead } from './shell'
import { PageFrame } from '@/components/templates/page-frame'
import parts from './parts.module.css'
import styles from './audit.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import Card from '@/components/shared/card'
import { useOpsReadOnly } from './use-ops-read-only'

/**
 * 運営の監査ログ V8。
 *
 * 動きは 管理画面（app/ops/audit）と同じ口：種類（代理ログイン・個人情報の表示・
 * 契約先の停止・運営メンバー）と期間で /api/ops/audit を読み、50件ずつ送る。
 * CSV はいまの条件で全部（上限 2万件）を書き出す。記録は消せない。
 */

const FILTERS: Array<{ key: string; label: string; actions: string }> = [
  { key: 'applications', label: '申込アカウント', actions: 'application.contact,application.approve,application.invite' },
  { key: 'impersonation', label: '代理ログイン', actions: 'impersonation.start,impersonation.write,impersonation.end' },
  { key: 'pii', label: '個人情報の表示', actions: 'pii.reveal' },
  { key: 'status', label: '契約先の停止', actions: 'tenant.status.change' },
  { key: 'members', label: '運営メンバー', actions: 'member.invite,member.deactivate,member.activate' },
]

const PAGE = 50
const CSV_PAGE = 500
const CSV_MAX = 20_000

const ACTION_WORD: Record<string, string> = {
  'impersonation.start': '代理ログイン（閲覧）',
  'impersonation.write': '代理ログイン（書き込み）',
  'tenant.status.change': '契約先の停止',
  'pii.reveal': '個人情報の表示',
  'member.invite': '運営メンバー',
  'member.deactivate': '運営メンバー',
  'member.activate': '運営メンバー',
}

function actionWord(action: string): string {
  const word = Object.prototype.hasOwnProperty.call(ACTION_WORD, action) ? ACTION_WORD[action] : undefined
  const fallback = Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABEL, action) ? AUDIT_ACTION_LABEL[action]?.label : undefined
  return word ?? fallback ?? action
}

/** 短い日時（10/1 15:20 の形）。 */
function shortDateTime(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

export default function OpsAuditV8() {
  const readOnly = useOpsReadOnly()
  const [entry, setEntry] = useState<LogEntryFacts | null>(null)
  const [rows, setRows] = useState<OpsAuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useListUrlValue('filter', '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorSource, setErrorSource] = useState<'load' | 'export' | null>(null)
  const [loadFailure, setLoadFailure] = useState<unknown>(null)
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')
  const requestSeq = useRef(0)

  const counts = useAuditCounts(from, to, FILTERS)
  const actionsFor = (key: string) => FILTERS.find((f) => f.key === key)?.actions || undefined

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    setErrorSource(null)
    setLoadFailure(null)
    const res = await opsCall(api.ops.audit({ action: actionsFor(filter), from: from || undefined, to: to ? `${to}T23:59:59` : undefined, limit: PAGE, offset: (page - 1) * PAGE }))
    if (seq !== requestSeq.current) return
    setLoading(false)
    if (!res.success) {
      const message = res.error || '読み込めませんでした'
      setError(message)
      setErrorSource('load')
      setLoadFailure(new Error(message))
      return
    }
    setRows(res.data)
    setTotal(res.total)
  }, [filter, from, to, page])

  useEffect(() => {
    setEntry(null)
    void load()
    return () => { requestSeq.current += 1 }
  }, [load])

  const exportCsv = async () => {
    setExporting(true)
    setExportNote('')
    const collected: OpsAuditRow[] = []
    let expected = 0
    let truncated = false
    for (let offset = 0; ; offset += CSV_PAGE) {
      const res = await opsCall(api.ops.audit({ action: actionsFor(filter), from: from || undefined, to: to ? `${to}T23:59:59` : undefined, limit: CSV_PAGE, offset }))
      if (!res.success) { setError(res.error || '書き出せませんでした'); setErrorSource('export'); setExporting(false); return }
      collected.push(...res.data)
      expected = res.total
      if (res.data.length < CSV_PAGE || collected.length >= res.total) break
      if (collected.length >= CSV_MAX) { truncated = true; break }
    }
    const header = ['日時', '運営者', '契約先', '操作', '理由', 'IP', '契約先に表示']
    const lines = collected.map((r) => [
      r.created_at, r.staff_name, r.tenant_name ?? '', AUDIT_ACTION_LABEL[r.action]?.label ?? r.action, r.reason ?? '', r.ip ?? '', r.visible_to_tenant ? '表示' : '運営のみ',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    const blob = new Blob([`﻿${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName("運営の操作履歴")
    a.click()
    URL.revokeObjectURL(url)
    setExportNote(truncated
      ? `いまの条件の ${formatNumber(collected.length)} 件を書き出しました（${expected} 件中・上限 ${formatNumber(CSV_MAX)} 件まで。全部を残すには期間で絞ってください）`
      : `いまの条件の ${formatNumber(collected.length)} 件を書き出しました`)
    setExporting(false)
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE))

  return (
    <PageFrame kind="list" boardId="e7ljE" standalone heightMode="content">
      <OpsHead
        title="監査ログ"
        description="運営が行った操作の記録です。代理ログイン・個人情報の表示・契約先の停止・運営メンバーの変更が残ります。"
        actions={(
          <Button onClick={() => void exportCsv()} title={exporting ? '書き出しています' : total === 0 ? '記録がないため書き出せません' : undefined} disabled={exporting || total === 0} busy={exporting} busyLabel="書き出しています…">
            <Download aria-hidden="true" />CSVで書き出す
          </Button>
        )}
      />
      <div className={parts.stack}>
        <div className={styles.tools}>
          <Tabs size="compact" wrap label="監査ログの種類" items={[{ key: '', label: 'すべて' }, ...FILTERS].map(item => ({ label: item.label, count: counts[item.key], current: filter === item.key, onClick: () => { setFilter(item.key); setPage(1); setEntry(null) } }))} />

          <span className={styles.spacer} />
          <div className={styles.dateGroup} role="group" aria-label="開始日"><span className={styles.dateLabel}>開始日</span><span className={styles.date}>
            <SaveErrorField names={["from"]}><DateField value={from} onChange={(value) => { setFrom(value); setPage(1) }} max={to || undefined} aria-label="開始日" placeholder="指定なし" displayFormat="short" /></SaveErrorField>
          </span></div>
          <div className={styles.dateGroup} role="group" aria-label="終了日"><span className={styles.dateLabel}>終了日</span><span className={styles.date}>
            <SaveErrorField names={["to"]}><DateField value={to} onChange={(value) => { setTo(value); setPage(1) }} min={from || undefined} aria-label="終了日" placeholder="指定なし" displayFormat="short" /></SaveErrorField>
          </span></div>
        </div>

        {exportNote ? <p role="status" className={parts.status}>{exportNote}</p> : null}
        {error && rows.length > 0 ? (
          <Notice
            tone="danger"
            className={parts.alertNoticePlacement}
            action={errorSource === 'load' ? <Button variant="text" size="inline" onClick={() => void load()} disabled={loading} busy={loading}>もう一度読み込む</Button> : undefined}
          >
            {error}
          </Notice>
        ) : null}

        {loading && rows.length === 0 ? (
          <ListState permissionScope="hq" kind="loading" title="記録を読み込んでいます" />
        ) : error && rows.length === 0 ? (
          <div className={parts.panel}>
            <ListState permissionScope="hq" kind="error" title="記録を表示できませんでした" error={loadFailure} description={error} onRetry={() => void load()} />
          </div>
        ) : rows.length === 0 ? (
          <div className={parts.panel}>
            <ListState permissionScope="hq" kind="empty" title="記録がありません" description="運営が操作を行うと、ここに残ります。" />
          </div>
        ) : (
          <Card padding="rows" overflow="hidden"><DataTable density="records" columnSizing="content" label="監査ログ">
            <colgroup><col className={styles.colAt} /><col className={styles.colWho} /><col className={styles.colWhat} /><col className={styles.colTenant} /><col /></colgroup>
            <thead><TableHeadRow><Th>日時</Th><Th>運営者</Th><Th><span>操作</span></Th><Th>契約先</Th><Th grow>理由</Th></TableHeadRow></thead>
            <tbody>{rows.map((row) => (
              <Tr key={row.id}>
                <Td title={formatDateTime(row.created_at)} className={styles.atCell}>{shortDateTime(row.created_at)}</Td>
                <Td><TruncatedText value={row.staff_name ?? ''} /></Td>
                <Td><RowNameButton title={actionWord(row.action)} onClick={() => setEntry({ occurredAt: row.created_at, target: row.tenant_name ?? '運営全体', status: actionWord(row.action), reason: row.reason ?? '理由の記録なし' })}>{actionWord(row.action)}</RowNameButton></Td>
                <Td title={row.tenant_name ?? ''}><TruncatedText value={row.tenant_name ?? emptyValue('unknown')} /></Td>
                <Td grow title={`${row.reason ?? ''}・IP ${row.ip ?? '—'}・${row.visible_to_tenant ? '契約先に表示' : '運営のみ'}`}><TruncatedText value={row.reason ?? emptyValue('unknown')} /></Td>
              </Tr>
            ))}</tbody>
          </DataTable></Card>
        )}
        {rows.length > 0 ? (
          <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
        ) : null}
        <p className={parts.note} title={`${total}件中 ${total === 0 ? 0 : (page - 1) * PAGE + 1}〜${Math.min(page * PAGE, total)}件を表示`}>記録は運営メンバーでも消せません。理由は4文字以上が必須です。</p>
      </div>
      <LogEntryDetails canCopy={!readOnly} entry={entry} onClose={() => setEntry(null)} />
    </PageFrame>
  )
}
