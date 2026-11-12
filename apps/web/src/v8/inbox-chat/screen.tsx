'use client'
import { notifySaved } from '@/components/shared/toast'

import { japaneseDetailOf } from '@/components/shared/api-error-message';
import { useUnsavedGuard } from '@/lib/use-unsaved-guard';
import type { SavedViewDraft, SavedViewSaveResult } from '@/components/chats/saved-view-dialog';
import FriendInfoSidebarBoundary from '@/components/chats/friend-info-sidebar-boundary';
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar';
import Notice from '@/components/shared/notice';
import { SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors';
import { InboxPage } from '@/components/templates/inbox-page';
import { useAccount } from '@/contexts/account-context';
import { api,fetchApi,type ChatDetailMessage } from '@/lib/api';
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store';
import { useStaffRole } from '@/lib/staff-role';
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog';
import { useSamePageUrl } from '@/lib/use-same-page-url';
import { useInboxAi } from '@/v8/ai-reply/public/inbox-ai/index'
import { useRouter,useSearchParams } from 'next/navigation';
import { Suspense,useEffect,useRef,useState } from 'react';
import { InboxSort,jstDatetimeLocalToIso,MESSAGE_MAX_LENGTH,SAVED_VIEW_URL_KEY,StatusFilter,buildInboxUrl,inboxSortFromParam,resolveInboxChannel,statusFilters,type OldestAttentionTarget } from './inbox-model';

import InboxConversation from './inbox-conversation-view';
import InboxCustomerPanel from './inbox-customer-panel';
import InboxList from './inbox-list-view';
import { savedViewFailureMessage } from './saved-view-failure';
import { useInboxActions } from './use-inbox-actions';
import { useInboxConversation } from './use-inbox-conversation';
import { useInboxDraft } from './use-inbox-draft';
import { useInboxLists } from './use-inbox-lists';
import { useInboxSavedViews } from './use-inbox-saved-views';
import { useInboxSchedule } from './use-inbox-schedule';
import { useInboxScroll } from './use-inbox-scroll';
import { useInboxSearch } from './use-inbox-search';
import { useInboxSend } from './use-inbox-send';
import { useInboxStats } from './use-inbox-stats';
import { useInboxSubscription } from './use-inbox-subscription';

import { useInboxDeepLink } from './use-inbox-deep-link';
import { useInboxPanel } from './use-inbox-panel';

const CHAT_PAGE_SIZE = 200
const EMAIL_PAGE_SIZE = 200
const CHAT_MESSAGE_PAGE_SIZE = 100

function ChatsPageInner({ channel, emailInboxEnabled }: { channel: 'all' | 'line' | 'email'; emailInboxEnabled: boolean }) {

  const saveErrors = useSaveFormErrors()

  const router = useRouter()

  const params = useSearchParams()

  // URLが指す保存検索のID。再読込・URL共有からの復元元(N-021)。
  const savedViewParam = (params.get(SAVED_VIEW_URL_KEY) ?? '').trim()

  const { selectedAccountId, loading: accountsLoading } = useAccount()

  // 中央ペインで開いているメール。LINEのトークと排他。
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  // 切替直後の1描画でも、前のアカウントで開いたメールを表示しない。
  const visibleThreadId = emailInboxEnabled ? selectedThreadId : null

  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)

  /*
   * URLの `?status=` で絞り込み済みの受信箱を開けるようにする（IDEA-01）。
   * ダッシュボードの「対応が必要な受信」は `?status=unread` でここへ来る。
   * 旧い深掘りリンクの `unanswered=1` も「未対応」として受ける。
   */
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const raw = (params.get('status') ?? '').trim()
    if (statusFilters.some((f) => f.key === raw)) return raw as StatusFilter
    if (params.get('unanswered') === '1' || params.get('unanswered') === 'true') return 'unread'
    return 'all'
  })

  /* 並び（未読が先／新しい順）は URL の `?sort=` が正本。戻る・共有で同じ並びに戻る。 */
  const samePageUrl = useSamePageUrl()
  const sortOrder = inboxSortFromParam(params.get('sort'))
  const setSortOrder = (next: InboxSort) => {
    const query = new URLSearchParams(params.toString())
    if (next === 'latest') query.set('sort', 'latest')
    else query.delete('sort')
    const text = query.toString()
    samePageUrl.replace(`${window.location.pathname}${text ? `?${text}` : ''}`)
  }

  const [quickFilter, setQuickFilter] = useState<'all' | 'reply' | 'overdue'>('all')

  const [assigneeFilter, setAssigneeFilter] = useState('all')

  const [filterOpen, setFilterOpen] = useState(false)

  const [unreadOnly, setUnreadOnly] = useState(false)

  // 一覧が長くなると状態の絞り込みだけでは足りない（設計 `ListPane` の「名前で検索」）。
  // 送信側で絞ると、打つたびに一覧を取り直して重い。手元で絞る。
  const [nameQuery, setNameQuery] = useState('')

  // 送信の細かい設定。既定は畳む。出しっぱなしだと入力欄が縦に伸びて
  // トークが読めなくなる。
  const [showComposerOptions, setShowComposerOptions] = useState(false)

  const [showTemplatePicker, setShowTemplatePicker] = useState(false)

  // G-4: ピッカーで「まとめて選ぶ」で選んだ本文たち。送る前に確認する。
  const [pendingPack, setPendingPack] = useState<{ texts: string[]; chatId: string; accountId: string | null; revision?: number } | null>(null)

  // Send mode: 'enter' = Enter sends, Shift+Enter = newline; 'shift-enter' = reverse
  /*
   * 送信キーの初期値は Shift + Enter。**選び直せる。**
   *
   * Enter 単体だと、書きかけで改行しようとして送ってしまう。取り消せない
   * ものが相手へ飛ぶので、既定は事故の起きにくい方にする。
   * 一度選ぶと chat.sendMode に残り、次からはその設定が使われる。
   * メール側（email-thread.tsx）も同じ置き場・同じ既定。
   */
  const [sendMode, setSendMode] = useState<'enter' | 'shift-enter'>('shift-enter')

  const [error, setError] = useState('')

  const [sending, setSending] = useState(false)

  // N-025: 引用返信。会話の中の1件を引用して返す。
  const [quotedMessage, setQuotedMessage] = useState<ChatDetailMessage | null>(null)

  /* 訂正：送ったあとは取り消せない。間違えた吹き出しの［訂正を送る］から、見本の文と引用を入れて人が送る。 */
  const [correctingId, setCorrectingId] = useState<string | null>(null)

  const staffRole = useStaffRole()

  /* 送り手（G8）：選ぶと、お客さまの LINE でメッセージの上に出る名前と顔が変わる。空は店の名前。 */
  const [senderId, setSenderId] = useState('')

  const sendLockRef = useRef(false)

  const sendKeysRef = useRef(new IdempotencyKeyStore())


  const isComposingRef = useRef(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 会話を素早く切り替えたとき、前の会話の遅い応答で現在の詳細を
  // 上書きしない。注目操作が別の友だちへ向く事故もここで防ぐ。
  const detailRequestIdRef = useRef(0)

  const detailAccountRef = useRef(selectedAccountId)

  /*
   * いま画面で開いている会話ID。通信の応答が「どの会話へ向けたものか」を
   * 照合するために描画のたびに同期する（listFilterKeyRef と同じ型）。
   * 切替後に届いた古い応答の履歴マージ・入力欄クリア・予約一覧反映を
   * 止める(#962 F03/F06/F07)。
   */
  const selectedChatIdRef = useRef<string | null>(selectedChatId)

  selectedChatIdRef.current = selectedChatId

  // Load/save sendMode preference (guarded — privacy-restricted browsers throw)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('chat.sendMode')
      if (saved === 'enter' || saved === 'shift-enter') setSendMode(saved)
    } catch { /* localStorage unavailable */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem('chat.sendMode', sendMode) } catch { /* ignore */ }
  }, [sendMode])

  // 状態の切り替えの5つの押し場所。選んでいる所だけ Tab で止まる
  // （ラジオの決まり）。左右・先頭・末尾のキーで選ぶ。

  const hasInboxFilters = Boolean(
    nameQuery.trim()
    || statusFilter !== 'all'
    || quickFilter !== 'all'
    || assigneeFilter !== 'all'
    || unreadOnly,
  )

  const {
    imageInputRef,
    imageError,
    pendingImageMeta,
    setPendingImageMeta,
    imagePreviewOpen,
    setImagePreviewOpen,
    attachDraftsRef,
    pendingAttachment,
    putAttachment,
    handlePickAttachment,
    retryAttachment,
    clearPendingAttachment,
    dropOver,
    setDropOver,
    clearPendingImage,
    messageContent,
    setMessageContent,
    pendingImage,
    setPendingImage,
    pendingImageRef,
    dropSentDraft,
    imageUploading,
  } = useInboxDraft({
    selectedAccountId,
    selectedChatId,
  })

  useEffect(() => { setPendingPack(null); setImagePreviewOpen(false) }, [selectedChatId, selectedAccountId, setImagePreviewOpen])

  // INBOX-29: 上限を超えた本文は送らせない(下書きは消さない)。
  const messageLength = messageContent.length

  const messageOverLimit = messageLength > MESSAGE_MAX_LENGTH

  const {
    chats,
    setChats,
    emailItems,
    setEmailItems,
    emailError,
    emailLoading,
    debouncedNameQuery,
    setDebouncedNameQuery,
    statusFilterRef,
    loading,
    chatListFailed,
    loadingMore,
    hasMoreChats,
    listScrollRef,
    slaEnabled,
    overdueTotal,
    setSlaReload,
    listFilterKey,
    chatListCompletedKey,
    emailListCompletedKey,
    loadingMoreEmails,
    hasMoreEmails,
    loadEmails,
    loadChats,
    loadMoreChats,
    loadChatsQuietly,
  } = useInboxLists({
    CHAT_PAGE_SIZE,
    EMAIL_PAGE_SIZE,
    nameQuery,
    selectedAccountId,
    emailInboxEnabled: emailInboxEnabled && channel !== 'line',
    statusFilter,
    assigneeFilter,
    unreadOnly,
    quickFilter,
    sort: sortOrder,
    setError,
  })

  // 入力からdebounce反映までを「0件」と断定しない。古い条件の結果が一瞬見えるため。
  const nameQueryPending = nameQuery.trim() !== debouncedNameQuery

  const currentFilterNotLoaded = (channel !== 'email' && chatListCompletedKey !== listFilterKey)
    || (channel !== 'line' && emailListCompletedKey !== listFilterKey)

  const inboxListLoading = nameQueryPending
    || currentFilterNotLoaded

  const inboxListRefreshing = !inboxListLoading && ((channel !== 'email' && loading) || (channel !== 'line' && emailLoading))

  const inboxListFailed = (channel !== 'email' && chatListFailed)
    || (channel !== 'line' && Boolean(emailError))

  const {
    scheduledSends,
    scheduledSendsFailed,
    scheduleInput,
    setScheduleInput,
    showSchedulePanel,
    setShowSchedulePanel,
    scheduling,
    loadScheduledSends,
    handleScheduleSend,
    handleCancelScheduled,
  } = useInboxSchedule({
    detailAccountRef,
    selectedChatIdRef,
    selectedChatId,
    getFriendName: () => chatDetail?.id === selectedChatId ? chatDetail.friendName : undefined,
    messageContent,
    pendingImage,
    pendingAttachment,
    setError,
    selectedAccountId,
    dropSentDraft,
    pendingImageRef,
    setPendingImage,
    setPendingImageMeta,
    attachDraftsRef,
    putAttachment,
    setMessageContent,
    quotedMessage,
    sendKeysRef,
    setQuotedMessage,
  })

  /** 予約時刻の変更。datetime-local の JST 値はオフセットを付けて口へ渡す(INBOX-21)。 */
  const handleReschedule = async (scheduleId: string, nextAt: string) => {
    if (!selectedChatId || !nextAt) return
    try {
      const res = await api.chats.updateScheduled(selectedChatId, scheduleId, { scheduledAt: jstDatetimeLocalToIso(nextAt) })
      if (res.success) await loadScheduledSends(selectedChatId)
    } catch (reason) {
      saveErrors.capture(reason)
      setError('予約時刻の変更に失敗しました。一覧を読み込み直してください。')
      void loadScheduledSends(selectedChatId)
    }
  }
  // 会話を切り替えたら引用中の選択と予約パネルは閉じる。
  // 前の会話のメッセージを引用したまま別の会話へ送ると、別friendの
  // メッセージ指定で口が404を返すため、ここで必ず外す。
  useEffect(() => {
    setQuotedMessage(null)
    setCorrectingId(null)
    setShowSchedulePanel(false)
    setScheduleInput('')
  }, [selectedChatId, setScheduleInput, setShowSchedulePanel])

  const {
    operators,
    assigneeUnread,
    assigneeUnreadStatus,
    statusCountsNow,
    quickCountsNow,
  } = useInboxStats({
    selectedAccountId,
    statusFilter,
    debouncedNameQuery,
    assigneeFilter,
    unreadOnly,
    channel,
  })

  const {
    saveDialogOpen,
    setSaveDialogOpen,
    savedViews,
    savedViewsOpen,
    setSavedViewsOpen,
    savedViewMenuId,
    setSavedViewMenuId,
    setSavedViewName,
    savedViewError,
    setSavedViewError,
    savingView,
    setSavedViewSuccess,
    savedViewNotice,
    operatorNames,
    dropSavedViewParam,
    loadSavedViews,
    currentSavedViewConditions,
    savedViewName,
    setSavingView,
    applySavedView,
  } = useInboxSavedViews({
    operators,
    setNameQuery,
    setStatusFilter,
    setAssigneeFilter,
    setQuickFilter,
    setUnreadOnly,
    params,
    router,
    selectedAccountId,
    savedViewParam,
    accountsLoading,
    setDebouncedNameQuery,
    channel,
    quickFilter,
    nameQuery,
    statusFilter,
    assigneeFilter,
    unreadOnly,
  })

  const createSavedView = async (draft?: SavedViewDraft): Promise<SavedViewSaveResult> => {
    if (savingView) return { success: false, error: '保存処理が終わるまでお待ちください' }
    // モーダルから呼ぶときは、そこで打った名前をそのまま使う。
    // 状態の更新を待つと、1回目の保存が空の名前で走る。
    const name = (draft?.name ?? savedViewName).trim()
    if (!name) {
      const message = '名前を入力してください'
      setSavedViewError(message)
      return { success: false, error: message }
    }
    setSavingView(true)
    setSavedViewError('')
    try {
      if (!selectedAccountId) {
        const message = 'LINE公式アカウントを選んでください'
        setSavedViewError(message)
        return { success: false, error: message }
      }
      const savingAccountId = selectedAccountId
      const response = await api.chats.savedViews.create(savingAccountId, {
        name,
        conditions: currentSavedViewConditions(draft),
        isFavorite: draft?.favorite ?? false,
      })
      if (!response.success) {
        const message = '保存できませんでした。時間を置いてもう一度お試しください。'
        setSavedViewError(message)
        return { success: false, error: message }
      }
      if (detailAccountRef.current !== savingAccountId) return { success: true }
      setSavedViewName('')
      await loadSavedViews()
      if (detailAccountRef.current !== savingAccountId) return { success: true }
      setSaveDialogOpen(false)
      setSavedViewsOpen(true)
      notifySaved(`保存した検索「${name}」を保存しました`)
      return { success: true }
    } catch (reason) {
      saveErrors.capture(reason)
      /*
        **失敗の種類で言い分ける。** fetchApi は !ok を ApiError として投げる
        ので、409(同名の競合)も403(権限)も通信障害もここへ来る。全部を
        「時間を置いて」と言うと、名前を変えれば直る競合まで待たせてしまう
        (N-027)。文言は運用者向けに作り、APIの内部文言は素通ししない。
      */
      const message = savedViewFailureMessage(reason)
      setSavedViewError(message)
      return { success: false, error: message }
    } finally {
      setSavingView(false)
    }
  }

  const clearInboxFilters = () => {
    setNameQuery('')
    setDebouncedNameQuery('')
    setStatusFilter('all')
    setQuickFilter('all')
    setAssigneeFilter('all')
    setUnreadOnly(false)
    // 手動で解除したので、URLの保存検索IDも外す(N-021)。
    dropSavedViewParam()
  }
  const { wideInfoPanel, panesRef, showFriendInfo, setShowFriendInfo, customerPanelRef } = useInboxPanel()
  const {
    deepLinkNotice,
    setDeepLinkNotice,
    deepLinkIdRef,
    deepLinkRequestIdRef,
    clearDeepLink,
  } = useInboxDeepLink({
    params,
    setSelectedChatId,
    setSelectedThreadId,
    accountsLoading,
    emailInboxEnabled,
    selectedAccountId,
    router,
    channel,
    savedViewParam,
  })

  const handleSelectChat = (chatId: string) => {
    // 手選びはURL指定を上書きする。古い案内とURL状態を残さない。
    // friend / thread を残すと、再読込で手選び前の会話へ戻る(#673)。
    // 世代も進める。進めないと、走っている友だち照会が後から
    // 手で選んだ会話を上書きする。
    deepLinkRequestIdRef.current += 1
    deepLinkIdRef.current = null
    setDeepLinkNotice('')
    setSelectedChatId(chatId)
    // friend は外すが、一覧条件の savedView は残す(N-021)。
    router.replace(buildInboxUrl(channel, savedViewParam || null))
    // 既読はログイン中の担当者だけに反映する。対応状況は変えない。
    setChats((prev) => prev.map((chat) => (
      chat.id === chatId ? { ...chat, isUnread: false } : chat
    )))
    void api.chats.markRead(chatId).catch(() => {
      // 会話を開く処理は止めない。次の一覧取得で正しい未読へ戻る。
    })
    /*
     * 開いていたメールを外す。
     *
     * 右側は「メールが選ばれていたらメール」を先に見るので、ここで
     * 外さないと、LINEのトークを選んでも前のメールが出たままになる。
     * メールを一度開くと、以後どのトークも開けなくなっていた。
     * メール側は逆にLINEの選択を外していたので、片側だけ抜けていた。
     */
    setSelectedThreadId(null)
    // 下書きは会話ごとの預かりに移した(#962 F06)。ここで消すと、
    // 切り替えただけで書きかけが消える。預け・戻しは上の効果が担う。
  }

  // メールの行（一覧）と中央の行き先（ID27）で共用する開き方。
  const handleSelectEmail = (threadId: string) => {
    // LINEの選択を外す。両方開いていると中央に何を
    // 出すのか決まらない。URL指定の案内とURL状態も外す。
    // friend を残すと、再読込で古いLINE会話へ戻る(#673)。
    deepLinkRequestIdRef.current += 1
    deepLinkIdRef.current = null
    setDeepLinkNotice('')
    setSelectedChatId(null)
    setSelectedThreadId(threadId)
    router.replace(buildInboxUrl(channel, savedViewParam || null))
    setEmailItems((prev) => prev.map((email) => (
      email.threadId === threadId ? { ...email, isUnread: false } : email
    )))
    void fetchApi(`/api/support/email/threads/${encodeURIComponent(threadId)}/read`, {
      method: 'POST',
    }).catch(() => undefined)
  }

  // 未選択の中央の「いちばん古い会話を開く」（ID27）。一覧の行を押した時と同じ開き方。
  const openAttentionTarget = (target: OldestAttentionTarget) => {
    if (target.kind === 'chat') {
      handleSelectChat(target.id)
      return
    }
    handleSelectEmail(target.threadId)
  }

  const {
    chatDetail,
    setChatDetail,
    detailLoading,
    setDetailLoading,
    messagesHasMore,
    setMessagesHasMore,
    loadingOlderMessages,
    loadChatDetail,
    loadOlderMessages,
    refreshChatDetailQuietly,
  } = useInboxConversation({
    sendLockRef,
    CHAT_MESSAGE_PAGE_SIZE,
    selectedChatIdRef,
    detailAccountRef,
    detailRequestIdRef,
    setError,
    deepLinkIdRef,
    setDeepLinkNotice,
    selectedChatId,
    selectedAccountId,
    setChats,
    chats,
  })

  /* G2：会話の要約と返信案（l1i3v）。AI を使っていない店では何も出さない。 */
  const inboxAi = useInboxAi(chatDetail?.id ?? null, selectedAccountId, chatDetail?.messages)

  const activeFriendId = (chatDetail?.id === selectedChatId ? chatDetail.friendId : null)
    ?? chats.find((chat) => chat.id === selectedChatId)?.friendId
    ?? null

  const {
    chatSearch,
    chatSearchFocusSeq,
    chatSearchFilling,
    chatSearchTarget,
    openChatSearch,
  } = useInboxSearch({
    chatDetail,
    messagesHasMore,
    selectedChatIdRef,
    detailAccountRef,
    setChatDetail,
    setMessagesHasMore,
    setError,
  })

  const {
    chatPollStalled,
    setChatPollRetryKey,
  } = useInboxSubscription({
    refreshChatDetailQuietly,
    channel,
    loadChatsQuietly,
  })

  const {
    sendError,
    pendingMessages,
    handleSendMessage,
    handleSendPack,
    handleKeyDown,
  } = useInboxSend({
    selectedChatId,
    sending,
    sendLockRef,
    pendingAttachment,
    messageContent,
    pendingImage,
    selectedAccountId,
    setSending,
    chatDetail,
    quotedMessage,
    senderId,
    sendKeysRef,
    dropSentDraft,
    selectedChatIdRef,
    detailAccountRef,
    pendingImageRef,
    setPendingImage,
    setPendingImageMeta,
    setMessageContent,
    setChatDetail,
    setChats,
    statusFilterRef,
    attachDraftsRef,
    putAttachment,
    correctingId,
    setCorrectingId,
    setQuotedMessage,
    pendingPack,
    setPendingPack,
    isComposingRef,
    sendMode,
  })

  const {
    showMemoEditor,
    setShowMemoEditor,
    memoDraft,
    setMemoDraft,
    memoSaving,
    setMemoSaving,
    memoError,
    setMemoError,
    attentionSaving,
    setAttentionSaving,
    handleStatusUpdate,
    handleAttentionUpdate,
    closeMemoEditor,
    memoPopoverRef,
  } = useInboxActions({
    chatDetail,
    selectedChatId,
    loadChatDetail,
    loadChats,
    setError,
    setChatDetail,
    setChats,
  })

  /** 担当を付け替える（設計 `TalkPane` の「担当」）。 */
  const handleOperatorUpdate = async (operatorId: string | null) => {
    if (!selectedChatId || !chatDetail) return
    try {
      await api.chats.update(selectedChatId, { operatorId, revision: chatDetail.revision })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch (reason) {
      saveErrors.capture(reason)
      setError('担当の更新に失敗しました。時間をおいて、もう一度お試しください。')
    }
  }

  const handleSaveMemo = async () => {
    if (!selectedChatId || memoSaving) return
    /*
     * 保存を始めた会話と版を固定する(INBOX-25)。応答を待つ間に別の
     * 会話・アカウントへ切り替わっても、その画面へ結果を書き込まない。
     */
    const savingChatId = selectedChatId
    const savingAccountId = selectedAccountId
    const savingRevision = chatDetail?.revision
    const notes = memoDraft.trim() || null
    setMemoSaving(true)
    setMemoError('')
    try {
      const response = await api.chats.update(savingChatId, {
        notes,
        revision: savingRevision,
      })
      if (!response.success) throw new Error(response.error || '内部メモを保存できませんでした。時間をおいて、もう一度お試しください。')
      // 返ってきた版を採用する。古い版のまま次の保存を送ると409になる。
      setChatDetail((current) => current && current.id === savingChatId
        ? { ...current, notes: response.data?.notes ?? notes, revision: response.data.revision }
        : current)
      setChats((current) => current.map((chat) => chat.id === savingChatId
        ? { ...chat, notes }
        : chat))
      // 開いている紙を閉じるのは、いまも同じ会話を見ているときだけ。
      if (selectedChatIdRef.current === savingChatId && detailAccountRef.current === savingAccountId) {
        setShowMemoEditor(false)
        notifySaved(`「${chatDetail?.friendName ?? '友だち'}」の内部メモを保存しました`)
      }
    } catch (memoSaveError) {
      if (selectedChatIdRef.current === savingChatId && detailAccountRef.current === savingAccountId) {
        saveErrors.capture(memoSaveError)
        setMemoError(japaneseDetailOf(memoSaveError) || '内部メモを保存できませんでした。時間をおいて、もう一度お試しください。')
      }
    } finally {
      setMemoSaving(false)
    }
  }

  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: showMemoEditor && memoDraft !== (chatDetail?.notes ?? ''),
    busy: memoSaving,
    samePage: (destination) => destination.pathname === '/chats',
    onDiscard: () => { setShowMemoEditor(false); setMemoDraft(chatDetail?.notes ?? '') },
  })

  // 同じ会話IDが別アカウントにも存在していても、切替前の遅い応答を表示しない。
  // 初回表示では深いリンクを消さず、実際にアカウントが変わったときだけ外す。
  useEffect(() => {
    if (detailAccountRef.current === selectedAccountId) return
    detailAccountRef.current = selectedAccountId
    detailRequestIdRef.current += 1
    setSelectedChatId(null)
    setSelectedThreadId(null)
    setChatDetail(null)
    setDetailLoading(false)
    setAttentionSaving(false)
  }, [selectedAccountId, setAttentionSaving, setChatDetail, setDetailLoading])

  const {
    messagesScrollRef,
    unseenIncoming,
    setUnseenIncoming,
  } = useInboxScroll({
    pendingMessages,
    selectedChatId,
    chatDetail,
    textareaRef,
    messageContent,
  })

  const lineContent = (<FriendInfoSidebarBoundary resetKey={`${selectedAccountId ?? ''}:${activeFriendId ?? ''}`}><FriendInfoSidebar
            lastContactAt={chatDetail && chatDetail.id === selectedChatId ? chatDetail.lastMessageAt : null}
            friendId={activeFriendId}
            accountId={selectedAccountId ?? undefined}
            chatId={chatDetail && chatDetail.id === selectedChatId ? chatDetail.id : null}
            revision={chatDetail && chatDetail.id === selectedChatId ? chatDetail.revision : undefined}
            operators={operators}
            operatorId={chatDetail && chatDetail.id === selectedChatId ? chatDetail.operatorId : null}
            onChatChanged={() => {
              if (selectedChatId) void loadChatDetail(selectedChatId)
              void loadChats()
            }}
            operatorName={
              chatDetail?.operatorId
                ? operators.find((operator) => operator.id === chatDetail.operatorId)?.name ?? chatDetail.operatorName ?? '担当者不明'
                : null
            }
            chatStatus={
              chatDetail && chatDetail.id === selectedChatId
                ? { status: chatDetail.status, notes: chatDetail.notes }
                : undefined
            }
          /></FriendInfoSidebarBoundary>)

  return (
    <SaveErrorScope errors={saveErrors}><div className="space-y-3">
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した内部メモ" onConfirm={confirmLeave} onCancel={cancelLeave} />

      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {savedViewNotice ? <Notice tone="info" message={savedViewNotice} /> : null}
      <InboxPage elementRef={panesRef} boardId="eovoG" composed>
        {/* Left Panel: Chat List */}
        {/* 設計 `ListPane` 360px。 */}
        {/*
          顧客情報を開いている間は一覧を 288px に留める(#982 LAY-01)。
          以前は 2xl で 420px へ急拡大し、一覧+トーク+顧客情報の3列が
          1536px でちょうど収まらなくなっていた。顧客情報を閉じた
          2列だけのときだけ 420px へ広げる。
        */}
        {/* 狭い画面では、開いている間は一覧を隠して中央を広く使う。
            メールを開いたときも同じ。ここが LINE だけを見ていたので、
            メールを開いても一覧が残って中央が半分のままだった。 */}
        <InboxList {...{
          unreadOnly, selectedChatId, selectedThreadId: visibleThreadId, setFilterOpen, filterOpen, setSavedViewsOpen,
          setSavedViewError, savedViewsOpen, savedViews, applySavedView, operatorNames, setSavedViewMenuId,
          savedViewMenuId, selectedAccountId, loadSavedViews, setSavedViewSuccess, setSaveDialogOpen,
          savedViewError, setSlaReload, slaEnabled, overdueTotal, quickFilter, setQuickFilter,
          dropSavedViewParam, quickCountsNow, saveDialogOpen, statusFilter, assigneeFilter, operators,
          savingView, setSavedViewName, createSavedView, showTemplatePicker, setStatusFilter,
          setAssigneeFilter, setUnreadOnly, channel, emailInboxEnabled, router, nameQuery, setNameQuery, assigneeUnreadStatus,
          assigneeUnread, listScrollRef,
          emailError, loadEmails, chatListFailed, loadChats, emailItems, chats,
          handleSelectChat, handleSelectEmail, inboxListLoading, inboxListRefreshing, hasMoreChats, hasMoreEmails, inboxListFailed, hasInboxFilters,
          clearInboxFilters, loadingMore, loadMoreChats, loadingMoreEmails, sortOrder, setSortOrder,
        }} />

        {/* Right Panel: Chat Detail */}
        {/*
          `min-w-0 flex-1` だけにして、トーク列は残り幅いっぱいに伸縮させる。
          以前の `xl:min-w-xl`（576px）は min-w-0 を上書きして 1280〜1536px
          で右の顧客情報を画面外へ押し出していた(#982 LAY-01)。
          顧客情報は狭い幅では列ではなくドロワーで開く（下の aside 参照）。
        */}
        <InboxConversation {...{
          operators, selectedChatId, selectedThreadId: visibleThreadId, setSelectedThreadId, showFriendInfo, setShowFriendInfo,
          loadEmails, deepLinkNotice, clearDeepLink, detailLoading, chatDetail, setSelectedChatId,
          attentionSaving, handleAttentionUpdate, handleOperatorUpdate, handleStatusUpdate, chatSearch,
          openChatSearch, inboxAi, selectedAccountId, chatSearchFocusSeq, chatSearchFilling, messagesScrollRef,
          messagesHasMore, loadingOlderMessages, loadOlderMessages, chatSearchTarget, setQuotedMessage,
          textareaRef, staffRole, setCorrectingId, setMessageContent, unseenIncoming, setUnseenIncoming,
          dropOver, setDropOver, handlePickAttachment, chatPollStalled, setChatPollRetryKey,
          setShowTemplatePicker, showComposerOptions, setShowComposerOptions, showMemoEditor,
          setShowMemoEditor, sendMode, setSendMode, memoPopoverRef, memoDraft, setMemoDraft, memoError,
          closeMemoEditor, handleSaveMemo, memoSaving, quotedMessage, pendingImage, setImagePreviewOpen,
          pendingImageMeta, imageInputRef, imageUploading, clearPendingImage, pendingAttachment, sending,
          scheduling, clearPendingAttachment, retryAttachment, messageContent, handleKeyDown, isComposingRef,
          messageOverLimit, messageLength, imageError, senderId, setSenderId, setShowSchedulePanel,
          showSchedulePanel, scheduledSends, handleSendMessage, scheduleInput, setScheduleInput,
          handleScheduleSend, error, scheduledSendsFailed, loadScheduledSends, handleReschedule,
          handleCancelScheduled, showTemplatePicker, setPendingPack, pendingPack, handleSendPack,
          imagePreviewOpen, sendError, pendingMessages, quickCountsNow, statusCountsNow, slaEnabled,
          overdueTotal, chats, emailItems, onOpenAttentionTarget: openAttentionTarget,
        }} />

        {/*
          友だち詳細。3列に収まる幅（1536px〜）では右列として常設し、
          それより狭い幅ではトークの上に重ねるドロワーにする(#982)。
          以前は `hidden xl:block` だけで、1280px未満では開閉ボタンを
          押しても何も出ず、1280〜1536pxでは `xl:min-w-xl` と固定幅の
          積み上げで右に切れていた。

          friendId は **現在の選択** を優先する。chatDetail の読み込み中は
          一覧にある chat.friendId を使い、読み込み後は同じ会話の
          chatDetail.friendId を使う。会話IDと友だちIDは別物なので混同しない。
        */}
        {/*
          友だち詳細。メールでも出したいが、メールのスレッドは友だちに
          紐づいていない（support_email_threads は customer_email しか
          持たない）。メールアドレスから友だちを引く口が要る。

          いまはメールを開いているときは案内を出す。空の枠を出すより、
          なぜ出ないかが分かる方がよい。
        */}
        <InboxCustomerPanel
          lineContent={lineContent}
          showFriendInfo={showFriendInfo}
          selectedChatId={selectedChatId}
          selectedThreadId={visibleThreadId}
          wideInfoPanel={wideInfoPanel}
          setShowFriendInfo={setShowFriendInfo}
          customerPanelRef={customerPanelRef}
          emailItems={emailItems}

        />
      </InboxPage>
    </div></SaveErrorScope>
  )
}

