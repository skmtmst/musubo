'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { Field, TextArea } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import { InboxComposerActions, InboxComposerBottom, InboxDraftArea, InboxDraftCount, InboxInputBox } from '@/components/shared/inbox-composer'
import { InboxMessage, InboxMessageDay, InboxThreadLoading } from '@/components/shared/inbox-thread'
import { InboxComposer, InboxConversationPane, InboxMessages } from '@/components/templates/inbox-page'
import type { ChatListItem } from '@/lib/api'
import { formatListRecent, formatTime } from '@/lib/format'
import ConversationHead from './conversation-head'
import { formatDayJa, formatInboxDatetime, sameYmd } from './inbox-model'
import type { InstagramResolveOutcome, InstagramThread } from './use-instagram-thread'

/** Instagram が受け付ける返信の長さ（Worker と同じ上限）。 */
const INSTAGRAM_REPLY_MAX_LENGTH = 1000

const RESOLVE_TEXT: Record<InstagramResolveOutcome, { title: string; description: string; confirm: string }> = {
  sent: {
    title: '送信済みにしますか？',
    description: 'Instagram のアプリで、この返信がお客さまに届いていることを確かめてから記録してください。記録すると次の返信を送れます。',
    confirm: '送信済みにする',
  },
  not_sent: {
    title: '未送信にしますか？',
    description: 'Instagram のアプリで、この返信が届いていないことを確かめてから記録してください。入力欄が空なら同じ文を戻すので、送り直すかを選べます。',
    confirm: '未送信にする',
  },
}

/** 返信の期限までの残り（「あと5時間」「あと12分」）。 */
export function formatReplyWindowLeft(deadline: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((deadline - now) / (60 * 1000)))
  return minutes < 60 ? `あと${minutes}分` : `あと${Math.floor(minutes / 60)}時間`
}

/** 吹き出しに出す返信の文の頭（長い文は省く）。 */
function quoteHead(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat
}

/**
 * 受信箱の中央に出す Instagram の会話。頭・吹き出し・返信欄は LINE の会話と同じ部品を使う。
 * Instagram には担当・対応状況が無いので、頭はそれを出さず、右の欄の出し入れだけ置く。
 */
