'use client'
import { DetailPreview, DetailSection, DetailFields } from '@/components/shared/detail-content'
import { classifyApiFailure } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Card,{ CardHeader } from '@/components/shared/card'
import { HorizontalBarChart } from '@/components/shared/charts'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import EmptyValue, { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import SegmentedControl from '@/components/shared/segmented'
import FormFileAttachments from '@/components/shared/form-file-attachments'
import ListState from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SearchField from '@/components/shared/search-field'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell,DataTable,DateCell,NameCell,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import { Tabs } from '@/components/shared/tabs'
import TargetMissing from '@/components/shared/target-missing'
import TruncatedText from '@/components/shared/truncated-text'
import { usePageTitle } from '@/components/shell/page-chrome'
import { DetailColumns,DetailPage } from '@/components/templates'
import ListRange from '@/components/ui/list-range'
import { useAccount } from '@/contexts/account-context'
import { ApiError,fetchApi } from '@/lib/api'
import { csvFileName } from '@/lib/csv-file-name'
import { formAnswerText } from '@/lib/form-answer'
import { formatDateTime,formatNumber,formatDate as polishFormatDate } from '@/lib/format'
import { csvCell } from '@/lib/presentation'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import { useCustomerDeletion } from '@/lib/use-customer-deletion'
import { useFeatureAccess } from '@/lib/use-feature-access'
import type { FormBlock,FormInputType,FormLayout } from '@line-crm/shared'
import { ArrowRight,Download,Filter,Pencil,RotateCw,User } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense,useCallback,useEffect,useMemo,useRef,useState } from 'react'
import styles from './responses.module.css'
import { retryEffectsFailureText } from './retry-failure'
import { postActionStepLabel,ratingAverageText,type DestinationWrite,type FormSubmissionSummary,type SubmissionPostActions } from './summary'


/*
 * ★V8 回答フォーム「集まった回答」（Pencil まとめて見る ・1件ずつ見る ）。
 *
 * 型（DetailPage）の頭とタブに、左の本文（まとめ／表）と右の列（フォームを編集・CSV・絞り込み・回答の詳細）をはめる。
 * 読み込み・検索・CSV・後処理のやり直しは今の作り（src/app/form-submissions/responses/page.tsx）と同じ口と同じ文。
 */

type Submission = {
  id: string
  formId: string
  friendId: string | null
  friendName: string | null
  data: Record<string, unknown> | string
  destinationWrite: DestinationWrite
  postActions?: SubmissionPostActions | null
  createdAt: string
}
type SubmissionPage = { items: Submission[]; total: number; page: number; limit: number; summary?: FormSubmissionSummary }
type FormDetail = { id: string; name: string; fields: Array<{ name: string; label: string }> | string; layout: FormLayout; submitCount: number }
type InputBlock = Extract<FormBlock, { kind: 'input' }>

/* 一度に書き出す上限。超えたら止めて件数を言う（黙って欠けさせない）。今の作りと同じ。 */
const MAX_EXPORT_ROWS = 5000
const EXPORT_PAGE_LIMIT = 200

function valueText(value: unknown, block?: InputBlock): string {
  if (Array.isArray(value) && value.some(v => v && typeof v === 'object' && 'fileId' in v)) return value.map(v => v && typeof v === 'object' && 'fileId' in v ? v.state === 'expired' ? '期限で消しました' : v.state === 'restricted' ? '見る権限がありません' : v.filename || '書類' : formAnswerText(v)).join('、')
  return formAnswerText(value, block) || '—'
}
function normalizedSubmission(item: Submission): Submission {
  if (typeof item.data !== 'string') return item
  try {
    return { ...item, data: JSON.parse(item.data) as Record<string, unknown> }
  } catch {
    return { ...item, data: {} }
  }
}
function answerOf(data: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined
}
function saveCsv(filename: string, rows: Submission[], fieldKeys: string[], labels: Record<string, string>, blocks: InputBlock[]) {
  const header = ['回答ID', '答えた人', '答えた日時', ...fieldKeys.map((key) => labels[key] ?? key)]
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const data = row.data as Record<string, unknown>
    lines.push([row.id, row.friendName ?? '不明', formatDateTime(row.createdAt), ...fieldKeys.map((key) => valueText(answerOf(data, key), blocks.find(block => block.name === key || block.id === key)))].map(csvCell).join(','))
  }
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
/** 「9/30 17:40」（日本時間）。絵どおり年と曜日は出さない。 */
function shortWhen(iso: string): string {
  return polishFormatDate(iso, { style: 'list', fallback: '—' })
}
function shortDay(iso: string): string {
  return shortWhen(iso).split(' ')[0] ?? ''
}
/** 後処理の状態：null＝記録なし、true＝未完、false＝済み。 */
function incompleteOf(item: Submission): boolean | null {
  const actions = item.postActions
  if (actions == null || actions.state === 'untracked') return null
  return actions.state !== 'completed'
}
function typeLabel(type: FormInputType): string | null {
  switch (type) {
    case 'radio': return 'ラジオ'
    case 'checkbox': return 'チェック'
    case 'select': return 'プルダウン'
    case 'rating': return '5段階'
    case 'textarea': return '複数行'
    case 'date': return '日付'
    default: return null
  }
}

