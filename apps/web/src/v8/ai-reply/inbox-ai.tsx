'use client'

/*
 * 受信箱の会話の AI（板 l1i3v：要約と返信案、OmV7B：AI が使えない帯）。要件 G2 §2-1・§2-2・§2-6・§4（AI-01〜06・20・22・28・29）。
 * - 使っていない店：何も出さない（空の枠も出さない）。会話の右上「…」に［AI の返信案を使う］（管理者以上）
 * - 要約：会話の頭の下。3 行・作った時刻（○時点）。そのあと受信があれば「新しいメッセージがあります［作り直す］」
 * - 返信案：入力欄の上。案の文・元にした物の札・［入力欄に入れる］［作り直す］［使わない］。送るのはいつも担当者
 * - 止まっている・混んでいる：小さな帯だけ。入力欄はふつうに使える
 * 閲覧のみ：要約は見える・返信案は隠す。代理ログイン：要約は見える（伏せた形）・返信案は出さない。
 */
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudOff, CornerDownLeft, RefreshCw, Sparkles } from 'lucide-react'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { RowMenu } from '@/components/shared/row-actions'
import { classifyApiFailure, describeApiFailure } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import { ApiError } from '@/lib/api'
import { formatDate, formatNumber } from '@/lib/format'
import { conversationAiUiEnabled } from '@/lib/environment-features'
import { aiReplyApi, type ChatDraft, type ChatSummary } from './api'
import { useAiSettings } from './use-ai-settings'
import styles from './inbox-ai.module.css'

type Part<T> = { kind: 'idle' } | { kind: 'loading'; prev: T | null } | { kind: 'ready'; data: T } | { kind: 'error'; busy: boolean; message: string }

interface ChatMessageLike { id: string; direction: string }

const BUSY_MESSAGE = 'AI が混んでいます。少し待ってから［作り直す］を押してください。'

function failureText(error: unknown, action: string): { busy: boolean; message: string } {
  const kind = classifyApiFailure(error)
  const busy = kind === 'rateLimited' || (error instanceof ApiError && (error.status === 503 || error.status === 504))
  return { busy, message: busy ? BUSY_MESSAGE : describeApiFailure(error, action) }
}

const time = (value: string) => formatDate(value, { style: 'time', fallback: '' })

/**
 * 受信箱の 1 つの会話の AI の状態。画面（inbox-chat/screen.tsx）が 1 回呼び、出す部品へ渡す。
 * messages は今の会話の吹き出し（最後の受信の id で「新しいメッセージ」と［使わない］の続きを決める）。
 */
