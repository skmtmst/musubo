// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FeatureGroup, MenuItemOrder } from '@/lib/feature-settings'
import { ReorderDialog } from './reorder-dialog'
const groups: FeatureGroup[] = [{ id: 'delivery', label: '配信', items: [{ id: 'a', label: '一斉配信', note: '', keys: [] }, { id: 'b', label: 'シナリオ配信', note: '', keys: [] }] }]
afterEach(cleanup)
it.each([
  ['並び順の全体が配列', []],
  ['並び順に文字でない項目', { delivery: ['a', 123] }],
])('%sの場合は確定せず、理由を知らせる', (_label, order) => {
  const apply = vi.fn()
  render(<ReorderDialog groups={groups} initialOrder={order as MenuItemOrder} onCancel={() => {}} onApply={apply} moveItemInOrder={vi.fn()} />)
  expect(screen.getByText('並び順を確認できません。画面を読み直してください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'この並びにする' }))
  expect(apply).not.toHaveBeenCalled()
})
