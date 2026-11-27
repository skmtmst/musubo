'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import Button from '@/components/shared/button'
import styles from './post-image-crop.module.css'
import { ApiError } from '@/lib/api'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'

export type CropTarget = 'google' | 'instagram'
export type CropSource = { file?: File; url?: string; name: string; mediaId?: string }

function outputName(name: string, target: CropTarget) {
  const stem = name.replace(/\.[^.]+$/, '')
  return `${stem}${target === 'instagram' ? '-instagram' : ''}.jpg`
}

export function PostImageCrop({ target, source, onClose, onConfirm }: {
  target: CropTarget
  source: CropSource
  onClose: () => void
  onConfirm: (file: File) => Promise<void>
}) {
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const start = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const [src, setSrc] = useState('')
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const sourceRef = useRef(source)
  if (sourceRef.current !== source) {
    sourceRef.current = source
    busyRef.current = false
  }
  const ratio = target === 'google' ? 4 / 3 : 4 / 5
  const title = target === 'google' ? 'Google用画像の切り取り位置を確認' : 'Instagram用画像の切り取り位置を確認'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      busyRef.current = false
    }
  }, [])

  useEffect(() => {
    const next = source.file ? URL.createObjectURL(source.file) : source.url ?? ''
    setSrc(next)
    setDimensions({ width: 0, height: 0 })
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    setError('')
    setBusy(false)
    return () => { if (source.file) URL.revokeObjectURL(next) }
  }, [source])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); document.body.style.overflow = priorOverflow; previous?.focus() }
  }, [busy, onClose])

  useEffect(() => {
    if (!frame.current || !stage.current) return
    const observer = new ResizeObserver(() => {
      const bounds = frame.current?.getBoundingClientRect()
      if (bounds) setFrameSize({ width: bounds.width, height: bounds.height })
      const stageBounds = stage.current?.getBoundingClientRect()
      if (stageBounds) setStageSize({ width: stageBounds.width, height: stageBounds.height })
    })
    observer.observe(frame.current)
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])

  const baseWidth = dimensions.width && stageSize.width
    ? Math.max(stageSize.width, stageSize.height * dimensions.width / dimensions.height) : 0
  const baseHeight = dimensions.height && stageSize.height
    ? Math.max(stageSize.height, stageSize.width * dimensions.height / dimensions.width) : 0
  const limitX = Math.max(0, (baseWidth * zoom - frameSize.width) / 2)
  const limitY = Math.max(0, (baseHeight * zoom - frameSize.height) / 2)
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))
  const move = (x: number, y: number) => setOffset({ x: clamp(x, limitX), y: clamp(y, limitY) })

  const applyCrop = async () => {
    const img = image.current
    if (!img || !img.naturalWidth || !frameSize.width || busy || busyRef.current) return
    const activeSource = sourceRef.current
    const isCurrent = () => mountedRef.current && sourceRef.current === activeSource
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const width = target === 'google' ? 1200 : 1080
      const height = Math.round(width / ratio)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('画像を処理できませんでした。')
      const sourceWidth = img.naturalWidth * frameSize.width / (baseWidth * zoom)
      const sourceHeight = img.naturalHeight * frameSize.height / (baseHeight * zoom)
      const sourceX = (img.naturalWidth - sourceWidth) / 2 - offset.x * img.naturalWidth / (baseWidth * zoom)
      const sourceY = (img.naturalHeight - sourceHeight) / 2 - offset.y * img.naturalHeight / (baseHeight * zoom)
      context.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      if (!isCurrent()) return
      if (!blob) throw new Error('画像を保存できませんでした。')
      await onConfirm(new File([blob], outputName(source.name, target), { type: 'image/jpeg' }))
    } catch (cause) {
      if (!isCurrent()) return
      setError(
        cause instanceof ApiError && (cause.status === 403 || cause.status === 429)
          ? describeApiFailure(cause, '画像の保存')
          : japaneseDetailOf(cause) || '画像を保存できませんでした。',
      )
    } finally {
      if (isCurrent()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  return <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.header}>
        <div><h2>{title}</h2><p>画像をドラッグして位置を調整してください。切り取る範囲が投稿に表示されます。</p></div>
        <button ref={closeButton} className={styles.close} type="button" aria-label="閉じる" onClick={onClose} disabled={busy}><X size={22} /></button>
      </div>
      <div className={styles.body}>
        <div className={styles.stageWrap}>
          <div ref={stage} className={styles.stage} onPointerDown={(event) => {
            if (!dimensions.width) return
            event.currentTarget.setPointerCapture(event.pointerId)
            start.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y }
          }} onPointerMove={(event) => {
            if (start.current) move(start.current.offsetX + event.clientX - start.current.x, start.current.offsetY + event.clientY - start.current.y)
          }} onPointerUp={() => { start.current = null }} onPointerCancel={() => { start.current = null }}>
            {src ? <img ref={image} src={src} alt="" crossOrigin={source.file ? undefined : 'anonymous'} draggable={false} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError('画像を読み込めませんでした。')} style={{ width: baseWidth * zoom || undefined, height: baseHeight * zoom || undefined, left: `calc(50% + ${offset.x}px)`, top: `calc(50% + ${offset.y}px)` }} /> : null}
            <div ref={frame} className={`${styles.frame} ${target === 'instagram' ? styles.portrait : styles.landscape}`} aria-hidden="true"><span>写真をドラッグして位置を調整</span></div>
          </div>
        </div>
        <div className={styles.settings}>
          <div><span>選択した画像</span><strong>{source.name}</strong></div>
          <div><span>切り取り比率</span><strong>{target === 'google' ? '4:3（横長）' : '4:5（縦長）'}</strong></div>
          <div><label htmlFor="post-image-zoom">拡大・縮小</label><input id="post-image-zoom" type="range" min="1" max="2" step="0.01" value={zoom} onChange={(event) => { setZoom(Number(event.target.value)); setOffset({ x: 0, y: 0 }) }} /><div className={styles.zoomEnds}><span>1.0×</span><span>2.0×</span></div></div>
          <div><span>暗い部分は投稿されません</span><b>白い余白は追加しません</b></div>
        </div>
      </div>
      <div className={styles.footer}><span>元画像は保持され、投稿用の表示範囲だけが保存されます。</span><div><Button onClick={onClose} disabled={busy}>キャンセル</Button><Button variant="primary" onClick={() => void applyCrop()} disabled={!dimensions.width || busy} busy={busy}>この位置で確定</Button></div></div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  </div>
}
