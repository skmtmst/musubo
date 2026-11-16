'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { InboxEmailHeading } from '@/components/shared/inbox-content'
import { InboxDraftArea, InboxInputBox, InboxComposerBottom, InboxComposerActions } from '@/components/shared/inbox-composer'
import { InboxMessage } from '@/components/shared/inbox-thread'
import { InboxComposer, InboxConversationPane, InboxMessages } from '@/components/templates/inbox-page'
import { api, type ChatListItem } from '@/lib/api'
import { canEditFeature } from '@/lib/staff-capability'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { formatTime } from '@/lib/format'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { ChannelBadge } from './inbox-model'

type Message = { id: string; content: string; createdAt: string; direction: 'incoming' | 'outgoing' }
type Detail = { messages: Message[]; replyState: 'ready' | 'disconnected' | 'permission_required' }

export default function InstagramConversation({ chat, role, onChanged }: { chat: ChatListItem; role: string | null; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const lock = useRef(false)
  const key = useRef<string | null>(null)
  const account = chat.lineAccountId ?? ''
  const load = useCallback(async () => {
    const result = await api.instagram.conversation(account, chat.friendId)
    if (!result.success) throw new Error('会話を読み込めませんでした')
    setDetail(result.data)
  }, [account, chat.friendId])
  useEffect(() => {
    let active = true
    setDetail(null); setText(''); setError(''); key.current = null
    void api.instagram.conversation(account, chat.friendId).then(result => {
      if (active && result.success) setDetail(result.data)
    }).catch(() => { if (active) setError('会話を読み込めませんでした') })
    if (canEditFeature('/chats', role) && !readStaffIdentity()?.readOnly) void api.instagram.markConversationRead(account, chat.friendId).then(() => { if (active) { onChanged(); window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) } }).catch(() => undefined)
    return () => { active = false }
  }, [account, chat.friendId, role])
  const incoming = detail?.messages.filter(m => m.direction === 'incoming').at(-1)
  const canEdit = canEditFeature('/chats', role) && !readStaffIdentity()?.readOnly
  const canSend = canEdit && detail?.replyState === 'ready' && Boolean(incoming)
  const reason = !canEdit ? '閲覧のみの権限では返信できません。'
    : detail?.replyState === 'disconnected' ? '接続が切れているため返信できません。Instagramの接続を確認してください。'
      : detail?.replyState === 'permission_required' ? 'DMの権限がありません。Instagramをつなぎ直してください。' : ''
  const send = async () => {
    if (!incoming || !canSend || !text.trim() || lock.current) return
    lock.current = true; setSending(true); setError('')
    key.current ??= crypto.randomUUID()
    try {
      await api.instagram.sendReply(account, incoming.id, text, key.current)
      setText(''); key.current = null
      await load(); onChanged(); window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch (err) { setError(err instanceof Error ? err.message : '返信できませんでした') }
    finally { lock.current = false; setSending(false) }
  }
  return <InboxConversationPane selected>
    <InboxEmailHeading>{chat.friendName} <ChannelBadge channel="instagram" /></InboxEmailHeading>
    <InboxMessages>{detail?.messages.map((message, index) => <InboxMessage key={`${message.direction}:${message.id}`} outgoing={message.direction === 'outgoing'} last={index === detail.messages.length - 1} time={formatTime(message.createdAt)} senderName={message.direction === 'outgoing' ? '担当者' : undefined}>{message.content}</InboxMessage>)}</InboxMessages>
    <InboxComposer>
      {reason ? <Notice tone="warn" message={reason} /> : null}
      {error ? <Notice tone="danger" message={error} /> : null}
      <InboxInputBox><InboxDraftArea aria-label="メッセージを入力" placeholder="メッセージを入力" value={text} disabled={!canSend || sending} maxLength={1000} onChange={event => { setText(event.target.value); key.current = null }} />
        <InboxComposerBottom><InboxComposerActions><Button disabled={!canSend || !text.trim() || sending} title={reason || undefined} onClick={() => void send()}>送る</Button></InboxComposerActions></InboxComposerBottom>
      </InboxInputBox>
    </InboxComposer>
  </InboxConversationPane>
}
