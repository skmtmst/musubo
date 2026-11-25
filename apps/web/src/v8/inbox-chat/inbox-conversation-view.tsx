'use client'
import ChatThreadWindow from '@/components/chats/chat-thread-window';
import { type ChatStatus } from '@/components/chats/inbox-dropdown';
import Button from '@/components/shared/button';
import Dialog from '@/components/shared/dialog';
import { InboxMedia } from '@/components/shared/inbox-content';
import { InboxHistoryButton } from '@/components/shared/inbox-list';
import { InboxThreadLoading } from '@/components/shared/inbox-thread';
import EmailThread from '@/components/support/email-thread';
import { InboxConversationPane, InboxMessages } from '@/components/templates/inbox-page';
import { EMAIL_SOURCE_LABEL, STORE_EMAIL_REPLY_LOCK_REASON } from './email-sources';
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { formatListRecent } from '@/lib/format';
import { InboxAiDraft, InboxAiHeadMenu, InboxAiSummary } from '@/v8/ai-reply/public/inbox-ai/index'
import ConversationHead from '@/v8/inbox-chat/conversation-head';
import { ChatSearchBar } from '@/v8/inbox-search/public/chat-search-bar/index'
import { CORRECTION_TEMPLATE, Chat, formatByteSize, formatInboxDatetime } from './inbox-model';

import { useMemo, useRef } from 'react';
import type { Props } from './inbox-conversation-view-types';
import InboxEmptyGuide from './inbox-empty-guide';
import InboxReplyComposer from './inbox-reply-composer';
import { InboxMessageRow } from './message-row';
import { withHonorific } from '@line-crm/shared'
import { canEditFeature } from '@/lib/staff-capability'
import { lockReason } from '@/components/shared/permission-lock'