/**
 * 受信箱（設計 `V2 2-1 受信箱`）。
 *
 * 設計に上部タブは無い。チャネル（すべて / LINE / メール）は
 * 画面内の絞り込みチップとして扱う。タブにすると「LINEの受信箱」と
 * 「メールの受信箱」が別物に見えるが、実際は1つの受信箱で、
 * 出どころが違うだけ。設計が1画面にまとめているのはそのため。
 *
 * ただし中身の作りが LINE とメールで大きく違うので、いまは
 * チップで表示を切り替える形にしている。将来1つの一覧に混ぜるときも、
 * 画面の入口は変わらない。
 */
// 受信箱のチャネル。
//
// /api/support/inbox は channel を 'all' | 'line' | 'email' で受け取り、
// どちらの出どころも同じ形（id / channel / customerName / preview /
// lastIncomingAt）で返す。つまり1つの一覧に混ぜられる。
function ChatsPageHost() {
  const params = useSearchParams()
  const { selectedAccountId, selectedAccount, loading } = useAccount()
  // 既存アカウントはこれまでどおり。新規アカウントはメール接続が未設計なのでLINEだけ。
  const emailInboxEnabled = !loading && (!selectedAccountId || selectedAccount?.emailInboxEnabled === true)
  const channel = resolveInboxChannel(params.get('channel'), emailInboxEnabled)

  return (
    <div className="space-y-3">
      {/*
        1つの受信箱。LINEもメールも同じ一覧に並び、同じ場所で開く。

        以前はメールを下に別ブロックで積んでいたが、返信を待っている人を
        2か所で探すことになっていた。設計 `V2 2-1 受信箱` の一覧も
        「✉ 定期便の解約について」のように1本に混ざっている。
      */}
      <ChatsPageInner channel={channel} emailInboxEnabled={emailInboxEnabled} />

    </div>
  )
}

/** 訂正の見本の文（店ごとに直せる）。 */

export default function ChatsPage() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<div className="text-ink-faint p-6 text-sm">読み込み中…</div>}>
      <ChatsPageHost />
    </Suspense>
  )
}
