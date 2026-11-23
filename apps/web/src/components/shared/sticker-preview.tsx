'use client'

import { useState } from 'react'
import { STICKER_IMAGE_PATHS } from './composer-stickers'

/** LINEのスタンプ画像。配信の下見で同じ画像と寸法を使う。 */
export default function StickerPreview({ stickerId, size = 96 }: { stickerId: string; size?: 80 | 96 }) {
  return <StickerImage key={stickerId} stickerId={stickerId} size={size} />
}

function StickerImage({ stickerId, size }: { stickerId: string; size: 80 | 96 }) {
  const [attempt, setAttempt] = useState(0)
  if (attempt >= STICKER_IMAGE_PATHS.length) return <span className="text-body">スタンプ</span>
  // 公開の小さい画像は最適化せず、取得できなければ次の置き場を試す。
  // eslint-disable-next-line @next/next/no-img-element
  return <img width={size} height={size}
    src={`https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/${STICKER_IMAGE_PATHS[attempt]}`}
    alt="スタンプ" className={size === 80 ? 'h-20 w-20' : 'h-24 w-24 object-contain'} onError={() => setAttempt(current => current + 1)} />
}
