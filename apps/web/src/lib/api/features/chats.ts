import { fetchApi } from '../transport/request'
import type {
  ApiResponse,
  ChatAttachmentUploadSession,
  ChatAttachment,
  Chat,
  ChatSendInput,
  ChatScheduleInput,
  SavedSearch,
} from '@line-crm/shared'
import { CHAT_FILE_TYPES } from '@line-crm/shared'
import type { ChatListItem, ChatDetail, ScheduledChatSend, InboxSavedViewApiItem } from '../types/chats'

export const chatsMethods = {
  chats: {
    attachments: {
      createUploadSession: (id: string, input: { filename: string; mimeType: 'video/mp4'; sizeBytes: number }) =>
        fetchApi<ApiResponse<ChatAttachmentUploadSession>>(`/api/chats/${encodeURIComponent(id)}/attachments/upload-sessions`, {
          method: 'POST', body: JSON.stringify(input),
        }),
      completeUploadSession: (id: string, sessionId: string, etag: string) =>
        fetchApi<ApiResponse<ChatAttachment>>(`/api/chats/${encodeURIComponent(id)}/attachments/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {
          method: 'POST', body: JSON.stringify({ etag }),
        }),
      upload: async (id: string, file: File): Promise<ApiResponse<ChatAttachment>> => {
        const path = `/api/chats/${encodeURIComponent(id)}/attachments`;
        const extension = file.name.split('.').pop()?.toLowerCase();
        const inferredMime = Object.entries(CHAT_FILE_TYPES).find(([, ext]) => ext === extension)?.[0];
        const mimeType = !file.type || ['application/octet-stream', 'application/x-zip-compressed'].includes(file.type)
          ? inferredMime ?? file.type : file.type;
        if (mimeType !== 'video/mp4') return fetchApi<ApiResponse<ChatAttachment>>(`${path}/upload`, {
          method: 'POST', body: file,
          headers: { 'Content-Type': mimeType || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        });
        const prepared = await fetchApi<ApiResponse<ChatAttachmentUploadSession>>(`${path}/upload-sessions`, {
          method: 'POST', body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
        });
        if (!prepared.success || !prepared.data) return prepared as unknown as ApiResponse<ChatAttachment>;
        const response = await fetch(prepared.data.uploadUrl, {
          method: 'PUT', headers: prepared.data.requiredHeaders, body: file, credentials: 'omit',
        });
        if (!response.ok) throw new Error('動画をアップロードできませんでした。時間をおいて、もう一度お試しください。');
        const etag = response.headers.get('etag');
        if (!etag) throw new Error('アップロード結果を確認できませんでした。R2のCORS設定を確認してください');
        return fetchApi<ApiResponse<ChatAttachment>>(`${path}/upload-sessions/${encodeURIComponent(prepared.data.id)}/complete`, {
          method: 'POST', body: JSON.stringify({ etag }),
        });
      },
    },
    searchMessages: (friendId:string,q:string,offset=0,limit=30) => fetchApi<ApiResponse<import('@line-crm/shared').ConversationSearchResult>>(`/api/chats/${encodeURIComponent(friendId)}/messages/search?${new URLSearchParams({q,offset:String(offset),limit:String(limit)})}`),
    messagesAt: (friendId:string,params:{cursorAt?:string;cursorId?:string;direction?:'before'|'after'|'around';limit?:number}={}) => fetchApi<ApiResponse<import('@line-crm/shared').ConversationMessagePage>>(`/api/chats/${encodeURIComponent(friendId)}/messages?${new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]))}`),
    list: (params?: { channel?: 'all' | 'line' | 'instagram'; status?: string; operatorId?: string; accountId?: string; q?: string; unansweredOnly?: boolean; unreadOnly?: boolean; quickFilter?: 'reply' | 'overdue'; sort?: 'unread_first' | 'latest'; limit?: number; beforeAt?: string; beforeId?: string; beforeUnread?: 0 | 1 }) => {
      const query: Record<string, string> = {}
      if (params?.channel) query.channel = params.channel
      if (params?.status) query.status = params.status
      if (params?.operatorId) query.operatorId = params.operatorId
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.q) query.q = params.q
      if (params?.unansweredOnly) query.unansweredOnly = '1'
      if (params?.unreadOnly) query.unreadOnly = '1'
      if (params?.quickFilter) query.quickFilter = params.quickFilter
      // 並び: 既定は未読が先。latest は新しい順だけで、カーソルの beforeUnread は見ない
      if (params?.sort) query.sort = params.sort
      if (params?.limit !== undefined) query.limit = String(params.limit)
      // カーソルページング: (未読, lastMessageAt, friendId) の複合カーソルより後の行を返す
      if (params?.beforeUnread !== undefined) query.beforeUnread = String(params.beforeUnread)
      if (params?.beforeAt) query.beforeAt = params.beforeAt
      if (params?.beforeId) query.beforeId = params.beforeId
      return fetchApi<ApiResponse<ChatListItem[]>>(
        '/api/chats?' + new URLSearchParams(query),
      )
    },
    /*
     * INBOX-09: 「すべて／要返信／1時間以上待ち」の件数。一覧と同じ条件を
     * サーバーで数え、ページに載った行数や別の集計口と混ぜない。
     */
    quickCounts: (params?: {
      status?: string; operatorId?: string; accountId?: string; q?: string;
      unreadOnly?: boolean; channel?: 'all' | 'line' | 'email' | 'instagram'; socialChannel?: 'all' | 'line' | 'instagram';
    }) => {
      const query: Record<string, string> = {}
      if (params?.status) query.status = params.status
      if (params?.operatorId) {
        query.operatorId = params.operatorId
        query.assignee = params.operatorId
      }
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.q) query.q = params.q
      if (params?.unreadOnly) query.unreadOnly = '1'
      if (params?.channel) query.channel = params.channel
      if (params?.socialChannel) query.socialChannel = params.socialChannel
      return fetchApi<ApiResponse<{
        all: number
        reply: number
        overdue: number
        line: { all: number; reply: number; overdue: number }
        email: { all: number; reply: number; overdue: number }
      }>>(
        '/api/chats/quick-counts?' + new URLSearchParams(query),
      )
    },
    get: (id: string, params?: { limit?: number; beforeAt?: string; beforeId?: string }) => {
      const query = new URLSearchParams()
      if (params?.limit !== undefined) query.set('limit', String(params.limit))
      if (params?.beforeAt) query.set('beforeAt', params.beforeAt)
      if (params?.beforeId) query.set('beforeId', params.beforeId)
      const qs = query.toString()
      return fetchApi<ApiResponse<ChatDetail>>(
        `/api/chats/${id}${qs ? `?${qs}` : ''}`,
      )
    },
    create: (data: { friendId: string; operatorId?: string | null }) =>
      fetchApi<ApiResponse<Chat>>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { operatorId?: string | null; status?: Chat['status']; notes?: string | null; revision?: number; reason?: string }) =>
      fetchApi<ApiResponse<Chat>>(`/api/chats/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    send: (id: string, data: ChatSendInput, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ sent: true; messageId: string; sentByStaffName: string; revision: number }>>(`/api/chats/${id}/send`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data),
      }),
    // N-026: 送信と同じ解決器で差し込みを展開したプレビュー。
    // unresolved に残る名は、送信すると UNRESOLVED_TEMPLATE_VARIABLES で拒否されるもの。
    renderPreview: (id: string, data: { content: string; messageType?: string }) =>
      fetchApi<ApiResponse<{ content: string; unresolved: string[] }>>(`/api/chats/${id}/render-preview`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    // N-022: 画像と本文を1回の送信単位にする結合口。両方あるときだけ使う。
    sendCombined: (id: string, data: { image?: { originalContentUrl: string; previewImageUrl: string }; text?: string; texts?: string[]; revision?: number; quotedMessageId?: string }, idempotencyKey: string) =>
      fetchApi<ApiResponse<{ sent: true; messageId: string; messageIds: string[]; sentByStaffName: string; revision: number }>>(`/api/chats/${id}/send-combined`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data),
      }),
    // N-025: 送信予約。scheduledAt は JST の datetime-local 値でも受け付ける
    // (サーバー側でUTCへ正規化)。取消・変更は送信中以降になると409で拒否される。
    schedule: (id: string, data: ChatScheduleInput, idempotencyKey: string) =>
      fetchApi<ApiResponse<ScheduledChatSend & { replayed: boolean }>>(`/api/chats/${id}/schedule`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data),
      }),
    scheduled: (id: string) =>
      fetchApi<ApiResponse<{ scheduled: ScheduledChatSend[] }>>(`/api/chats/${id}/scheduled`),
    updateScheduled: (id: string, scheduleId: string, data: { scheduledAt?: string; content?: string }) =>
      fetchApi<ApiResponse<{ updated: true }>>(`/api/chats/${id}/scheduled/${scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    cancelScheduled: (id: string, scheduleId: string) =>
      fetchApi<ApiResponse<{ cancelled: true }>>(`/api/chats/${id}/scheduled/${scheduleId}`, {
        method: 'DELETE',
      }),
    markRead: (id: string) =>
      fetchApi<ApiResponse<{ isUnread: false }>>(`/api/chats/${id}/read`, {
        method: 'POST',
      }),
    markAllRead: () =>
      fetchApi<ApiResponse<{ marked: true }>>('/api/chats/read-all', {
        method: 'POST',
      }),
    events: (id: string) =>
      fetchApi<ApiResponse<Array<{
        id: string
        eventType: 'assignment' | 'status' | 'note' | 'read' | 'send' | 'conflict' | 'unsend'
        before: unknown
        after: unknown
        actorStaffId: string | null
        actorStaffName: string | null
        reason: string | null
        correlationId: string
        createdAt: string
      }>>>(`/api/chats/${id}/events`),
    savedViews: {
      list: (accountId: string) => fetchApi<ApiResponse<InboxSavedViewApiItem[]>>(`/api/inbox/saved-views?lineAccountId=${encodeURIComponent(accountId)}`),
      create: (accountId: string, data: { name: string; conditions: unknown; isShared?: boolean; isFavorite?: boolean }) =>
        fetchApi<ApiResponse<SavedSearch>>(`/api/inbox/saved-views?lineAccountId=${encodeURIComponent(accountId)}`, {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, accountId: string, data: { name?: string; conditions?: unknown; isShared?: boolean; isFavorite?: boolean }) =>
        fetchApi<ApiResponse<SavedSearch>>(`/api/inbox/saved-views/${id}?lineAccountId=${encodeURIComponent(accountId)}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        }),
      delete: (id: string, accountId: string) =>
        fetchApi<ApiResponse<null>>(`/api/inbox/saved-views/${id}?lineAccountId=${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
    },
  },
  inbox: {
    unanswered: {
      list: (opts?: {
        q?: string;
        account?: string;
        minWaitMinutes?: number;
        page?: number;
        pageSize?: number;
      }) => {
        const p = new URLSearchParams();
        if (opts?.q) p.set('q', opts.q);
        if (opts?.account) p.set('account', opts.account);
        if (opts?.minWaitMinutes) p.set('minWaitMinutes', String(opts.minWaitMinutes));
        if (opts?.page) p.set('page', String(opts.page));
        if (opts?.pageSize) p.set('pageSize', String(opts.pageSize));
        const qs = p.toString();
        return fetchApi<ApiResponse<{
          total: number;
          page: number;
          pageSize: number;
          rows: Array<{
            friendId: string;
            displayName: string | null;
            pictureUrl: string | null;
            accountId: string;
            accountName: string;
            lastIncomingAt: string;
            lastManualAt: string | null;
            lastMachineAt: string | null;
            lastIncomingType: string;
            lastIncomingContent: string;
          }>;
        }>>(`/api/inbox/unanswered${qs ? `?${qs}` : ''}`);
      },
      count: () =>
        fetchApi<ApiResponse<{
          total: number;
          byAccount: Array<{ accountId: string; accountName: string; count: number }>;
          oldestWaitMinutes: number | null;
        }>>('/api/inbox/unanswered/count'),
    },
  },
}
