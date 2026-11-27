import type { Chat, SavedSearch } from '@line-crm/shared'

/**
 * 会話詳細のメッセージ1件（`GET /api/chats/:id` の実応答）。
 * `messages_log` の行をそのまま写す。送信向きは `direction: 'outgoing'` で
 * 見分け、`senderType` という名の項目は口に存在しない。
 */
export interface ChatDetailMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  /** LINE上で送信取消されたため、本文・添付は表示しない。 */
  isUnsent: boolean
  source: string | null
  originKind: string | null
  sentByStaffId: string | null
  sentByStaffName: string | null
  scenarioName: string | null
  /** 引用返信のとき、引用元の要約。取り消された引用元は isUnsent: true で本文は空。 */
  quoted: {
    id: string
    direction: 'incoming' | 'outgoing'
    messageType: string
    content: string
    isUnsent: boolean
    createdAt: string | null
  } | null
  createdAt: string
  /** LINEイベントの起こった時刻。無いときは保存時刻(createdAt)と同じ扱い。 */
  eventAt?: string | null
}

/** `GET /api/chats/:id/scheduled` が返す送信予約1件。 */
export interface ScheduledChatSend {
  id: string
  messageType: string
  content: string
  quotedMessageId: string | null
  scheduledAt: string
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled'
  attemptCount: number
  lastErrorCode: string | null
  createdAt: string
}

/** `GET /api/chats` が返す、受信箱一覧専用の会話行。 */
export type ChatListItem = Chat & {
  friendName: string
  operatorName?: string | null
  friendPictureUrl: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  /** ログイン中の担当者だけの未読。対応状況とは別。 */
  isUnread: boolean
  /** 担当者ごとの未読受信数。旧バージョンの口では省略。 */
  unreadCount?: number
  /** 友だち一覧と共通の注目印。旧応答では未指定。 */
  isAttention?: boolean
}

/** `GET /api/chats/:id` の実応答。一覧にだけある値は省略される。 */
export type ChatDetail = Pick<ChatListItem,
  'id' | 'friendId' | 'operatorId' | 'status' | 'notes' | 'revision' | 'lastMessageAt' | 'createdAt'
> & {
  friendName: string
  friendRealName: string | null
  operatorName?: string | null
  friendPictureUrl: string | null
  isAttention: boolean
  lastMessageContent?: string | null
  lastMessageDirection?: 'incoming' | 'outgoing' | null
  lastMessageType?: string | null
  updatedAt?: string
  messages: ChatDetailMessage[]
  hasMoreMessages: boolean
  total: number
}

/** 受信箱の保存検索は友だち検索と条件JSONの形が違うため、ここでは未知値として受ける。 */
export type InboxSavedViewApiItem = Omit<SavedSearch, 'conditions'> & {
  conditions: unknown
  isFavorite: boolean
  matchCount: number | null
  matchCountCapped: boolean
}
