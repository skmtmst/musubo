// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ account: 'a', role: 'owner' as string, contextId: null as string | null, list: vi.fn(), context: vi.fn(), select: vi.fn(), media: vi.fn(), save: vi.fn(), link: vi.fn(), channels: vi.fn(), notice: vi.fn(), saveNotice: vi.fn(), add: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: net.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {}, useHideSettingsNav: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => net.role, canManageRole: (role: string) => role === 'owner' || role === 'admin' }))
vi.mock('@/lib/api', async load => ({ ...await load<typeof import('@/lib/api')>(), fetchApi: net.channels }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: {
  listStores: net.list, storeContext: net.context, selectStore: net.select,
  addGourmetMedia: net.add, mediaLinks: net.media, saveMediaLink: net.save, reservationLink: net.link,
  closeNotificationSettings: net.notice, saveCloseNotificationSettings: net.saveNotice,
  snapshot: async () => ({ data: { memberships: [] } }),
} }))
import BookingMedia from '@/v8/settings/booking-media/screen'
import { ApiError } from '@/lib/api'
const row = { code: 'fixture', name: '人工媒体', acceptsReservations: true, pageUrl: 'https://fixture.invalid/page', loginUrl: null, closeOnBooking: false, version: 3 }
beforeEach(() => {
  vi.resetAllMocks(); net.account = 'a'; net.role = 'owner'; net.contextId = null
  net.list.mockResolvedValue({ data: { stores: [
    { id: 'other', name: '別の店', line_account_id: 'b', status: 'active' },
    { id: 'old', name: '現在の店', line_account_id: 'a', status: 'archived' },
    { id: 'current', name: '現在の店', line_account_id: 'a', status: 'active' },
  ] } })
  net.context.mockImplementation(async () => ({ data: { selectedStore: net.contextId ? { id: net.contextId, name: '店' } : null } }))
  net.select.mockImplementation(async (_account, id) => { net.contextId = id; return { data: { selectedStore: { id, name: '店' } } } })
  net.media.mockResolvedValue({ data: [{ ...row }] })
  net.channels.mockResolvedValue({ data: [] })
  net.link.mockResolvedValue({ data: { url: 'https://fixture.invalid/reserve', html: '', available: true } })
  net.save.mockResolvedValue({ data: { version: 4 } })
  net.notice.mockResolvedValue({ data: { notifyReopen: false, recipientMode: 'responsible', membershipIds: [], version: 1 } })
  net.saveNotice.mockResolvedValue({ data: { version: 2 } })
})
afterEach(cleanup)




async function openAdd() {
  render(<BookingMedia />)
  await screen.findByText('人工媒体')
  fireEvent.click(screen.getByRole('button', { name: '媒体を足す', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '媒体を足す', exact: true })
  const input = within(dialog).getByRole('textbox', { name: '媒体の名前' }) as HTMLInputElement
  const button = within(dialog).getByRole('button', { name: '足す', exact: true }) as HTMLButtonElement
  return { dialog, input, button }
}

it.each(['', '   ', '\u3000'])('媒体名が空または空白の時は必須の印と理由を出して要求しない: %j', async (value) => {
  const { dialog, input, button } = await openAdd()
  fireEvent.change(input, { target: { value } })
  expect(input.getAttribute('aria-required')).toBe('true')
  expect(dialog.querySelectorAll('[data-required-badge]')).toHaveLength(1)
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-description')).toBe('媒体の名前を入れてください')
  expect(within(dialog).getAllByText('媒体の名前を入れてください')).toHaveLength(1)
  fireEvent.click(button)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(net.add).not.toHaveBeenCalled()
})

it('名前があれば追加でき、前後の空白を除いた既存の値を送る', async () => {
  const { dialog, input, button } = await openAdd()
  fireEvent.change(input, { target: { value: '  架空の媒体  ' } })
  expect(button.disabled).toBe(false)
  expect(within(dialog).queryByText('媒体の名前を入れてください')).toBeNull()
  net.add.mockResolvedValue({ success: true })
  fireEvent.click(button)
  await waitFor(() => expect(net.add).toHaveBeenCalledExactlyOnceWith('a', { code: expect.stringMatching(/^gourmet_[a-z0-9]+$/), name: '架空の媒体' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '媒体を足す', exact: true })).toBeNull())
})

it('入力上限100を保ち、名前を消すと再び同じ理由で止まる', async () => {
  const { dialog, input, button } = await openAdd()
  expect(input.maxLength).toBe(100)
  fireEvent.change(input, { target: { value: 'あ'.repeat(100) } })
  expect(button.disabled).toBe(false)
  expect(input.value).toHaveLength(100)
  fireEvent.change(input, { target: { value: '' } })
  expect(button.disabled).toBe(true)
  expect(within(dialog).getAllByText('媒体の名前を入れてください')).toHaveLength(1)
  expect(net.add).not.toHaveBeenCalled()
})

it('追加に失敗した時は名前と窓を残し、既存の権限の入口を保つ', async () => {
  net.add.mockRejectedValue(new ApiError(400, 'fixture failure'))
  const { dialog, input, button } = await openAdd()
  fireEvent.change(input, { target: { value: '架空の媒体' } })
  fireEvent.click(button)
  await within(dialog).findByText('媒体を足せませんでした。もう一度お試しください')
  expect(input.value).toBe('架空の媒体')
  expect(button.disabled).toBe(false)
  expect(net.add).toHaveBeenCalledTimes(1)
})

it('閲覧のみの追加入口は灰色で出し、押しても開かない', async () => {
  net.role = 'viewer'
  render(<BookingMedia />)
  await screen.findByText('人工媒体')
  const add = screen.getByRole('button', { name: '媒体を足す', exact: true })
  expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(add)).toBe(true)
  fireEvent.click(add)
  expect(net.add).not.toHaveBeenCalled()
})

it('追加窓で予約サイトが現れる方法を案内する', async () => {
  const { dialog } = await openAdd()
  expect(dialog.textContent).toContain('予約サイトは、予約メールを取り込むと自動で現れます')
})
