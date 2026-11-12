'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, Send, X } from 'lucide-react'
import MobileScreen from '@/components/mobile/mobile-screen'
import { useMobileShell } from '@/components/mobile/mobile-shell'
import Avatar from '@/components/shared/avatar'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import IconButton from '@/components/shared/icon-button'
import { InboxDraftArea } from '@/components/shared/inbox-composer'
import { InboxHistoryButton } from '@/components/shared/inbox-list'
import { InboxThreadLoading } from '@/components/shared/inbox-thread'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { MobileListTools, MobileTalkList, type MobileTalkItem } from '@/components/templates'
import { talkItem } from './mobile-talk-item'
import { useAccount } from '@/contexts/account-context'
import { api, type ChatDetailMessage, type ChatListItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import { canEditFeature } from '@/lib/staff-capability'
import { useStaffRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import AttachMenu from './attach-menu'
import AttachmentChip from './attachment-chip'
import { ATTACH_NOTE } from './attachments'
import { MESSAGE_MAX_LENGTH, type StatusFilter } from './inbox-model'
import { InboxMessageRow } from './message-row'
import { useInboxConversation } from './use-inbox-conversation'
import { useInboxDeepLink } from './use-inbox-deep-link'
import { useInboxDraft } from './use-inbox-draft'
import { useInboxLists } from './use-inbox-lists'
import { useInboxSend } from './use-inbox-send'
import { useInboxSubscription } from './use-inbox-subscription'
import styles from './mobile-talk.module.css'

/*
 * 電話の画面のトーク（/m/chats → /m/chats?friend=…）。
 * 一覧と会話を 2 枚に分ける。取得・送信・下書き・別のアカウントの取り違え防止は PC の受信箱と同じフックを使う
 * （送信は冪等キー付きで 1 回だけ・失敗したら書いた文を残す・送ったら取り消せない）。
 * 出さない物：振り分けのルール・保存した見方・予約送信・AI の下書きの設定・メール・まとめての既読・引用と訂正（PC だけ。
 * 吹き出しの横の小さな操作は指で押せる大きさにならないため、電話の段②以降で形を決める）。
 */

/* 1 回に読む件数（表示の件数の切り替えではない）。 */
const LIST_BATCH = 50
const MESSAGE_BATCH = 100
const TALK_PERMISSION = '/chats'

export default function MobileTalkScreen() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={null}>
      <MobileTalkHost />
    </Suspense>
  )
}

function MobileTalkHost() {
  const params = useSearchParams()
  const friend = (params.get('friend') ?? '').trim()
  return friend ? <MobileTalkThread /> : <MobileTalkInbox />
}

type ListFilter = 'all' | 'unread'

function MobileTalkInbox() {
  const { selectedAccountId } = useAccount()
  const [filter, setFilter] = useState<ListFilter>('all')
  const [nameQuery, setNameQuery] = useState('')
  const [, setError] = useState('')
  const {
    chats, setChats, debouncedNameQuery, loading, chatListFailed, loadingMore, hasMoreChats,
    listFilterKey, chatListCompletedKey, loadChats, loadMoreChats, loadChatsQuietly,
  } = useInboxLists({
    CHAT_PAGE_SIZE: LIST_BATCH,
    EMAIL_PAGE_SIZE: 1,
    nameQuery,
    selectedAccountId,
    emailInboxEnabled: false,
    statusFilter: 'all',
    assigneeFilter: 'all',
    unreadOnly: filter === 'unread',
    quickFilter: 'all',
    setError,
  })
  // 一覧だけを静かに読み直す（見えている間だけ）。会話は開いていないので詳細は読まない。
  useInboxSubscription({ refreshChatDetailQuietly: nothingToRefresh, channel: 'line', loadChatsQuietly })

  const pending = nameQuery.trim() !== debouncedNameQuery || chatListCompletedKey !== listFilterKey
  const items = chats.map(talkItem)
  const open = (item: MobileTalkItem) => {
    // 既読はログイン中の担当者だけに付く。対応の状態は変えない（PC で会話を開いた時と同じ）。
    setChats((prev) => prev.map((chat) => (chat.id === item.id ? { ...chat, isUnread: false } : chat)))
    void api.chats.markRead(item.id).catch(() => {
      // 会話を開く操作は止めない。次の読み直しで正しい未読に戻る。
    })
  }
  return (
    <MobileScreen title="トーク" permission={TALK_PERMISSION}>
      <MobileListTools<ListFilter>
        searchLabel="トークを名前で探す"
        searchPlaceholder="名前で探す"
        query={nameQuery}
        onQuery={setNameQuery}
        choiceLabel="表示するトーク"
        choice={filter}
        choices={[{ value: 'all', label: 'すべて' }, { value: 'unread', label: '未読' }]}
        onChoice={setFilter}
      />
      {pending || (loading && chats.length === 0) ? (
        <ListState kind="loading" title="トークを読み込んでいます" />
      ) : chatListFailed ? (
        <ListState kind="error" title="トークを読み込めませんでした" onRetry={() => { void loadChats() }} />
      ) : items.length === 0 ? (
        <ListState kind="empty" emptyPreset={nameQuery.trim() || filter !== 'all' ? 'filtered' : 'readonly'} title={nameQuery.trim() || filter !== 'all' ? '条件に合うトークはありません' : 'トークはまだありません'} />
      ) : (
        <>
          <MobileTalkList label="トーク" items={items} onOpen={open} />
          {hasMoreChats ? (
            <div className={styles.more}>
              <InboxHistoryButton context="list" busy={loadingMore} onClick={() => { void loadMoreChats() }}>さらに読み込む</InboxHistoryButton>
            </div>
          ) : null}
        </>
      )}
    </MobileScreen>
  )
}

