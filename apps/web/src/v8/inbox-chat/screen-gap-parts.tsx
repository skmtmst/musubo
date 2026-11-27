'use client'

import { useState } from 'react';
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared';
import { InboxMedia } from '@/components/shared/inbox-content';


function StickerMessageImage({ content }: { content: string }) {
  return <StickerImage key={content} content={content} />
}

function StickerImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  // 本文由来のURLをそのまま読みに行く。https 以外(意図しない scheme・
  // 空文字など)は画像にせず、文字の代替表示に倒す。共通側の許可リスト
  // 検証(#493-C1)が入るまでの間の最低限の guard。
  if (!sticker || failed || !sticker.stickerUrl.startsWith('https://')) {
    return (
      <span className="inline-flex flex-col items-center gap-1">
        <span>{fallback}</span>
        {sticker && failed ? (
          <button
            type="button"
            onClick={() => { setFailed(false); setRetryKey((key) => key + 1) }}
            className="text-action text-micro font-semibold underline underline-offset-2"
          >
            画像を読み込み直す
          </button>
        ) : null}
      </span>
    )
  }

  return (
    <InboxMedia kind="sticker"
      key={retryKey}
      src={sticker.stickerUrl}
      alt={fallback}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}


/**
 * 履歴の画像メッセージ(INBOX-30)。
 *
 * 以前は alt 空・onError なしの `<img>` だけで、404・期限切れ・回線断で
 * 何も出ない空白になっていた。スタンプと同じく、失敗は代替表示と
 * 再読み込みに倒す。画像の内容は推測して書かない。
 */
function ChatImageMessage({ content }: { content: string }) {
  return <ChatImage key={content} content={content} />
}

function ChatImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  let url: string | null = null
  try {
    const parsed = JSON.parse(content) as { originalContentUrl?: unknown; previewImageUrl?: unknown }
    const candidate = parsed.originalContentUrl ?? parsed.previewImageUrl
    if (typeof candidate === 'string' && candidate.startsWith('https://')) url = candidate
  } catch {
    url = null
  }

  if (!url || failed) {
    return (
      <span className="flex min-w-40 flex-col items-center justify-center gap-1.5 rounded-mini bg-canvas-sunken px-4 py-6 text-center">
        <span className="text-ink-faint text-xs">画像を読み込めませんでした</span>
        {url ? (
          <button
            type="button"
            onClick={() => { setFailed(false); setRetryKey((key) => key + 1) }}
            className="text-action text-xs font-semibold underline underline-offset-2"
          >
            画像を読み込み直す
          </button>
        ) : null}
      </span>
    )
  }

  return (
    <InboxMedia kind="image"
      key={retryKey}
      src={url}
      alt="画像"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
export { StickerMessageImage, ChatImageMessage }
