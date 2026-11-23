'use client'

import { useState } from 'react'
import Dialog from '@/components/shared/dialog'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Checkbox from '@/components/shared/checkbox'
import HelpTip from '@/components/shared/help-tip'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { DAYS, type BusinessHoursDay } from './shared'

export default function HoursCopyDialog({ source, days, onCancel, onCopy }: {
  source: BusinessHoursDay
  days: BusinessHoursDay[]
  onCancel: () => void
  onCopy: (targets: number[]) => void
}) {
  const [targets, setTargets] = useState<number[]>([])
  const [confirming, setConfirming] = useState(false)
  const eligible = DAYS.filter((day) => day.weekday !== source.weekday && days.some((entry) => entry.weekday === day.weekday && entry.intervals.length > 0))
  const selected = eligible.filter((day) => targets.includes(day.weekday))
  const sourceLabel = DAYS.find((day) => day.weekday === source.weekday)?.label ?? ''
  if (confirming) return <ConfirmDialog open title="選んだ曜日の受付時間を上書きしますか？"
    description={`${sourceLabel}の時間帯と同時受付数を、${selected.map((day) => day.label).join('・')}に写します。まだ保存はしません。`}
    confirmLabel="選んだ曜日に写す" onCancel={() => setConfirming(false)} onConfirm={() => onCopy(selected.map((day) => day.weekday))} />
  return <Dialog open title="ほかの曜日に写す" titleHelp={<HelpTip label="曜日に写す操作の説明">休みの曜日は変えません。写したあとは、下の保存ボタンで保存してください。</HelpTip>} onCancel={onCancel}
    confirmLabel="上書きする曜日を確認する" confirmDisabled={selected.length === 0}
    confirmDisabledReason={eligible.length === 0 ? '写せる受付中の曜日がありません。' : '写す先の曜日を選んでください'} onConfirm={() => setConfirming(true)}>
    <div className="grid gap-3">
      <p className="text-body">{sourceLabel}：{source.intervals.map((interval) => `${interval.start}〜${interval.end}（同時${interval.capacity ?? 1}件）`).join('・')}</p>
      {eligible.length > 0 ? <DataTable>
        <thead><TableHeadRow><Th>写す先の曜日</Th></TableHeadRow></thead>
        <tbody>{eligible.map((day) => <Tr key={day.weekday}><Td><Checkbox
          checked={targets.includes(day.weekday)} onCheckedChange={(checked) => setTargets((current) => checked ? [...current, day.weekday] : current.filter((value) => value !== day.weekday))}>{day.label}</Checkbox></Td></Tr>)}</tbody>
      </DataTable> : <p className="text-body">ほかの曜日の受付を開けると、ここで写す先を選べます。</p>}
    </div>
  </Dialog>
}
