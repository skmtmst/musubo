import { lineMessagePreview } from '@line-crm/shared'
import type { ChatListItem } from '@/lib/api'

/**
 * 一覧の 1 行に出す最後のメッセージ。画像・スタンプなどは文字で見せても意味が薄いので種類の言葉にする
 * （絵文字は付けない）。PC の受信箱と電話の画面で同じ言葉にする。
 */
export function chatListPreview(chat: Pick<ChatListItem, 'lastMessageType' | 'lastMessageContent'>): string {
  if (chat.lastMessageType != null && typeof chat.lastMessageType !== 'string') return 'メッセージを確認できません'
  const preview = lineMessagePreview(chat.lastMessageType, chat.lastMessageContent)
  return typeof preview === 'string' ? preview.replace(/\n+/g, ' ').slice(0, 60) : 'メッセージを確認できません'
}
