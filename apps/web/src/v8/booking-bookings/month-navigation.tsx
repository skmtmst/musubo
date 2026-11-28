'use client'

import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { jstDate as japanDate } from '@/lib/jst-datetime'

import { ChevronLeft, ChevronRight, Link as LinkIcon } from 'lucide-react'
import Button from '@/components/shared/button'
import CopyTextButton from '@/components/shared/copy-text-button'
import IconButton from '@/components/shared/icon-button'
import { ListToolbarEnd, ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

function isValidIsoDate(value: string | undefined): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() + 1 === month && check.getUTCDate() === day
}

export function monthKey(offset: number, anchor?: string): string {
  const parsed = isValidIsoDate(anchor) ? new Date(`${anchor}T00:00:00+09:00`) : new Date(Date.now())
  const now = Number.isNaN(parsed.getTime()) ? new Date(Date.now()) : parsed
  const safeOffset = Number.isInteger(offset) ? offset : 0
  const jst = japanCalendar(now)
  const target = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + safeOffset, 1))
  if (!Number.isFinite(target.getTime())) {
    return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1)).toISOString().slice(0, 7)
  }
  return target.toISOString().slice(0, 7)
}

export function monthLabel(key: string): string {
  if (typeof key !== 'string') return '—'
  const match = YEAR_MONTH.exec(key)
  if (!match) return '—'
  return `${Number(match[1])}年${Number(match[2])}月`
}

export default function LedgerMonthNavigation({ anchor, onChange, shareUrl, historyUrl }: {
  anchor: string
  onChange: (date: string) => void
  shareUrl: string
  historyUrl: string
}) {
  return <ListToolbarFrame>
    <ListToolbarRow>
      <IconButton size="small" aria-label="前の月" onClick={() => onChange(`${monthKey(-1, anchor)}-01`)}><ChevronLeft aria-hidden="true" /></IconButton>
      <IconButton size="small" aria-label="次の月" onClick={() => onChange(`${monthKey(1, anchor)}-01`)}><ChevronRight aria-hidden="true" /></IconButton>
      <strong aria-live="polite">{monthLabel(monthKey(0, anchor))}</strong>
      <Button onClick={() => onChange(japanDate())}>今日</Button>
      <ListToolbarEnd>
        {shareUrl ? <CopyTextButton variant="secondary" value={shareUrl} icon={<LinkIcon size={16} aria-hidden="true" />} label="友だち予約URL　コピーする" aria-label="友だち予約URLをコピーする" /> : null}
        {historyUrl ? <CopyTextButton variant="secondary" value={historyUrl} icon={<LinkIcon size={16} aria-hidden="true" />} label="予約履歴URL　コピーする" aria-label="予約履歴URLをコピーする" /> : null}
      </ListToolbarEnd>
    </ListToolbarRow>
  </ListToolbarFrame>
}

/** 月送り・URL・タブ内保存で、同じ対象日を使うための月差。 */
export function monthDifference(anchor: string): number {
  const current = monthKey(0).split('-').map(Number)
  const target = monthKey(0, anchor).split('-').map(Number)
  return (target[0] - current[0]) * 12 + target[1] - current[1]
}
