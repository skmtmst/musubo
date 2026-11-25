'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import Button from '@/components/shared/button'
import styles from './style-choice-video.module.css'
import { STYLE_EXPERIENCE_SCRIPT } from './style-experience-player/script'

const files: Record<AccountStyle, string> = {
  restaurant: 'restaurant', salon: 'salon', consult: 'consultation', lesson: 'lesson', standard: 'standard', ec: 'ec',
}

export default function StyleChoiceVideo({ style, fallback, accountName }: { style: AccountStyle; fallback: ReactNode; accountName?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [reduced, setReduced] = useState(true)
  const [started, setStarted] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) { setReduced(false); return }
    const update = () => setReduced(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const current = video.current
    if (!current) return
    if (reduced && !started) current.pause()
    else void current.play().catch(error => { if (error.name !== 'AbortError' && video.current === current) setBlocked(true) })
  }, [reduced, started, style])
  const base = `/onboarding/style-demos/${files[style]}`
  if (failed) return fallback
  return <div className={styles.preview}>
    <p className={styles.account}>登録するアカウント：{accountName?.trim() || '店名未取得'}</p>
    <video ref={video} key={style} className={styles.video} src={`${base}.mp4`} poster={`${base}.jpg`} muted playsInline loop autoPlay={!reduced || started} controls preload="metadata" onError={() => setFailed(true)} onPlay={() => { setStarted(true); setBlocked(false) }} aria-label={`${STYLE_EXPERIENCE_SCRIPT.styles[style].label}のデモ動画`} />
    {(reduced && !started || blocked) ? <Button onClick={() => { setStarted(true); setBlocked(false); void video.current?.play().catch(error => { if (error.name !== 'AbortError') setBlocked(true) }) }}>動画を再生</Button> : null}
  </div>
}
