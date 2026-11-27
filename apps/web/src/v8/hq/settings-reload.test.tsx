// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  role: 'owner' as string | null,
  me: vi.fn(),
  companyContact: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    tenants: {
      me: mocks.me,
      updateName: vi.fn(),
      companyContact: mocks.companyContact,
      saveCompanyContact: vi.fn(),
    },
    postalCode: { search: vi.fn() },
  },
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => mocks.role,
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/hq/settings',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))

import HqSettingsV8 from './settings'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.role = 'owner'
  mocks.companyContact.mockResolvedValue({
    success: true,
    data: {
      revision: 1,
      legalCompanyName: '株式会社テスト',
      postalCode: '100-0001',
      address: '東京都千代田区',
      building: null,
      phone: '03-0000-0000',
      contactName: '担当',
      contactEmail: 'test@example.com',
      invoiceAddressee: null,
    },
  })
})
afterEach(cleanup)

it('統括名の取得に失敗したとき、その場でもう一度読み込んで編集へ復帰できる', async () => {
  mocks.me
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ success: true, data: { name: '再取得した統括名' } })

  render(<HqSettingsV8 />)
  expect(await screen.findByText('統括名を読み込めませんでした。時間をおいてもう一度お試しください。')).toBeTruthy()
  const input = screen.getByLabelText(/統括名/) as HTMLInputElement
  expect(input.disabled).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(input.value).toBe('再取得した統括名'))
  expect(input.disabled).toBe(false)
  expect(screen.queryByText('統括名を読み込めませんでした。時間をおいてもう一度お試しください。')).toBeNull()
})

it('閲覧のみの権限でも統括名の取得失敗からもう一度読み込める', async () => {
  mocks.role = 'staff'
  mocks.me
    .mockResolvedValueOnce({ success: false, error: 'temporary' })
    .mockResolvedValueOnce({ success: true, data: { name: '閲覧先の統括名' } })

  render(<HqSettingsV8 />)
  expect(await screen.findByText('統括名を読み込めませんでした。時間をおいてもう一度お試しください。')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('閲覧先の統括名')).toBeTruthy()
  expect(screen.queryByText('統括名を読み込めませんでした。時間をおいてもう一度お試しください。')).toBeNull()
})
