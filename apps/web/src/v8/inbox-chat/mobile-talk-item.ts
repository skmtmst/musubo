import type { MobileTalkItem } from '@/components/templates'
import type { ChatListItem } from '@/lib/api'
import { formatListRecent, formatListRecentTitle } from '@/lib/format'
import { mobileTalkHref } from '@/lib/mobile-shell'
import { chatListPreview } from './list-preview'

/** 一覧の 1 件を電話の会話の一覧の形へ。 */
export function talkItem(chat: ChatListItem): MobileTalkItem {
  const preview = chatListPreview(chat)
  const knownUnread = typeof chat.isUnread === 'boolean'
  return {
    id: chat.id,
    name: typeof chat.friendName === 'string' ? chat.friendName : '名前を確認できません',
    pictureUrl: chat.friendPictureUrl,
    preview: knownUnread ? preview : `未読状態を確認できません${preview ? `・${preview}` : ''}`,
    outgoing: chat.lastMessageDirection === 'outgoing',
    time: formatListRecent(chat.lastMessageAt),
    timeTitle: formatListRecentTitle(chat.lastMessageAt),
    unread: knownUnread && chat.isUnread,
    href: mobileTalkHref(chat.friendId),
  }
}
