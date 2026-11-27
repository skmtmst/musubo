// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import TablePenEditor, { type Draft } from './restaurant-table-pen-editor'

afterEach(cleanup)
it('丸を選ぶと全周・片側・向かい合わせと方向を切り替えられる', () => {
  const initial: Draft = { code: '1', label: '1', seatType: 'table', seatDetailType: 'table', minCapacity: '1', maxCapacity: '4', floorX: '', floorY: '', joinGroup: '', floorId: 'f', shape: 'rectangle', orientation: 'horizontal', smokingPolicy: 'non_smoking', partition: 'open', shoesAllowed: true, isActive: true, visibleOnMap: true, chairArrangement: 'both', chairSide: 'left' }
  function Example() { const [draft, setDraft] = useState(initial); return <TablePenEditor draft={draft} onChange={setDraft} floors={[]} errors={{}} onCapacity={() => {}} count={1} onCount={() => {}} /> }
  const { container } = render(<Example />)
  fireEvent.click(screen.getByRole('button', { name: '丸' }))
  const group = screen.getByRole('group', { name: '椅子の配置' })
  expect(within(group).getByRole('button', { name: 'まわりに均等' }).getAttribute('aria-pressed')).toBe('true')
  const chairs = () => [...container.querySelectorAll<HTMLElement>('[data-round]')]
  expect(chairs()).toHaveLength(4)
  expect(new Set(chairs().map(chair => chair.style.getPropertyValue('--chair-angle'))).size).toBe(4)
  fireEvent.click(within(group).getByRole('button', { name: '片側' }))
  fireEvent.click(within(screen.getByRole('group', { name: '椅子を置く側' })).getByRole('button', { name: '右' }))
  expect(chairs().every(chair => chair.style.getPropertyValue('--chair-x') !== '')).toBe(true)
  expect(chairs().map(chair => chair.style.getPropertyValue('--chair-angle'))).toEqual(['45deg', '75deg', '105deg', '135deg'])
  fireEvent.click(within(group).getByRole('button', { name: '向かい合わせ' }))
  expect(chairs().map(chair => chair.style.getPropertyValue('--chair-angle'))).toEqual(['45deg', '135deg', '225deg', '315deg'])
})