export default function InboxConversation({ operators, selectedChatId, selectedEmail, storeEmailAccountId, setSelectedEmail, showFriendInfo, setShowFriendInfo, deepLinkNotice, clearDeepLink, detailLoading, chatDetail, setSelectedChatId, attentionSaving, handleAttentionUpdate, handleOperatorUpdate, handleStatusUpdate, chatSearch, openChatSearch, inboxAi, selectedAccountId, chatSearchFocusSeq, chatSearchFilling, messagesScrollRef, messagesHasMore, loadingOlderMessages, loadOlderMessages, chatSearchTarget, setQuotedMessage, textareaRef, tokenNames, staffRole, setCorrectingId, setMessageContent, unseenIncoming, setUnseenIncoming, dropOver, setDropOver, handlePickAttachment, chatPollStalled, setChatPollRetryKey, setShowTemplatePicker, showComposerOptions, setShowComposerOptions, showMemoEditor, setShowMemoEditor, sendMode, setSendMode, memoPopoverRef, memoDraft, setMemoDraft, memoError, closeMemoEditor, handleSaveMemo, memoSaving, quotedMessage, pendingImage, setImagePreviewOpen, pendingImageMeta, imageInputRef, imageUploading, clearPendingImage, pendingAttachment, sending, scheduling, clearPendingAttachment, retryAttachment, messageContent, handleKeyDown, isComposingRef, messageOverLimit, messageLength, imageError, senderId, setSenderId, setShowSchedulePanel, showSchedulePanel, scheduledSends, handleSendMessage, scheduleInput, setScheduleInput, handleScheduleSend, error, scheduledSendsFailed, loadScheduledSends, handleReschedule, handleCancelScheduled, showTemplatePicker, setPendingPack, pendingPack, handleSendPack, imagePreviewOpen, sendError, pendingMessages, quickCountsNow, statusCountsNow, slaEnabled, overdueTotal, chats, emailItems, onOpenAttentionTarget }: Props) {
  const messages = useMemo(() => pendingMessages?.length ? [...(chatDetail?.messages ?? []), ...pendingMessages] : (chatDetail?.messages ?? []), [chatDetail?.messages, pendingMessages])
  // 店舗の会話は店舗の口だけで開く。つながっていない間は共通の口で開き直さない。
  const openEmail = selectedEmail && (selectedEmail.source === 'shared' || storeEmailAccountId) ? selectedEmail : null
  // 共通メールの下書きはここで預かる。店舗の会話や LINE を見てから戻っても書きかけが残る。
  const sharedEmailDrafts = useRef(new Map<string, string>())
  return (<InboxConversationPane data-inbox-v4="talk-pane" selected={Boolean(selectedChatId || openEmail)}>
    {openEmail ? (
      /* メールの往復。LINEのトークと同じ場所に出す。会話・対応状況・既読・返信は届いた経路の口を使う。 */
      <EmailThread
        key={openEmail.source === 'store' ? `store:${storeEmailAccountId}` : 'shared'}
        threadId={openEmail.threadId}
        storeAccountId={openEmail.source === 'store' ? storeEmailAccountId : null}
        sourceLabel={EMAIL_SOURCE_LABEL[openEmail.source]}
        replyLockedReason={openEmail.source === 'store' ? STORE_EMAIL_REPLY_LOCK_REASON : undefined}
        draftStore={openEmail.source === 'shared' ? sharedEmailDrafts.current : undefined}
        readOnly={staffRole === 'viewer'}
        onBack={() => setSelectedEmail(null)}
        customerInfoOpen={showFriendInfo}
        onOpenCustomerInfo={() => setShowFriendInfo(true)}
        onCloseCustomerInfo={() => setShowFriendInfo(false)}
        onChanged={() => {
          // 一覧（共通と店舗）と件数・左のメニューの数を同じ知らせで読み直す。
          window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
        }}
      />
    ) : deepLinkNotice ? (
      // URL指定の会話が開けなかったときの空状態。別人は開かず、
      // 理由と戻り先だけ出す。不正IDではselectedChatIdがnullに
      // なるため、通常の「選択してください」より先に判定する。
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-ink text-sm font-semibold">会話を開けませんでした</p>
          <p className="text-ink-secondary mt-2 text-sm leading-relaxed">{deepLinkNotice}</p>
          <Button onClick={clearDeepLink} className="mt-4">
            受信箱の一覧へ戻る
          </Button>
        </div>
      </div>
    ) : !selectedChatId ? (
      <InboxEmptyGuide
        unread={statusCountsNow?.unread ?? null}
        overdue={slaEnabled ? overdueTotal : (quickCountsNow?.overdue ?? null)}
        slaEnabled={slaEnabled}
        chats={chats}
        emails={emailItems}
        onOpenTarget={onOpenAttentionTarget}
      />
    ) : <InboxThreadLoading key={`${selectedAccountId}:${selectedChatId}`} loading={detailLoading && !chatDetail}>{chatDetail ? (
      <>
        {/* Chat Header */}
        {/*
                U008: 狭い幅では「戻る・顔・名前」を1行目いっぱいに取り、
                操作（注目・担当・対応・顧客情報）は2行目へ折り返す。
                操作が同じ行にいると 390px で宛先の名前が潰れて、
                誰への返信か読めなかった。640px 以上では従来どおり1行。
              */}
        {(
          /*
           * ★V8 会話の頭（XqSvX）：顔28・名前15・補足、右に ☆・担当・対応状況・探す・右の列の出し入れ。
           * メールの会話も同じ部品（ConversationHead）を使う。動き（注目・担当・対応・探す・開閉）は同じ処理を呼ぶ。
           */
          <ConversationHead
            name={chatDetail.friendName}
            pictureUrl={chatDetail.friendPictureUrl}
            sub={`${chatDetail.friendRealName ? `${chatDetail.friendRealName}・` : ''}LINE・${formatListRecent(chatDetail.lastMessageAt)}`}
            subTitle={`${chatDetail.friendRealName ? `${chatDetail.friendRealName}・` : ''}LINE・最終受信 ${formatInboxDatetime(chatDetail.lastMessageAt)}`}
            onBack={() => setSelectedChatId(null)}
            attention={{ on: Boolean(chatDetail.isAttention), saving: attentionSaving, disabled: !staffRole, lockedReason: staffRole ? lockReason(canEditFeature('/friends', staffRole)) : undefined, onToggle: () => void handleAttentionUpdate() }}
            operator={{
              value: chatDetail.operatorId ?? 'unassigned',
              operators: chatDetail.operatorId && chatDetail.operatorName && !operators.some(o => o.id === chatDetail.operatorId) ? [{ id: chatDetail.operatorId, name: chatDetail.operatorName, disabled: true }, ...operators] : operators,
              onChange: (next) => { void handleOperatorUpdate(next === 'unassigned' ? null : next) },
            }}
            status={{ value: chatDetail.status as ChatStatus, onChange: (next) => void handleStatusUpdate(next as Chat['status']) }}
            search={{ open: chatSearch.open, onToggle: () => (chatSearch.open ? chatSearch.close() : openChatSearch()) }}
            panel={{ open: showFriendInfo, onToggle: () => setShowFriendInfo((current) => !current) }}
            extra={<InboxAiHeadMenu inboxAi={inboxAi} accountId={selectedAccountId} />}
          />
        )}
        <InboxAiSummary inboxAi={inboxAi} />

        {chatSearch.open && (
          <ChatSearchBar search={chatSearch} focusSeq={chatSearchFocusSeq} busy={chatSearchFilling} />
        )}

        {/* Messages — LINE-style chat bubbles */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* 板 `M0393`：会話の地は surface-pearl（LINE青の地は使わない）。 */}
          {/*
                2026-10-07 速さ：吹き出しは下から積む窓分け（ChatThreadWindow）。
                見ている位置は窓分けの側で守るので、ブラウザの自動の位置合わせは切る
                （二重に直すと飛ぶ）。行の間 8px は行の中に持つので space-y は付けない。
              */}
          <InboxMessages ref={messagesScrollRef} data-inbox-search-scope="">
            {/*
                  古い履歴の続き。直近100件だけ読んでいる会話で出す。
                  押すと今見えている最古の1件より古い分を上に足す。
                */}
            {messagesHasMore && (chatDetail.messages?.length ?? 0) > 0 && (
              <div className="flex justify-center pb-1">
                <InboxHistoryButton context="thread" busy={loadingOlderMessages}
                  onClick={() => { void loadOlderMessages() }}
                >
                  前のメッセージ
                </InboxHistoryButton>
              </div>
            )}
            {(messages.length === 0) ? (
              <div className="text-center py-8">
                <p className="text-on-accent/60 text-sm">メッセージはまだありません。</p>
              </div>
            ) : (
              <ChatThreadWindow
                key={chatDetail.id}
                messages={messages}
                scrollerRef={messagesScrollRef}
                hasMore={messagesHasMore}
                loadingOlder={loadingOlderMessages}
                onLoadOlder={() => { void loadOlderMessages() }}
                label={`${withHonorific(chatDetail.friendName)}とのメッセージ`}
                total={chatDetail.total === undefined ? undefined : chatDetail.total + (pendingMessages?.length ?? 0)}
                scrollToId={chatSearchTarget?.id ?? null}
                scrollSeq={chatSearchTarget?.seq ?? 0}
                rowGap={'var(--tpl-inbox-thread-gap)'}
                renderMessage={(msg, idx, list) => (
                  <InboxMessageRow msg={msg} idx={idx} list={list}
                    sending={pendingMessages?.some((pending) => pending.id === msg.id) === true}
                    searchHit={chatSearch.hitKind(msg)}
                    onQuote={(target) => { setQuotedMessage(target); textareaRef.current?.focus() }}
                    onCorrect={staffRole !== 'viewer'
                      ? (target) => { setQuotedMessage(target); setCorrectingId(target.id); setMessageContent((prev) => prev.trim() ? prev : CORRECTION_TEMPLATE); textareaRef.current?.focus() }
                      : undefined} />
                )}
              />
            )}
          </InboxMessages>
          {/*
                INBOX-27: 読み返している途中に下へ届いた新着は、位置を
                動かさず件数の目印だけ出す。押すと新しい方へ移る。
              */}
          {unseenIncoming > 0 && (
            <button
              type="button"
              onClick={() => {
                const el = messagesScrollRef.current
                if (el) el.scrollTop = el.scrollHeight
                setUnseenIncoming(0)
              }}
              className="bg-canvas/95 text-action absolute bottom-3 left-1/2 -translate-x-1/2 rounded-pill px-3 py-1.5 text-xs font-semibold shadow-card"
            >
              新着 {unseenIncoming} 件
            </button>
          )}
        </div>

        {/*
                入力欄（設計 `Reply`）。3段。

                  上: テンプレート・送信設定・内部メモ
                  中: メッセージを入力
                  下: 改行案内、画像は JPEG / PNG、1枚 10MB まで …… 送信

                以前は送信キーの設定・入力中ローディング・画像の投入枠が
                すべて出しっぱなしで、入力欄が縦に伸びてトークが読めなかった。
                よく使うものだけ出し、設定は畳む。
              */}
        <InboxAiDraft inboxAi={inboxAi} onInsert={(text) => { setMessageContent(text); textareaRef.current?.focus() }} />
        <InboxReplyComposer
          dropOver={dropOver}
          setDropOver={setDropOver}
          handlePickAttachment={handlePickAttachment}
          chatPollStalled={chatPollStalled}
          setChatPollRetryKey={setChatPollRetryKey}
          setShowTemplatePicker={setShowTemplatePicker}
          showComposerOptions={showComposerOptions}
          setShowComposerOptions={setShowComposerOptions}
          showMemoEditor={showMemoEditor}
          setShowMemoEditor={setShowMemoEditor}
          sendMode={sendMode}
          setSendMode={setSendMode}
          memoPopoverRef={memoPopoverRef}
          memoDraft={memoDraft}
          setMemoDraft={setMemoDraft}
          memoError={memoError}
          closeMemoEditor={closeMemoEditor}
          handleSaveMemo={handleSaveMemo}
          memoSaving={memoSaving}
          chatDetail={chatDetail}
          quotedMessage={quotedMessage}
          setQuotedMessage={setQuotedMessage}
          pendingImage={pendingImage}
          setImagePreviewOpen={setImagePreviewOpen}
          pendingImageMeta={pendingImageMeta}
          imageInputRef={imageInputRef}
          imageUploading={imageUploading}
          clearPendingImage={clearPendingImage}
          pendingAttachment={pendingAttachment}
          sending={sending}
          scheduling={scheduling}
          clearPendingAttachment={clearPendingAttachment}
          retryAttachment={retryAttachment}
          textareaRef={textareaRef}
          tokenNames={tokenNames}
          messageContent={messageContent}
          setMessageContent={setMessageContent}
          handleKeyDown={handleKeyDown}
          isComposingRef={isComposingRef}
          messageOverLimit={messageOverLimit}
          messageLength={messageLength}
          selectedChatId={selectedChatId}
          imageError={imageError}
          staffRole={staffRole}
          selectedAccountId={selectedAccountId}
          senderId={senderId}
          setSenderId={setSenderId}
          setShowSchedulePanel={setShowSchedulePanel}
          showSchedulePanel={showSchedulePanel}
          scheduledSends={scheduledSends}
          handleSendMessage={handleSendMessage}
          scheduleInput={scheduleInput}
          setScheduleInput={setScheduleInput}
          handleScheduleSend={handleScheduleSend}
          sendError={sendError}
          error={error}
          scheduledSendsFailed={scheduledSendsFailed}
          loadScheduledSends={loadScheduledSends}
          handleReschedule={handleReschedule}
          handleCancelScheduled={handleCancelScheduled}
          showTemplatePicker={showTemplatePicker}
          setPendingPack={setPendingPack}
          pendingPack={pendingPack}
          handleSendPack={handleSendPack}
        />

        {/* INBOX-32: 添付画像を大きく確かめる窓。背景か Esc 相当の閉じるで戻る。 */}
        {imagePreviewOpen && pendingImage && pendingImage.mode === 'line-image' ? (
          <Dialog open title="添付した画像の確認" onCancel={() => setImagePreviewOpen(false)} designWidth={800}>
            <InboxMedia kind="preview" src={pendingImage.originalContentUrl} alt={pendingImageMeta?.name ?? '添付した画像'} />
            <p className="text-ink-faint mt-3 truncate text-xs" title={pendingImageMeta?.name}>{pendingImageMeta?.name ?? '画像'}{pendingImageMeta ? `・${formatByteSize(pendingImageMeta.size)}` : ''}</p>
          </Dialog>
        ) : null}
      </>
    ) : null}</InboxThreadLoading>}
  </InboxConversationPane>)
}