export function useInboxAi(chatIdIn: string | null, accountIdIn: string | null, messages: ChatMessageLike[] | undefined) {
  /* 会話の AI を出さない間は、設定も要約も返信案も読まない。 */
  const enabled = conversationAiUiEnabled()
  const chatId = enabled ? chatIdIn : null
  const accountId = enabled ? accountIdIn : null
  const ai = useAiSettings(accountId)
  const active = enabled && (ai.mode === 'draft_only' || ai.mode === 'auto_qa')
  const lastIncomingId = [...(messages ?? [])].reverse().find((message) => message.direction === 'incoming')?.id ?? null
  const [summary, setSummary] = useState<Part<ChatSummary>>({ kind: 'idle' })
  const [draft, setDraft] = useState<Part<ChatDraft>>({ kind: 'idle' })
  const [summaryOpen, setSummaryOpen] = useState(true)
  /** ［使わない］を押した会話と、その時の最後の受信。新しい受信が来るまで出さない（AI-05）。 */
  const [dismissed, setDismissed] = useState<Record<string, string | null>>({})
  const chatRef = useRef(chatId)
  chatRef.current = chatId
  const scope = useRef({ chatId, accountId })
  if (scope.current.chatId !== chatId || scope.current.accountId !== accountId) scope.current = { chatId, accountId }
  const summarySeq = useRef(0)
  useEffect(() => () => { summarySeq.current += 1 }, [])

  const loadSummary = useCallback(async (refresh: boolean) => {
    if (!chatId) return
    const mine = chatId
    const requestScope = scope.current
    const seq = ++summarySeq.current
    const current = () => scope.current === requestScope && summarySeq.current === seq
    setSummary((current) => ({ kind: 'loading', prev: current.kind === 'ready' ? current.data : current.kind === 'loading' ? current.prev : null }))
    try {
      const res = await aiReplyApi.summary(mine, refresh)
      if (current()) setSummary({ kind: 'ready', data: res.data })
    } catch (error) {
      if (current()) setSummary({ kind: 'error', ...failureText(error, '要約') })
    }
  }, [chatId, accountId])

  const loadDraft = useCallback(async () => {
    if (!chatId) return
    const mine = chatId
    setDraft((current) => ({ kind: 'loading', prev: current.kind === 'ready' ? current.data : current.kind === 'loading' ? current.prev : null }))
    try {
      const res = await aiReplyApi.draft(mine)
      if (chatRef.current === mine) setDraft({ kind: 'ready', data: res.data })
    } catch (error) {
      if (chatRef.current === mine) setDraft({ kind: 'error', ...failureText(error, '返信案') })
    }
  }, [chatId])

  const isDismissed = Boolean(chatId && chatId in dismissed && dismissed[chatId] === lastIncomingId)

  useEffect(() => {
    setSummary({ kind: 'idle' })
    setDraft({ kind: 'idle' })
    setSummaryOpen(true)
  }, [chatId, accountId])

  useEffect(() => {
    if (!chatId || !active || !ai.permissions.seeSummary) return
    void loadSummary(false)
  }, [chatId, active, ai.permissions.seeSummary, loadSummary])

  useEffect(() => {
    if (!chatId || !active || !ai.permissions.useDraft || isDismissed || !lastIncomingId) return
    void loadDraft()
  }, [chatId, active, ai.permissions.useDraft, isDismissed, lastIncomingId, loadDraft])

  return {
    ai,
    active,
    lastIncomingId,
    summary,
    summaryOpen,
    setSummaryOpen,
    draft,
    isDismissed,
    dismiss: () => { if (chatId) setDismissed((current) => ({ ...current, [chatId]: lastIncomingId })) },
    reloadSummary: () => loadSummary(true),
    reloadDraft: loadDraft,
  }
}

export type InboxAi = ReturnType<typeof useInboxAi>

/** 会話の頭の下：要約（l1i3v）か、AI が使えない帯（OmV7B）。使っていない店では何も出さない。 */
export function InboxAiSummary({ inboxAi }: { inboxAi: InboxAi }) {
  if (!conversationAiUiEnabled()) return null
  const { ai, active, summary, summaryOpen, setSummaryOpen, lastIncomingId } = inboxAi
  if (ai.mode === 'suspended' || (summary.kind === 'error' && summary.busy)) {
    return (
      <div className={styles.unavailable} role="status" data-design-node="OmV7B">
        <CloudOff size={16} aria-hidden="true" />
        <span>AI が使えません（混んでいます）。要約と返信案は止めています。返事はいつもどおり送れます。</span>
      </div>
    )
  }
  if (!active || !ai.permissions.seeSummary || summary.kind === 'idle') return null
  const data = summary.kind === 'ready' ? summary.data : summary.kind === 'loading' ? summary.prev : null
  const stale = Boolean(data && lastIncomingId && data.basedOnMessageId && data.basedOnMessageId !== lastIncomingId)
  return (
    <section className={styles.summary} aria-label="要約" data-design-node="l1i3v">
      <header className={styles.head}>
        <Sparkles size={16} aria-hidden="true" />
        <span className={styles.title}>要約</span>
        {data ? <span className={styles.meta}>{`${time(data.generatedAt)} 時点${data.messageCount ? `・最新 ${formatNumber(data.messageCount)} 件から` : ''}`}</span> : null}
        <span className={styles.spacer} />
        <RowMenu
          appearance="box"
          label="要約の操作"
          items={[
            { id: 'refresh', label: '作り直す', onSelect: () => void inboxAi.reloadSummary() },
            { id: 'fold', label: summaryOpen ? '畳む' : '開く', onSelect: () => setSummaryOpen(!summaryOpen) },
          ]}
        />
      </header>
      {summaryOpen ? (
        summary.kind === 'error' ? <p className={styles.error}>{summary.message}</p>
          : data ? <ul className={styles.lines}>{data.lines.slice(0, 3).map((line, index) => <li key={index}>{line}</li>)}</ul>
            : <p className={styles.meta}>要約を作っています…</p>
      ) : null}
      {summaryOpen && stale ? (
        <p className={styles.stale}>
          新しいメッセージがあります
          <Button size="compact" onClick={() => void inboxAi.reloadSummary()} busy={summary.kind === 'loading'}>作り直す</Button>
        </p>
      ) : null}
    </section>
  )
}

