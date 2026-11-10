'use client'

import { PAGE_SIZES, pageSizeOptions } from '@/components/shared/page-size-options'

/*
 * ★V8 自動応答の「Q&A」タブ（板 y4nixm・使っていない UbRQ4・閲覧のみ yUK7Z、確かめの窓 NmTj4）。
 * 要件 G2 §2-1・§2-2・§2-6・§4（AI-02・07・08・20・21・23・24）。
 * 見出しの右に［取り込む（PDF・Web）］［Q&A を追加］、タブ、AI の使い方の帯、探す・状態・件数、平らな表。
 */
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { MessageSquareText, Plus, Upload } from 'lucide-react'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import EmptyList from '@/components/shared/empty-list'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow, ListToolbarSearchSlot } from '@/components/shared/list-toolbar'
import { useListUrlState } from '@/components/shared/list-url-state'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import TruncatedText from '@/components/shared/truncated-text'
import { describeApiFailure, loadFailureCopy } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import { ListPage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatNumber } from '@/lib/format'
import { aiReplyApi, type QaEntry, type QaStatus } from './api'
import { AiModeBand } from './ai-mode-band'
import { AutoReplyTabs } from './auto-reply-tabs'
import QaEditDialog, { type QaDraftSeed } from './qa-edit-dialog'
import { useAiSettings } from './use-ai-settings'
import { QA_STATUS_LABEL, QA_STATUS_TONE } from './words'
import styles from './qa-list.module.css'

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'published', label: '公開' },
  { value: 'draft', label: '下書き' },
  { value: 'stopped', label: '止めた' },
]

type Load = { kind: 'loading' } | { kind: 'ready'; items: QaEntry[]; total: number; scope: object } | { kind: 'error'; error: unknown }
type Pending = { kind: 'publish' | 'stop' | 'delete'; entry: QaEntry; accountId: string; scope: object }

export const QA_HELP = 'よくある質問と店の答えを登録します。公開した Q&A は返信案の元になり、自動で答えるをオンにした店では答えの文をそのまま返します。'

