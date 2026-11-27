'use client'

/*
 * 「プレビューを開く →」：お客さまの申込ページの見本を窓で見せる（右の列）。
 * 口は既存の applicationPreview。APIが見本として返した情報を表示する。
 * 見本を作るだけで、申し込みや公開はしない。
 */
import { useRef, useState } from 'react'
import type { EventApplicationPreview } from '@line-crm/shared'
import { eventsApi, type EventDetail } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { TextField } from '@/components/shared/text-field'
import TextLink from '@/components/shared/text-link'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import { jstToUtcIso } from './shared'
import styles from './create.module.css'
import { Field } from '@/components/shared/form-controls'

export default function ApplicationPreview({ accountId, draft, date, startTime, endTime, capacity }: {
  accountId: string
  draft: EventDetail
  date: string
  startTime: string
  endTime: string
  capacity: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<EventApplicationPreview | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)

  async function load() {
    const seq = ++generation.current
    setOpen(true)
    setBusy(true)
    setError('')
    setData(null)
    try {
      const result = await eventsApi.applicationPreview(accountId, {
        ...draft,
        slot: { starts_at: jstToUtcIso(date, startTime), ends_at: jstToUtcIso(date, endTime), capacity: Number(capacity) || 1 },
      })
      if (!result || typeof result.name !== 'string' || typeof result.startsAt !== 'string' || typeof result.endsAt !== 'string'
        || typeof result.capacity !== 'number' || !Number.isFinite(result.capacity) || typeof result.requiresApproval !== 'boolean'
        || !Array.isArray(result.questions) || result.questions.some((q) => !q || typeof q.id !== 'string' || typeof q.label !== 'string' || typeof q.required !== 'boolean')
        || [result.venueName, result.venueUrl, result.venueAddress, result.description].some((value) => value != null && typeof value !== 'string')) {
        if (seq === generation.current) setError('見本の内容を確認できませんでした。もう一度お試しください。')
        return
      }
      if (seq === generation.current) setData(result)
    } catch {
      if (seq === generation.current) setError('見本を開けませんでした。入力を確かめて、もう一度お試しください。')
    } finally {
      if (seq === generation.current) setBusy(false)
    }
  }
  const close = () => {
    ++generation.current
    setOpen(false)
  }

  return (
    <div className={styles.linkRow}>
      <Button variant="text" onClick={() => void load()}>プレビューを開く →</Button>
      <Dialog open={open} title="お客さまの申込ページの見本" onCancel={close} >
        {busy ? <ListState kind="loading" /> : error ? (
          <ListState kind="error" description={error} onRetry={() => void load()} />
        ) : data ? (
          <div className={styles.previewBody}>
            <p className={styles.phoneName}>{data.name}</p>
            <p>{formatDateTime(data.startsAt)}〜{formatDateTime(data.endsAt)}</p>
            {data.venueName || data.venueUrl ? <p>{data.venueUrl
              ? <TextLink href={data.venueUrl} external>{data.venueName || '会場の案内'}</TextLink>
              : data.venueName}</p> : null}
            {data.venueAddress ? <p>{data.venueAddress}</p> : null}
            {data.description ? <p className={styles.previewText}>{data.description}</p> : null}
            <p>残り {data.capacity} 席</p>
            {data.questions.map((question) => (
              <Field key={question.id} label={question.label} required={question.required}><TextField disabled aria-label={question.label} /></Field>
            ))}
            <Button disabled>{data.requiresApproval ? '申し込む（承認後に確定）' : '申し込む'}</Button>
            <Notice tone="info">見本です。申し込みや公開は行いません。</Notice>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
