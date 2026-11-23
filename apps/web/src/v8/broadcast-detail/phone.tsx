import { ImageIcon } from 'lucide-react'
import LinePreview, { LinePreviewCarousel, LinePreviewMessage } from '@/components/shared/line-preview'
import MusuboMark from '@/components/shared/musubo-mark'
import BroadcastMessagePreview from '@/components/broadcasts/broadcast-message-preview'
import type { BroadcastBubble, BroadcastMessageButton } from '@/lib/api'
import styles from './phone.module.css'

/**
 * ★V8 右の欄の「本物のスマホ」（絵の の「スマホ 配信の中身」）。
 *
 * 外枠 330×690・黒い島・LINE の上の帯・トーク・下のメニュー。
 * テキストは絵の吹き出し（幅200）で出し、写真・カルーセルなどは
 * 今の見本の部品（BroadcastMessagePreview）をトークの中に置く。
 */
export default function BroadcastPhone({
  broadcast,
  accountName,
  chip,
  time,
}: {
  broadcast: {
    messageType: string
    messageContent: string
    messageBubbles?: BroadcastBubble[] | null
    messageOptions?: { buttons?: BroadcastMessageButton[] | null } | null
  }
  /** 部屋の名（LINE公式アカウントの表示名）。 */
  accountName: string
  /** トークの上の札。例「8/24（月）10:00 に届きます」「送る前の見本」。 */
  chip?: string
  /** 吹き出しの横の時刻。まだ決まっていなければ「—」。 */
  time: string
}) {
  const previewName = accountName.trim() || 'musubo'
  const initial = accountName.trim() ? accountName.trim().charAt(0) : <MusuboMark />
  const single = !(broadcast.messageBubbles?.length)
  const plainText = broadcast.messageType === 'text' && single && !broadcast.messageOptions?.buttons?.length
  /* 写真1枚は絵の「画像」（200×200・角丸16）。URL が読めないときは枠と「写真」だけ。 */
  const photo = broadcast.messageType === 'image' && single ? { url: imageUrlOf(broadcast.messageContent) } : null
  /* カルーセル1通は吹き出しに入れず、カードを横に並べる。読めない中身は今までどおり種別名。 */
  const carousel = broadcast.messageType === 'carousel' && single ? carouselColumnsOf(broadcast.messageContent) : null
  if (carousel) {
    return (
      <LinePreview title={null} accountName={previewName} caption={chip}>
        <LinePreviewCarousel columns={carousel} />
      </LinePreview>
    )
  }
  return (
    <LinePreview title={null} accountName={previewName} caption={chip}>
      <LinePreviewMessage accountName={previewName} avatar={initial} time={time} bare={Boolean(photo)}>
                {plainText ? (
                  <p className={styles.bubble}>{broadcast.messageContent}</p>
                ) : photo ? (
                  photo.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- LINE に送る画像の見本（外部の URL）
                    <img width={200} height={200} className={styles.photo} src={photo.url} alt="送る写真" />
                  ) : (
                    <span className={`${styles.photo} ${styles.photoEmpty}`}>
                      <ImageIcon aria-hidden="true" />
                      写真
                    </span>
                  )
                ) : (
                  <div className={styles.rich}>
                    <BroadcastMessagePreview
                      bubbles={broadcast.messageBubbles}
                      messageType={broadcast.messageType}
                      messageContent={broadcast.messageContent}
                      buttons={broadcast.messageOptions?.buttons}
                    />
                  </div>
                )}
      </LinePreviewMessage>
    </LinePreview>
  )
}

/** 写真の中身（`{"originalContentUrl": …}`）から見本に出す URL を読む。読めなければ null。 */
function imageUrlOf(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { previewImageUrl?: unknown; originalContentUrl?: unknown }
    const url = typeof parsed.previewImageUrl === 'string' ? parsed.previewImageUrl : parsed.originalContentUrl
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

/** カルーセルの中身（columns の配列）から見本のカードを読む。読めなければ null。 */
function carouselColumnsOf(content: string): Array<{ title: string; text: string; imageUrl: string | null; actions: string[] }> | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed.map((raw) => {
      const column = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const actions = Array.isArray(column.actions) ? column.actions.map((action) => (action && typeof action === 'object' ? String((action as Record<string, unknown>).label ?? '') : '')).filter(Boolean) : []
      return {
        title: typeof column.title === 'string' ? column.title : '',
        text: typeof column.text === 'string' ? column.text : '',
        imageUrl: typeof column.thumbnailImageUrl === 'string' ? column.thumbnailImageUrl : null,
        actions,
      }
    })
  } catch {
    return null
  }
}
