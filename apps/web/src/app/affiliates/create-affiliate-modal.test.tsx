// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { chooseAffiliateFriend, openAffiliateFriendPicker } from '@/test-utils/affiliate-create'

const fixture = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    friends: { list: async () => ({ success: true, data: { items: [{ id: 'friend-kenta', displayName: 'Demo Person(Obama)' }], total: 1 } }) },
    affiliates: { create: fixture.create, update: fixture.update },
  },
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/affiliate-navigation-mock')).affiliateNavigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'line-acc-stg-nen', selectedAccount: { id: 'line-acc-stg-nen', name: '本店' } }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
const { default: CreateAffiliateV8 } = await import('@/v8/affiliates/create')
const { ApiError } = await import('@/lib/api')
const { affiliateNavigation } = await import('@/test-utils/affiliate-navigation-mock')
const submit = () => screen.getByRole('button', { name: '登録して紹介リンクを発行する' })
const fillName = () => fireEvent.change(screen.getByLabelText('名前（表示名）'), { target: { value: 'Kenta' } })

beforeEach(() => {
  fixture.create.mockResolvedValue({ success: true, data: { id: 'aff-new', name: 'Kenta' }, link: null })
  fixture.update.mockResolvedValue({ success: true, data: { id: 'aff-new' } })
})
afterEach(cleanup)

describe('現役V8の紹介者登録', () => {
  test('必須の名前がないと作成を送らない。友だち未連携でも名前があれば登録できる', async () => {
    render(<CreateAffiliateV8 />)
    await act(async () => { fireEvent.click(submit()) })
    expect(await screen.findByText('名前・屋号を入力してください')).toBeTruthy()
    expect(fixture.create).not.toHaveBeenCalled()
    fillName()
    await act(async () => { fireEvent.click(submit()) })
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Kenta', friendId: undefined }))
  })

  test('選んだ友だちとLINEアカウントを作成に送り、一覧へ戻る', async () => {
    render(<CreateAffiliateV8 />)
    await chooseAffiliateFriend('Demo Person(Obama)')
    fillName()
    await act(async () => { fireEvent.click(submit()) })
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ friendId: 'friend-kenta', lineAccountId: 'line-acc-stg-nen' }))
    await waitFor(() => expect(affiliateNavigation.push).toHaveBeenCalledWith('/affiliates?affiliate=aff-new&highlight=aff-new'))
  })

  test('サーバーの安全な失敗理由を見せ、作成を送り直せる', async () => {
    fixture.create.mockRejectedValueOnce(new ApiError(400, 'LINEアカウントを指定してください'))
    render(<CreateAffiliateV8 />)
    fillName()
    await act(async () => { fireEvent.click(submit()) })
    expect(await screen.findByText('LINEアカウントを指定してください')).toBeTruthy()
    expect(submit()).toHaveProperty('disabled', false)
    await act(async () => { fireEvent.click(submit()) })
    expect(fixture.create).toHaveBeenCalledTimes(2)
    expect(affiliateNavigation.push).toHaveBeenCalled()
  })

  test('友だちを選ぶ窓は共通Dialogの閉じる操作を1つ持つ', async () => {
    render(<CreateAffiliateV8 />)
    const { dialog } = await openAffiliateFriendPicker()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getAllByRole('button', { name: '閉じる' })).toHaveLength(1)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' })) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('発行後に追加情報だけ失敗してもリンクを見せ、同じ人の保存を再開する', async () => {
    fixture.create.mockResolvedValue({ success: true, data: { id: 'aff-new', name: 'Kenta' }, link: { url: 'https://lin.ee/issued-1' } })
    fixture.update.mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true })
    render(<CreateAffiliateV8 />)
    fillName()
    await act(async () => { fireEvent.click(submit()) })
    expect(await screen.findByTitle('https://lin.ee/issued-1')).toBeTruthy()
    expect(affiliateNavigation.push).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '追加情報の保存を再開する' })) })
    expect(fixture.create).toHaveBeenCalledTimes(1)
    expect(fixture.update).toHaveBeenCalledTimes(2)
    expect(affiliateNavigation.push).toHaveBeenCalled()
  })
})
