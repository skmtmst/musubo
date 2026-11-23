import { LinePreviewFlex } from '@/components/shared/line-preview'
import { MapPin } from 'lucide-react'

import type { BroadcastBubble, BroadcastMessageButton } from '@/lib/api'
import { contentExcerpt, messageTypeLabel } from '@/lib/broadcast-summary'

/**
 * 下書き・送信済みの中身を、種別ごとに分けて見せる（監査 R211）。
 *
 * 以前は `messageContent` をそのまま出していたので、位置情報は
 * `{"latitude":91,...}` という JSON が並び、ボタン付きテキストでは
 * ボタンが出なかった。作成画面の見え方（1通目の下にボタン）とそろえる。
 *
 * 吹き出しが無い古い配信は、従来の種別＋本文から1件分を作る。
 * 読めない中身は種別名だけにして、生の JSON は出さない。
 */
export default function BroadcastMessagePreview({
  bubbles,
  messageType,
  messageContent,
  buttons = null,
  unsentNote = false,
}: {
  bubbles?: BroadcastBubble[] | null
  messageType: string
  messageContent: string
  buttons?: BroadcastMessageButton[] | null
  /** 下書きのとき、まだ誰にも届いていないことを添える。 */
  unsentNote?: boolean
}) {
  const saved = (bubbles ?? []).filter(isPreviewBubble)
  const items: Array<{ key: string; type: string; text: string; location: LocationView | null }> =
    saved.length > 0
      ? saved.map((bubble, index) => bubbleView(`bubble-${index}`, bubble))
      : [{ key: 'legacy', type: messageType, text: messageContent, location: locationFromJson(messageContent) }]

  return (
    <div className="space-y-3">
      {unsentNote && (
        <p className="text-xs text-ink-faint">下書きのため、まだ誰にも届いていません。</p>
      )}
      {items.map((item, index) => (
        <div key={item.key}>
          {items.length > 1 && (
            <p className="mb-1 text-xs text-ink-faint">
              {index + 1}通目・{messageTypeLabel(item.type)}
            </p>
          )}
          {item.type === 'text' ? (
            <p className="whitespace-pre-wrap rounded-card rounded-tl-mini bg-canvas px-3 py-2 text-sm leading-6 text-ink shadow-card">
              {item.text || 'テキストを入力すると表示されます'}
            </p>
          ) : item.type === 'flex' ? <LinePreviewFlex content={item.text} /> : item.location ? (
            <div className="rounded-card bg-canvas p-3 text-sm shadow-card">
              <p className="flex items-center gap-1 font-bold text-ink">
                <MapPin size={16} aria-hidden />
                {item.location.title}
              </p>
              {item.location.address && (
                <p className="mt-0.5 text-xs text-ink-secondary">{item.location.address}</p>
              )}
              <p className="mt-0.5 text-xs text-ink-faint tabular-nums">
                緯度 {item.location.latitude}・経度 {item.location.longitude}
              </p>
            </div>
          ) : (
            <p className="rounded-card bg-canvas px-3 py-2 text-sm text-ink shadow-card">
              {contentExcerpt(item.type, item.text) || messageTypeLabel(item.type)}
            </p>
          )}
          {index === 0 && (buttons ?? []).map((button) => (
            <p
              key={`${button.label}-${button.value}`}
              className="mt-1 truncate rounded-control bg-accent-deep px-3 py-2 text-center text-xs font-medium text-on-accent"
              title={button.value}
            >
              {button.label || 'ボタン'}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}

type LocationView = {
  title: string
  address: string
  latitude: string
  longitude: string
}

function isPreviewBubble(bubble: BroadcastBubble): boolean {
  return (
    Boolean(bubble) &&
    typeof bubble === 'object' &&
    typeof bubble.id === 'string' &&
    typeof bubble.type === 'string' &&
    Boolean(bubble.content)
  )
}

function bubbleView(key: string, bubble: BroadcastBubble): {
  key: string
  type: string
  text: string
  location: LocationView | null
} {
  const content = bubble.content as Record<string, unknown>
  if (bubble.type === 'flex') return { key, type: bubble.type, text: typeof content.flexJson === 'string' ? content.flexJson : JSON.stringify(content), location: null }
  if (bubble.type === 'text') {
    return { key, type: bubble.type, text: String(content.text ?? ''), location: null }
  }
  if (bubble.type === 'location') {
    const state = content.state as { location?: Partial<Record<'title' | 'address' | 'latitude' | 'longitude', unknown>> } | undefined
    const loc = state?.location
    if (loc) {
      return {
        key,
        type: bubble.type,
        text: '',
        location: {
          title: typeof loc.title === 'string' && loc.title.trim() ? loc.title.trim() : '場所',
          address: typeof loc.address === 'string' ? loc.address.trim() : '',
          latitude: String(loc.latitude ?? ''),
          longitude: String(loc.longitude ?? ''),
        },
      }
    }
    return { key, type: bubble.type, text: '', location: null }
  }
  return { key, type: bubble.type, text: JSON.stringify(content), location: null }
}

function locationFromJson(messageContent: string): LocationView | null {
  try {
    const parsed = JSON.parse((messageContent ?? '').trim()) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.latitude === undefined || parsed.longitude === undefined) return null
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '場所',
      address: typeof parsed.address === 'string' ? parsed.address.trim() : '',
      latitude: String(parsed.latitude),
      longitude: String(parsed.longitude),
    }
  } catch {
    return null
  }
}
