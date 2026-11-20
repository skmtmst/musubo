'use client'

import { useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { bookingCalendarApi } from '@/lib/api/helpers/gap1'
import { ApiError } from '@/lib/api'
import { canAdministerRole, useStaffRole } from '@/lib/staff-role'

type Review = { id: string; provider: string; staff_name: string | null; starts_at: string | null; ends_at: string | null }
const names: Record<string, string> = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' }

export function MeetingReviewSection({ accountId, bookingId, canOperate }: { accountId: string; bookingId: string; canOperate: boolean }) {
  const role = useStaffRole()
  const [items, setItems] = useState<Review[]>([])
  const [target, setTarget] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    let alive = true
    generation.current++
    setItems([]); setTarget(null); setError(''); setBusy(false)
    void Promise.resolve().then(() => bookingCalendarApi.meetingReviews(accountId, bookingId)).then(result => { if (alive) setItems(result.data.items) }).catch(() => { if (alive) setError('会議の確認状況を読み込めませんでした。') })
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
  if (!items.length && !error) return null
  return <Card variant="form" gap="normal">
    <CardHeader size="stacked" title="確認が必要な会議" />
    {error ? <Notice tone="danger">{error}</Notice> : null}
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
