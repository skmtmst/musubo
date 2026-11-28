'use client'
import { knownValue } from '@/lib/known-value'
import { DetailContent, DetailField, DetailSection } from '@/components/shared/detail-content'

import { PAGE_SIZES, pageSizeOptions } from '@/components/shared/page-size-options'

/*
 * ★V8 自動応答の「AI が答えた記録」タブ（板 LPkKH、行を押した引き出し V5WpQ）。
 * 要件 G2 §2-1・§4（AI-14・18・19・20）。数の帯 3 つ・したこと／期間・件数・表（日時・お客さま・質問・したこと・元の Q&A）。
 * 行を押すと引き出しに 質問・送った答えの全文・元の Q&A・そのあとの会話。行末「…」に［受信箱で開く］［Q&A に足す］。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Drawer from '@/components/shared/drawer'
import EmptyList from '@/components/shared/empty-list'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'
import { useListUrlState } from '@/components/shared/list-url-state'
import Pagination from '@/components/shared/pagination'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowMenu } from '@/components/shared/row-actions'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { describeApiFailure, loadFailureCopy } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import { ListPage } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatDate, formatNumber } from '@/lib/format'
import { History } from 'lucide-react'
import { aiReplyApi, type AiAnswerLog, type AiAnswerLogDetail, type AiAnswerSummary, type AnswerAction } from './api'
import { AutoReplyTabs } from './auto-reply-tabs'
import QaEditDialog, { type QaDraftSeed } from './qa-edit-dialog'
import { QA_HELP } from './qa-list'
import { useAiSettings } from './use-ai-settings'
import { ACTION_LABEL, ACTION_TONE, QA_STATUS_LABEL, handoffReasonText } from './words'
import styles from './qa-list.module.css'
import { withHonorific } from '@line-crm/shared'

const ACTION_OPTIONS = [
  { value: '', label: 'したこと：すべて' },
  { value: 'answered', label: '答えた' },
  { value: 'handed_off', label: '人へ回した' },
  { value: 'customer_asked_human', label: 'お客さまが「人と話したい」' },
]
const PERIOD_OPTIONS = [
  { value: '7', label: '期間：過去7日' },
  { value: '30', label: '期間：過去30日' },
  { value: '90', label: '期間：過去90日' },
]

type Load = { kind: 'loading' } | { kind: 'ready'; items: AiAnswerLog[]; total: number; summary: AiAnswerSummary } | { kind: 'error'; error: unknown }
type Detail = { kind: 'loading' } | { kind: 'ready'; data: AiAnswerLogDetail } | { kind: 'error'; message: string }

const at = (value: string) => formatDate(value, { style: 'list', fallback: '—' })

export default function AnswerLogV8() {
  const { selectedAccountId } = useAccount()
  const accountId = selectedAccountId ?? ''
  const accountScope = useRef({ accountId })
  if (accountScope.current.accountId !== accountId) accountScope.current = { accountId }
  const { permissions } = useAiSettings(selectedAccountId)
  usePageTitle('AI が答えた記録')
  usePageCrumbs([{ label: '自動応答', href: '/auto-replies' }])
  const [url, setUrl] = useListUrlState({ action: '', days: '30', page: '1', size: '20', log: '' })
  const page = Math.max(1, Number(url.page) || 1)
  const size = Number(url.size) || 20
  const days = Number(url.days) || 30
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [menuId, setMenuId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [seed, setSeed] = useState<QaDraftSeed | null>(null)
  const [stopTarget, setStopTarget] = useState<{ qaEntryId: string; title: string; version: number; scope: { accountId: string }; ticket: object } | null>(null)
  const stopTicket = useRef<object | null>(null)
  const stopLock = useRef<object | null>(null)
  const [detailScope, setDetailScope] = useState<{ accountId: string } | null>(null)
  const detailGeneration = useRef(0)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  const generation = useRef(0)

  const fetchList = useCallback(async () => {
    const mine = ++generation.current
    if (!accountId) { setLoad({ kind: 'ready', items: [], total: 0, summary: { answered: 0, handedOff: 0, askedAgainRate: null } }); return }
    setLoad({ kind: 'loading' })
    try {
      const res = await aiReplyApi.logs(accountId, { action: url.action as AnswerAction | '', days, page, limit: size })
      if (mine !== generation.current) return
      setLoad({ kind: 'ready', ...res.data })
    } catch (error) {
      if (mine !== generation.current) return
      setLoad({ kind: 'error', error })
    }
  }, [accountId, url.action, days, page, size])
  useEffect(() => { void fetchList() }, [fetchList])

  const openLog = useCallback(async (id: string) => {
    const scope = accountScope.current
    const mine = ++detailGeneration.current
    setDetailScope(scope)
    setDetail({ kind: 'loading' })
    try {
      const res = await aiReplyApi.log(accountId, id)
      if (scope !== accountScope.current || mine !== detailGeneration.current) return
      setDetail({ kind: 'ready', data: res.data })
    } catch (caught) {
      if (scope !== accountScope.current || mine !== detailGeneration.current) return
      setDetail({ kind: 'error', message: describeApiFailure(caught, '記録の読み込み') })
    }
  }, [accountId])
  useEffect(() => {
    if (url.log && accountId) void openLog(url.log)
    else { detailGeneration.current += 1; setDetail(null) }
  }, [url.log, accountId, openLog])

  const stopAnswer = async () => {
    if (!stopTarget || stopTarget.scope !== accountScope.current || stopTarget.ticket !== stopTicket.current || stopLock.current === stopTarget.ticket || !stopTarget.scope.accountId) return
    stopLock.current = stopTarget.ticket
    setStopBusy(true)
    setStopError('')
    try {
      await aiReplyApi.stopQa(stopTarget.scope.accountId, stopTarget.qaEntryId, stopTarget.version)
      if (stopTarget.scope !== accountScope.current || stopTicket.current !== stopTarget.ticket) return
      stopTicket.current = null
      notifyToast('この答えを止めました。返信案にも自動の答えにも使いません')
      setStopTarget(null)
      if (url.log) void openLog(url.log)
    } catch (caught) {
      if (stopTarget.scope === accountScope.current && stopTicket.current === stopTarget.ticket) setStopError(describeApiFailure(caught, '止める操作'))
    } finally {
      if (stopLock.current === stopTarget.ticket) { stopLock.current = null; setStopBusy(false) }
    }
  }

  const total = load.kind === 'ready' ? load.total : 0
  const summary = load.kind === 'ready' ? load.summary : null
  const failure = load.kind === 'error' ? loadFailureCopy(load.error, 'AI が答えた記録') : null
  const opened = detailScope === accountScope.current && detail?.kind === 'ready' ? detail.data : null

  return (
    <ListPage
      boardId="LPkKH"
      headingSize="regular"
      heightMode="content"
      title="自動応答"
      help={QA_HELP}
      tabs={<AutoReplyTabs active="ai-log" />}
      stats={<>
        {permissions.viewer ? <ReadOnlyNotice role="status" /> : null}
        <KpiBand aria-label="AI が答えた数">
          <KpiCard title="答えた" value={summary ? summary.answered : null} unit={summary ? '件' : ''} detail={`過去${days}日`} />
          <KpiCard title="人へ回した" value={summary ? summary.handedOff : null} unit={summary ? '件' : ''} detail="答えが見つからない など" />
          <KpiCard title="答えのあとに聞き直し" value={summary?.askedAgainRate ?? null} unit={summary?.askedAgainRate != null ? '%' : ''} detail="同じ人が 30 分以内にもう一度聞いた割合" />
        </KpiBand>
      </>}
      toolbar={<ListToolbarFrame><ListToolbarRow>
        <Select size="content" aria-label="したこと" value={url.action} options={ACTION_OPTIONS} onChange={(action) => setUrl({ action, page: '1' })} />
        <Select size="content" aria-label="期間" value={String(days)} options={PERIOD_OPTIONS} onChange={(next) => setUrl({ days: next, page: '1' })} />
        <ListToolbarEnd>
          <Select size="page-size" aria-label="表示件数" value={String(size)} options={pageSizeOptions(PAGE_SIZES)} onChange={(next) => setUrl({ size: next, page: '1' })} />
        </ListToolbarEnd>
      </ListToolbarRow></ListToolbarFrame>}
      pagination={load.kind === 'ready' && total > size ? <Pagination page={page} pageCount={Math.max(1, Math.ceil(total / size))} onPageChange={(next) => setUrl({ page: String(next) })} range={{ total, first: (page - 1) * size + 1, last: Math.min(total, page * size) }} /> : undefined}
      overlays={<>
        <Drawer
          open={detail !== null && detailScope === accountScope.current}
          title="AI が答えた記録"
          description={opened ? `${at(opened.createdAt)}・${withHonorific(opened.friendName, 'さん', { space: true })}` : undefined}
          closeAppearance="box"
          heightMode="viewport"
          onClose={() => setUrl({ log: '' })}
          status={opened ? <StatusBadge tone={knownValue(ACTION_TONE, opened.action, 'neutral' as const)}>{knownValue(ACTION_LABEL, opened.action, '内容を確認できません')}</StatusBadge> : null}
          actions={{ primary: opened ? <Button variant="primary" href={`/chats?friend=${encodeURIComponent(opened.friendId)}`}>受信箱で会話を開く</Button> : null, menuItems: [...(opened?.qa ? [{id: 'open-qa', label: 'Q&A を開く', href: '/auto-replies?tab=qa'}] : []), ...(opened && opened.qa && opened.qa.status === 'published' && opened.action === 'answered' ? [{ allowed: permissions.publishQa, id: 'detail-0', label: "この答えを止める", onSelect: () => { if (!detailScope || detailScope !== accountScope.current) return; setStopError(''); const ticket = {}; stopTicket.current = ticket; setStopTarget({ qaEntryId: opened.qa!.id, title: opened.qa!.title, version: opened.qa!.version, scope: detailScope, ticket }); } }] : [])] }}
        >
<DetailContent>
          {detail?.kind === 'loading' ? <ListState kind="loading" /> : null}
          {detail?.kind === 'error' ? <ListState kind="error" title="記録を読み込めませんでした" description={detail.message} onRetry={() => void openLog(url.log)} /> : null}
          {opened ? <LogDetailBody log={opened} /> : null}

</DetailContent>
</Drawer>
        <QaEditDialog
          open={seed !== null}
          accountId={accountId}
          seed={seed}
          canPublish={permissions.publishQa}
          onSaved={() => setSeed(null)}
          onClose={() => setSeed(null)}
        />
        <ConfirmDialog
          open={stopTarget !== null && stopTarget.scope === accountScope.current}
          title={`「${stopTarget?.title ?? ''}」の答えを止めますか？`}
          description="止めると、この Q&A を返信案にも自動の答えにも使いません。すでに送った答えは取り消せません。あとから公開し直せます。"
          confirmLabel="止める"
          busy={stopBusy && stopLock.current === stopTarget?.ticket}
          error={stopError || undefined}
          onConfirm={() => void stopAnswer()}
          onCancel={() => { if (stopLock.current !== stopTarget?.ticket) { stopTicket.current = null; setStopTarget(null) } }}
        ><OperationTargetSummary accounts={[{ id: stopTarget?.scope.accountId ?? '' }]} /></ConfirmDialog>
      </>}
    >
      {load.kind === 'loading' ? <ListState kind="loading" /> : null}
      {failure ? <ListState kind="error" title={failure.title} description={failure.description} onRetry={failure.retryable ? () => void fetchList() : undefined} /> : null}
      {load.kind === 'ready' && load.items.length === 0 ? (
        <EmptyList
          icon={<History aria-hidden="true" />}
          title="まだ記録がありません"
          description="自動で答えるをオンにすると、AI が答えた・人へ回した記録がここに残ります。"
          filtered={Boolean(url.action)}
          onClearFilters={() => setUrl({ action: '', page: '1' })}
        />
      ) : null}
      {load.kind === 'ready' && load.items.length > 0 ? (
        <DataTable aria-label="AI が答えた記録" columnSizing="content">
          <thead>
            <TableHeadRow>
              <Th grow weight={1}>日時</Th>
              <Th grow weight={1}>お客さま</Th>
              <Th grow weight={3}>質問</Th>
              <Th>したこと</Th>
              <Th grow weight={2}>元の Q&A</Th>
              <Th><span className="sr-only">操作</span></Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {load.items.map((log) => (
              <Tr key={log.id} data-row-id={log.id} onClick={() => setUrl({ log: log.id })}>
                <Td grow weight={1}>{at(log.createdAt)}</Td>
                <Td grow weight={1} title={log.friendName}><TruncatedText value={log.friendName} /></Td>
                <Td grow weight={3} title={log.questionText}><TruncatedText value={log.questionText} /></Td>
                <Td><StatusBadge tone={knownValue(ACTION_TONE, log.action, 'neutral' as const)}>{knownValue(ACTION_LABEL, log.action, '内容を確認できません')}</StatusBadge></Td>
                <Td grow weight={2} title={log.qaTitle ?? handoffReasonText(log.handoffReason)}><TruncatedText value={log.qaTitle ?? '—'} /></Td>
                <ActionCell>
                  <RowMenu
                    appearance="plain"
                    label={`${at(log.createdAt)} の記録の操作`}
                    open={menuId === log.id}
                    onOpenChange={(next) => setMenuId(next ? log.id : null)}
                    items={[
                      { id: 'inbox', label: '受信箱で開く', href: `/chats?friend=${encodeURIComponent(log.friendId)}`, onSelect: () => setMenuId(null) },
                      ...(permissions.editQa && log.action !== 'answered' ? [{ id: 'add-qa', label: 'Q&A に足す', onSelect: () => { setMenuId(null); setSeed({ question: log.questionText }) } }] : []),
                    ]}
                  />
                </ActionCell>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      ) : null}
    </ListPage>
  )
}

/** 引き出しの中身（V5WpQ）。送った答えは控え（その時の版）を出し、今の Q&A と違えば知らせる（AI-19）。 */
function LogDetailBody({ log }: { log: AiAnswerLogDetail }) {
  const differs = Boolean(log.qa && log.answerText && log.qa.currentAnswerText !== log.answerText)
  return (
    <div className={styles.drawerBody}>
      <DetailSection title="お客さまの質問">
        <DetailField label="質問" multiline>{log.questionText}</DetailField>
      </DetailSection>
      <DetailSection title="送った答え（全文）">
        {log.answerText ? <DetailField label="送った答え" multiline>{log.answerText}</DetailField> : <p className={styles.after}>答えを送っていません（{handoffReasonText(log.handoffReason)}）</p>}
        <div className={styles.answerMeta}>

          {log.answerText ? <span>自動で送ったため取り消せません</span> : null}
        </div>
      </DetailSection>
      <DetailSection title="元の Q&A">
        {log.qa ? (
          <DetailField label="Q&A" note={`${knownValue(QA_STATUS_LABEL, log.qa.status, '状態を確認できません')}・使われた ${formatNumber(log.qa.useCount)} 回・最後に直した ${formatDate(log.qa.updatedAt, { style: 'list-day', fallback: '—' })}`}>{log.qa.title}
            {differs ? <p className={styles.differs}>今の答えと違います（送った時の答えを出しています）</p> : null}
          </DetailField>
        ) : <p className={styles.after}>—</p>}
      </DetailSection>
      <DetailSection title="そのあとの会話">
        {log.afterNote ? <p className={styles.after}>{log.afterNote}</p> : null}

      </DetailSection>
    </div>
  )
}
