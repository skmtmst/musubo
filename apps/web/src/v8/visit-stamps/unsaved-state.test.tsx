// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1',
  role: 'owner' as string | null,
  cards: vi.fn(), save: vi.fn(), create: vi.fn(), paperRequests: vi.fn(), reviewPaper: vi.fn(), wallet: vi.fn(), grant: vi.fn(), reverse: vi.fn(), setPin: vi.fn(),
  friendsList: vi.fn(), friendsGet: vi.fn(), staffList: vi.fn(), entries: vi.fn(), paperPhoto: vi.fn(),
  uploadImage: vi.fn(), replace: vi.fn(), push: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.accountId, accounts: [{ id: 'acc-1', name: '銀座店' }, { id: 'acc-2', name: '渋谷店' }] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fx.role, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/shared/toast', () => ({ ...(() => { const notifyToast = vi.fn(); return { notifyToast, notifySaved: notifyToast } })() }))
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRouter: () => ({ push: fx.push, replace: fx.replace, back: vi.fn() }),
    usePathname: () => '/visit-stamps',
    useSearchParams: () => {
      const search = useSyncExternalStore(
        listener => { window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener) },
        () => window.location.search,
      )
      return new URLSearchParams(search)
    },
  }
})
vi.mock('@/lib/visit-stamps-api', () => ({
  visitStampsApi: {
    storefrontQr:vi.fn(async()=>({success:true,data:null})),
    cards: fx.cards, save: fx.save, create: fx.create, paperRequests: fx.paperRequests, reviewPaper: fx.reviewPaper,
    wallet: fx.wallet, grant: fx.grant, reverse: fx.reverse, setPin: fx.setPin, entries: fx.entries, paperPhoto: fx.paperPhoto,
  },
}))
vi.mock('@/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: { friends: { list: fx.friendsList, get: fx.friendsGet }, staff: { list: fx.staffList }, uploads: { image: fx.uploadImage } },
  describeSaveFailure: (e: unknown) => (e instanceof Error ? e.message : '保存できませんでした。'),
}))
import { flushListUrlState } from '@/components/shared/list-url-state'
import VisitStampsV8 from './visit-stamps'
import { notifyToast } from '@/components/shared/toast'

const card = {
  id: 'card-1', name: '然 来店スタンプカード', accountIds: ['acc-1'], active: true, version: 3, expectedVersion: 3,
  settings: {
    mode: 'visit' as const, amountUnit: 1000, maxPerVisit: 3, firstVisitBonus: 1, expiryMonths: 6, timezone: 'Asia/Tokyo',
    multipliers: [], rankMultipliers: [], rewards: [{ id: 'r1', name: 'ドリンク 1杯', stamps: 5 }, { id: 'r2', name: 'デザート 1品', stamps: 10 }],
  },
}

