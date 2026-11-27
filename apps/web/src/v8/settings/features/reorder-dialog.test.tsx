// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FeatureGroup } from '@/lib/feature-settings'
import { ReorderDialog } from './reorder-dialog'

afterEach(cleanup)
const groups: FeatureGroup[] = [
  { id: 'delivery', label: '配信', items: [{ id: 'a', label: '一斉配信', note: '', keys: [] }, { id: 'b', label: 'シナリオ配信', note: '', keys: [] }] },
  { id: 'main', label: 'メイン', items: [{ id: 'c', label: '友だち', note: '', keys: [] }] },
]
test('区分を変えても並べ替えた下書きを保ち、確定した時だけまとめて返す', () => {
  const apply = vi.fn()
  render(<ReorderDialog groups={groups} initialOrder={{}} onApply={apply} onCancel={() => {}} moveItemInOrder={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '一斉配信を下へ' }))
  fireEvent.click(screen.getByRole('button', { name: '並びを変更する区分を選択する' }))
  fireEvent.click(within(screen.getByRole('option', { name: 'メイン' })).getByRole('button'))
  expect(screen.getByText('友だち')).toBeTruthy()
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'この並びにする' }))
  expect(apply).toHaveBeenCalledWith({ delivery: ['b', 'a'] })
})
test('81: 取り消しが左、実行が右（［キャンセル］［この並びにする］）', () => {
  render(<ReorderDialog groups={groups} initialOrder={{}} onApply={vi.fn()} onCancel={() => {}} moveItemInOrder={vi.fn()} />)
  const pair = screen.getByRole('dialog').querySelector('[data-dialog-action-pair]')
  const labels = within(pair as HTMLElement).getAllByRole('button').map((button) => (button.textContent ?? '').replace(/\s+/g, ''))
  expect(labels).toEqual(['元の並びに', 'キャンセル', 'この並びにする'])
})
