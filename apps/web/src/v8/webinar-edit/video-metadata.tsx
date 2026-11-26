'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import type { MediaItem } from '@line-crm/shared'
import { api, ApiError, type Webinar } from '@/lib/api'
import { fmtJaDuration, fmtSec } from './helpers'
import styles from './video.module.css'

const KIND_LABEL = { image: '画像', video: '動画', audio: '音声', file: 'ファイル' }

/** 識別子からファイル名を作らず、登録したメディアの実名を使う。 */
export default function VideoMetadata({ webinar, children }: { webinar: Webinar; children?: (metadata: ReactNode) => ReactNode }) {
  const mediaId = webinar.videoMediaId ?? null
  const accountId = webinar.accountId ?? null
  const [loaded, setLoaded] = useState<{ mediaId: string; accountId: string; item: MediaItem } | null>(null)
  const [failed, setFailed] = useState<{ mediaId: string; accountId: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const media = loaded?.mediaId === mediaId && loaded.accountId === accountId ? loaded.item : null
  useEffect(() => {
    setLoaded(null)
    setFailed(null)
    if (!mediaId || !accountId) return
    let cancelled = false
    void api.media.detail(mediaId, accountId).then(response => {
      if (cancelled) return
      if (response.success) setLoaded({ mediaId, accountId, item: response.data.item })
      else setFailed({ mediaId, accountId })
    }).catch(error => { if (!cancelled && !(error instanceof ApiError && error.status === 403)) setFailed({ mediaId, accountId }) })
    return () => { cancelled = true }
  }, [mediaId, accountId, retry])
  const hasVideo = Boolean(webinar.videoPrefix || mediaId)
  const name = media?.filename ?? (hasVideo ? '設定済みの動画' : '—（未設定）')
  const description = media ? [media.filename, KIND_LABEL[media.kind], media.durationMs && media.durationMs > 0 ? fmtSec(Math.round(media.durationMs / 1000)) : null].filter(Boolean).join('・') : name
  const metadata = <>
    <span className={styles.videoName} title={description}>{name}</span>
    <span className={styles.videoMeta}>{hasVideo ? `${fmtJaDuration(webinar.durationSeconds)}・16:9・自動再生なし` : '差し替えるから登録メディアの動画を選びます'}</span>
  </>
  return <>
    {children ? children(metadata) : metadata}
    {failed?.mediaId === mediaId && failed?.accountId === accountId ? <Notice tone="danger" action={<Button onClick={() => setRetry(n => n + 1)}>動画情報を読み直す</Button>}>動画の情報を読み込めませんでした。</Notice> : null}
  </>
}
