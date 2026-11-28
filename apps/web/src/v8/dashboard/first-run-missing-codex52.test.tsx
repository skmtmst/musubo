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
  expect(within(row).getByText('見つかりません')).toBeTruthy()
  expect(within(row).queryByText('止めています')).toBeNull()
})

it('同じ種類に停止中と見つからない物があれば両方の案内を出す', async () => {
  net.starterSet.mockResolvedValue({ success: true, data: { definition: { items: [{ kind: 'automation' }] } } })
  net.starterItems.mockResolvedValue({ success: true, data: { items: [{ kind: 'automation', status: 'missing' }, { kind: 'automation', status: 'draft' }] } })
  render(<FirstRunDoneDialog accountId="a" style="standard" minutes={null} steps={[]} onClose={() => {}} />)
  expect(await screen.findByText('一部見つかりません')).toBeTruthy()
  expect(screen.getByText(/止めている物は、はじめの質問/)).toBeTruthy()
})
