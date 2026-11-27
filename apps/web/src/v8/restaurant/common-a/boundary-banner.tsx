'use client'

import { useEffect, useState } from 'react'
import Notice from '@/components/shared/notice'
import { loadAdminVersionDetail } from '@/lib/admin-version-cache'

/** 本番や環境が確認できない場合は、検証環境と断定しない。 */
export function BoundaryBanner({ note, noteAlways = false }: { note?: string; noteAlways?: boolean } = {}) {
  const [staging, setStaging] = useState(false)
  useEffect(() => {
    let active = true
    void loadAdminVersionDetail().then(detail => {
      if (active) setStaging(detail.deploy_env === 'staging')
    }).catch(() => { if (active) setStaging(false) })
    return () => { active = false }
  }, [])
  const trimmedNote = typeof note === 'string' ? note.trim() : ''
  if (!staging && !(noteAlways && trimmedNote)) return null
  return <Notice tone="info">{staging ? <span>検証環境です。予約サイトへは送りません{trimmedNote ? '。' : null}</span> : null}{trimmedNote && (staging || noteAlways) ? <span>{staging ? ' ' : null}{trimmedNote}</span> : null}</Notice>
}
