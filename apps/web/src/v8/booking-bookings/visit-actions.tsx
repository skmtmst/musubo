'use client'

import { useRef, useState } from 'react'
import ActionMenu from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import StatusBadge from '@/components/shared/status-badge'
import type { BookingVisitMark } from '@/lib/api'
import type { AccountStyle } from '@line-crm/shared'
import { bookingWords } from './words'

/** 採用（lS8qh）。人の予約の印。席予約の来店処理には使わない。 */
export default function PeopleVisitActions({ mark, ready, busy, canMark, onMark, onUnmark, usageStyle }: {
  usageStyle?: AccountStyle
  mark: BookingVisitMark | null
  ready: boolean
  busy: boolean
  canMark: boolean
  onMark: (kind: BookingVisitMark['kind'], lateMinutes?: number) => void
  onUnmark: () => void
}) {
  const lateAnchor = useRef<HTMLButtonElement>(null)
  const [lateOpen, setLateOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const words = bookingWords(usageStyle)
  /* 権限が無い人にも印（データ）は見せ、操作は隠さず灰色＋理由（2026-10-26 オーナー・全画面）。 */
  if (!canMark) return <span className="inline-flex items-center gap-2">
    {mark?.kind === 'visited' || mark?.kind === 'no_show'
      ? <><StatusBadge tone={mark.kind === 'visited' ? 'success' : 'neutral'}>{mark.kind === 'visited' ? words.completed : words.absent}</StatusBadge><PermissionGatedButton allowed={false} variant="text" size="inline">取り消す</PermissionGatedButton></>
      : <>{mark?.kind === 'late' ? <StatusBadge tone="warning">{mark.late_minutes}分遅れる</StatusBadge> : null}<PermissionGatedButton allowed={false} variant="primary" size="booking">{words.completeAction}</PermissionGatedButton></>}
  </span>
  if (mark?.kind === 'visited' || mark?.kind === 'no_show') return <span className="inline-flex items-center gap-2">
    <StatusBadge tone={mark.kind === 'visited' ? 'success' : 'neutral'}>{mark.kind === 'visited' ? words.completed : words.absent}</StatusBadge>
    <Button variant="text" size="inline" disabled={busy || !ready} onClick={onUnmark}>取り消す</Button>
  </span>
  return <span className="inline-flex items-center gap-2">
    {mark?.kind === 'late' ? <StatusBadge tone="warning">{mark.late_minutes}分遅れる</StatusBadge> : null}
    <Button variant="primary" size="booking" disabled={busy || !ready} onClick={() => onMark('visited')}>{words.completeAction}</Button>
    <Button ref={lateAnchor} size="booking" disabled={busy || !ready} aria-expanded={lateOpen} onClick={() => { setMoreOpen(false); setLateOpen(!lateOpen) }}>遅れる</Button>
    <ActionMenu open={lateOpen} anchorRef={lateAnchor} onClose={() => setLateOpen(false)} ariaLabel="遅れる分数" items={[5, 10, 15, 30].map(minutes => ({ id: `late-${minutes}`, label: `${minutes}分`, onSelect: () => { setLateOpen(false); onMark('late', minutes) } }))} />
    <RowMenu open={moreOpen} onOpenChange={(open) => { if (open) setLateOpen(false); setMoreOpen(open) }} label="その他の操作" size="small" triggerProps={{ disabled: busy || !ready }} items={[
      { id: 'no-show', label: words.absent, onSelect: () => { setMoreOpen(false); onMark('no_show') } },
      ...(mark ? [{ id: 'unmark', label: '印を取り消す', onSelect: () => { setMoreOpen(false); onUnmark() } }] : []),
    ]} />
  </span>
}
