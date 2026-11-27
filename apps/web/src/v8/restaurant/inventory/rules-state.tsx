import type { RestaurantInventoryRuleState } from '@line-crm/shared'
import ListState, { ListEmptyMessage } from '@/components/shared/list-state'
import SectionHeader from '@/components/shared/section-header'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import StatusBadge from '@/components/shared/status-badge'
import { formatAt, slotTimeLabel } from './format'
import { formatNumber } from '@/lib/format'

const CAUSES: Record<string, string> = { reservation: '予約の変更', tables: '卓の変更', rules: 'ルールの保存', inventory: '在庫の再計算' }
export function RulesState({ state, error, onRetry, timezone }: {
  state: RestaurantInventoryRuleState | null; error: string; onRetry: () => void; timezone?: string
}) {
  if (error || !state) return <ListState kind={error ? 'error' : 'loading'} description={error || undefined} onRetry={error ? onRetry : undefined} />
  return <>
    <SectionHeader title="自動停止中" note={`${formatNumber(state.stoppedTotal)}件${state.stoppedTotal > state.stopped.length ? `（先頭${formatNumber(state.stopped.length)}件）` : ''}`} />
    {state.stopped.length === 0 ? <ListEmptyMessage>この日に自動停止している枠はありません</ListEmptyMessage> : <DataTable aria-label="自動停止中の枠">
      <thead><TableHeadRow><Th>時間</Th><Th>止めている受付</Th><Th>理由</Th><Th>元の配分</Th></TableHeadRow></thead>
      <tbody>{state.stopped.map((slot) => {
        const channels = [slot.lineOriginal !== null ? 'LINE' : '', slot.sameDayOriginal !== null ? '当日受付' : ''].filter(Boolean).join('・')
        const originals = [slot.lineOriginal !== null ? `LINE ${slot.lineOriginal}` : '', slot.sameDayOriginal !== null ? `当日受付 ${slot.sameDayOriginal}` : ''].filter(Boolean).join('・')
        return <Tr key={slot.slotId}>
          <Td>{slotTimeLabel(slot.startsAt, timezone)}</Td>
          <Td>{channels || '—'}</Td>
          <Td>{`残り${slot.remainingSeats}席・基準${slot.threshold}席以下`}</Td>
          <Td>{originals || '—'}</Td>
        </Tr>
      })}</tbody>
    </DataTable>}
    <SectionHeader title="停止・復元の記録" note={`${formatNumber(state.historyTotal)}件${state.historyTotal > state.history.length ? `（直近${formatNumber(state.history.length)}件）` : ''}`} />
    {state.history.length === 0 ? <ListEmptyMessage>この日の停止・復元の記録はありません</ListEmptyMessage> : <DataTable aria-label="停止・復元の記録">
      <thead><TableHeadRow><Th>記録日時</Th><Th>枠</Th><Th>変更</Th><Th>配分の変化</Th><Th>きっかけ</Th></TableHeadRow></thead>
      <tbody>{state.history.map((entry) => {
        const restoring = entry.afterLine > entry.beforeLine || entry.afterSameDay > entry.beforeSameDay
        const stopping = entry.afterLine < entry.beforeLine || entry.afterSameDay < entry.beforeSameDay
        const tone = restoring && !stopping ? 'success' : !restoring && !stopping ? 'neutral' : 'warning'
        const label = restoring && stopping ? '調整' : restoring ? '復元' : stopping ? '停止' : '変更なし'
        const diff = [entry.beforeLine !== entry.afterLine ? `LINE ${entry.beforeLine}→${entry.afterLine}` : '', entry.beforeSameDay !== entry.afterSameDay ? `当日受付 ${entry.beforeSameDay}→${entry.afterSameDay}` : ''].filter(Boolean).join('・')
        return <Tr key={entry.id}>
          <Td>{formatAt(entry.createdAt, timezone)}</Td><Td>{slotTimeLabel(entry.startsAt, timezone)}</Td>
          <Td><StatusBadge tone={tone}>{label}</StatusBadge></Td>
          <Td>{diff || '—'}</Td>
          <Td>{CAUSES[entry.cause] ?? '—'}</Td>
        </Tr>
      })}</tbody>
    </DataTable>}
  </>
}
