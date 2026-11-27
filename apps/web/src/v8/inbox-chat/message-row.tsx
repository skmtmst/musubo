import type { ReactNode } from 'react'
import FlexPreviewComponent from '@/components/flex-preview'
import { InboxFlexContent } from '@/components/shared/inbox-content'
import { InboxMessage, InboxMessageDay, InboxQuotedMessage } from '@/components/shared/inbox-thread'
import type { ChatDetailMessage } from '@/lib/api'
import { formatDateTime, formatTime } from '@/lib/format'
import { knownValue } from '@/lib/known-value'
import { Link2 } from 'lucide-react'
import AttachmentMessage from './attachment-message'
import { AUTO_SOURCE_LABEL, formatDayJa, formatYmdSlash, sameYmd } from './inbox-model'
import { ChatImageMessage, StickerMessageImage } from './screen-gap-parts'

/**
 * 会話の 1 件（日付の区切り・吹き出し・引用・シナリオの開始の印）。PC の受信箱と電話の画面で同じ物を使う。
 * 引用・訂正の操作は画面が渡す。渡さない（閲覧のみなど）と出さない。
 */
export function InboxMessageRow({ msg, idx, list, sending, searchHit = null, onQuote, onCorrect }: {
  msg: ChatDetailMessage
  idx: number
  list: readonly ChatDetailMessage[]
  /** 送っている途中の吹き出し（引用・訂正は出さない）。 */
  sending: boolean
  searchHit?: 'current' | 'other' | null
  onQuote?: (msg: ChatDetailMessage) => void
  /** 送ったあとは取り消せない。間違いは訂正を送る（送るのは人）。 */
  onCorrect?: (msg: ChatDetailMessage) => void
}) {
  const prevMsg = idx > 0 ? list[idx - 1] : null
  const isLast = idx === list.length - 1
  const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
  const isOutgoing = msg.direction === 'outgoing'
  const isSending = sending
  const unknownMessage = typeof msg.isUnsent !== 'boolean' || (msg.source !== 'scenario' && !msg.isUnsent && typeof msg.content !== 'string')

  // メッセージ表示の分岐
  let bubbleContent: ReactNode
  if (unknownMessage) {
    bubbleContent = <span>メッセージを確認できません</span>
  } else if (msg.isUnsent) {
    bubbleContent = <span className="text-ink-faint">送信を取り消しました</span>
  } else if (msg.messageType === 'flex') {
    bubbleContent = (
      <InboxFlexContent>
        <FlexPreviewComponent content={msg.content} maxWidth={280} />
      </InboxFlexContent>
    )
  } else if (msg.messageType === 'image') {
    // INBOX-30: 404・期限切れ・回線断は空白にせず、
    // 理由の出る代替表示と読み込み直しに倒す。
    bubbleContent = <ChatImageMessage content={msg.content} />
  } else if (msg.messageType === 'sticker') {
    bubbleContent = <StickerMessageImage content={msg.content} />
  } else if ((msg.messageType === 'video' || msg.messageType === 'file') && msg.direction === 'outgoing') {
    // ：送った動画・ファイルは JSON のまま出さず、再生できる枠・名前と期限の札にする。
    bubbleContent = <AttachmentMessage messageType={msg.messageType} content={msg.content} />
  } else {
    bubbleContent = <span>{msg.content}</span>
  }

  if (msg.source === 'scenario' && !unknownMessage) {
    const startedAt = formatDateTime(msg.createdAt)
    return (
      <>
        {showDateSep && (
          <div className="mb-3 flex justify-center" style={{ marginTop: idx === 0 ? 12 : 4 }}>
            <span className="bg-ink/20 text-on-accent/85 rounded-pill px-2.5 py-0.5 text-micro">
              {formatYmdSlash(msg.createdAt)}
            </span>
          </div>
        )}
        {/* 上下の 8px は窓分けの行が持つ（外の余白は測った高さに入らない）。 */}
        <div className="flex items-center justify-center gap-1.5" style={{ marginTop: !showDateSep && idx === 0 ? 8 : 0, marginBottom: isLast ? 8 : 0 }}>
          <span className="inline-flex items-center gap-1 rounded-pill bg-canvas/90 px-3 py-1 text-micro font-semibold text-action shadow-card">
            <Link2 aria-hidden="true" size={16} />
            シナリオ「{msg.scenarioName ?? '名称未設定'}」を開始
          </span>
          <time className="text-micro text-ink-faint">{startedAt}</time>
        </div>
      </>
    )
  }

  {
    /*
     * ★V8 やりとり（XqSvX「やりとり」）：日付は真ん中の小さな字、相手の吹き出しは白・薄い枠で
     * 顔を置かない、時刻は吹き出しの横（相手は右・こちらは左）、こちらの吹き出しは薄い緑で
     * 下に「K Kenta が送信」／「自動：…」。引用・探すの印・取り消しの扱いは 管理画面 と同じ。
     */
    const quotedNode = msg.quoted ? (
      <InboxQuotedMessage>
        {msg.quoted.isUnsent
          ? '取り消されたメッセージ'
          : msg.quoted.messageType === 'text'
            ? msg.quoted.content
            : `[${msg.quoted.messageType}]`}
      </InboxQuotedMessage>
    ) : null
    const autoLabel = knownValue(AUTO_SOURCE_LABEL, msg.source ?? '', '') || null
    return <>
      {showDateSep ? <InboxMessageDay first={idx === 0}>{formatDayJa(msg.createdAt)}</InboxMessageDay> : null}
      <InboxMessage sendStatus={isOutgoing ? (isSending ? 'sending' : 'sent') : undefined} outgoing={isOutgoing} last={isLast} time={formatTime(msg.createdAt)} searchHit={searchHit} senderName={msg.sentByStaffName} autoLabel={autoLabel}
        onQuote={unknownMessage || msg.isUnsent || isSending || !onQuote ? undefined : () => onQuote(msg)}
        onCorrect={onCorrect && !unknownMessage && !isSending && isOutgoing && msg.messageType === 'text' && !msg.isUnsent && msg.source !== 'scenario'
          ? () => onCorrect(msg)
          : undefined}>
        {quotedNode}{bubbleContent}
      </InboxMessage>
    </>
  }
}
