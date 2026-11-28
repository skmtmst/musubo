// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { findPickerDialog } from '@/components/shared/entity-picker-test-helpers'

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', accounts: [] }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual,
    api: { ...actual.api,
      tags: { ...actual.api.tags, list: async () => ({ success: true, data: [
        { id: 'tag-1', name: '予約中', lineAccountId: 'account-a', status: 'active', groupId: null },
        { id: 'tag-2', name: '常連さん', lineAccountId: 'account-a', status: 'active', groupId: null },
      ] }) },
      tagGroups: { ...actual.api.tagGroups, list: async () => ({ success: true, data: [] }) },
      mileage: { ...actual.api.mileage, rules: async () => ({ success: true, data: [] }) },
    },
    bookingApi: { ...actual.bookingApi,
      listMenus: async () => ({ menus: [] }), listStaff: async () => ({ staff: [] }),
      getSettings: async () => ({ success: true, data: { bookingWindowDays: 30 } }),
      listResources: async () => ({ success: true, data: { resources: [] } }),
      listStaffMenusBulk: async () => ({ staff: [] }),
    },
  }
})

import MenuFormV8 from '@/v8/booking-menus/menu-form'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('予約後に付けるタグを実際の窓で名前検索し、確定した候補を欄へ返す', async () => {
  render(<MenuFormV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '予約後に付けるタグ', exact: true }))
  const dialog = await findPickerDialog()
  fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '常連' } })
  expect(await within(dialog).findByRole('radio', { name: '常連さん' })).toBeTruthy()
  await waitFor(() => expect(within(dialog).queryByRole('radio', { name: '予約中' })).toBeNull())
  fireEvent.click(within(dialog).getByRole('radio', { name: '常連さん' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する', exact: true }))
  await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
  expect(await screen.findByLabelText('選択中のタグ：常連さん')).toBeTruthy()
})
