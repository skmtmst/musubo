'use client'

import Avatar from '@/components/shared/avatar'
import { CustomerInfoRows } from '@/components/shared/customer-info-rows'
import { InboxEmailHeading } from '@/components/shared/inbox-content'
import TextLink from '@/components/shared/text-link'
import type { ChatListItem } from '@/lib/api'
import { ChannelBadge, formatInboxDatetime } from './inbox-model'
import { formatReplyWindowLeft } from './instagram-conversation'
import type { InstagramReplyState, InstagramThread } from './use-instagram-thread'

const CONNECTION_WORD: Record<InstagramReplyState, string> = {
  ready: 'つながっています',
  permission_required: 'DM の権限なし',
  disconnected: '接続が切れています',
}

/** 右の欄に出す Instagram の相手。LINE の友だちではないので、誰とのやり取りかと、いま返信できるかを出す。 */
export default function InstagramCustomerInfo({ chat, thread }: { chat: ChatListItem; thread: InstagramThread }) {
  const { detail, deadline, now, canEdit } = thread
  const lastMessageAt = detail?.messages.at(-1)?.createdAt ?? chat.lastMessageAt
  // 期限と残りは別の行にする（1行に入れると右の欄の幅で残りが切れる）。
  const open = detail !== null && deadline !== null && now < deadline
  const replyWindow = !detail ? '—'
    : deadline === null ? '受信待ち'
      : open ? formatInboxDatetime(new Date(deadline).toISOString())
        : '過ぎました'
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas" data-inbox-customer="instagram">
      <InboxEmailHeading>
        <p className="text-ink text-sm font-bold">顧客情報</p>
        <p className="text-ink-faint mt-0.5 truncate text-micro">DM の相手を確認できます</p>
      </InboxEmailHeading>
      <div className="flex-1 overflow-y-auto divide-y divide-hairline">
        <section className="flex flex-col items-center px-5 py-5 text-center">
          <Avatar name={chat.friendName} src={chat.friendPictureUrl} size={56} />
          <p className="text-ink mt-2 max-w-full truncate text-sm font-bold" title={chat.friendName}>{chat.friendName}</p>
          <p className="mt-1"><ChannelBadge channel="instagram" /></p>
        </section>
        <section className="px-5 py-4">
          <p className="text-ink text-xs font-medium">やり取り</p>
          <div className="mt-2">
            <CustomerInfoRows rows={[
              { label: '受信経路', value: 'Instagram の DM' },
              { label: '最後のメッセージ', value: formatInboxDatetime(lastMessageAt) },
              { label: '返信の期限', value: replyWindow },
              ...(open && deadline !== null ? [{ label: '残り', value: formatReplyWindowLeft(deadline, now) }] : []),
              { label: '接続', value: detail ? CONNECTION_WORD[detail.replyState] : '—' },
            ]} />
          </div>
          {canEdit && detail && detail.replyState !== 'ready' ? (
            <p className="mt-2">
              <TextLink href="/settings/sns">{detail.replyState === 'permission_required' ? 'メール・SNS連携でつなぎ直す' : 'メール・SNS連携で接続を確認する'}</TextLink>
            </p>
          ) : null}
          <p className="text-ink-faint mt-2 text-xs leading-relaxed">返信できるのは、お客さまの最後のメッセージから24時間です。</p>
        </section>
        <section className="px-5 py-4">
          <p className="text-ink text-xs font-medium">LINE友だちとの連携</p>
          <p className="text-ink-faint mt-2 text-xs leading-relaxed">
            Instagram の相手は、LINE の友だちと結びついていません。
          </p>
        </section>
      </div>
    </div>
  )
}
