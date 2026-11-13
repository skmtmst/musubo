// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { friends: { list: fixture.list } } }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => (await import('@/test-utils/affiliate-navigation-mock')).affiliateNavigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '本店' } }) }))
const { default: CreateAffiliateV8 } = await import('@/v8/affiliates/create')
afterEach(cleanup)

async function search(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINE の友だちと結びつける' })) })
  fireEvent.change(screen.getByLabelText('友だちの名前で探す'), { target: { value: name } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '検索' })) })
}

describe('R294 現役V8の友だち検索は0件と失敗を言い分ける', () => {
  test('0件は0件と案内し、友だち未連携のままにする', async () => {
    fixture.list.mockResolvedValue({ success: true, data: { items: [], total: 0 } })
    render(<CreateAffiliateV8 />)
    await search('QA_R69_NO_MATCH')
    expect(await screen.findByText('全0 件')).toBeTruthy()
    expect(screen.getByText('結びつけると、本人が LINE で成果を見られます')).toBeTruthy()
    expect(fixture.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'QA_R69_NO_MATCH', accountId: 'acc-1' }))
  })

  test('失敗は再試行でき、直れば候補が出る', async () => {
    fixture.list.mockResolvedValue({ success: false, error: '落ちた' })
    render(<CreateAffiliateV8 />)
    await search('Kenta')
    expect(await screen.findByText(/友だちを読み込めませんでした/)).toBeTruthy()
    fixture.list.mockResolvedValue({ success: true, data: { items: [{ id: 'friend-kenta', displayName: 'Demo Person(Obama)' }], total: 1 } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' })) })
    await screen.findByText('全1 件')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINEの友だちと結びつける' })) })
    expect(await within(screen.getByRole('dialog')).findByText('Demo Person(Obama)')).toBeTruthy()
  })

  test('候補を選べて、結びつける欄を畳んでも選択が残る', async () => {
    fixture.list.mockResolvedValue({ success: true, data: { items: [{ id: 'friend-kenta', displayName: 'Demo Person(Obama)' }], total: 1 } })
    render(<CreateAffiliateV8 />)
    await search('Kenta')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINEの友だちと結びつける' })) })
    const dialog = await screen.findByRole('dialog')
    await act(async () => { fireEvent.click(await within(dialog).findByRole('radio', { name: /Demo Person/ })) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' })) })
    expect(screen.getByText('結びつける友だち：Demo Person(Obama)')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINE の友だちと結びつける' })) })
    expect(screen.queryByRole('button', { name: 'LINEの友だちと結びつける' })).toBeNull()
    expect(screen.getByText('結びつける友だち：Demo Person(Obama)')).toBeTruthy()
  })
})
