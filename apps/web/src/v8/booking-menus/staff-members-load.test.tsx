// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, list: mocks.list } } } })
import { StaffEditModal } from './staff-edit-dialog'
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('ログインユーザーの取得失敗を示し、入力を残して読み直す', async () => {
  mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: [{ id: 'm-1', name: '山田', isActive: true }] })
  render(<StaffEditModal staff={{ name: 'staff', display_name: '担当者', staff_member_id: 'm-1', is_active: 1 }} onSave={vi.fn()} onClose={vi.fn()} />)
  await screen.findByText('ログインユーザーを読み込めませんでした。ほかの項目は編集できます。')
  expect(mocks.list).toHaveBeenCalledWith('account-a')
  expect(screen.getByText('紐づけ済み（確認中）')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'ログインユーザーとの紐づけ' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'ログインユーザーを読み直す' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'ログインユーザーとの紐づけ' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText('ログインユーザーを読み込めませんでした。ほかの項目は編集できます。')).toBeNull()
  expect(screen.getByText('山田')).toBeTruthy()
})
