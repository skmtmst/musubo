import { type ImageUploaderValue } from '@/components/shared/image-uploader';
import type { InsertTextFieldHandle } from '@/components/shared/insert-text-field';
import type { InsertTokenNames } from '@/components/shared/insert-tokens';
import { type ChatDetail as ApiChatDetail, type ChatDetailMessage, type ChatListItem, type ScheduledChatSend } from '@/lib/api';
import { useInboxAi } from '@/v8/ai-reply/public/inbox-ai/index'
import { type AttachSlot } from '@/v8/inbox-chat/attachments';
import { useChatSearch } from '@/v8/inbox-search/public/use-chat-search/index'
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { EmailInboxItem, OldestAttentionTarget, PendingAttachment } from './inbox-model';
import { Chat } from './inbox-model';
import type { UnconfiguredInboxChannel } from './inbox-channel-tabs';
export type Props = {
  operators: { id: string; name: string }[]
  selectedChatId: string | null
  selectedThreadId: string | null
  setSelectedThreadId: Dispatch<SetStateAction<string | null>>
  showFriendInfo: boolean
  setShowFriendInfo: (next: boolean | ((current: boolean) => boolean)) => void
  loadEmails: (offset?: number, append?: boolean) => Promise<void>
  deepLinkNotice: string
  clearDeepLink: () => void
  detailLoading: boolean
  chatDetail: ApiChatDetail | null
  setSelectedChatId: Dispatch<SetStateAction<string | null>>
  attentionSaving: boolean
  handleAttentionUpdate: () => Promise<void>
  handleOperatorUpdate: (operatorId: string | null) => Promise<void>
  handleStatusUpdate: (newStatus: Chat["status"]) => void
  chatSearch: ReturnType<typeof useChatSearch>
  openChatSearch: () => void
  inboxAi: ReturnType<typeof useInboxAi>
  selectedAccountId: string | null
  chatSearchFocusSeq: number
  chatSearchFilling: boolean
  messagesScrollRef: RefObject<HTMLDivElement | null>
  messagesHasMore: boolean
  loadingOlderMessages: boolean
  loadOlderMessages: () => Promise<void>
  chatSearchTarget: { id: string; seq: number; } | null
  setQuotedMessage: Dispatch<SetStateAction<ChatDetailMessage | null>>
  textareaRef: RefObject<InsertTextFieldHandle | null>
  /** 返信の札の名前（友だち情報・共通情報）。 */
  tokenNames: InsertTokenNames
  staffRole: string | null
  setCorrectingId: Dispatch<SetStateAction<string | null>>
  setMessageContent: Dispatch<SetStateAction<string>>
  unseenIncoming: number
  setUnseenIncoming: Dispatch<SetStateAction<number>>
  dropOver: boolean
  setDropOver: Dispatch<SetStateAction<boolean>>
  handlePickAttachment: (file: File, slot?: AttachSlot) => Promise<void>
  chatPollStalled: boolean
  setChatPollRetryKey: Dispatch<SetStateAction<number>>
  setShowTemplatePicker: Dispatch<SetStateAction<boolean>>
  showComposerOptions: boolean
  setShowComposerOptions: Dispatch<SetStateAction<boolean>>
  showMemoEditor: boolean
  setShowMemoEditor: Dispatch<SetStateAction<boolean>>
  sendMode: "enter" | "shift-enter"
  setSendMode: Dispatch<SetStateAction<"enter" | "shift-enter">>
  memoPopoverRef: RefObject<HTMLDivElement | null>
  memoDraft: string
  setMemoDraft: Dispatch<SetStateAction<string>>
  memoError: string
  closeMemoEditor: () => void
  handleSaveMemo: () => Promise<void>
  memoSaving: boolean
  quotedMessage: ChatDetailMessage | null
  pendingImage: ImageUploaderValue | null
  setImagePreviewOpen: Dispatch<SetStateAction<boolean>>
  pendingImageMeta: { name: string; size: number; } | null
  imageInputRef: RefObject<HTMLInputElement | null>
  imageUploading: boolean
  clearPendingImage: () => void
  pendingAttachment: PendingAttachment | null
  sending: boolean
  scheduling: boolean
  clearPendingAttachment: () => void
  retryAttachment: () => void
  messageContent: string
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  isComposingRef: RefObject<boolean>
  messageOverLimit: boolean
  messageLength: number
  imageError: string
  senderId: string
  setSenderId: Dispatch<SetStateAction<string>>
  setShowSchedulePanel: Dispatch<SetStateAction<boolean>>
  showSchedulePanel: boolean
  scheduledSends: ScheduledChatSend[]
  handleSendMessage: () => Promise<void>
  scheduleInput: string
  setScheduleInput: Dispatch<SetStateAction<string>>
  handleScheduleSend: () => Promise<void>
  sendError?: string
  pendingMessages?: ChatDetailMessage[]
  error: string
  scheduledSendsFailed: boolean
  loadScheduledSends: (chatId: string) => Promise<void>
  handleReschedule: (scheduleId: string, nextAt: string) => Promise<void>
  handleCancelScheduled: (scheduleId: string) => Promise<void>
  showTemplatePicker: boolean
  setPendingPack: Dispatch<SetStateAction<{ texts: string[]; chatId: string; accountId: string | null; revision?: number; } | null>>
  pendingPack: { texts: string[]; chatId: string; accountId: string | null; revision?: number; } | null
  handleSendPack: (pack: NonNullable<{ texts: string[]; chatId: string; accountId: string | null; revision?: number; } | null>) => Promise<boolean | void>
  imagePreviewOpen: boolean
  /** 未選択の中央の「次にやること」（ID27）。件数はサーバー集計（読めない時は null）。 */
  quickCountsNow: { all: number; reply: number; overdue: number; } | null
  statusCountsNow: Record<'in_progress' | 'resolved' | 'unread' | 'on_hold', number> | null
  slaEnabled: boolean
  /** 上の札と同じ期限超過の総数（SLA有りの時だけ数が入る）。 */
  overdueTotal: number | null
  chats: ChatListItem[]
  emailItems: EmailInboxItem[]
  onOpenAttentionTarget: (target: OldestAttentionTarget) => void
  unconfiguredChannel?: UnconfiguredInboxChannel
  onOpenChannelSettings?: (href: string) => void
}