/** 読み直さない側（一覧の画面の会話・会話の画面の一覧）に渡す。 */
const nothingToRefresh = async () => true

function MobileTalkThread() {
  const router = useRouter()
  const params = useSearchParams()
  const shell = useMobileShell()
  const role = useStaffRole()
  const { accounts, selectedAccountId, loading: accountsLoading } = useAccount()
  const canReply = !shell.readOnly && role !== null && canEditFeature(TALK_PERMISSION, role)

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [, setSelectedThreadId] = useState<string | null>(null)
  const [chats, setChats] = useState<ChatListItem[]>([])
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [quotedMessage, setQuotedMessage] = useState<ChatDetailMessage | null>(null)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [pendingPack, setPendingPack] = useState<{ texts: string[]; chatId: string; accountId: string | null; revision?: number } | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const sendLockRef = useRef(false)
  const sendKeysRef = useRef(new IdempotencyKeyStore())
  const isComposingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const statusFilterRef = useRef<StatusFilter>('all')
  const detailRequestIdRef = useRef(0)
  const detailAccountRef = useRef(selectedAccountId)
  const selectedChatIdRef = useRef<string | null>(selectedChatId)
  selectedChatIdRef.current = selectedChatId

  // アカウントを切り替えたら、前の店の会話を閉じる（遅れて届いた応答も出さない）。
  useEffect(() => {
    if (detailAccountRef.current === selectedAccountId) return
    detailAccountRef.current = selectedAccountId
    detailRequestIdRef.current += 1
    setSelectedChatId(null)
  }, [selectedAccountId])

  /* 会話の指定は PC と同じ照合を通す（いま選んでいるアカウントの相手でなければ開かない）。 */
  const { deepLinkNotice, setDeepLinkNotice, deepLinkIdRef } = useInboxDeepLink({
    params, setSelectedChatId, setSelectedThreadId, accountsLoading, emailInboxEnabled: false, selectedAccountId, router, channel: 'line', savedViewParam: '',
  })

  const draft = useInboxDraft({ selectedAccountId, selectedChatId })
  const { chatDetail, setChatDetail, messagesHasMore, loadingOlderMessages, loadChatDetail, loadOlderMessages, refreshChatDetailQuietly } = useInboxConversation({
    sendLockRef,
    CHAT_MESSAGE_PAGE_SIZE: MESSAGE_BATCH,
    selectedChatIdRef, detailAccountRef, detailRequestIdRef, setError, deepLinkIdRef, setDeepLinkNotice,
    selectedChatId, selectedAccountId, setChats, chats,
  })
  const { chatPollStalled, setChatPollRetryKey } = useInboxSubscription({ refreshChatDetailQuietly, channel: 'line', loadChatsQuietly: nothingToRefresh })

  const { sendError, pendingMessages, handleSendMessage } = useInboxSend({
    selectedChatId, sending, sendLockRef,
    pendingAttachment: draft.pendingAttachment, messageContent: draft.messageContent, pendingImage: draft.pendingImage,
    selectedAccountId, setSending, chatDetail, quotedMessage, senderId: '', sendKeysRef,
    dropSentDraft: draft.dropSentDraft, selectedChatIdRef, detailAccountRef, pendingImageRef: draft.pendingImageRef,
    setPendingImage: draft.setPendingImage, setPendingImageMeta: draft.setPendingImageMeta, setMessageContent: draft.setMessageContent,
    setChatDetail, setChats, statusFilterRef, attachDraftsRef: draft.attachDraftsRef, putAttachment: draft.putAttachment,
    correctingId, setCorrectingId, setQuotedMessage, pendingPack, setPendingPack, isComposingRef,
    // 電話は Enter で改行。送るのは［送る］ボタンだけ（誤って送らない。送ったら取り消せない）。
    sendMode: 'shift-enter',
  })

  /* 書きかけの返信がある時に戻る・タブを移る・アカウントを切り替えると、PC と同じく捨ててよいかを確かめる。 */
  const dirty = canReply && Boolean(draft.messageContent.trim() || draft.pendingImage || draft.pendingAttachment)
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: sending })

  // 開いた時・自分が送った時は一番下（新しい方）を見せる。
  const messages = [...(chatDetail?.messages ?? []), ...(pendingMessages ?? [])]
  const lastId = messages.length ? messages[messages.length - 1].id : null
  useEffect(() => {
    if (!lastId) return
    window.requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }))
  }, [lastId])

  const name = chatDetail?.friendName ?? 'トーク'
  const account = accounts.find((item) => item.id === selectedAccountId) ?? null
  const accountName = account ? (account.displayName || account.name) : '公式アカウント'
  const overLimit = draft.messageContent.length > MESSAGE_MAX_LENGTH
  const attachmentNotReady = draft.pendingAttachment !== null && draft.pendingAttachment.status !== 'ready'
  const hasContent = Boolean(draft.messageContent.trim() || draft.pendingImage || draft.pendingAttachment?.status === 'ready')
  const ready = Boolean(chatDetail) && !deepLinkNotice

  const composer = canReply && ready ? (
    <div className={styles.composer}>
      {sendError ? (
        <Notice tone="danger" message={sendError} action={<Button size="compact" onClick={() => void handleSendMessage()} busy={sending} busyLabel="送っています…">もう一度送る</Button>} />
      ) : null}
      {chatPollStalled ? (
        <Notice tone="warn" message="会話の読み直しを止めています（つながりません）。" action={<Button size="compact" onClick={() => setChatPollRetryKey((key) => key + 1)}>読み直す</Button>} />
      ) : null}
      {draft.pendingAttachment ? (
        <AttachmentChip item={draft.pendingAttachment} busy={sending} onRemove={draft.clearPendingAttachment} onRetry={draft.retryAttachment} />
      ) : null}
      {draft.pendingImage ? (
        <div className={styles.quoted}>
          <span className={styles.quotedText} title={draft.pendingImageMeta?.name}>{`画像：${draft.pendingImageMeta?.name ?? '選んだ画像'}`}</span>
          <IconButton size="row" aria-label="画像を外す" onClick={draft.clearPendingImage}><X aria-hidden="true" /></IconButton>
        </div>
      ) : null}
      {draft.imageError ? <Notice tone="danger" message={draft.imageError} /> : null}
      <InboxDraftArea
        ref={textareaRef}
        value={draft.messageContent}
        onChange={(event) => draft.setMessageContent(event.target.value)}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={() => { isComposingRef.current = false }}
        rows={2}
        placeholder="メッセージを入力"
        aria-label="メッセージを入力"
        aria-invalid={overLimit}
      />
      <div className={styles.composerRow}>
        <AttachMenu disabled={sending} onPick={(file, slot) => void draft.handlePickAttachment(file, slot)} />
        <span className={styles.count} data-over={overLimit || undefined} title={ATTACH_NOTE}>
          {`${formatNumber(draft.messageContent.length)} / ${formatNumber(MESSAGE_MAX_LENGTH)}`}
        </span>
        {draft.messageContent.trim() ? (
          <Button variant="secondary" size="compact" onClick={() => setPreviewOpen(true)}><Eye aria-hidden="true" />見え方</Button>
        ) : null}
        {hasContent ? (
          <Button variant="primary" size="compact" onClick={() => void handleSendMessage()} disabled={sending || overLimit || attachmentNotReady || draft.imageUploading} busy={sending} busyLabel="送っています…">
            <Send aria-hidden="true" />送る
          </Button>
        ) : null}
      </div>
      <Dialog open={previewOpen} title="LINE での見え方" onCancel={() => setPreviewOpen(false)} cancelLabel="閉じる">
        <LinePreview fit title={null} accountName={accountName}>
          <LinePreviewMessage accountName={accountName} avatar={<Avatar name={accountName} src={account?.iconUrl || account?.pictureUrl || null} size={28} shape="rounded" />} time="">
            {draft.messageContent}
          </LinePreviewMessage>
        </LinePreview>
      </Dialog>
    </div>
  ) : null

  return (
    <MobileScreen title={name} back={{ href: '/m/chats', label: 'トーク' }} permission={TALK_PERMISSION} hideTabs footer={composer}>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="書きかけの返信" onConfirm={confirmLeave} onCancel={cancelLeave} />
      {deepLinkNotice ? (
        <ListState kind="empty" emptyPreset="readonly" title="この会話は開けません" description={deepLinkNotice} />
      ) : error && !chatDetail ? (
        <ListState kind="error" title="会話を読み込めませんでした" description={error} onRetry={() => { if (selectedChatId) void loadChatDetail(selectedChatId) }} />
      ) : !chatDetail ? (
        <InboxThreadLoading loading />
      ) : (
        <div className={styles.thread} aria-label={`${name}さんとのメッセージ`}>
          {messagesHasMore && messages.length > 0 ? (
            <div className={styles.more}>
              <InboxHistoryButton context="thread" busy={loadingOlderMessages} onClick={() => { void loadOlderMessages() }}>前のメッセージ</InboxHistoryButton>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <ListState kind="empty" emptyPreset="readonly" title="メッセージはまだありません" />
          ) : messages.map((msg, idx, list) => (
            <InboxMessageRow
              key={msg.id}
              msg={msg}
              idx={idx}
              list={list}
              sending={pendingMessages?.some((item) => item.id === msg.id) === true}
            />
          ))}
          {chatDetail && error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
        </div>
      )}
    </MobileScreen>
  )
}
