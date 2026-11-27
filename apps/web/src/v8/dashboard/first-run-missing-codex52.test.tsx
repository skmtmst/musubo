// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ starterSet: vi.fn(), starterItems: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { starterSet: net.starterSet, starterItems: net.starterItems } }))
const { FirstRunDoneDialog } = await import('./first-run-done')
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('初期設定の対象が見つからない場合は止まっていると断定しない', async () => {
  net.starterSet.mockResolvedValue({ success: true, data: { definition: { items: [{ kind: 'automation' }] } } })
  net.starterItems.mockResolvedValue({ success: true, data: { items: [{ kind: 'automation', status: 'missing' }] } })
  render(<FirstRunDoneDialog accountId="a" style="standard" minutes={null} steps={[]} onClose={() => {}} />)
  const row = (await screen.findByText('オートメーション')).closest('li')!
  expect(within(row).getByText('状態を確認できません')).toBeTruthy()
  expect(within(row).queryByText('止めています')).toBeNull()
})
