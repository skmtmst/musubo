'use client'

import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import { formatTime } from '@/lib/format'
import type { BookingRequest } from '@/lib/api'
import PeopleVisitActions from './visit-actions'
import type { usePeopleVisitMarks } from './use-visit-marks'
import type { AccountStyle } from '@line-crm/shared'
import { bookingWords } from './words'

/** 日の台帳の一覧行。採用済みのその場の来店印だけを移す。 */
export default function PeopleDayList({ rows, canMark, visits, onOpen, usageStyle }: {
  usageStyle?: AccountStyle
  rows: BookingRequest[]
  canMark: boolean
  visits: ReturnType<typeof usePeopleVisitMarks>
  onOpen: (id: string) => void
}) {
  const words = bookingWords(usageStyle)
  const safeRows = Array.isArray(rows) ? rows.filter((row): row is BookingRequest => Boolean(row && typeof row === 'object')) : []
  return <>
    {canMark && visits.status === 'error' ? <Notice tone="danger">{words.mark}を読み込めませんでした。<Button onClick={visits.reload}>読み直す</Button></Notice> : null}
    {safeRows.length === 0 ? <ListState kind="empty" title="この日の予約はありません" /> : <ol className="flex flex-col gap-2" aria-label="時刻順の予約">
      {/* --tpl-bkd-row-pad（12 16）を変数1語で渡すと、Card が左右別々の余白だと見抜けず
          共通の下限 16 と突き合わされて `max(16px, 12px 16px)` になり、余白が 0 に落ちる。
          値を空白で分けて渡す（card.tsx の hasSides）。 */}
      {safeRows.map(row => {
        const friendName = typeof row.friend_name === 'string' && row.friend_name.trim() ? row.friend_name : '名前の登録なし'
        const menuName = typeof row.menu_name === 'string' && row.menu_name.trim() ? row.menu_name : '—'
        const staffName = typeof row.staff_name === 'string' && row.staff_name.trim() ? row.staff_name : '—'
        const summary = `${menuName}・${words.staff} ${staffName}`
        return <li key={row.id}><Card frame="inset" layout="horizontal" gap="normal" contentPadding="var(--space-12) var(--space-16)">
          <span className="font-semibold tabular-nums">{formatTime(row.starts_at)}</span>
          <span className="min-w-0 flex-1">
            <Button variant="text" textTone="ink" size="inline" onClick={() => onOpen(row.id)}>{friendName}</Button>
            <span className="block truncate text-xs text-ink-secondary" title={summary}>{summary}</span>
          </span>
          <PeopleVisitActions usageStyle={usageStyle} mark={visits.mark(row.id)} ready={visits.status === 'ready'} busy={visits.busy(row.id)}
            canMark={canMark && (row.status === 'confirmed' || visits.mark(row.id) !== null)}
            onMark={(kind, minutes) => void visits.markVisit(row.id, kind, minutes)} onUnmark={() => void visits.markVisit(row.id, null)} />
        </Card></li>
      })}
    </ol>}
  </>
}