export default function InstagramConversation({ chat, thread, panel, onBack }: {
  chat: ChatListItem
  thread: InstagramThread
  panel: { open: boolean; onToggle: () => void }
  onBack: () => void
}) {
  const router = useRouter()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState<InstagramResolveOutcome | null>(null)
  const [reason, setReason] = useState('')
  const [closedNotice, setClosedNotice] = useState('')
  const [closedWarning, setClosedWarning] = useState('')
  const { detail, loadFailed, reload, text, setText, sending, sendError, send, canEdit, canConfirmNotSent, canSend, lockedReason, blockedReason, deadline, now, pending, resolve, resolving, resolveError, resolveNotice, pendingNow, clearResolveError } = thread
  const messages = detail?.messages ?? []
  const lastMessageAt = messages.at(-1)?.createdAt ?? chat.lastMessageAt

  // 開いた時・送った後は、いちばん新しい吹き出しを見せる。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [messages.length])

  const openSettings = canEdit && detail && detail.replyState !== 'ready'
    ? <Button variant="text" size="inline" onClick={() => router.push('/settings/sns')}>設定を開く</Button>
    : undefined
  const resolveActions = pending?.canResolve && canConfirmNotSent
    ? <>
        <Button variant="secondary" size="field" onClick={() => { clearResolveError(); setReason(''); setConfirming('sent') }}>送信済みにする</Button>
        {openSettings}
        {canConfirmNotSent && pending.canResolveNotSent ? <Button variant="secondary" size="field" onClick={() => { clearResolveError(); setReason(''); setConfirming('not_sent') }}>未送信にする</Button> : null}
      </>
    : <>{openSettings}<Button variant="text" size="inline" onClick={() => void reload()}>読み直す</Button></>

  return (
    <InboxConversationPane selected data-inbox-channel="instagram">
      <ConversationHead
        name={chat.friendName}
        pictureUrl={chat.friendPictureUrl}
        sub={`Instagram・${formatListRecent(lastMessageAt)}`}
        subTitle={`Instagram・最終受信 ${formatInboxDatetime(lastMessageAt)}`}
        onBack={onBack}
        panel={panel}
      />
      {loadFailed ? (
        <Notice tone="danger" role="alert" message="会話を読み込めませんでした。" action={<Button variant="text" size="inline" onClick={() => void reload()}>もう一度読み込む</Button>} />
      ) : null}
      <InboxMessages ref={scrollerRef}>
        <InboxThreadLoading loading={!detail && !loadFailed}>
          {messages.map((message, index) => (
            <Fragment key={`${message.direction}:${message.id}`}>
              {index === 0 || !sameYmd(messages[index - 1].createdAt, message.createdAt)
                ? <InboxMessageDay first={index === 0}>{formatDayJa(message.createdAt)}</InboxMessageDay>
                : null}
              <InboxMessage
                outgoing={message.direction === 'outgoing'}
                last={index === messages.length - 1}
                time={formatTime(message.createdAt)}
                senderName={message.direction === 'outgoing' ? '担当者' : undefined}
                sendStatus={message.direction === 'outgoing' ? 'sent' : undefined}
              >
                {message.content}
              </InboxMessage>
            </Fragment>
          ))}
        </InboxThreadLoading>
      </InboxMessages>
      <InboxComposer>
        {detail?.lateEchoNotice && closedNotice !== `${chat.id}:${detail.lateEchoNotice}` ? <Notice tone="warn" role="alert" message={detail.lateEchoNotice} onClose={() => setClosedNotice(`${chat.id}:${detail.lateEchoNotice ?? ''}`)} /> : null}
        {detail?.reconciliationWarning && closedWarning !== `${chat.id}:${detail.reconciliationWarning}` ? <Notice tone="warn" role="alert" message={detail.reconciliationWarning} onClose={() => setClosedWarning(`${chat.id}:${detail.reconciliationWarning ?? ''}`)} /> : null}
        {resolveNotice ? <Notice tone="success" role="status" message={resolveNotice} /> : null}
        {pending ? (
          <Notice tone="warn" role="status" actionLayout="stack-on-narrow" message={(pending.canResolveNotSent || !pending.resolveAt ? `「${quoteHead(pending.content)}」の送信結果が分かりません。Instagram で送信結果を確認してください。` : `送信結果の反映を待っています。未送信の確定まで${formatReplyWindowLeft(Date.parse(pending.resolveAt ?? ""), pendingNow)}です。`) + (detail?.replyState !== 'ready' ? ' Instagram をつなぎ直すと照合できます。' : '') + (!canConfirmNotSent ? ' 管理者に確定を頼んでください。' : '')} action={resolveActions} />
        ) : blockedReason ? (
          <Notice tone="warn" role="status" message={blockedReason} action={openSettings} />
        ) : null}
        {pending?.warning && !detail?.reconciliationWarning ? <Notice tone="warn" role="alert" message={pending.warning} /> : null}
        {sendError ? <Notice tone="danger" role="alert" message={sendError} /> : null}
        <InboxInputBox>
          <InboxDraftArea
            aria-label="メッセージを入力"
            placeholder="メッセージを入力"
            value={text}
            disabled={!canSend || sending}
            maxLength={INSTAGRAM_REPLY_MAX_LENGTH}
            onChange={(event) => setText(event.target.value)}
          />
          <InboxComposerBottom>
            {canSend && deadline !== null ? (
              <InboxDraftCount data-instagram-reply-window="">
                {`返信の期限 ${formatInboxDatetime(new Date(deadline).toISOString())}（${formatReplyWindowLeft(deadline, now)}）`}
              </InboxDraftCount>
            ) : null}
            <InboxComposerActions>
              <Button disabled={!canSend || !text.trim()} lockedReason={lockedReason} busy={sending} busyLabel="送信中…" onClick={() => void send()}>
                送る
              </Button>
            </InboxComposerActions>
          </InboxComposerBottom>
        </InboxInputBox>
      </InboxComposer>
      <ConfirmDialog
        open={confirming !== null && pending !== null}
        title={confirming ? RESOLVE_TEXT[confirming].title : ''}
        description={confirming ? RESOLVE_TEXT[confirming].description : ''}
        confirmLabel={confirming ? RESOLVE_TEXT[confirming].confirm : ''}
        busy={resolving}
        busyLabel="記録しています…"
        error={resolveError || undefined}
        onConfirm={() => {
          if (!confirming) return
          // 共通の窓は返した約束を待つ間、押し直しを受けない（記録を2回送らない）。
          return resolve(confirming, confirming === 'not_sent' ? reason : undefined).then((done) => {
            if (done) { setReason(''); setConfirming(null) }
          })
        }}
        onCancel={() => { if (!resolving) { setReason(''); setConfirming(null) } }}
      >
        {pending ? <p className="text-ink-secondary text-sm">{`返信：「${quoteHead(pending.content)}」`}</p> : null}
        {confirming === 'not_sent' ? (
          <Field label="確認した理由" optional htmlFor="ig-resolve-reason" note="Instagram で届いていないことを確かめてから入力してください。自動照合できない場合は理由が必要です。">
            <TextArea
              id="ig-resolve-reason"
              aria-label="確認した理由"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={resolving}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        ) : null}
      </ConfirmDialog>
    </InboxConversationPane>
  )
}
