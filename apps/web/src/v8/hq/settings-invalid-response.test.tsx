// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ me: vi.fn(), update: vi.fn(), saved: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { tenants: { me: mocks.me, updateName: mocks.update, companyContact: vi.fn().mockResolvedValue({ success: true, data: { revision: 1, legalCompanyName: null, postalCode: null, address: null, building: null, phone: null, contactName: null, contactEmail: null, invoiceAddressee: null } }), saveCompanyContact: vi.fn() }, postalCode: { search: vi.fn() } } }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: mocks.saved }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/hq/settings', useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
import HqSettingsV8 from './settings'

afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks() })

it('統括名が不正な応答は空の名前と扱わず再読み込みできる', async () => {
  mocks.me.mockResolvedValueOnce({ success: true, data: { name: 42 } }).mockResolvedValueOnce({ success: true, data: { name: '確認済み' } })
  render(<HqSettingsV8 />)
  expect(await screen.findByText(/統括名を読み込めませんでした/)).toBeTruthy()
  const input = screen.getByLabelText(/統括名/) as HTMLInputElement
  expect(input.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(input.value).toBe('確認済み'))
})

it('保存の返答が不正なら成功と表示せず、入力を残して結果を確認するよう知らせる', async () => {
  mocks.me.mockResolvedValue({ success: true, data: { name: '元の名前' } })
  mocks.update.mockResolvedValue({ success: true, data: { name: null } })
  render(<HqSettingsV8 />)
  const input = screen.getByLabelText(/統括名/) as HTMLInputElement
  await waitFor(() => expect(input.value).toBe('元の名前'))
  fireEvent.change(input, { target: { value: '新しい名前' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する', exact: true }))
  expect(await screen.findByText(/保存結果を確認できませんでした/)).toBeTruthy()
  expect(input.value).toBe('新しい名前')
  expect(mocks.saved).not.toHaveBeenCalled()
})


it('統括名が null の既存データは空欄で開き編集できる', async () => {
  mocks.me.mockResolvedValue({ success: true, data: { name: null } })
  render(<HqSettingsV8 />)
  const input = screen.getByLabelText(/統括名/) as HTMLInputElement
  await waitFor(() => expect(input.disabled).toBe(false))
  expect(input.value).toBe('')
  expect(screen.queryByText(/統括名を読み込めませんでした/)).toBeNull()
})