export default function QaListV8() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const accountId = selectedAccountId ?? ''
  const accountScope = useRef({ accountId })
  if (accountScope.current.accountId !== accountId) accountScope.current = { accountId }
  const ai = useAiSettings(selectedAccountId)
  usePageTitle('Q&A')
  usePageCrumbs([{ label: '自動応答', href: '/auto-replies' }])
  const { permissions } = ai
  const [url, setUrl] = useListUrlState({ q: '', status: '', page: '1', size: '20' })
  const page = Math.max(1, Number(url.page) || 1)
  const size = Number(url.size) || 20
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [menuId, setMenuId] = useState<string | null>(null)
  const [edit, setEdit] = useState<QaDraftSeed | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingError, setPendingError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const generation = useRef(0)
  const saveErrors = useSaveFormErrors()

  const fetchList = useCallback(async () => {
    const mine = ++generation.current
    const scope = accountScope.current
    if (!accountId) { setLoad({ kind: 'ready', items: [], total: 0, scope }); return }
    setLoad({ kind: 'loading' })
    try {
      const res = await aiReplyApi.listQa(accountId, { q: url.q, status: url.status as QaStatus | '', page, limit: size })
      if (mine !== generation.current || accountScope.current !== scope) return
      setLoad({ kind: 'ready', items: res.data.items, total: res.data.total, scope })
    } catch (error) {
      if (mine !== generation.current || accountScope.current !== scope) return
      setLoad({ kind: 'error', error })
    }
  }, [accountId, url.q, url.status, page, size])

  useEffect(() => { void fetchList() }, [fetchList])
  useEffect(() => { setPending(null); setPendingBusy(false); setPendingError('') }, [accountId])

  const runPending = async () => {
    if (!pending || pending.scope !== accountScope.current || pendingBusy) return
    setPendingBusy(true)
    setPendingError('')
    try {
      if (pending.kind === 'publish') await aiReplyApi.publishQa(pending.accountId, pending.entry.id, pending.entry.version)
      else if (pending.kind === 'stop') await aiReplyApi.stopQa(pending.accountId, pending.entry.id, pending.entry.version)
      else await aiReplyApi.deleteQa(pending.accountId, pending.entry.id, pending.entry.version)
      if (pending.scope !== accountScope.current) return
      notifyToast(pending.kind === 'publish' ? 'Q&A を公開しました' : pending.kind === 'stop' ? 'Q&A を止めました' : 'Q&A を削除しました')
      setPending(null)
      void fetchList()
      void ai.reload()
    } catch (caught) {
      if (pending.scope !== accountScope.current) return
      if (!saveErrors.capture(caught)) setPendingError(describeApiFailure(caught, pending.kind === 'publish' ? '公開' : pending.kind === 'stop' ? '止める操作' : '削除'))
    } finally {
      if (pending.scope === accountScope.current) setPendingBusy(false)
    }
  }

  const filtered = Boolean(url.q || url.status)
  const total = load.kind === 'ready' ? load.total : 0
  const pageCount = Math.max(1, Math.ceil(total / size))
  const failure = load.kind === 'error' ? loadFailureCopy(load.error, 'Q&A') : null

  const actions = <>
    {permissions.importQa ? <Button onClick={() => setImportOpen(true)}><Upload size={16} aria-hidden="true" />取り込む（PDF・Web）</Button> : null}
    {permissions.editQa ? <Button variant="primary" onClick={() => setEdit({})}><Plus size={16} aria-hidden="true" />Q&A を追加</Button> : null}
  </>

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="y4nixm"
      headingSize="regular"
      heightMode="content"
      title="自動応答"
      help={`${QA_HELP}${permissions.editQa ? '行を押すと編集。' : ''}${permissions.publishQa ? '「…」に公開・止める・削除。' : ''}`}
      actions={actions}
      tabs={<AutoReplyTabs active="qa" />}
      stats={<div className={styles.bands}>
        {permissions.viewer ? <ReadOnlyNotice role="status">閲覧のみで見ています。Q&A の追加・取り込み・AI の使い方の変更はできません。</ReadOnlyNotice> : null}
        {accountId && ai.status === 'ready' ? (
          <AiModeBand
            accountId={accountId}
            accountName={selectedAccount?.name ?? 'この店'}
            settings={ai.settings}
            permissions={permissions}
            onChanged={(next) => ai.setSettings(next)}
          />
        ) : null}
        {ai.status === 'error' ? <ListState kind="error" title="AI の使い方を読み込めませんでした" description="もう一度読み込んでください。" onRetry={() => void ai.reload()} /> : null}
      </div>}
      toolbar={<ListToolbarFrame singleRow><ListToolbarRow>
        <ListToolbarSearchSlot search={{ placeholder: '質問・答えで探す', value: url.q, onChange: (q) => setUrl({ q, page: '1' }), width: 280 }} />
        <Select size="content" aria-label="状態" label="状態" value={url.status} options={STATUS_OPTIONS} onChange={(status) => setUrl({ status, page: '1' })} />
        <ListToolbarEnd>
          <Select size="page-size" aria-label="表示件数" value={String(size)} options={pageSizeOptions(PAGE_SIZES)} onChange={(next) => setUrl({ size: next, page: '1' })} />
        </ListToolbarEnd>
      </ListToolbarRow></ListToolbarFrame>}
      pagination={load.kind === 'ready' && total > size ? <Pagination page={page} pageCount={pageCount} onPageChange={(next) => setUrl({ page: String(next) })} range={{ total, first: (page - 1) * size + 1, last: Math.min(total, page * size) }} /> : undefined}
      overlays={<>
        <QaEditDialog
          open={edit !== null}
          accountId={accountId}
          seed={edit}
          canPublish={permissions.publishQa}
          onSaved={() => { setEdit(null); void fetchList(); void ai.reload() }}
          onClose={() => setEdit(null)}
        />
        <ConfirmDialog
          open={pending !== null && pending.scope === accountScope.current}
          title={pending?.kind === 'publish' ? `「${pending.entry.questions[0] ?? ''}」を公開しますか？` : pending?.kind === 'stop' ? `「${pending.entry.questions[0] ?? ''}」を止めますか？` : `「${pending?.entry.questions[0] ?? ''}」を削除しますか？`}
          description={pending?.kind === 'publish'
            ? '公開すると返信案の元になります。自動で答えるをオンにしている店では、この答えをそのまま返します。'
            : pending?.kind === 'stop'
              ? '止めると返信案にも自動の答えにも使いません。あとから公開し直せます。'
              : '削除すると元に戻せません。これまでの記録は残ります。'}
          confirmLabel={pending?.kind === 'publish' ? '公開する' : pending?.kind === 'stop' ? '止める' : '削除する'}
          destructive={pending?.kind === 'delete'}
          busy={pendingBusy}
          error={pendingError || undefined}
          onConfirm={() => void runPending()}
          onCancel={() => { if (!pendingBusy) { setPending(null); setPendingError('') } }}
        >
          {pending ? <OperationTargetSummary accounts={[{ id: pending.accountId }]} /> : null}
        </ConfirmDialog>
        <QaImportDialog open={importOpen} accountId={accountId} onClose={() => setImportOpen(false)} />
      </>}
    >
      {load.kind === 'loading' ? <ListState kind="loading" /> : null}
      {failure ? <ListState kind="error" title={failure.title} description={failure.description} onRetry={failure.retryable ? () => void fetchList() : undefined} /> : null}
      {load.kind === 'ready' && load.items.length === 0 ? (
        <EmptyList
          icon={<MessageSquareText aria-hidden="true" />}
          title="まだ Q&A がありません"
          description="よくある質問と答えを登録すると、返信案の元になります。自動で答えるは、Q&A を 1 件以上公開すると選べます。"
          create={{ label: 'Q&A を追加', onClick: () => setEdit({}) }}
          canCreate={permissions.editQa}
          filtered={filtered}
          onClearFilters={() => setUrl({ q: '', status: '', page: '1' })}
          action={permissions.importQa && !filtered ? <Button onClick={() => setImportOpen(true)}><Upload size={16} aria-hidden="true" />取り込む</Button> : undefined}
        />
      ) : null}
      {load.kind === 'ready' && load.items.length > 0 ? (
        <DataTable aria-label="Q&A" columnSizing="content">
          <thead>
            <TableHeadRow>
              <Th grow weight={4}>質問</Th>
              <Th grow weight={3}>答えの頭</Th>
              <Th>使われた</Th>
              <Th>状態</Th>
              {permissions.editQa ? <Th><span className="sr-only">操作</span></Th> : null}
            </TableHeadRow>
          </thead>
          <tbody>
            {load.items.map((entry) => {
              const title = entry.questions[0] ?? '—'
              const items = [
                { id: 'edit', label: '編集する', onSelect: () => { setMenuId(null); setEdit({ entry }) } },
                ...(permissions.publishQa && entry.status !== 'published' ? [{ id: 'publish', label: '公開する', onSelect: () => { setMenuId(null); if (accountId && load.scope === accountScope.current) setPending({ kind: 'publish', entry, accountId, scope: load.scope }) } }] : []),
                ...(permissions.publishQa && entry.status === 'published' ? [{ id: 'stop', label: '止める', onSelect: () => { setMenuId(null); if (accountId && load.scope === accountScope.current) setPending({ kind: 'stop', entry, accountId, scope: load.scope }) } }] : []),
                ...(permissions.publishQa ? [{ id: 'delete', label: '削除する', tone: 'danger' as const, onSelect: () => { setMenuId(null); if (accountId && load.scope === accountScope.current) setPending({ kind: 'delete', entry, accountId, scope: load.scope }) } }] : []),
              ]
              return (
                <Tr key={entry.id} data-row-id={entry.id} onClick={permissions.editQa ? () => setEdit({ entry }) : undefined}>
                  <Td grow weight={4} title={title}><TruncatedText value={title} /></Td>
                  <Td grow weight={3} title={entry.answerText}><TruncatedText value={entry.status === 'draft' && entry.source !== 'manual' ? `（${entry.source === 'import_pdf' ? 'PDF' : 'Web'} から取り込み・確かめ待ち）` : entry.answerText} /></Td>
                  <Td>{entry.useCount > 0 ? `${formatNumber(entry.useCount)} 回` : '—'}</Td>
                  <Td><StatusBadge tone={QA_STATUS_TONE[entry.status]}>{QA_STATUS_LABEL[entry.status]}</StatusBadge></Td>
                  {permissions.editQa ? (
                    <ActionCell>
                      <RowMenu appearance="plain" label={`「${title}」の操作`} open={menuId === entry.id} onOpenChange={(next) => setMenuId(next ? entry.id : null)} items={items} />
                    </ActionCell>
                  ) : null}
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      ) : null}
    </ListPage></SaveErrorScope>
  )
}

/** 取り込む（Web）。案は下書きで入り、裏で続く（閉じても止まらない）。PDF は口ができてから足す。 */
function QaImportDialog({ open, accountId, onClose }: { open: boolean; accountId: string; onClose: () => void }) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: open && (address.trim() !== '' || busy), busy: open && busy, onDiscard: onClose })
  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])
  useEffect(() => { guard.cancelLeave() }, [accountId, guard.cancelLeave])
  const current = useRef({ open, busy, accountId, target: guard.leaveTarget })
  current.current = { open, busy, accountId, target: guard.leaveTarget }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const discardAndLeave = () => {
    const target = guard.leaveTarget
    if (!alive.current || !current.current.open || current.current.busy || current.current.accountId !== accountId || !target || current.current.target !== target) return
    current.current.target = null
    guard.disarm(); guard.confirmLeave()
  }
  useEffect(() => { if (open) { setAddress(''); setError(''); setFieldError('') } }, [open])
  const run = async () => {
    const value = address.trim()
    if (!/^https?:\/\/\S+$/.test(value)) { setFieldError('https:// から始まるページの URL を入れてください'); return }
    setFieldError('')
    setBusy(true)
    setError('')
    try {
      await aiReplyApi.importQa(accountId, { kind: 'web', url: value })
      notifyToast('取り込みを始めました。できたら知らせます（案は下書きで入ります）')
      onClose()
    } catch (caught) {
      setError(describeApiFailure(caught, '取り込み'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <><Dialog
      open={open}
      title="Q&A を取り込む"
      description="ページの内容から Q&A の案を作ります。案は下書きで入り、公開するまでお客さまには使いません。1 回 20 件まで。"
      designWidth={520}
      dirty={address.trim() !== ''}
      busy={busy}
      error={error || undefined}
      confirmLabel="取り込む"
      onConfirm={() => void run()}
      onCancel={() => { if (!busy) onClose() }}
    >
      <Field label="ページの URL" htmlFor="qa-import-url" required error={fieldError || undefined}>
        <TextField id="qa-import-url" value={address} invalid={Boolean(fieldError)} onChange={(event) => setAddress(event.target.value)} placeholder="https://example.com/faq" />
      </Field>
    </Dialog><OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={open && guard.leaveTarget !== null} subject="取り込み先の URL" onConfirm={discardAndLeave} onCancel={guard.cancelLeave} busy={busy} /></OverlayDepthContext.Provider></>
  )
}
