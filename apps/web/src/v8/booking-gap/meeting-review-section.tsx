'use client'

import { useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { notifySaved } from '@/components/shared/toast'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import { ApiError } from '@/lib/api'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'
import styles from './meeting-review-section.module.css'

type Review = { id: string; provider: string; staff_name: string | null; starts_at: string | null; ends_at: string | null }
type MeetingStatus = {state:'none'|'active'|'failed'|'unknown';provider:'google_meet'|'zoom'|'teams'|null;version:number}
const names: Record<string, string> = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' }

export function MeetingReviewSection({ accountId, bookingId, canOperate }: { accountId: string; bookingId: string; canOperate: boolean }) {
  const role = useStaffRole()
  const [items, setItems] = useState<Review[]>([])
  const [target, setTarget] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [meeting, setMeeting] = useState<MeetingStatus | null>(null)
  const [manualUrl, setManualUrl] = useState('')
  const retryKey = useRef<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    let alive = true
    generation.current++
    setItems([]); setTarget(null); setError(''); setBusy(false); setMeeting(null); setManualUrl(''); retryKey.current = null
    void Promise.resolve().then(() => bookingCalendarApi.meetingReviews(accountId, bookingId)).then(result => { if (alive) setItems(result.data.items) }).catch(() => { if (alive) setError('会議の確認状況を読み込めませんでした。') })
    void Promise.resolve().then(() => bookingCalendarApi.meetingStatus(accountId, bookingId)).then(result => { if (alive) setMeeting(result.data) }).catch(() => { if (alive) setError('会議の発行状況を読み込めませんでした。') })
    return () => { alive = false; generation.current++ }
  }, [accountId, bookingId])
  async function resolve() {
    if (!target || !canOperate || !canAdministerRole(role) || busy) return
    const id = target.id
    const started = generation.current
    setBusy(true); setError('')
    try { await bookingCalendarApi.resolveMeetingReview(accountId, bookingId, id); if (started === generation.current) { setItems(previous => previous.filter(item => item.id !== id)); setTarget(null) } }
    catch (cause) {
      if (started !== generation.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        try {
          const refreshed = await bookingCalendarApi.meetingReviews(accountId, bookingId)
          if (started === generation.current) { setItems(refreshed.data.items); setTarget(null); setError('会議の状態が変わったため、一覧を更新しました。') }
        } catch { if (started === generation.current) setError('会議の状態を読み直せませんでした。') }
      } else setError('記録できませんでした。もう一度確認してください。')
    }
    finally { if (started === generation.current) setBusy(false) }
  }
  async function retry() {
    if (!canOperate || !canAdministerRole(role) || busy || meeting?.state !== 'failed' || meeting.provider === 'teams') return
    const started = generation.current
    const key = retryKey.current ?? crypto.randomUUID(); retryKey.current = key
    setBusy(true); setError('')
    try {
      const result = await bookingCalendarApi.retryMeeting(accountId, bookingId, key)
      if (started !== generation.current) return
      if (result.data.outcome === 'created') { setMeeting({ ...meeting, state: 'active' }); notifySaved('会議の URL を発行しました。') }
      else if (result.data.outcome === 'unknown' || result.data.outcome === 'in_progress') setMeeting({ ...meeting, state: 'unknown' })
      else { retryKey.current = null; setError('会議を発行できませんでした。接続を確認してください。') }
    } catch { if (started === generation.current) setMeeting({ ...meeting, state:'unknown' }) }
    finally { if (started === generation.current) setBusy(false) }
  }
  async function saveManualUrl() {
    if (!canOperate || !meeting || busy || !/^https:\/\/\S+$/.test(manualUrl.trim())) return
    const started = generation.current
    setBusy(true); setError('')
    try {
      await bookingCalendarApi.setBookingUrl(accountId, bookingId, {action:'set_manual',url:manualUrl.trim(),expectedVersion:meeting.version})
      if (started === generation.current) { setMeeting({ ...meeting, state:'none' }); setManualUrl(''); notifySaved('会議の URL を保存しました。') }
    } catch { if (started === generation.current) setError('URL を保存できませんでした。予約を読み直してからお試しください。') }
    finally { if (started === generation.current) setBusy(false) }
  }
  if (!items.length && !error && meeting?.state !== 'failed' && meeting?.state !== 'unknown') return null
  return <Card variant="form" gap="normal">
    <CardHeader size="stacked" title="会議の確認" />
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {meeting?.state === 'unknown' ? <p>相手のサービスで確かめてください。</p> : null}
    {meeting?.state === 'failed' ? <>
      <p className={styles.failure}>会議の URL を作れませんでした</p>
      <p>予約は確定しています。URL を手で入れるか、もう一度発行してください。</p>
      {canOperate ? <Field label="会議の URL（https://）" note={!manualUrl.trim() ? 'URL を入力してください。' : !/^https:\/\/\S+$/.test(manualUrl.trim()) ? 'https:// で始まる URL を入力してください。' : undefined}>
        <div className={styles.urlLine}>
          <TextField aria-label="会議の URL（https://）" value={manualUrl} placeholder="https://" onChange={event => setManualUrl(event.target.value)} />
          <Button variant="secondary" size="field" disabled={busy || !/^https:\/\/\S+$/.test(manualUrl.trim())} onClick={() => void saveManualUrl()}>URL を保存</Button>
        </div>
      </Field> : null}
      {meeting.provider === 'teams' ? <p>Teams の会議は相手のサービスで確認してください。</p> : canOperate && canAdministerRole(role) ? <div className={styles.retry}><Button variant="secondary" size="compact" disabled={busy} onClick={() => void retry()}>もう一度発行する</Button></div> : null}
      <p>お客さまには「会議の URL は前日までにお送りします」と案内します。</p>
    </> : null}
    {items.map(item => <div key={item.id}>
      <p>{names[item.provider] ?? '会議'}・{item.staff_name ?? '担当者不明'}</p>
      <p>{item.starts_at ? new Date(item.starts_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '日時不明'}</p>
      <p>元の担当者が接続し直すか、相手先で会議を削除してください。</p>
      {canOperate && canAdministerRole(role) ? <Button size="compact" onClick={() => { setError(''); setTarget(item) }}>相手先で削除した</Button> : null}
    </div>)}
    <Dialog open={target !== null} title="相手先で会議を削除しましたか？" titleNote={target ? `${names[target.provider] ?? '会議'}・${target.staff_name ?? '担当者不明'}・${target.starts_at ? new Date(target.starts_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '日時不明'}` : undefined} error={error || undefined} size="medium" busy={busy} cancelLabel="やめる" onCancel={() => setTarget(null)} confirmLabel="削除したことを記録" onConfirm={() => void resolve()}>
      <p>相手先で削除したことを確認してから記録してください。</p>
    </Dialog>
  </Card>
}
