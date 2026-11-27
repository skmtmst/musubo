'use client'

import { jstDate as japanDate } from '@/lib/jst-datetime'

import Card from '@/components/shared/card'

import { useState } from 'react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import Select from '@/components/shared/select'
import type { Gap2Booking, Gap2Series } from '@line-crm/shared'
import SeriesScopeDialog from './series-scope-dialog'
import { dayWithWeekday, hm, ruleLabel } from './series-model'
import styles from './series-panel-section.module.css'
import { formatNumber } from '@/lib/format'

const TIMES = Array.from({ length: 19 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`)

/*
 * 予約の詳細パネルの段「繰り返し（毎週金曜 14:00・全 8 回）」と回の一覧（B4）。
 * 変える・取り消すは確かめの窓（この回だけ／この回から後ぜんぶ）を通す。閲覧のみの人には操作を出さない。
 */
export default function SeriesPanelSection({ series, bookings, accountId, customerName, menuName, bookingId, startsAt, canOperate, onChanged }: {
  series: Gap2Series
  bookings: Gap2Booking[]
  accountId: string
  customerName: string
  menuName: string
  bookingId: string
  startsAt: string
  canOperate: boolean
  onChanged: () => void
}) {
  const [picking, setPicking] = useState(false)
  const [time, setTime] = useState(hm(startsAt))
  const [mode, setMode] = useState<'change' | 'cancel' | null>(null)
  const sorted = [...bookings].sort((a, b) => (a.series_index ?? 0) - (b.series_index ?? 0))
  const rule = (() => { try { return JSON.parse(series.rule_json) as { freq: 'weekly' | 'biweekly' | 'monthly_nth' } } catch { return { freq: 'weekly' as const } } })()
  const here = sorted.find((b) => b.id === bookingId)
  const target = { seriesId: series.id, customerName, ruleText: ruleLabel(rule.freq, startsAt), menuName, index: (here?.series_index ?? 0) + 1, bookingId, startsAt }
  const jstDay = japanDate(new Date(startsAt))
  const newStartsAt = `${jstDay}T${time}:00+09:00`

  return (
    <Card padding="compact" layout="vertical" gap="var(--polish-space-field)" aria-label="繰り返し">
      <h3 className={styles.title}>繰り返し（{target.ruleText}・全 {formatNumber(sorted.length)} 回）</h3>
      <ol className={styles.list}>
        {sorted.map((o, i) => (
          <li className={styles.occurrence} key={o.id} data-current={o.id === bookingId || undefined}>
            <span>{(o.series_index ?? i) + 1} 回目</span><span>{dayWithWeekday(o.starts_at)} {hm(o.starts_at)}</span>
            {o.id === bookingId ? <span className={styles.here}>この予約</span> : null}
          </li>
        ))}
      </ol>
      {canOperate ? <div className={styles.actions}>
        <Button variant="secondary" onClick={() => setPicking(true)}>この予約の時間を変更する</Button>
        <Button variant="danger-outline" onClick={() => setMode('cancel')}>繰り返しを取り消す</Button>
      </div> : null}
      <Dialog open={picking} size="small" title="新しい時間を選ぶ" description={`${dayWithWeekday(startsAt)} の開始時刻を変えます。次の確かめで、この回だけか後ぜんぶかを選びます。`} confirmLabel="次へ" onConfirm={() => { setPicking(false); setMode('change') }} onCancel={() => setPicking(false)}>
        <Select aria-label="新しい開始時刻" value={time} options={TIMES.map((t) => ({ value: t, label: t }))} onChange={setTime} />
      </Dialog>
      {mode ? <SeriesScopeDialog open mode={mode} accountId={accountId} target={target} newStartsAt={mode === 'change' ? newStartsAt : undefined}
        onClose={() => setMode(null)} onDone={() => { setMode(null); onChanged() }} /> : null}
    </Card>
  )
}
