/** 会話の対応状況。自由に作る対応マークとは別のデータ。 */
export const CHAT_SUPPORT_STATUS = {
  unread: { label: '未対応', tone: 'danger', color: '#ef4444' },
  in_progress: { label: '対応中', tone: 'warning', color: '#f97316' },
  on_hold: { label: '保留', tone: 'neutral', color: '#94a3b8' },
  resolved: { label: '対応済み', tone: 'success', color: '#16a34a' },
} as const;
export type ChatSupportStatus = keyof typeof CHAT_SUPPORT_STATUS;
export const CHAT_SUPPORT_STATUS_ORDER: ChatSupportStatus[] = ['unread','in_progress','on_hold','resolved'];
