// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ fields: vi.fn(), folders: vi.fn(), update: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: f.push }), useSearchParams: () => new URLSearchParams('id=f-1'), usePathname: () => '/tags/fields/edit' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', selectedAccount: { id: 'a', name: '本店' } }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, friendFields: { ...actual.api.friendFields, list: f.fields, update: f.update }, folders: { ...actual.api.folders, list: f.folders } } } })
import FieldEdit from './field-edit'
const field = { id: 'f-1', name: 'メモ', fieldKey: 'memo', type: 'text', options: null, defaultValue: null, folderId: null, version: 1 }
beforeEach(() => { vi.clearAllMocks(); f.fields.mockReset().mockResolvedValue({ success: true, data: [field] }); f.folders.mockReset().mockResolvedValue({ success: true, data: [] }) })
afterEach(cleanup)
it('初回フォルダ応答が不正でも編集画面で読み直せる', async () => {
  f.folders.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [] })
  render(<FieldEdit />)
  expect(await screen.findByText('所属を読み込めませんでした。今の所属は変わらず保存されます。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(screen.queryByText('所属を読み込めませんでした。今の所属は変わらず保存されます。')).toBeNull())
  expect((screen.getByLabelText(/項目名/) as HTMLInputElement).value).toBe('メモ')
})
it('フォルダの再取得が不正でも入力を保ち、再度読み直せる', async () => {
  f.folders.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [] })
  render(<FieldEdit />)
  await screen.findByText('所属を読み込めませんでした。今の所属は変わらず保存されます。')
  fireEvent.change(screen.getByLabelText(/項目名/), { target: { value: '入力中のメモ' } })
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(f.folders).toHaveBeenCalledTimes(2))
  expect(screen.getByText('所属を読み込めませんでした。今の所属は変わらず保存されます。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(screen.queryByText('所属を読み込めませんでした。今の所属は変わらず保存されます。')).toBeNull())
  expect((screen.getByLabelText(/項目名/) as HTMLInputElement).value).toBe('入力中のメモ')
})