export default function FormResponsesV8() {
  usePageTitle('集まった回答')
  return (
    <Suspense fallback={<ListState kind="loading" title="集まった回答を読み込んでいます" />}>
      <Responses />
    </Suspense>
  )
}

function Responses() {
  const role = useStaffRole()
  const canDeleteResponse = canManageRole(role)
  const canEditForm = useFeatureAccess('forms')
  const canRetry = canEditForm
  const searchParams = useSearchParams()
  const formId = searchParams.get('id') ?? ''
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [form, setForm] = useState<FormDetail | null>(null)
  const [items, setItems] = useState<Submission[]>([])
  const [summary, setSummary] = useState<FormSubmissionSummary | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formMissing, setFormMissing] = useState(false)
  const [formForbidden, setFormForbidden] = useState(false)
  const [query, setQuery] = useListUrlValue('q', '')
  /* 絵は「まとめて見る」が先頭。 */
  const [view, setView] = useState<'rows' | 'summary'>('summary')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [asideExpanded, setAsideExpanded] = useState(false)
  const selectAnswer = (id: string | null) => { setSelectedId(id); setAsideExpanded(true) }
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [exportProgress, setExportProgress] = useState('')
  const scopeKey = `${selectedAccountId ?? ''}:${formId}`
  const scope = useRef({ key: scopeKey, generation: 0 })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const canDeleteRef = useRef(canDeleteResponse)
  canDeleteRef.current = canDeleteResponse
  const [deletionScope, setDeletionScope] = useState<{ accountId: string; generation: number } | null>(null)
  const loadRequest = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query
  /* 集計と一覧の期間（今月・先月・すべて）。口は submissions の period（組1）。 */
  const [period, setPeriod] = useState<'this_month' | 'last_month' | 'all'>('this_month')
  const periodRef = useRef(period)
  periodRef.current = period

  const load = useCallback(async (nextPage = 1, nextLimit = 20, searchText?: string) => {
    if (!selectedAccountId || !formId) {
      setLoading(false)
      return
    }
    const generation = scope.current.generation
    const request = ++loadRequest.current
    setLoading(true)
    setError('')
    setFormMissing(false)
    setFormForbidden(false)
    try {
      const account = `account_id=${encodeURIComponent(selectedAccountId)}`
      const needle = (searchText ?? queryRef.current).trim()
      const search = needle ? `&q=${encodeURIComponent(needle)}` : ''
      const [formResult, responseResult] = await Promise.all([
        fetchApi<{ success: boolean; data: FormDetail }>(`/api/forms/${formId}?${account}`),
        fetchApi<{ success: boolean; data: SubmissionPage }>(`/api/forms/${formId}/submissions?page=${nextPage}&limit=${nextLimit}&${account}${search}&period=${periodRef.current}`),
      ])
      if (!formResult.success || !responseResult.success) throw new Error('load_failed')
      if (request !== loadRequest.current || generation !== scope.current.generation) return
      loadedScope.current = generation
      setForm(formResult.data)
      setItems(responseResult.data.items.map(normalizedSubmission))
      setSummary(responseResult.data.summary ?? null)
      setTotal(responseResult.data.total)
      setPage(responseResult.data.page)
      setPageSize(responseResult.data.limit)
      setSelectedId(null)
    } catch (caught) {
      if (request !== loadRequest.current || generation !== scope.current.generation) return
      loadedScope.current = -1
      if (caught instanceof ApiError && caught.status === 404) setFormMissing(true)
      else if (classifyApiFailure(caught) === 'forbidden') setFormForbidden(true)
      else setError('集まった回答を読み込めませんでした。')
      setItems([])
      setSummary(null)
      setTotal(null)
    } finally {
      if (request === loadRequest.current && generation === scope.current.generation) setLoading(false)
    }
  }, [formId, selectedAccountId])

  const deletion = useCustomerDeletion(async () => { if (deletionScope?.generation === scope.current.generation) await load(page, pageSize) })
  const openDeletion = (item: Submission) => {
    if (!canDeleteResponse || !selectedAccountId || loadedScope.current !== scope.current.generation) return
    setDeletionScope({ accountId: selectedAccountId, generation: scope.current.generation })
    deletion.open({ id: item.id, name: `${item.friendName ?? '不明'}（${formatDateTime(item.createdAt)}）の回答`, kind: 'form_response', path: `/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(item.id)}?account_id=${encodeURIComponent(selectedAccountId)}` })
  }

  useEffect(() => {
    deletion.close()
    setDeletionScope(null)
    // The scope change invalidates any confirmation from the previous account or form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  useEffect(() => {
    void load(1, 20)
  }, [load])

  const firstPeriod = useRef(true)
  useEffect(() => {
    if (firstPeriod.current) { firstPeriod.current = false; return }
    if (!selectedAccountId || !formId) return
    void load(1, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  /* 検索語が変わったら1ページ目から取り直す（打ち終わりを待つ）。 */
  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false
      return
    }
    if (!selectedAccountId || !formId) return
    const timer = setTimeout(() => { void load(1, pageSize, query) }, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const fields = useMemo(() => {
    if (!form) return []
    if (Array.isArray(form.fields)) return form.fields
    try {
      const parsed = JSON.parse(form.fields) as unknown
      return Array.isArray(parsed) ? parsed as Array<{ name: string; label: string }> : []
    } catch {
      return []
    }
  }, [form])
  const labels = useMemo<Record<string, string>>(() => Object.assign(Object.create(null), Object.fromEntries(fields.map((field) => [field.name, field.label]))), [fields])
  const fieldKeys = useMemo(() => {
    const fromDefinition = fields.map((field) => field.name)
    const fromRows = items.flatMap((item) => Object.keys(item.data as Record<string, unknown>))
    return [...new Set([...fromDefinition, ...fromRows])]
  }, [fields, items])
  const inputBlocks = useMemo<InputBlock[]>(() => (form
    ? [...form.layout.header, ...form.layout.sections.flatMap((section) => section.blocks)].filter((block): block is InputBlock => block.kind === 'input')
    : []), [form])
  const blockByKey = (key: string) => inputBlocks.find((block) => block.name === key || block.id === key)
  const summaries = useMemo(() => fieldKeys.map((key) => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const value = valueText(answerOf(item.data as Record<string, unknown>, key), blockByKey(key))
      if (value === '—') continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return { key, values: [...counts.entries()].sort((left, right) => right[1] - left[1]) }
  }), [fieldKeys, items])

  /* 1件ずつ見るでは、右の詳細に最初の未完（無ければ先頭）を出しておく。 */
  const selected = items.find((item) => item.id === selectedId)
    ?? (view === 'rows' ? (items.find((item) => incompleteOf(item) === true) ?? items[0] ?? null) : null)
  const incompleteItems = items.filter((item) => incompleteOf(item) === true)
  const failedSteps = [...new Set(incompleteItems.flatMap((item) => item.postActions?.pending ?? []).map(postActionStepLabel))]

  const exportAll = async () => {
    if (!selectedAccountId || !form || exporting) return
    if (total !== null && total > MAX_EXPORT_ROWS) {
      setExportError(`回答が${formatNumber(total)} 件あり、一度に書き出せる上限（${formatNumber(MAX_EXPORT_ROWS)} 件）を超えています。`)
      return
    }
    setExporting(true)
    setExportError('')
    setExportProgress('')
    try {
      const all: Submission[] = []
      let currentPage = 1
      let expected = 0
      const exportNeedle = query.trim()
      const exportSearch = exportNeedle ? `&q=${encodeURIComponent(exportNeedle)}` : ''
      do {
        const result = await fetchApi<{ success: boolean; data: SubmissionPage }>(
          `/api/forms/${formId}/submissions?page=${currentPage}&limit=${EXPORT_PAGE_LIMIT}&account_id=${encodeURIComponent(selectedAccountId)}${exportSearch}`,
        )
        if (!result.success) throw new Error('export_failed')
        expected = result.data.total
        if (expected > MAX_EXPORT_ROWS) throw new Error('export_too_many')
        all.push(...result.data.items.map(normalizedSubmission))
        setExportProgress(`${formatNumber(Math.min(all.length, expected))} / ${formatNumber(expected)} 件を取得中`)
        currentPage += 1
      } while (all.length < expected && currentPage <= 1001)
      if (all.length < expected) throw new Error('export_incomplete')
      const keys = [...new Set([...fieldKeys, ...all.flatMap((item) => Object.keys(item.data as Record<string, unknown>))])]
      saveCsv(csvFileName("フォーム回答"), all, keys, labels, inputBlocks)
    } catch (caught) {
      setExportError(caught instanceof Error && caught.message === 'export_too_many'
        ? `回答が一度に書き出せる上限（${formatNumber(MAX_EXPORT_ROWS)} 件）を超えています。`
        : 'CSVを書き出せませんでした。もう一度お試しください。')
    } finally {
      setExporting(false)
      setExportProgress('')
    }
  }

  const retryPostActions = async (item: Submission) => {
    if (!canRetry) return
    if (!selectedAccountId || retrying) return
    setRetrying(true)
    setRetryError('')
    try {
      const result = await fetchApi<{ success: boolean; data?: { submission?: Submission; pendingEffects?: string[] }; error?: string }>(
        `/api/forms/${formId}/submissions/${item.id}/retry-effects?account_id=${encodeURIComponent(selectedAccountId)}`,
        { method: 'POST' },
      )
      if (!result.success || !result.data?.submission) throw new Error(result.error ?? 'retry_failed')
      const updated = normalizedSubmission(result.data.submission)
      setItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
      setSelectedId(updated.id)
    } catch (caught) {
      setRetryError(retryEffectsFailureText(caught))
    } finally {
      setRetrying(false)
    }
  }

  if (!formId) {
    return (
      <TargetMissing
        kind="unspecified"
        title="見る回答フォームが指定されていません"
        description="一覧から回答を見るフォームを選び直してください。"
        backHref="/form-submissions"
        backLabel="回答フォーム一覧へ戻る"
      />
    )
  }
  if (accountLoading || (loading && !form)) return <ListState kind="loading" title="集まった回答を読み込んでいます" />
  if (!selectedAccountId) return <ListState kind="empty" title="LINE公式アカウントを選んでください" />
  if (formForbidden) {
    return (
      <TargetMissing
        kind="not-found"
        title="集まった回答を見る権限がありません"
        description="選んでいるアカウントでは見られません。アカウントを選び直すか、管理者に権限を確認してください。"
        backHref="/form-submissions"
        backLabel="回答フォーム一覧へ戻る"
      />
    )
  }
  if (formMissing || (!error && !form)) {
    return (
      <TargetMissing
        kind="not-found"
        title="この回答フォームは見つかりません"
        description="削除されたか、リンクが古くなっています。一覧から選び直してください。"
        backHref="/form-submissions"
        backLabel="回答フォーム一覧へ戻る"
      />
    )
  }
  if (error || !form) {
    return (
      <TargetMissing
        kind="error"
        title="集まった回答を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void load(page, pageSize)}
      />
    )
  }

  const rate = summary?.completionRate
  const pageCount = Math.max(1, Math.ceil((total ?? 0) / pageSize))
  const firstKey = fieldKeys[0]
  const headLine = [
    total === null ? emptyValue('unknown') : `${formatNumber(total)}件`,
    rate != null ? `全回答の答え終えた割合 ${formatNumber(rate)}%` : null,
  ].filter(Boolean).join('・')
  const longKey = fieldKeys.find((key) => blockByKey(key)?.type === 'textarea'
    && items.some((item) => String(answerOf(item.data as Record<string, unknown>, key) ?? '').trim() !== ''))

  const responseSelection = view === 'rows' ? selected : null
  const rail = (
    <DetailPreview title={view === 'rows' && selected ? `回答の詳細：${selected.friendName ?? '不明'}` : '回答の絞り込み'}
      actions={{
        menuLabel: '回答の詳細の操作',
        primary: responseSelection && incompleteOf(responseSelection) === true ? <Button variant="primary" onClick={() => { if (canRetry) void retryPostActions(responseSelection) }} disabled={retrying} busy={retrying} busyLabel="再実行中…"><RotateCw size={16} aria-hidden="true" />後処理をやり直す</Button> : responseSelection?.friendId ? <Button variant="primary" href={`/chats?friend=${encodeURIComponent(responseSelection.friendId)}`}><User size={16} aria-hidden="true" />友だちを開く</Button> : null,
        primaryAllowed: responseSelection && incompleteOf(responseSelection) === true ? canRetry : undefined,
        secondary: <Button variant="secondary" onClick={() => void exportAll()} disabled={exporting || total === 0} busy={exporting} busyLabel="書き出し中…" title={exportProgress || undefined} widthReserve="idle"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>,
        menuItems: [
          {id: 'edit-form', label: 'フォームを編集', href: `/form-submissions/edit?id=${encodeURIComponent(form.id)}&tab=basic`, allowed: canEditForm},
          ...(responseSelection?.friendId && incompleteOf(responseSelection) === true ? [{id: 'friend', label: '友だちを開く', href: `/chats?friend=${encodeURIComponent(responseSelection.friendId)}`}] : []),
          ...(responseSelection ? [{id: 'delete-response', label: '回答を削除する', tone: 'danger' as const, allowed: canDeleteResponse, onSelect: () => { if (canDeleteResponse) openDeletion(responseSelection) }}] : []),
        ],
      }}>
      {view === 'rows' && selected ? (
        <DetailSection label={`回答の詳細：${selected.friendName ?? '不明'}`}>

          <DetailFields>
            <div>
              <dt>答えた日時</dt>
              <dd>{shortWhen(selected.createdAt)}</dd>
            </div>
            {fieldKeys.map((key) => {
              const value = valueText(answerOf(selected.data as Record<string, unknown>, key), blockByKey(key))
              return (
                <div key={key}>
                  <dt title={labels[key] ?? key}>{labels[key] ?? key}</dt>
                  <dd title={value}>{blockByKey(key)?.type === 'rating' && value !== '—' ? `★${value}` : <FormFileAttachments value={answerOf(selected.data as Record<string, unknown>, key)} block={blockByKey(key)} />}</dd>
                </div>
              )
            })}
          </DetailFields>
          <p className={styles.railLabel}>後処理</p>
          {selected.postActions == null || selected.postActions.state === 'untracked' ? (
            <p className={styles.railNote}>この回答には後処理の記録がありません</p>
          ) : (
            <ul className={styles.detailList}>
              {selected.postActions.pending.length === 0 ? (
                <li className={styles.detailRow}><span>すべての工程</span><span className={styles.ok}>済み</span></li>
              ) : selected.postActions.pending.map((step, index) => (
                <li key={step} className={styles.detailRow}>
                  <span>{`${index + 1} ${postActionStepLabel(step)}`}</span>
                  <span className={styles.ng}>{selected.postActions?.state === 'in_progress' ? '処理中' : '未完'}</span>
                </li>
              ))}
            </ul>
          )}
          {retryError ? <p className={styles.error}>{retryError}</p> : null}

        </DetailSection>
      ) : null}

      {exportError ? <p className={styles.error}>{exportError}</p> : null}
      {exporting && exportProgress ? <p className={styles.railNote} role="status">{exportProgress}</p> : null}
      <DetailSection title="絞り込み">
        <p className={styles.railNote}>{total === null ? emptyValue('unknown') : `全 ${formatNumber(total)}件から、名前と答えで探します`}</p>
        <SegmentedControl
          aria-label="集計する期間"
          value={period}
          onChange={setPeriod}
          options={([['this_month', '今月'], ['last_month', '先月'], ['all', 'すべて']] as const).map(([value, label]) => ({ value, label }))}
        />
        <ListToolbar searchSlot={<SaveErrorField names={["query"]}><SearchField updateMode="immediate" value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="名前・答えで探す（全件から）" aria-label="名前・答えで探す（全件から）" /></SaveErrorField>} />
      </DetailSection>
    </DetailPreview>
  )

  return (
    <DetailPage
      boardId={view === 'summary' ? 'v0SbYR' : 'MKQyJ'}
      tabSpacing="compact"
      identity={<></>}
      title={`集まった回答：${form.name}`}
      help={headLine}
      tabs={(
        <Tabs
          className={styles.tabsPlain}
          label="回答の見方"
          items={[
            { label: 'まとめて見る', current: view === 'summary', onClick: () => setView('summary') },
            { label: '1件ずつ見る', current: view === 'rows', onClick: () => setView('rows') },
          ]}
        />
      )}
    >
      {!canEditForm && !canRetry ? <ReadOnlyNotice >閲覧のみで見ています。フォームの編集や後処理の再実行には変更権限が必要です。</ReadOnlyNotice> : null}
      <DetailColumns asideLayout="detail" aside={rail} asideLabel="回答の詳細・絞り込み" expanded={asideExpanded} onExpandedChange={setAsideExpanded}>
          {total === 0 && !query.trim() ? (
            <ListState kind="empty" title="まだ回答がありません" description="フォームが回答されると、ここに1件ずつ並びます。" />
          ) : view === 'summary' ? (
            <>
              {incompleteItems.length > 0 ? (
                <Notice tone="danger" role="status"
                  heading={`後処理が終わっていない回答が ${formatNumber(incompleteItems.length)} 件あります`}
                  message={`答えは保存されています。${failedSteps.join('・') || '後処理'}が終わっていません${(total ?? 0) > items.length ? '（表示中のページから数えています）' : ''}。`}
                  action={<Button onClick={() => { selectAnswer(incompleteItems[0]?.id ?? null); setView('rows') }}><Filter size={16} aria-hidden="true" />{`その${formatNumber(incompleteItems.length)} 件を見る`}</Button>} />
              ) : null}
              {summaries.map((fieldSummary) => {
                const block = blockByKey(fieldSummary.key)
                if (block?.type === 'textarea') return null
                const answered = fieldSummary.values.reduce((acc, [, count]) => acc + count, 0)
                const kind = block ? typeLabel(block.type) : null
                const rating = block?.type === 'rating' ? summary?.ratingFields?.find((field) => field.key === fieldSummary.key) : undefined
                const sub = rating
                  ? `5段階・全回答の平均 ${ratingAverageText(rating.average)}／棒は表示中の ${formatNumber(answered)} 件`
                  : `${kind ? `${kind}・` : ''}${answered === 0 ? '表示中の回答はありません' : `表示中の ${formatNumber(answered)} 件の回答`}`
                /* 5段階は ★5・★4・★3以下 の3段にまとめる。 */
                const values: Array<[string, number]> = block?.type === 'rating'
                  ? [
                      ['5', fieldSummary.values.filter(([value]) => Number(value) >= 5).reduce((acc, [, count]) => acc + count, 0)],
                      ['4', fieldSummary.values.filter(([value]) => Number(value) === 4).reduce((acc, [, count]) => acc + count, 0)],
                      ['3以下', fieldSummary.values.filter(([value]) => Number(value) <= 3).reduce((acc, [, count]) => acc + count, 0)],
                    ]
                  : fieldSummary.values
                const top = values.slice(0, 6)
                return (
                  <Card key={fieldSummary.key} variant="form" padding="roomy" aria-label={labels[fieldSummary.key] ?? fieldSummary.key}>
                    <CardHeader size="stacked" title={labels[fieldSummary.key] ?? fieldSummary.key} meta={sub} />
                    {answered > 0 ? (
                      <HorizontalBarChart label={labels[fieldSummary.key] ?? fieldSummary.key} unit="件" total={answered} items={top.map(([value,count])=>({key:value,label:block?.type==='rating'?`★${value}`:value,value:count}))} />
                    ) : null}
                  </Card>
                )
              })}
              {longKey ? (() => {
                const recents = items.filter((item) => String(answerOf(item.data as Record<string, unknown>, longKey) ?? '').trim() !== '')
                return (
                  <Card variant="form" padding="roomy" aria-label={labels[longKey] ?? longKey}>
                    <CardHeader size="stacked" title={labels[longKey] ?? longKey} meta={`表示中の複数行回答・${formatNumber(recents.length)} 件`} />
                    <DataTable label={`${labels[longKey] ?? longKey}の新しい回答`} presentation="columns" columnLayout={{ headHeight: 'var(--tpl-thead-h)', rowHeight: 'auto', gap: 'var(--polish-space-card)', padding: 'var(--polish-space-row) 0' }}><tbody>
                      {recents.slice(0, 2).map((item) => {
                        const text = String(answerOf(item.data as Record<string, unknown>, longKey))
                        return (
                          <Tr key={item.id} interactive={false} data-table-layout="columns">
                            <Td grow><TruncatedText value={`「${text}」`} /></Td>
                            <Td align="right"><TruncatedText value={`${shortDay(item.createdAt)} ${item.friendName ?? emptyValue('unknown')}`} /></Td>
                          </Tr>
                        )
                      })}
                    </tbody></DataTable>
                    {/* 絵 v0SbYR：「1件ずつ見る」は一覧の下の右端。 */}
                    <div className={styles.cardFootEnd}><Button variant="text" textTone="ink" onClick={() => setView('rows')}>1件ずつ見る<ArrowRight size={16} aria-hidden="true" /></Button></div>
                  </Card>
                )
              })() : null}
            </>
          ) : items.length === 0 ? (
            <Card variant="form" padding="roomy">
              <p className={styles.cardTitle}>条件に合う回答はありません</p>
              <p className={styles.cardNote}>検索語を変えてください。</p>
              <div><Button onClick={() => setQuery('')}>× 条件を外す</Button></div>
            </Card>
          ) : (
            <Card variant="records" aria-labelledby="fr-rows">
              <CardHeader size="stacked" title="回答" titleId="fr-rows" meta={total === null ? emptyValue('unknown') : `全 ${formatNumber(total)}件`} />
              <DataTable label="集まった回答">
                <thead>
                  <TableHeadRow presentation="embedded">
                    <Th className={styles.colWhen}>答えた日時</Th>
                    <Th>答えた人</Th>
                    <Th className={styles.colAnswer} truncate>{firstKey ? (labels[firstKey] ?? firstKey) : '回答'}</Th>
                    <Th className={styles.colState}>後処理</Th>
                    {canDeleteResponse ? <Th className={styles.colActions}>操作</Th> : null}
                  </TableHeadRow>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const incomplete = incompleteOf(item)
                    const first = firstKey ? valueText(answerOf(item.data as Record<string, unknown>, firstKey), blockByKey(firstKey)) : emptyValue('unknown')
                    const isSelected = selected?.id === item.id
                    return (
                      <Tr
                        key={item.id}
                        selected={isSelected}
                        interactive
                        aria-selected={isSelected}
                        onClick={() => selectAnswer(item.id)}
                      >
                        <DateCell>{shortWhen(item.createdAt)}</DateCell>
                        <NameCell name={
                          <button type="button" className={styles.who} title={item.friendName ?? '不明'} onClick={() => selectAnswer(item.id)}>
                            {item.friendName ?? <EmptyValue kind="unknown" />}
                          </button>
                        } />
                        <Td className={styles.ellipsis} title={first}>{first}</Td>
                        <Td>
                          {incomplete === null ? <EmptyCell />
                            : <StatusBadge tone={incomplete ? 'danger' : 'success'}>{incomplete ? '未完' : '済み'}</StatusBadge>}
                        </Td>
                        {canDeleteResponse ? <ActionCell><RowMenu size="row" label={`回答 ${item.id} の操作`} items={[{ id: 'delete-response', label: '回答を削除する', tone: 'danger', onSelect: () => openDeletion(item) }]} /></ActionCell> : null}
                      </Tr>
                    )
                  })}
                </tbody>
              </DataTable>
              <div className={styles.pager} data-card-footer="">
                <span className={styles.range}>
                  {total === null ? emptyValue('unknown') : <ListRange total={total} first={total === 0 ? 0 : (page - 1) * pageSize + 1} last={Math.min(page * pageSize, total)} />}
                </span>
                <Pagination page={page} pageCount={pageCount} disabled={loading} ariaLabel="回答一覧のページ送り" onPageChange={(next) => void load(next, pageSize)} />
              </div>
            </Card>
          )}
      </DetailColumns>
      <ConfirmDialog open={deletion.target !== null && deletionScope?.generation === scope.current.generation} title="回答を削除しますか？" deleteName="この回答"
        description={`${deletion.target?.name ?? 'この回答'}と添付した写真・PDF・本人確認書類を削除します。元に戻せません。すでに行った送信やタグの変更は取り消されません。`}
        destructive confirmDisabled={deletion.blocked} busy={deletion.busy} busyLabel="削除中…" error={deletion.error}
        onConfirm={() => { if (deletionScope?.generation === scope.current.generation && canDeleteRef.current) void deletion.confirm() }} onCancel={deletion.close}>
        {deletionScope ? <OperationTargetSummary accounts={[{ id: deletionScope.accountId }]} /> : null}
      </ConfirmDialog>
    </DetailPage>
  )
}
