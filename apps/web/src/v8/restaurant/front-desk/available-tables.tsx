'use client'

import type { RestaurantFloor } from '@line-crm/shared'
import { Armchair } from 'lucide-react'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { Tabs } from '@/components/shared/tabs'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { tableNote } from './slots'
import styles from './front-desk.module.css'

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })

export function tableGroups(tables: RestaurantTable[], floors: RestaurantFloor[]) {
  const compare = (a: RestaurantTable, b: RestaurantTable) => {
    const ac = a.code?.trim() ?? ''
    const bc = b.code?.trim() ?? ''
    return Number(!ac) - Number(!bc) || collator.compare(ac, bc) || collator.compare(a.label ?? '', b.label ?? '') || collator.compare(a.id, b.id)
  }
  if (!floors.length) return [{ id: '', name: '', tables: [...tables].sort(compare) }]
  const groups = floors.map(floor => ({ id: floor.id, name: floor.name, tables: tables.filter(table => table.floor_id === floor.id).sort(compare) }))
  const unknown = tables.filter(table => !floors.some(floor => floor.id === table.floor_id)).sort(compare)
  if (unknown.length) groups.push({ id: '', name: '階・エリア未設定', tables: unknown })
  return groups
}

export default function AvailableTables({ tables, floors, floorId, onFloorChange, selected, onSelect, guests, disabled, radioName = 'walk-in-table', heading, errorNames = ['walk-in-table', 'id', 'table.id', 'tableId'] }: {
  tables: RestaurantTable[]; floors: RestaurantFloor[]; floorId: string; onFloorChange: (id: string) => void
  selected: string; onSelect: (id: string) => void; guests: number; disabled: boolean
  radioName?: string; heading?: string; errorNames?: string[]
}) {
  const groups = tableGroups(tables, floors)
  const visible = floorId === 'all' ? groups : groups.filter(group => group.id === floorId)
  return <>
    {floors.length > 1 && <Tabs label="階・エリア" size="compact" items={[
      { label: 'すべて', count: tables.length, current: floorId === 'all', onClick: () => onFloorChange('all') },
      ...floors.map(floor => ({ label: floor.name, count: groups.find(group => group.id === floor.id)?.tables.length ?? 0, current: floorId === floor.id, onClick: () => onFloorChange(floor.id) })),
    ]} />}
    <p className={styles.label}>{heading ?? `今すぐ座れる卓（${guests}名が座れる卓だけ）`}</p>
    <SaveErrorField names={errorNames}><div className={styles.floorGroups} role="group" aria-label="卓の選択" tabIndex={-1}>
    {visible.filter(group => group.tables.length).map(group => <RadioCardGroup key={group.id || 'unassigned'} legend={group.name || heading || `今すぐ座れる卓（${guests}名）`} legendVisible={Boolean(group.name)} columns={3}>
      {group.tables.map(table => <RadioCard key={table.id} name={radioName} value={table.id} checked={selected === table.id} onChange={onSelect} title={table.code} note={tableNote(table)} icon={<Armchair size={16} aria-hidden="true" />} height="short" disabled={disabled} />)}
    </RadioCardGroup>)}
    </div></SaveErrorField>
    {floorId !== 'all' && !visible.some(group => group.tables.length) && <p role="status">この階・エリアに座れる卓はありません。</p>}
  </>
}
