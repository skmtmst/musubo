'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import MediaSlot from '@/components/shared/media-slot'
import { validateCarouselImage } from './carousel-image-upload'
import styles from './carousel-image.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import ImageFrame from '@/components/shared/image-frame'

/** 受け取りの失敗理由。日本語の理由だけを出し、「API error: 500」などの英語は案内文に置き換える。 */
function uploadReasonOf(caught: unknown): string {
  return describeApiFailure(caught, '画像の登録')
}

/** カードの画像。共通の画像を入れる所（MediaSlot・Z7vd2）の小さい形。店と統括で送る口だけ替える。失敗しても元の画像・選んだファイルを残す。 */
export default function CarouselImage({ url, disabled, maxMB = 10, upload, onUploaded, onBusyChange, onMediaPick, onUrl, scope }: {
  url: string; disabled: boolean; maxMB?: number; scope: string
  upload: (file: File) => Promise<string>
  onUploaded: (url: string) => void
  onBusyChange: (busy: boolean) => void
  onMediaPick?: () => void
  onUrl: () => void
}) {
  const alive = useRef(true)
  const locked = useRef(false)
  const latestScope = useRef(scope)
  latestScope.current = scope
  const busyChange = useRef(onBusyChange)
  busyChange.current = onBusyChange
  const [busy, setBusy] = useState(false)
  const [scopedState, setScopedState] = useState<{ scope: string; error: string; file: File | null }>({
    scope,
    error: '',
    file: null,
  })
  const error = scopedState.scope === scope ? scopedState.error : ''
  const file = scopedState.scope === scope ? scopedState.file : null
  useEffect(() => { alive.current = true; return () => { alive.current = false; busyChange.current(false) } }, [])
  const send = async (selected: File) => {
    if (disabled || locked.current) return
    const requestedScope = scope
    setScopedState({ scope: requestedScope, file: selected, error: '' })
    const invalid = validateCarouselImage(selected, maxMB)
    if (invalid) { setScopedState({ scope: requestedScope, file: selected, error: invalid }); return }
    locked.current = true; setBusy(true); busyChange.current(true)
    try {
      const nextUrl = await upload(selected)
      if (!alive.current) return
      if (latestScope.current !== requestedScope) {
        setScopedState({
          scope: latestScope.current,
          file: null,
          error: '編集中のカードかアカウントが変わったため、画像を反映しませんでした。選び直してください。',
        })
        return
      }
      onUploaded(nextUrl)
      setScopedState({ scope: requestedScope, file: null, error: '' })
    } catch (caught) {
      if (alive.current && latestScope.current === requestedScope) {
        setScopedState({
          scope: requestedScope,
          file: selected,
          error: uploadReasonOf(caught) || '画像を登録できませんでした。時間をおいて、もう一度お試しください。',
        })
      }
    } finally {
      locked.current = false
      if (alive.current) { setBusy(false); busyChange.current(false) }
    }
  }
  return (
    <div className={styles.column}>
      <SaveErrorField names={["url"]}><ImageFrame
        title="画像を追加"
        previewAlt="カードの画像"
        value={url || null}
        accept="image/jpeg,image/png"
        maxBytes={maxMB * 1024 * 1024}
        busy={busy}
        error={error}
        disabled={disabled}
        onFile={(chosen) => void send(chosen)}
        onRemove={() => {
          if (disabled || locked.current) return
          setScopedState({ scope, file: null, error: '' })
          onUploaded('')
        }}
        onMediaPick={onMediaPick}
        onUrl={onUrl}
      /></SaveErrorField>
      {file && <span className={styles.filename} ><TruncatedText value={String(file.name ?? '')} /></span>}
      {error && file && !validateCarouselImage(file, maxMB) && <Button disabled={disabled || busy} onClick={() => void send(file)} busy={Boolean(busy)} busyLabel="処理中…">もう一度受け取る</Button>}
    </div>
  )
}
