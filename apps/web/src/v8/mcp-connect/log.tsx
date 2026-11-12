'use client'

import { PAGE_SIZES, pageSizeOptions } from '@/components/shared/page-size-options'

/*
 * ★V8 外部連携 › AI の操作の記録（板 hqhj5）。要件 G9 §2-1・§2-6・§4（MCP-04・06・11・15・16・17・22）。
 * 題の下に接続の名前とできること、右上に［この接続を止める］（オーナー・管理者・代理ログイン）。
 * したこと・期間・件数。表：日時・接続・したこと（読んだ／下書きを作った／送る依頼〔承認待ち〕／断った）・対象。
 * 送る依頼の行は「…」に［承認へ進む］、下書きの行は［下書きを開く］。範囲外の依頼は「断った」で残る。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import Button from '@/components/shared/button'
import LogEntryDetails, { type LogEntryFacts } from '@/components/shared/log-entry-details'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import EmptyList from '@/components/shared/empty-list'
import ListState from '@/components/shared/list-state'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'
import { readListUrlParam, useListUrlState } from '@/components/shared/list-url-state'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr, RowNameButton } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { describeApiFailure, loadFailureCopy } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import { ListPage } from '@/components/templates'
import { formatDate } from '@/lib/format'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { mcpApi, type McpCallLog, type McpConnection } from './api'
import { useMcpPermissions } from './section'
import { CALL_FILTER_OPTIONS, LEVEL_LABEL, callLabel } from './words'
import styles from './section.module.css'

const PERIOD_OPTIONS = [
  { value: '7', label: '期間：過去7日' },
  { value: '30', label: '期間：過去30日' },
  { value: '90', label: '期間：過去90日' },
]

type Load = { kind: 'loading' } | { kind: 'ready'; items: McpCallLog[]; total: number; connection: McpConnection | null } | { kind: 'error'; error: unknown }
const at = (value: string) => formatDate(value, { style: 'list', fallback: '—' })

export default function McpLogV8() {
  const permissions = useMcpPermissions()
  usePageTitle('AI の操作の記録')
  usePageCrumbs([{ label: '外部連携', href: '/webhooks?tab=api-tokens' }])
  const [url, setUrl] = useListUrlState({ connection: '', what: '', days: '7', page: '1', size: '20' })
  const page = Math.max(1, Number(url.page) || 1)
  const size = Number(url.size) || 20
  const days = Number(url.days) || 7
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [menuId, setMenuId] = useState<string | null>(null)
  const [stopTarget, setStopTarget] = useState<{ connection: McpConnection; selectedConnection: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [entry, setEntry] = useState<LogEntryFacts | null>(null)
  const loadSequence = useRef(0)

  const fetchLogs = useCallback(async () => {
    const sequence = ++loadSequence.current
    setEntry(null)
    setLoad({ kind: 'loading' })
    const resultFilter = url.what === 'refused' || url.what === 'error' ? url.what : ''
    const kindFilter = resultFilter ? '' : url.what
    try {
      const res = await mcpApi.logs({ connectionId: url.connection || undefined, result: resultFilter, kind: kindFilter, days, page, limit: size })
      if (sequence !== loadSequence.current) return
      setLoad({ kind: 'ready', ...res.data })
    } catch (caught) {
      if (sequence !== loadSequence.current) return
      setLoad({ kind: 'error', error: caught })
    }
  }, [url.connection, url.what, days, page, size])
  useEffect(() => { if (permissions.see) void fetchLogs(); return () => { loadSequence.current += 1 } }, [fetchLogs, permissions.see])
  useEffect(() => { setStopTarget(null) }, [url.connection])
  useEffect(() => {
    if (stopTarget && load.kind === 'ready' && (load.connection?.id !== stopTarget.connection.id || load.connection.version !== stopTarget.connection.version || load.connection.status !== 'active')) setStopTarget(null)
  }, [load, stopTarget])

  const connection = load.kind === 'ready' ? load.connection : null
  const stop = async () => {
    if (!stopTarget || !permissions.stop || readListUrlParam('connection') !== stopTarget.selectedConnection || !connection || connection.id !== stopTarget.connection.id || connection.version !== stopTarget.connection.version || connection.status !== 'active') {
      setError('接続が変わりました。読み直してから、もう一度選んでください。')
      return
    }
    const target = stopTarget.connection
    setBusy(true)
    setError('')
    try {
      await mcpApi.stop(target.id, target.version)
      notifyToast(`「${target.name}」を止めました。次の呼び出しから使えません`)
      setStopTarget(null)
      void fetchLogs()
    } catch (caught) {
      setError(describeApiFailure(caught, '止める操作'))
    } finally {
      setBusy(false)
    }
  }

  if (!permissions.see) {
    return (
      <ListPage boardId="hqhj5" headingSize="regular" title="AI の操作の記録">
        <ListState kind="forbidden" title="この画面を開く権限がありません" description="AI の操作の記録は、オーナー・管理者・閲覧のみの人が見られます。" />
      </ListPage>
    )
  }

  const total = load.kind === 'ready' ? load.total : 0
  const failure = load.kind === 'error' ? loadFailureCopy(load.error, 'AI の操作の記録') : null

  return (
    <ListPage
      boardId="hqhj5"
      headingSize="regular"
      heightMode="content"
      title="AI の操作の記録"
      help="AI との接続が読んだ・下書きを作った・送る依頼を出した・断ったことを、全部ここに残します。送る依頼は、人が承認するまで送りません。"
      subtitle={connection ? `${connection.name}・${LEVEL_LABEL[connection.level]}` : undefined}
      actions={connection && connection.status === 'active' && permissions.stop
        ? <Button variant="danger" onClick={() => { setError(''); setStopTarget({ connection, selectedConnection: url.connection }) }}>この接続を止める</Button>
        : undefined}
      stats={permissions.viewer ? <ReadOnlyNotice role="status" /> : undefined}
      toolbar={<ListToolbarFrame><ListToolbarRow>
        <Select size="content" aria-label="したこと" value={url.what} options={CALL_FILTER_OPTIONS} onChange={(what) => setUrl({ what, page: '1' })} />
        <Select size="content" aria-label="期間" value={String(days)} options={PERIOD_OPTIONS} onChange={(next) => setUrl({ days: next, page: '1' })} />
        <ListToolbarEnd>
          <Select size="page-size" aria-label="表示件数" value={String(size)} options={pageSizeOptions(PAGE_SIZES)} onChange={(next) => setUrl({ size: next, page: '1' })} />
        </ListToolbarEnd>
      </ListToolbarRow></ListToolbarFrame>}
      pagination={load.kind === 'ready' && total > size ? <Pagination page={page} pageCount={Math.max(1, Math.ceil(total / size))} onPageChange={(next) => setUrl({ page: String(next) })} range={{ total, first: (page - 1) * size + 1, last: Math.min(total, page * size) }} /> : undefined}
      overlays={<><LogEntryDetails canCopy={permissions.see && !permissions.viewer} entry={entry} onClose={() => setEntry(null)} /><ConfirmDialog
        open={stopTarget !== null}
        title={`「${stopTarget?.connection.name ?? ''}」を止めますか？`}
        description="すぐ使えなくなり、次の呼び出しから断ります。止めた人は記録に残ります。もう一度使うときは、接続を作り直します。"
        confirmLabel="止める"
        confirmIcon={false}
        destructive
        busy={busy}
        error={error || undefined}
        onConfirm={() => void stop()}
        onCancel={() => { if (!busy) setStopTarget(null) }}
      ><OperationTargetSummary accounts={stopTarget?.connection.accounts?.length ? stopTarget.connection.accounts : [{ id: '' }]} compactAccounts /></ConfirmDialog></>}
    >
      {load.kind === 'loading' ? <ListState kind="loading" /> : null}
      {failure ? <ListState kind="error" title={failure.title} description={failure.description} onRetry={failure.retryable ? () => void fetchLogs() : undefined} /> : null}
      {load.kind === 'ready' && load.items.length === 0 ? (
        <EmptyList icon={<History aria-hidden="true" />} title="まだ使われていません" description="AI からの呼び出しがあると、ここに残ります。" filtered={Boolean(url.what)} onClearFilters={() => setUrl({ what: '', page: '1' })} />
      ) : null}
      {load.kind === 'ready' && load.items.length > 0 ? (
        <DataTable aria-label="AI の操作の記録" columnSizing="content">
          <thead>
            <TableHeadRow>
              <Th>日時</Th>
              <Th>接続</Th>
              <Th>したこと</Th>
              <Th grow>対象</Th>
              <Th><span className="sr-only">操作</span></Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {load.items.map((log) => {
              const state = callLabel(log.kind, log.result)
              const broadcast = log.targetType === 'broadcast' && log.targetId && log.result === 'ok'
              /* 承認へ進む：送る依頼の行は詳細へ。下書きの行は、承認待ちかを口が返すまで押せない形で残す。 */
              const items = broadcast ? [
                ...(log.kind === 'send_request' && !permissions.viewer ? [{ id: 'approve', label: '承認へ進む', href: `/broadcasts/detail?id=${encodeURIComponent(log.targetId!)}`, onSelect: () => setMenuId(null) }] : []),
                ...(log.kind === 'draft' && !permissions.viewer ? [{ id: 'approve', label: '承認へ進む', disabled: true, disabledReason: '承認待ちかどうかを、まだ読めません' }] : []),
                { id: 'draft', label: '下書きを開く', href: `/broadcasts/detail?id=${encodeURIComponent(log.targetId!)}`, onSelect: () => setMenuId(null) },
              ] : []
              return (
                <Tr key={log.id} data-row-id={log.id}>
                  <Td>{at(log.at)}</Td>
                  <Td title={log.connectionName}><TruncatedText value={log.connectionName} /></Td>
                  <Td><RowNameButton onClick={() => setEntry({ occurredAt: log.at, target: log.connectionName, status: state.label, reason: log.summary })}><StatusBadge tone={state.tone}>{state.label}</StatusBadge></RowNameButton></Td>
                  <Td grow title={log.summary}><TruncatedText value={log.summary} /></Td>
                  <ActionCell>
                    {items.length ? <RowMenu appearance="plain" label={`${at(log.at)} の記録の操作`} open={menuId === log.id} onOpenChange={(next) => setMenuId(next ? log.id : null)} items={items} /> : null}
                  </ActionCell>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      ) : null}
    </ListPage>
  )
}
