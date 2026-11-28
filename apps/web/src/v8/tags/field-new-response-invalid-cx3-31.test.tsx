// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ fields: vi.fn(), folders: vi.fn(), create: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: f.push }), useSearchParams: () => new URLSearchParams(''), usePathname: () => '/tags/fields/new' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, friendFields: { ...actual.api.friendFields, list: f.fields, create: f.create }, folders: { ...actual.api.folders, list: f.folders } } } })
import FieldNew from './field-new'
beforeEach(() => { vi.clearAllMocks(); f.fields.mockReset().mockResolvedValue({ success: true, data: [] }); f.folders.mockReset().mockResolvedValue({ success: true, data: [] }) })
afterEach(cleanup)
it('既存項目の不正な応答は保存を止め、読み直せる', async () => {
  f.fields.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [] })
  render(<FieldNew />)
  expect(await screen.findByText('既存の項目を読み込めませんでした')).toBeTruthy()
  const create = screen.getByRole('button', { name: '項目を作る' }) as HTMLButtonElement
  expect(create.disabled).toBe(true)
  fireEvent.click(create)
  expect(f.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByLabelText(/項目名/)).toBeTruthy()
  expect(screen.queryByText('既存の項目を読み込めませんでした')).toBeNull()
})
it('フォルダの不正な応答は失敗を知らせ、読み直せる', async () => {
  f.folders.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [] })
  render(<FieldNew />)
  expect(await screen.findByText('フォルダを読み込めませんでした。今は未分類にしか入れられません。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByLabelText(/項目名/)
  expect(screen.queryByText('フォルダを読み込めませんでした。今は未分類にしか入れられません。')).toBeNull()
})