beforeEach(() => {
  fx.accountId = 'acc-1'
  flushListUrlState()
  window.history.replaceState(null, '', '/visit-stamps')
  fx.replace.mockImplementation((href: string) => {
    window.history.replaceState(null, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  fx.role = verifiedStaffRole('owner')
  fx.uploadImage.mockResolvedValue({ success: true, data: { url: 'https://example.test/images/card.png' } })
  fx.cards.mockResolvedValue({ success: true, data: [card] })
  fx.save.mockResolvedValue({ success: true, data: card })
  fx.paperRequests.mockResolvedValue({ success: true, data: [{ id: 'p1', friend_id: 'f1', photo_url: '', stamps: 7, status: 'pending', created_at: '2026-01-12 11:14:00' }] })
  fx.reviewPaper.mockResolvedValue({ success: true, data: { id: 'p1', status: 'approved' } })
  fx.wallet.mockResolvedValue({ success: true, data: { wallet: { cardId: 'card-1', friendId: 'f1', balance: 3, earnedTotal: 3, expiresAt: null }, entries: [] } })
  fx.grant.mockResolvedValue({ success: true, data: {} })
  fx.friendsList.mockResolvedValue({ success: true, data: { items: [{ id: 'f1', displayName: 'みさき', metadata: { name: '見本 183' } }] } })
  fx.friendsGet.mockImplementation(async (id: string) => ({ success: true, data: { id, displayName: 'みさき' } }))
  fx.staffList.mockResolvedValue({ success: true, data: [{ id: 's1', name: '田村', role: 'staff' }] })
  fx.entries.mockResolvedValue({ success: true, data: { items: [
    { id: 'e1', cardId: 'card-1', friendId: 'f1', accountId: 'acc-1', kind: 'redeem', delta: -10, actorId: 's1', reason: 'デザート 1品', createdAt: '2026-01-13T09:10:00.000Z', originalId: null },
    { id: 'e2', cardId: 'card-1', friendId: 'f2', accountId: 'acc-1', kind: 'visit', delta: 1, actorId: null, reason: '', createdAt: '2026-01-12T03:05:00.000Z', originalId: null },
  ], total: 2, page: 1, pageSize: 5 } })
  fx.paperPhoto.mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' }))
})
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/') })


const nameInput = async () => screen.findByDisplayValue('来店スタンプカード')
const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
const leave = () => { const link = document.createElement('a'); link.href = '/tags'; link.textContent = 'タグへ'; document.body.append(link); fireEvent.click(link); link.remove() }
const emptyCards = () => fx.cards.mockResolvedValue({ success: true, data: [] })

it('未作成の初期表示は未公開と伝え、初期値を保存でき、離脱を妨げない', async () => {
  emptyCards()
  render(<VisitStampsV8 />)
  await nameInput()
  expect(screen.queryByText('まだ公開していません')).not.toBeNull()
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(false)
  expect(unload()).toBe(false)
  expect(fx.create).not.toHaveBeenCalled()
})

it('未作成のキャンセルは初期値と未公開へ戻し、離脱の確認を残さない', async () => {
  emptyCards()
  render(<VisitStampsV8 />)
  fireEvent.change(await nameInput(), { target: { value: '入力中のカード' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  await nameInput()
  expect(screen.queryByText('まだ公開していません')).not.toBeNull()
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(unload()).toBe(false)
  expect(fx.create).not.toHaveBeenCalled()
})

it('未作成でも入力したら離脱を確認し、留まると入力を保ち、確定後だけ移る', async () => {
  emptyCards()
  render(<VisitStampsV8 />)
  fireEvent.change(await nameInput(), { target: { value: '入力中のカード' } })
  expect(screen.queryByText('保存していない変更があります')).not.toBeNull()
  expect(unload()).toBe(true)
  leave()
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(screen.queryByDisplayValue('入力中のカード')).not.toBeNull()
  expect(fx.push).not.toHaveBeenCalled()
  leave()
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  expect(fx.push).toHaveBeenCalledWith('/tags')
  expect(fx.create).not.toHaveBeenCalled()
})


it('未作成の入力を初期値に戻せば変更の案内と離脱確認を消し、初期保存は使える', async () => {
  emptyCards()
  render(<VisitStampsV8 />)
  fireEvent.change(await nameInput(), { target: { value: '別のカード' } })
  expect(unload()).toBe(true)
  fireEvent.change(screen.getByDisplayValue('別のカード'), { target: { value: '来店スタンプカード' } })
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(screen.queryByText('まだ公開していません')).not.toBeNull()
  expect(unload()).toBe(false)
  expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(false)
})

it('未作成の設定変更も離脱確認の対象となり、タブを往復して保持する', async () => {
  emptyCards()
  render(<VisitStampsV8 />)
  await nameInput()
  fireEvent.change(screen.getByRole('textbox', { name: '使い方の説明' }), { target: { value: 'ご来店ごとに押します' } })
  expect(unload()).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'カードの設定' }))
  expect(screen.getByDisplayValue('ご来店ごとに押します')).toBeTruthy()
  expect(screen.queryByText('保存していない変更があります')).not.toBeNull()
  expect(fx.create).not.toHaveBeenCalled()
})

it('保存済みカードは変更した時だけ確認し、キャンセルすると保存状態へ戻る', async () => {
  render(<VisitStampsV8 />)
  const input = await screen.findByDisplayValue(card.name)
  expect(screen.queryByText('まだ公開していません')).toBeNull()
  expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(true)
  expect(unload()).toBe(false)
  fireEvent.change(input, { target: { value: '更新したカード' } })
  expect(unload()).toBe(true)
  leave()
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.queryByDisplayValue(card.name)).not.toBeNull()
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(unload()).toBe(false)
  expect(fx.save).not.toHaveBeenCalled()
})

it('未作成の設定を保存したらカードを読み直し、未保存と未公開の案内を消す', async () => {
  const saved = { ...card, name: '新しいカード' }
  fx.cards.mockResolvedValueOnce({ success: true, data: [] }).mockResolvedValue({ success: true, data: [saved] })
  fx.create.mockResolvedValue({ success: true, data: saved })
  render(<VisitStampsV8 />)
  fireEvent.change(await nameInput(), { target: { value: saved.name } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(fx.create).toHaveBeenCalledWith(expect.objectContaining({ name: saved.name, accountIds: ['acc-1'], active: true, expectedVersion: 0 })))
  await waitFor(() => expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(true))
  expect(screen.queryByText('まだ公開していません')).toBeNull()
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(unload()).toBe(false)
})

it('未作成の保存失敗は入力と離脱確認を保ち、成功まで勝手に移らない', async () => {
  emptyCards()
  fx.create.mockRejectedValue(new Error('保存できませんでした。'))
  render(<VisitStampsV8 />)
  fireEvent.change(await nameInput(), { target: { value: '保存待ちのカード' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(notifyToast).toHaveBeenCalledWith('保存できませんでした。', expect.anything()))
  expect(screen.queryByDisplayValue('保存待ちのカード')).not.toBeNull()
  expect(unload()).toBe(true)
  expect(fx.push).not.toHaveBeenCalled()
})


it.each(['empty', 'saved'] as const)('カードの%s初期値は描画が落ち着いても変更として扱わない', async kind => {
  if (kind === 'empty') emptyCards()
  render(<VisitStampsV8 />)
  await screen.findByDisplayValue(kind === 'empty' ? '来店スタンプカード' : card.name)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(unload()).toBe(false)
})

it('取得待ちの間は未作成かどうかを断定せず、保存操作も出さない', () => {
  fx.cards.mockReturnValue(new Promise(() => {}))
  render(<VisitStampsV8 />)
  expect(screen.queryByText('まだ公開していません')).toBeNull()
  expect(screen.queryByText('保存していない変更があります')).toBeNull()
  expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
  expect(unload()).toBe(false)
})

it.each(['viewer', 'staff'])('役割%sは設定を変えられず、初期値で離脱を妨げない', async role => {
  emptyCards(); fx.role = role
  render(<VisitStampsV8 />)
  expect((await nameInput()).hasAttribute('readonly')).toBe(true)
  expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
  expect(unload()).toBe(false)
})

it('公開中カードのマス数を変える場合だけ、影響を確認して保存する', async () => {
  render(<VisitStampsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'マスの数' }))
  fireEvent.click(screen.getByRole('button', { name: '12 個' }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  const dialog = screen.getByRole('dialog', { name: 'マスの数を変更しますか？' })
  expect(within(dialog).getByText(/お客さま/)).toBeTruthy()
  expect(fx.save).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '変更して保存する' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(1))
  expect(fx.save.mock.calls[0][1].settings.slotCount).toBe(12)
})

it('確認を取り消すと保存せず、入力したマス数を保持する', async () => {
  render(<VisitStampsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'マスの数' }))
  fireEvent.click(screen.getByRole('button', { name: '12 個' }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'マスの数を変更しますか？' })).getByRole('button', { name: 'キャンセル' }))
  expect(fx.save).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'マスの数' }).textContent).toContain('12')
})

it('停止中カードのマス数変更は確認なしで保存する', async () => {
  fx.cards.mockResolvedValue({ success: true, data: [{...card, active:false}] })
  render(<VisitStampsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'マスの数' }))
  fireEvent.click(screen.getByRole('button', { name: '12 個' }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog', { name: 'マスの数を変更しますか？' })).toBeNull()
})

it('公開中でもマス数以外の変更は確認なしで保存する', async () => {
  render(<VisitStampsV8 />)
  fireEvent.change(await screen.findByDisplayValue('然 来店スタンプカード'), { target: { value: '新しい名前' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('dialog', { name: 'マスの数を変更しますか？' })).toBeNull()
})
