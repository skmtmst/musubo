'use client'

import { useInboxPreview } from './use-reservation-warning'
import TruncatedText from '@/components/shared/truncated-text'
import { terms } from '@/lib/terms'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import TemplatePicker from '@/components/chats/template-picker';
import Button from '@/components/shared/button';
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason';
import { canEditFeature } from '@/lib/staff-capability';
import ConfirmDialog from '@/components/shared/confirm-dialog';
import { InboxComposerActions, InboxComposerBottom, InboxComposerTools, InboxDraftArea, InboxDraftCount, InboxInputBox, InboxToolButton } from '@/components/shared/inbox-composer';
import { InboxFloatingPanel } from '@/components/shared/inbox-content';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import Notice from '@/components/shared/notice';
import SegmentedControl from '@/components/shared/segmented';
import SenderSelect from '@/components/shared/sender-select';
import { InboxComposer } from '@/components/templates/inbox-page';
import { formatNumber } from '@/lib/format';
import AttachMenu from '@/v8/inbox-chat/attach-menu';
import AttachmentChip from '@/v8/inbox-chat/attachment-chip';
import { ATTACH_NOTE, ATTACH_NOTE_TITLE, scheduledContentLabel } from '@/v8/inbox-chat/attachments';
import chatStyles from '@/v8/inbox-chat/inbox-chat.module.css';
import ScheduleSendDialog from '@/v8/inbox-chat/schedule-dialog';
import OperationTargetSummary from '@/components/shared/operation-target-summary';
import { Clock3, FileText, NotebookPen, Send, Settings2, X } from 'lucide-react';
import type { Props as ConversationProps } from './inbox-conversation-view-types';
import { MESSAGE_MAX_LENGTH, formatByteSize, formatJstScheduledAt, isoToJstDatetimeLocal } from './inbox-model';
import { TextArea as SharedTextArea } from '@/components/shared/text-field'
type Props = Pick<ConversationProps, 'dropOver' | 'setDropOver' | 'handlePickAttachment' | 'chatPollStalled' | 'setChatPollRetryKey' | 'setShowTemplatePicker' | 'showComposerOptions' | 'setShowComposerOptions' | 'showMemoEditor' | 'setShowMemoEditor' | 'sendMode' | 'setSendMode' | 'memoPopoverRef' | 'memoDraft' | 'setMemoDraft' | 'memoError' | 'closeMemoEditor' | 'handleSaveMemo' | 'memoSaving' | 'chatDetail' | 'quotedMessage' | 'setQuotedMessage' | 'pendingImage' | 'setImagePreviewOpen' | 'pendingImageMeta' | 'imageInputRef' | 'imageUploading' | 'clearPendingImage' | 'pendingAttachment' | 'sending' | 'scheduling' | 'clearPendingAttachment' | 'retryAttachment' | 'textareaRef' | 'messageContent' | 'setMessageContent' | 'handleKeyDown' | 'isComposingRef' | 'messageOverLimit' | 'messageLength' | 'selectedChatId' | 'imageError' | 'staffRole' | 'selectedAccountId' | 'senderId' | 'setSenderId' | 'setShowSchedulePanel' | 'showSchedulePanel' | 'scheduledSends' | 'handleSendMessage' | 'scheduleInput' | 'setScheduleInput' | 'handleScheduleSend' | 'sendError' | 'error' | 'scheduledSendsFailed' | 'loadScheduledSends' | 'handleReschedule' | 'handleCancelScheduled' | 'showTemplatePicker' | 'setPendingPack' | 'pendingPack' | 'handleSendPack'>
export default function InboxReplyComposer({ dropOver, setDropOver, handlePickAttachment, chatPollStalled, setChatPollRetryKey, setShowTemplatePicker, showComposerOptions, setShowComposerOptions, showMemoEditor, setShowMemoEditor, sendMode, setSendMode, memoPopoverRef, memoDraft, setMemoDraft, memoError, closeMemoEditor, handleSaveMemo, memoSaving, chatDetail, quotedMessage, setQuotedMessage, pendingImage, setImagePreviewOpen, pendingImageMeta, imageInputRef, imageUploading, clearPendingImage, pendingAttachment, sending, scheduling, clearPendingAttachment, retryAttachment, textareaRef, messageContent, setMessageContent, handleKeyDown, isComposingRef, messageOverLimit, messageLength, selectedChatId, imageError, staffRole, selectedAccountId, senderId, setSenderId, setShowSchedulePanel, showSchedulePanel, scheduledSends, handleSendMessage, scheduleInput, setScheduleInput, handleScheduleSend, sendError, error, scheduledSendsFailed, loadScheduledSends, handleReschedule, handleCancelScheduled, showTemplatePicker, setPendingPack, pendingPack, handleSendPack }: Props) {
  const { preview, warning: reservationWarning } = useInboxPreview(selectedChatId, messageContent)
  const friendId = chatDetail?.id === selectedChatId ? chatDetail.friendId : null
  const scheduleContext = useRef({ accountId: selectedAccountId, chatId: selectedChatId, friendId, generation: 0 })
  if (scheduleContext.current.accountId !== selectedAccountId || scheduleContext.current.chatId !== selectedChatId || scheduleContext.current.friendId !== friendId) {
    scheduleContext.current = { accountId: selectedAccountId, chatId: selectedChatId, friendId, generation: scheduleContext.current.generation + 1 }
  }
  const scheduleScopeRef = useRef<{ generation: number } | null>(null)
  if (!showSchedulePanel) scheduleScopeRef.current = null
  else if (!scheduleScopeRef.current) scheduleScopeRef.current = { generation: scheduleContext.current.generation }
  const scheduleScope = scheduleScopeRef.current
  const [scheduleTarget, setScheduleTarget] = useState<{ scope: { generation: number }; chatId: string; friendId: string; accountId: string | null } | null>(null)
  useEffect(() => {
    if (!showSchedulePanel || !scheduleScope || !selectedChatId || !friendId) return
    let active = true
    void api.friends.get(friendId).then((response) => {
      if (active) setScheduleTarget({ scope: scheduleScope, chatId: selectedChatId, friendId, accountId: response.success ? response.data.lineAccountId ?? null : null })
    }).catch(() => {
      if (active) setScheduleTarget({ scope: scheduleScope, chatId: selectedChatId, friendId, accountId: null })
    })
    return () => { active = false }
  }, [showSchedulePanel, scheduleScope, selectedChatId, friendId])
  const canInsertTemplate = staffRole !== null && canEditFeature('/chats', staffRole)
  const templateLockReason = usePermissionLockReason(canInsertTemplate)
  return (<InboxComposer
    data-inbox-v4="composer"
    data-drop-over={dropOver ? '' : undefined}
    onDragOver={((event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      if (!dropOver) setDropOver(true)
    })}
    onDragLeave={((event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(false)
    })}
    onDrop={((event) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault()
      setDropOver(false)
      const file = event.dataTransfer.files?.[0]
      if (file) void handlePickAttachment(file)
    })}>
    {/* INBOX-12: 定期更新が連続失敗で止まったときの理由と再試行 */}
    {chatPollStalled && (
      <p className="text-danger mb-2 text-xs">
        会話の更新を一時停止しています（接続できません）。
        <button
          type="button"
          onClick={() => setChatPollRetryKey((key) => key + 1)}
          className="font-bold underline"
        >
          再試行する
        </button>
      </p>
    )}
    {reservationWarning ? <Notice tone="warn" message={reservationWarning} /> : null}
    {/* 上段 */}
    {/*
                  U010: テンプレート・送信の設定・内部メモは横に収まらなければ
                  次の行へ折り返す。1行に固定したままだと 390px では右の
                  「内部メモ」が画面外へ切れて、存在自体に気づけない。
                */}
    {/*
                  ★V8（M0393 XqSvX「書く前の道具」）：4つとも白地・薄い枠・高さ32・墨の字13/600・印15。
                  「送信の設定」は settings-2、開いている間は緑の地と枠（段2「2.」）。
                  画像だけでなくファイル・動画も選ぶので「画像」は「添付」（paperclip）にする（オーナー指摘）。
                */}
    <InboxComposerTools
    >
      <>
        {/* 設計 2-1-1。選ぶと本文が入力欄に入る。 */}
        <InboxToolButton
          variant="secondary"
          size={'compact'}
          type="button"
          onClick={() => setShowTemplatePicker(true)}>
          <FileText aria-hidden="true" size={16} />
          テンプレートを選択
        </InboxToolButton>
        <InboxToolButton
          variant="secondary"
          size={'compact'}
          data-active={showComposerOptions ? '' : undefined}
          aria-expanded={showComposerOptions}
          type="button"
          onClick={() => setShowComposerOptions((v) => !v)}>
          {(<Settings2 aria-hidden="true" size={16} />)}
          送信の設定
        </InboxToolButton>

        {/*
                      設計 `B7CER8` は、開いている間このボタン自体が
                      琥珀色に変わる。窓が上に出るので、どのボタンから出た窓
                      なのかが分かる印が要る。
                    */}
        <InboxToolButton
          variant="secondary"
          size={'compact'}
          data-active={showMemoEditor ? '' : undefined}
          type="button"
          data-inbox-v6="internal-memo-toggle"
          onClick={() => setShowMemoEditor((current) => !current)}
          aria-expanded={showMemoEditor}>
          <NotebookPen aria-hidden="true" size={16} />
          内部メモ
        </InboxToolButton>
        {/* ★V8 B-6：［添付］の道具はやめ、入力欄の左下のクリップから選ぶ（M0393「7. 添付」）。v7 は今までの［画像］。 */}
        {(null)}
      </>
    </InboxComposerTools>

    {/* 送信の設定は送信キーだけ。入力中ローディングと画像の投入枠は
                    ここから外した。画像は下の枠のアイコンから選ぶ。 */}
    {showComposerOptions && (
      /*
       * ★V8（段2「2. 送信の設定（開いた）」）：見出し「送るキー」・切り替え（Enter／Shift+Enter）・
       * 説明1行の3段。前は選ぶカードの中で文字が切れ、丸が文字に重なっていた（オーナー指摘）。
       * 保存先（この端末の chat.sendMode）と動きは 管理画面 と同じ。
       */
      <div className={chatStyles.sendKey} data-inbox-v8="send-key">
        <p className={chatStyles.sendKeyTitle}>送るキー</p>
        <SegmentedControl
          size="small"
          aria-label="送るキー"
          options={[{ value: 'enter', label: 'Enter' }, { value: 'shift-enter', label: 'Shift+Enter' }]}
          value={sendMode}
          onChange={setSendMode}
        />
        <p className={chatStyles.sendKeyNote}>
          {sendMode === 'enter' ? 'Enter で送る／Shift+Enter で改行' : 'Shift+Enter で送る／Enter で改行'}（この端末に覚える）
        </p>
      </div>
    )}

    {/*
                  設計 `B7CER8` の内部メモは**画面を覆う窓ではなく、
                  「内部メモ」ボタンの上に出る紙**。トークを隠さずに、
                  直前のやり取りを見ながら書けるようにするため。
                */}
    <InboxFloatingPanel open={showMemoEditor} placement="above"
        role="dialog"
        aria-labelledby="chat-internal-memo-title"
        data-inbox-v6="internal-memo-popover"
        ref={memoPopoverRef}
      /*
        INBOX-19: 紙はボタンの上へ伸びるため、高さの上限を
        画面から差し引いておく。上限を超えた分は紙の中だけを
        スクロールさせ、見出しと操作が画面上部へ欠けない
        ようにする。
      */
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="chat-internal-memo-title" className="text-ink flex items-center gap-2 text-sm font-bold">
            <NotebookPen aria-hidden="true" size={16} className="text-status-warn" />
            内部メモを追加
          </h2>
          <span className="rounded-pill bg-status-warn-soft text-status-warn-deep text-micro shrink-0 px-2 py-0.5 font-semibold">
            スタッフのみ
          </span>
        </div>
        <p className="text-ink-faint mt-2 text-xs">
          対応方針や引き継ぎ内容を入力してください。顧客には表示・送信されません。
        </p>
        <label htmlFor="chat-internal-memo" className="sr-only">内部メモの本文</label>
        <SaveErrorField names={["notes", "memo"]}><SharedTextArea
          id="chat-internal-memo"
          value={memoDraft}
          onChange={(event) => setMemoDraft(event.target.value)}
          rows={4}
          placeholder="例：次回返信時に配送先住所を確認する"
          className="border-hairline focus:border-accent focus:ring-accent/15 rounded-control mt-3 w-full resize-y border bg-canvas px-3 py-2 text-sm leading-6 outline-none focus:ring-2"
        />
        </SaveErrorField>
        {memoError && <p className="text-danger mt-1 text-xs">{memoError}</p>}
        {/*
                      INBOX-19: 説明は独立した行へ。操作と同じ flex 行に置くと、
                      狭い幅で説明が1文字ずつ縦に割れ、紙全体が上へ伸びて
                      見出しが画面外へ出ていた。
                    */}
        <p className="text-ink-faint mt-3 text-xs">この内容は社内メンバーだけが確認できます</p>
        <div className="mt-3 flex items-center justify-end gap-2">
          {/* 設計 `B7CER8` の2つは h36・角丸8・13px・600。共通ボタンと同値。 */}
          <Button
            onClick={closeMemoEditor}
          >
            キャンセル
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSaveMemo()}
            disabled={memoSaving || memoDraft === (chatDetail?.notes ?? '')} busy={memoSaving} busyLabel="保存中…">メモを保存する
          </Button>
        </div>
      </InboxFloatingPanel>

    {/* N-025: 引用中のメッセージ。×で外す。 */}
    {quotedMessage && (
      <div
        data-inbox-v6="quote-preview"
        className="mb-2 flex items-center gap-2 rounded-control border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs"
      >
        <span className="shrink-0 font-semibold text-ink-faint">引用:</span>
        <span className="min-w-0 flex-1 truncate text-ink-secondary">
          {quotedMessage.isUnsent
            ? '取り消されたメッセージ'
            : quotedMessage.messageType === 'text'
              ? quotedMessage.content
              : `[${quotedMessage.messageType}]`}
        </span>
        <button
          type="button"
          onClick={() => setQuotedMessage(null)}
          aria-label="引用を解除"
          className="shrink-0 text-ink-faint hover:text-danger"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    )}

    {/* N-025: 送信予約パネル。日時はJSTのdatetime-localで入力する。 */}

    {/*
                  INBOX-32: 送る前に何を添付したかを見せる。
                  小さい画像・ファイル名・大きさ・外す/変更/大きく見る。
                  この添付は今開いている会話にだけ結びつく(INBOX-23)。
                */}
    {pendingImage && pendingImage.mode === 'line-image' && (
      <div
        data-inbox-v6="image-attachment-preview"
        className="mb-2 flex items-center gap-2 rounded-control border border-hairline bg-canvas-sunken px-3 py-2"
      >
        <button
          type="button"
          onClick={() => setImagePreviewOpen(true)}
          title="画像を大きく見る"
          aria-label="添付した画像を大きく見る"
          className="shrink-0"
        >
          <img width={40} height={40}
            src={pendingImage.previewImageUrl}
            alt={pendingImageMeta?.name ?? '添付した画像'}
            className="h-10 w-10 rounded-mini border border-hairline object-cover"
          />
        </button>
        <span className="min-w-0 flex-1 text-xs">
          <span className="text-ink block truncate font-semibold" title={pendingImageMeta?.name}>
            {pendingImageMeta?.name ?? '画像'}
          </span>
          <span className="text-ink-faint">
            {pendingImageMeta ? formatByteSize(pendingImageMeta.size) : ''}
            {pendingImageMeta ? '・添付済み' : '添付済み'}
          </span>
        </span>
        <Button
          type="button" variant="text" size="inline"
          onClick={() => imageInputRef.current?.click()}
          disabled={imageUploading} busy={imageUploading} busyLabel="画像を読み込み中…"
          className="shrink-0 whitespace-nowrap"
        >
          変更
        </Button>
        <button
          type="button"
          onClick={clearPendingImage}
          className="text-ink-faint hover:text-danger shrink-0 whitespace-nowrap text-xs"
        >
          外す
        </button>
      </div>
    )}

    {/* ★V8 B-6：動画・ファイルの札（名前・大きさ・×）。準備中・失敗（理由＋もう一度試す）もここで見せる。 */}
    {pendingAttachment ? (
      <div className={chatStyles.attachChips}>
        <AttachmentChip
          item={pendingAttachment}
          busy={sending || scheduling}
          onRemove={clearPendingAttachment}
          onRetry={retryAttachment}
        />
      </div>
    ) : null}

    {sendError ? <Notice tone="danger" message={sendError} /> : null}

    <InboxInputBox
    >
      {/* 中段 */}
      {/*
                    INBOX-20: この入力欄に textareaRef を付ける。
                    外れていると自動拡張と「引用を選んだら入力へ戻る」が
                    動かなかった。
                  */}
      <InboxDraftArea
        ref={textareaRef}
        value={messageContent}
        onChange={(e) => setMessageContent(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { isComposingRef.current = true }}
        onCompositionEnd={() => { isComposingRef.current = false }}
        rows={2}
        placeholder="メッセージを入力"
        aria-label="メッセージを入力"
        aria-invalid={messageOverLimit} />
      {preview !== null ? <Notice tone="info" heading="送るとこうなります："><TruncatedText value={preview} /></Notice> : null}

      <InboxDraftCount
      >
        {/* INBOX-29: 残りを送る前に見せる。超えたら送らせない。 */}
        <span className={messageOverLimit ? 'text-danger font-semibold' : 'text-ink-faint'}>
          {formatNumber(messageLength)} / {formatNumber(MESSAGE_MAX_LENGTH)}
          {messageOverLimit ? '・文字数が上限を超えています' : ''}
        </span>
        <span className="text-ink-faint shrink-0">
          {sendMode === 'enter' ? 'Enter で送る・Shift + Enter で改行' : 'Shift+Enter で送る・Enter で改行'}
        </span>
      </InboxDraftCount>

      {/* 下段 */}
      {/*
                    U009: 画像案内・予約・送信が同じ行に詰まると 390px で
                    「送信」が送／信に割れていた。行自体を折り返せるようにし、
                    長い画像エラーが出ても右の操作を圧迫しない。
                  */}
      <InboxComposerBottom
      >
        {/*
                    画像はここから。以前は「送信の設定」の中に投入枠を出しっぱなし
                    にしていて、入力欄が縦に伸びてトークが読めなかった。
                    アイコンを押すとファイルを選ぶ窓が開く。
                  */}
        {(
          /* ★V8 ：左下のクリップ（32角）＋「画像・動画・ファイルを添付」。選べない・大きすぎるはここに理由。 */
          <span className={chatStyles.attachLead}>
            <AttachMenu disabled={!selectedChatId} onPick={(file, slot) => void handlePickAttachment(file, slot)} />
            <span
              className={chatStyles.attachNote}
              data-error={imageError ? '' : undefined}
              role={imageError ? 'alert' : undefined}
              title={imageError || ATTACH_NOTE_TITLE}
            >
              {imageError ? imageError : imageUploading ? '画像を読み込み中…' : ATTACH_NOTE}
            </span>
          </span>
        )}
        <InboxComposerActions
        >
          {staffRole !== 'viewer' ? <SenderSelect accountId={selectedAccountId} value={senderId} onChange={setSenderId} disabled={sending} /> : null}
          <InboxToolButton
            size={'compact'}
            data-inbox-v6="schedule-toggle"
            onClick={() => setShowSchedulePanel((v) => !v)}
            aria-expanded={showSchedulePanel}
            aria-haspopup={'dialog'}>
            {(<Clock3 aria-hidden="true" size={16} />)}
            {terms.A41}{scheduledSends.length > 0 ? `(${scheduledSends.length})` : ''}
          </InboxToolButton>
          <Button variant="primary"
            size="standard"
            onClick={handleSendMessage}
            disabled={sending || messageOverLimit || ((pendingAttachment !== null) && pendingAttachment.status !== 'ready') || (!messageContent.trim() && !pendingImage && !(pendingAttachment?.status === 'ready'))}>
            {(!sending) ? <Send aria-hidden="true" size={16} /> : null}
            {sending ? '送っています…' : '送信する'}
          </Button>
        </InboxComposerActions>

        {(
          <ScheduleSendDialog
            open={showSchedulePanel}
            accountId={scheduleTarget?.scope === scheduleScope && scheduleTarget?.chatId === selectedChatId && scheduleTarget.friendId === friendId ? scheduleTarget.accountId : null}
            targetStale={!scheduleScope || scheduleScope.generation !== scheduleContext.current.generation || !selectedChatId || !friendId}
            onClose={() => { scheduleScopeRef.current = null; setShowSchedulePanel(false) }}
            content={messageContent}
            hasImage={Boolean(pendingImage)}
            attachmentLabel={pendingAttachment?.status === 'ready' ? `${pendingAttachment.kind === 'video' ? '動画' : 'ファイル'}「${pendingAttachment.name}」` : undefined}
            value={scheduleInput}
            onChange={setScheduleInput}
            onConfirm={() => { if (scheduleScope && scheduleScopeRef.current === scheduleScope && scheduleScope.generation === scheduleContext.current.generation && selectedChatId && friendId) void handleScheduleSend() }}
            busy={scheduling}
            error={showSchedulePanel && error ? error : undefined}
            rows={scheduledSends.map((row) => ({
              id: row.id,
              label: `${formatJstScheduledAt(row.scheduledAt)}${row.status === 'sending' ? '（送信中）' : ''}`,
              content: scheduledContentLabel(row.messageType, row.content),
              editable: row.status === 'scheduled',
              defaultValue: isoToJstDatetimeLocal(row.scheduledAt),
              tooLate: Date.parse(row.scheduledAt) - Date.now() < 60_000,
            }))}
            rowsFailed={scheduledSendsFailed}
            onRetryRows={() => { if (selectedChatId) void loadScheduledSends(selectedChatId) }}
            onReschedule={(id, next) => void handleReschedule(id, next)}
            onCancelRow={(id) => void handleCancelScheduled(id)}
          />
        )}
        <TemplatePicker
          open={showTemplatePicker}
          channel="line"
          canPick={canInsertTemplate}
          lockedReason={templateLockReason}
          onClose={() => setShowTemplatePicker(false)}
          chatId={selectedChatId}
          onPick={(content) =>
            // 入力済みの文があれば消さずに続ける。書きかけを失わせない。
            setMessageContent((prev) => (prev.trim() ? `${prev}\n${content}` : content))
          }
          onPickPack={(texts) => { if (selectedChatId) setPendingPack({ texts, chatId: selectedChatId, accountId: selectedAccountId, revision: chatDetail?.revision }); setShowTemplatePicker(false) }}
        />
        {/*
                    G-4: パック送信の最終確認。本文を全部読み合わせてから送る。
                    入力欄を経由しないので、ここで「何が・何通」送られるかを示す。
                  */}
        <ConfirmDialog
          open={pendingPack !== null}
          title="テンプレートをまとめて送る"
          description={pendingPack ? `${formatNumber(pendingPack.texts.length)}通をこの順番で一度に送ります。送信すると取り消せません。` : ''}
          confirmLabel={pendingPack ? `まとめて送る（${formatNumber(pendingPack.texts.length)}通）` : 'まとめて送る'}
          error={sendError || undefined} onSuccess={() => setPendingPack(null)} onConfirm={pendingPack ? () => handleSendPack(pendingPack) : undefined}
          onCancel={() => setPendingPack(null)}
          busy={sending}
        >
          {pendingPack ? <OperationTargetSummary accounts={[{ id: pendingPack.accountId ?? '' }]} /> : null}
          {pendingPack ? (
            <ol className="max-h-56 space-y-2 overflow-y-auto">
              {pendingPack.texts.map((text, index) => (
                <li key={index} className="rounded-control bg-canvas-sunken px-3 py-2 text-xs leading-relaxed text-ink-secondary">
                  <span className="mr-1 font-semibold text-ink">{index + 1}.</span>
                  <span className="whitespace-pre-wrap break-words">{text.length > 200 ? `${text.slice(0, 200)}…` : text}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </ConfirmDialog>
      </InboxComposerBottom>
    </InboxInputBox>
  </InboxComposer>)
}