/** 入力欄の上：返信案（l1i3v）。入力欄の位置は動かさない（会話の側が縮む）。 */
export function InboxAiDraft({ inboxAi, onInsert }: { inboxAi: InboxAi; onInsert: (text: string) => void }) {
  if (!conversationAiUiEnabled()) return null
  const { ai, active, draft, isDismissed } = inboxAi
  if (!active || !ai.permissions.useDraft || isDismissed || draft.kind === 'idle') return null
  if (draft.kind === 'error' && draft.busy) return null
  const data = draft.kind === 'ready' ? draft.data : draft.kind === 'loading' ? draft.prev : null
  const loading = draft.kind === 'loading'
  return (
    <section className={styles.draft} aria-label="返信案" data-design-node="l1i3v">
      <header className={styles.head}>
        <Sparkles size={16} aria-hidden="true" />
        <span className={styles.title}>返信案</span>
        {data?.sources.map((source) => (
          <span key={`${source.type}-${source.id}`} className={styles.source} title={source.title}>{source.type === 'qa' ? `Q&A ${source.title}` : `過去の返事 ${source.title}`}</span>
        ))}
      </header>
      {draft.kind === 'error' ? <p className={styles.error}>{draft.message}</p> : data ? <p className={styles.text}>{data.text}</p> : <p className={styles.meta}>返信案を作っています…</p>}
      <div className={styles.actions}>
        <Button size="compact" disabled={!data || loading} onClick={() => { if (data) { onInsert(data.text); notifyToast('返信案を入力欄に入れました。直してから送ってください') } }}>
          <CornerDownLeft size={16} aria-hidden="true" />入力欄に入れる
        </Button>
        <Button size="compact" busy={loading} onClick={() => void inboxAi.reloadDraft()}>
          <RefreshCw size={16} aria-hidden="true" />作り直す
        </Button>
        <Button size="compact" onClick={inboxAi.dismiss}>使わない</Button>
        <span className={styles.spacer} />
        <span className={styles.meta}>送るのは担当者です</span>
      </div>
    </section>
  )
}

/** 使っていない店の会話の右上「…」（AI-01）。管理者以上だけ［AI の返信案を使う］。確かめの窓を通して返信案だけにする。 */
export function InboxAiHeadMenu({ inboxAi, accountId }: { inboxAi: InboxAi; accountId: string | null }) {
  const { ai } = inboxAi
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saveErrors = useSaveFormErrors()
  if (!conversationAiUiEnabled() || ai.status !== 'ready' || ai.mode !== 'off' || !ai.permissions.modeChoices.includes('draft_only') || !accountId) return null
  const turnOn = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await aiReplyApi.saveSettings(accountId, { mode: 'draft_only', expectedVersion: ai.settings?.version ?? 0 })
      ai.setSettings(res.data)
      setOpen(false)
      notifyToast('AI の返信案を使い始めました')
    } catch (caught) {
      if (!saveErrors.capture(caught)) setError(describeApiFailure(caught, 'AI の使い方の変更'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SaveErrorScope errors={saveErrors}>
      <RowMenu appearance="box" label="会話のほかの操作" items={[{ id: 'ai-on', label: 'AI の返信案を使う', onSelect: () => { setError(''); setOpen(true) } }]} />
      <ConfirmDialog
        open={open}
        title="AI の返信案を使いますか？"
        description="この店の受信箱に要約と返信案が出ます。送るのはいつも担当者です。AI に渡す前に、電話番号・住所などは伏せます。"
        confirmLabel="使う"
        busy={busy}
        error={error || undefined}
        onConfirm={() => void turnOn()}
        onCancel={() => { if (!busy) setOpen(false) }}
      />
    </SaveErrorScope>
  )
}
