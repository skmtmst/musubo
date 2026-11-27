// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'admin' }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, listMenuVersions: net.list } }
})
const { default: MenuVersionHistory } = await import('./menu-version-history')
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('版の一覧が不正なら空の履歴と表示せず、読み直せる', async () => {
  net.list.mockResolvedValueOnce({ versions: null }).mockResolvedValueOnce({ versions: [{ version_number: 1, title: '第1版', status: 'in_use', summary: '', author: null, at: '2026-10-01T00:00:00Z', lines: [] }] })
  render(<MenuVersionHistory menuId="m1" menuName="カット" currentVersion={1} accountId="acc" canRevert onReverted={() => {}} onClose={() => {}} />)
  await screen.findByText('版の履歴を読み込めませんでした。')
  await act(async () => { screen.getByRole('button', { name: 'もう一度読み込む' }).click() })
  expect(await screen.findByText('第1版')).toBeTruthy()
})
