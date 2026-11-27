'use client'


import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import TextLink from '@/components/shared/text-link'
import { useState } from 'react'

/*
 * メディアのプレビュー。全面の暗い幕の上に中身だけを出す。
 *
 * 閉じ方は右上の×・Escape・背景を押すの3つ。Tabは中で回り、閉じると
 * 開いたボタンへ焦点が戻る——この3点は共通の useOverlayFocus が担う。
 * 「開いたボタンへ戻る」は hook が開く直前の document.activeElement を
 * 覚えて戻すので、呼び出し側で起点を記録する必要はない。
 */
export default function MediaPreviewOverlay({
  filename,
  kind,
  src,
  onClose,
}: {
  filename: string
  kind: 'image' | 'video' | 'audio' | 'file'
  src: string
  onClose: () => void
}) {
  return <Dialog open title={`${filename}のプレビュー`} onCancel={onClose} size="wide">
    <MediaContent key={`${kind}:${src}`} filename={filename} kind={kind} src={src} />
  </Dialog>
}

function MediaContent({ filename, kind, src }: { filename: string; kind: 'image' | 'video' | 'audio' | 'file'; src: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Notice tone="danger">{kind === 'image' ? '画像を表示できませんでした。' : 'メディアを再生できませんでした。'}</Notice>
  return <>
      {kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={filename} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />
      ) : kind === 'video' ? (
        <video src={src} controls onError={() => setFailed(true)} className="max-h-full max-w-full" />
      ) : kind === 'audio' ? (
        <audio src={src} controls onError={() => setFailed(true)} />
      ) : (
        <div className="rounded-card bg-canvas p-6 text-center text-sm">
          <p className="text-ink font-medium">{filename}</p>
          <TextLink external href={src}   className="mt-2 inline-block hover:underline">
            ファイルへ
          </TextLink>
        </div>
      )}
  </>
}
