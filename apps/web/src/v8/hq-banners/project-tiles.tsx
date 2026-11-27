'use client'
import {
type BannerImage
} from '@/lib/hq-banners'
import { Hourglass } from 'lucide-react'
import MediaThumbnail from '@/components/shared/media-thumbnail'
import { useState } from 'react'
import styles from './project.module.css'



/** 作っている途中の1枚（「作っています…」「待っています」）。 */
export function PendingTile({ running, label }: { running: boolean; label: string }) {
  return (
    <article className={styles.tile} role="status" aria-live="polite">
      <div className={`${styles.tileImage} ${styles.pending}`}>
        <Hourglass aria-hidden="true" className={styles.pendingIcon} />
        <span className={styles.pendingText}>{running ? '作っています…' : '待っています'}</span>
      </div>
      <div className={styles.tileMeta}><span className={styles.metaText}>{label}</span></div>
    </article>
  )
}


/** 読み込み失敗は空白と区別し、画像が変われば新しく読み込む。 */
export function Thumb({ image }: { image: BannerImage }) {
  return <ThumbImage key={image.media.url} url={image.media.url} />
}

function ThumbImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  return <span className={`${styles.thumb} ${styles.metaText}`} title={failed ? '画像を表示できません' : undefined} onErrorCapture={() => setFailed(true)}>
    <MediaThumbnail kind="image" src={url} alt="" />
  </span>
}
