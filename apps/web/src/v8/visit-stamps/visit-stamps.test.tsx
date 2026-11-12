// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1',
  role: 'owner' as string | null,
  cards: vi.fn(), save: vi.fn(), create: vi.fn(), paperRequests: vi.fn(), reviewPaper: vi.fn(), wallet: vi.fn(), grant: vi.fn(), reverse: vi.fn(), setPin: vi.fn(),
  friendsList: vi.fn(), friendsGet: vi.fn(), staffList: vi.fn(), entries: vi.fn(), paperPhoto: vi.fn(),
  uploadImage: vi.fn(), replace: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.accountId, accounts: [{ id: 'acc-1', name: '銀座店' }, { id: 'acc-2', name: '渋谷店' }] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fx.role, canManageRole: (r: string | null) => r === 'owner' || r === 'admin' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/shared/toast', () => ({ ...(() => { const notifyToast = vi.fn(); return { notifyToast, notifySaved: notifyToast } })() }))
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRouter: () => ({ push: vi.fn(), replace: fx.replace, back: vi.fn() }),
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
vi.mock('@/lib/api', () => ({
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

describe('来店スタンプ（管理画面）', () => {
  it('カード一覧の読込中は未保存の変更として扱わない', () => {
    fx.cards.mockReturnValue(new Promise(() => {}))
    window.history.replaceState(null, '', '/visit-stamps?tab=settings')
    render(<VisitStampsV8 />)
    expect(screen.queryByText('保存していない変更があります')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
  })

  it('タブを移っても下書きを保ち、URLの友だちと他の指定を残して保存の帯だけを切り替える', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=settings&friend=f1&from=detail#card')
    render(<VisitStampsV8 />)
    fireEvent.change(await screen.findByDisplayValue('然 来店スタンプカード'), { target: { value: '下書きのカード' } })
    fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    expect(fx.replace).toHaveBeenLastCalledWith('/visit-stamps?tab=paper&friend=f1&from=detail#card', { scroll: false })
    expect((await screen.findByRole('tab', { name: /紙のカードの移行/ })).getAttribute('aria-selected')).toBe('true')
    await screen.findByRole('button', { name: /さんの .*個を承認/ })
    const paperTable = document.querySelector('table[data-design="visit-stamp-paper"]')
    expect(paperTable?.parentElement?.getAttribute('data-column-sizing')).toBe('controls')
    expect(paperTable?.querySelector('tbody [data-cell-grow]')).not.toBeNull()
    expect(screen.queryByRole('textbox', { name: '使い方の説明' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '店で手入力' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    expect(await screen.findByRole('heading', { name: '店で手入力' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'カードの設定' }))
    expect(await screen.findByDisplayValue('下書きのカード')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalledWith('card-1', expect.objectContaining({ name: '下書きのカード' })))
  })

  it.each(['paper', 'history'])('共有URLの tab=%s で指定の内容を直接開く', async tab => {
    window.history.replaceState(null, '', `/visit-stamps?tab=${tab}`)
    render(<VisitStampsV8 />)
    const label = tab === 'paper' ? /紙のカードの移行/ : '押した・使った記録'
    expect((await screen.findByRole('tab', { name: label })).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '使い方の説明' })).toBeNull()
  })

  it('知らないタブはカードの設定へ戻し、未取得の申請数を0として見せない', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=unknown&friend=f1')
    fx.paperRequests.mockReturnValue(new Promise(() => {}))
    render(<VisitStampsV8 />)
    expect((await screen.findByRole('tab', { name: 'カードの設定' })).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: '紙のカードの移行' }).textContent).toBe('紙のカードの移行')
  })

  it('確認待ち0件は通常の数表示、1件以上は注意色で出す', async () => {
    fx.paperRequests.mockResolvedValue({ success: true, data: [] })
    const view = render(<VisitStampsV8 />)
    const empty = await screen.findByRole('tab', { name: /紙のカードの移行.*0/ })
    expect(empty.querySelector('[data-tone="warning"]')).toBeNull()
    view.unmount()
    fx.paperRequests.mockResolvedValue({ success: true, data: [{ id: 'p1', friend_id: 'f1', photo_url: '', stamps: 1, status: 'pending' }] })
    render(<VisitStampsV8 />)
    const pending = await screen.findByRole('tab', { name: /紙のカードの移行.*1/ })
    expect(pending.querySelector('[data-tone="warning"]')).not.toBeNull()
  })

  it('確認待ちだけを数え、承認後に数の札を読み直す', async () => {
    fx.paperRequests.mockResolvedValueOnce({ success: true, data: [
      { id: 'p1', friend_id: 'f1', photo_url: '', stamps: 7, status: 'pending' },
      { id: 'p2', friend_id: 'f1', photo_url: '', stamps: 3, status: 'approved' },
      { id: 'p3', friend_id: 'f1', photo_url: '', stamps: 4, status: 'rejected' },
    ] }).mockResolvedValue({ success: true, data: [] })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('tab', { name: /紙のカードの移行.*1/ }))
    fireEvent.click(await screen.findByRole('button', { name: '見本 183さんの 7個を承認' }))
    expect(await screen.findByRole('tab', { name: /紙のカードの移行.*0/ })).toBeTruthy()
  })

  it('店舗を切り替えた後の古い申請の返事で、今の店の申請と件数を上書きしない', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=paper')
    let finishOld!: (value: unknown) => void
    fx.paperRequests.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ success: true, data: [{ id: 'new-paper', friend_id: 'f1', photo_url: '', stamps: 2, status: 'pending' }] })
    const { rerender } = render(<VisitStampsV8 />)
    await screen.findByRole('tab', { name: '紙のカードの移行' })
    fx.accountId = 'acc-2'
    rerender(<VisitStampsV8 />)
    expect(await screen.findByRole('button', { name: '見本 183さんの 2個を承認' })).toBeTruthy()
    await act(async () => { finishOld({ success: true, data: [{ id: 'old-paper', friend_id: 'f1', photo_url: '', stamps: 9, status: 'pending' }] }) })
    expect(screen.queryByRole('button', { name: '見本 183さんの 9個を承認' })).toBeNull()
    expect(screen.getByRole('tab', { name: /紙のカードの移行.*1/ })).toBeTruthy()
  })

  it('タブと開いたパネルを読み上げ用のIDで結び、キーボードでタブを切り替える', async () => {
    render(<VisitStampsV8 />)
    const settings = await screen.findByRole('tab', { name: 'カードの設定' })
    const panel = screen.getByRole('tabpanel', { name: 'カードの設定' })
    expect(settings.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.getAttribute('aria-labelledby')).toBe(settings.id)
    settings.focus()
    fireEvent.keyDown(settings, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    expect(screen.getByRole('tabpanel', { name: 'カードの設定' })).toBeTruthy()
    fireEvent.click(document.activeElement!)
    expect(await screen.findByRole('tabpanel', { name: /紙のカードの移行/ })).toBeTruthy()
  })

  it('手入力欄の開閉は、タブを切り替えても保持する', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=history')
    render(<VisitStampsV8 />)
    const toggle = await screen.findByRole('button', { name: '店で手入力' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'カードの設定' }))
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    expect((await screen.findByRole('button', { name: '店で手入力' })).getAttribute('aria-expanded')).toBe('true')
  })

  it('記録は次のページをAPIから読み、表示件数を変えたら先頭へ戻る', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=history')
    fx.entries.mockResolvedValue({ success: true, data: { items: [], total: 88, page: 1, pageSize: 20 } })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '次のページ' }))
    await waitFor(() => expect(fx.entries).toHaveBeenLastCalledWith({ accountId: 'acc-1', page: 2, pageSize: 20 }))
    expect(await screen.findByText('88件中 21〜40件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '記録の表示件数' }))
    fireEvent.click(await screen.findByRole('button', { name: '10件表示' }))
    await waitFor(() => expect(fx.entries).toHaveBeenLastCalledWith({ accountId: 'acc-1', page: 1, pageSize: 10 }))
    expect(await screen.findByText('88件中 1〜10件')).toBeTruthy()
  })

  it('古い記録の返事が遅れても、操作後に読み直した記録を上書きしない', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=history')
    let finishOld!: (value: unknown) => void
    fx.entries.mockResolvedValueOnce({ success: true, data: { items: [], total: 88, page: 1, pageSize: 20 } })
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ success: true, data: { items: [], total: 120, page: 2, pageSize: 20 } })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '次のページ' }))
    await waitFor(() => expect(fx.entries).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('tab', { name: 'カードの設定' }))
    // 未完の読込中に表示件数が残らないことも確認する。
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    expect(screen.queryByRole('button', { name: '記録の表示件数' })).toBeNull()
    // 承認後の再読込が古いリクエストを追い越す場面を再現する。
    fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    fireEvent.click(await screen.findByRole('button', { name: '見本 183さんの 7個を承認' }))
    await waitFor(() => expect(fx.entries).toHaveBeenCalledTimes(3))
    await act(async () => { finishOld({ success: true, data: { items: [], total: 88, page: 2, pageSize: 20 } }) })
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    expect(await screen.findByText('120件中 21〜40件')).toBeTruthy()
    expect(screen.queryByText(/88件中/)).toBeNull()
  })

  it('記録の総数が減って今のページがなくなったら、最後のページを読み直す', async () => {
    window.history.replaceState(null, '', '/visit-stamps?tab=history')
    fx.entries.mockResolvedValueOnce({ success: true, data: { items: [], total: 88, page: 1, pageSize: 20 } })
      .mockResolvedValue({ success: true, data: { items: [], total: 2, page: 1, pageSize: 20 } })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '次のページ' }))
    await waitFor(() => expect(fx.entries).toHaveBeenCalledTimes(3))
    expect(fx.entries).toHaveBeenLastCalledWith({ accountId: 'acc-1', page: 1, pageSize: 20 })
    expect(await screen.findByText('2件中 1〜2件')).toBeTruthy()
    const pager = screen.getByText('2件中 1〜2件').closest('[data-pagination]')
    expect(pager).not.toBeNull()
    expect(pager!.querySelectorAll('button')).toHaveLength(0)
    expect(pager!.querySelector('[aria-current="page"]')).toBeNull()
  })

  it('閲覧のみは記録タブでも手入力欄を出さず、移行タブで承認・却下を隠す', async () => {
    fx.role = verifiedStaffRole('viewer')
    window.history.replaceState(null, '', '/visit-stamps?tab=history')
    render(<VisitStampsV8 />)
    await screen.findByRole('tab', { name: '押した・使った記録' })
    expect(screen.getByText('閲覧のみで見ています。変える操作は管理者に頼んでください。')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '店で手入力' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    await screen.findByRole('columnheader', { name: '状態・操作' })
    expect(screen.queryByRole('button', { name: /承認/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '却下' })).toBeNull()
  })

  it('受け取りボーナスと押印間隔は入力時に範囲外の理由をそれぞれ表示する', async () => {
    render(<VisitStampsV8 />)
    await screen.findByDisplayValue('然 来店スタンプカード')
    const bonus = screen.getByRole('spinbutton', { name: 'カードを受け取った時のボーナス' })
    fireEvent.change(bonus, { target: { value: '99' } })
    expect(screen.getByText('受け取りボーナスは0〜50個です。')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '前の押印から' }))
    const hours = screen.getByRole('spinbutton', { name: '押印をあける時間' })
    fireEvent.change(hours, { target: { value: '30' } })
    expect(screen.getByText('押印の間隔は1〜23時間です。')).toBeTruthy()
    expect(screen.getByText('受け取りボーナスは0〜50個です。')).toBeTruthy()
    fireEvent.change(bonus, { target: { value: '2' } })
    expect(screen.queryByText('受け取りボーナスは0〜50個です。')).toBeNull()
    expect(screen.getByText('押印の間隔は1〜23時間です。')).toBeTruthy()
  })

  it('誤った受け取りボーナスは欄を赤くし、その欄に移動して保存を止める', async () => {
    render(<VisitStampsV8 />)
    await screen.findByDisplayValue('然 来店スタンプカード')
    const input = screen.getByRole('spinbutton', { name: 'カードを受け取った時のボーナス' })
    fireEvent.change(input, { target: { value: '51' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '受け取りボーナスは0〜50個です。')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(fx.save).not.toHaveBeenCalled()
    expect(notifyToast).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalledOnce())
  })
  it('説明・受け取りボーナス・間隔を見本と保存に反映する', async () => {
    render(<VisitStampsV8 />)
    await screen.findByDisplayValue('然 来店スタンプカード')
    fireEvent.change(screen.getByRole('textbox', { name: '使い方の説明' }), { target: { value: 'お店で1 個\n特典があります' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'カードを受け取った時のボーナス' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('radio', { name: /同じ日は1回/ }))
    expect(screen.getByLabelText('お客さまの見え方').textContent).toContain('お店で1 個')
    expect(screen.getByLabelText('お客さまの見え方').textContent).toContain('3 / 10')
    expect(screen.getByLabelText('お客さまの見え方').textContent).toContain('有効期限')
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalledWith('card-1', expect.objectContaining({ settings: expect.objectContaining({ instructions: 'お店で1 個\n特典があります', receiptBonus: 2, stampInterval: { mode: 'same_day' } }) })))
  })
  it('画像は既存のアップロードを使い、3MBを越える画像は預けない', async () => {
    render(<VisitStampsV8 />)
    await screen.findByDisplayValue('然 来店スタンプカード')
    const input = screen.getByLabelText('背景画像を追加（ファイル）')
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })] } })
    expect(fx.uploadImage).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { files: [new File(['image'], 'card.png', { type: 'image/png' })] } })
    await screen.findByAltText('背景画像')
    expect(fx.uploadImage).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalledWith('card-1', expect.objectContaining({ settings: expect.objectContaining({ backgroundImageUrl: 'https://example.test/images/card.png' }) })))
  })
  it('カードの名前を変えて［保存する］で版を付けて保存する', async () => {
    render(<VisitStampsV8 />)
    const name = await screen.findByDisplayValue('然 来店スタンプカード')
    fireEvent.change(name, { target: { value: '新しいカード' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalledWith('card-1', expect.objectContaining({ name: '新しいカード', expectedVersion: 3, accountIds: ['acc-1'] })))
  })

  it('紙のカードの申請を承認すると、その申請を承認で送る', async () => {
    render(<VisitStampsV8 />)
    await screen.findByRole('tab', { name: /紙のカードの移行/ })
    fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    fireEvent.click(await screen.findByRole('button', { name: '見本 183さんの 7個を承認' }))
    await waitFor(() => expect(fx.reviewPaper).toHaveBeenCalledWith('p1', 'approve', expect.any(String)))
  })

  it('URL の友だちで店の手入力をすると、同じ requestId のまま理由とメモを送る', async () => {
    window.history.replaceState(null, '', '/visit-stamps?friend=f1')
    render(<VisitStampsV8 />)
    await screen.findByRole('heading', { name: '店で手入力' })
    fireEvent.change(screen.getByPlaceholderText('例：レシートを確認済み'), { target: { value: 'レシートあり' } })
    fireEvent.click(screen.getByRole('button', { name: '1個ふやす' }))
    fireEvent.click(screen.getByRole('button', { name: '押印を足す' }))
    await waitFor(() => expect(fx.grant).toHaveBeenCalledWith('card-1', expect.objectContaining({ friendId: 'f1', count: 2, reason: '紙のカードから移す：レシートあり', source: 'paper' })))
  })

  it('担当者（staff）は承認と手入力ができ、カードの保存・暗証番号は出さない', async () => {
    fx.role = verifiedStaffRole('staff')
    render(<VisitStampsV8 />)
    await screen.findByRole('tab', { name: /紙のカードの移行/ })
    fireEvent.click(screen.getByRole('tab', { name: /紙のカードの移行/ }))
    expect(await screen.findByRole('button', { name: '見本 183さんの 7個を承認' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByRole('button', { name: /店員の暗証番号/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /特典を足す/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    expect(await screen.findByRole('button', { name: '押印を足す' })).toBeTruthy()
  })

  it('閲覧のみには変える操作を置かない', async () => {
    fx.role = verifiedStaffRole('viewer')
    render(<VisitStampsV8 />)
    await screen.findByDisplayValue('然 来店スタンプカード')
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByRole('button', { name: /承認/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '却下' })).toBeNull()
    expect(screen.queryByRole('button', { name: '押印を足す' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ファイルを選ぶ' })).toBeNull()
    expect(screen.queryByRole('button', { name: /色を選ぶ/ })).toBeNull()
    expect((screen.getByRole('textbox', { name: '使い方の説明' }) as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('④ は店全体の記録（口の entries）。友だちを選ばなくても、誰に・何個・誰がを新しい順に出す', async () => {
    fx.friendsGet.mockImplementation(async (id: string) => ({ success: true, data: { id, displayName: id === 'f2' ? 'あや' : 'みさき' } }))
    render(<VisitStampsV8 />)
    await screen.findByRole('tab', { name: '押した・使った記録' })
    fireEvent.click(screen.getByRole('tab', { name: '押した・使った記録' }))
    await waitFor(() => expect(fx.entries).toHaveBeenCalledWith({ accountId: 'acc-1', page: 1, pageSize: 20 }))
    expect(await screen.findByText('−10 個（特典）')).toBeTruthy()
    expect(screen.getByText('店員：田村（暗証番号）')).toBeTruthy()
    expect(await screen.findByText('あや')).toBeTruthy()
  })

  it('倍率のスイッチは止めるだけ（消さない）。重ねる順番と重ねたときの上限を別々に保存する', async () => {
    fx.cards.mockResolvedValue({ success: true, data: [{ ...card, settings: { ...card.settings, multipliers: [{ name: '火曜の2倍デー', multiplier: 2, weekdays: [2] }] } }] })
    render(<VisitStampsV8 />)
    expect(await screen.findByText('火曜の2倍デー')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: '火曜の2倍デーを使う' }))
    expect(screen.getByText(/止めています/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重ねたときの順番' }))
    fireEvent.click(await screen.findByRole('button', { name: '倍率のあとで初回ボーナス' }))
    fireEvent.click(screen.getByRole('button', { name: '重ねたときの上限' }))
    fireEvent.click(await screen.findByRole('button', { name: '1回 8 個まで' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fx.save).toHaveBeenCalled())
    const body = fx.save.mock.calls[0][1]
    expect(body.settings.multipliers).toEqual([expect.objectContaining({ name: '火曜の2倍デー', active: false, multiplier: 2 })])
    expect(body.settings).toMatchObject({ stackingOrder: 'multipliers_then_bonus', maxStackedStamps: 8, maxPerVisit: 3 })
  })

  it('紙のカードの写真は非公開の置き場から、担当店舗の権限で読む', async () => {
    fx.paperRequests.mockResolvedValue({ success: true, data: [{ id: 'p1', friend_id: 'f1', photo_url: 'https://api.example/api/liff/visit-stamps/paper-photos/ph-9', stamps: 7, status: 'pending', created_at: '2026-01-12 11:14:00' }] })
    render(<VisitStampsV8 />)
    fireEvent.click(await screen.findByRole('tab', { name: /紙のカードの移行/ }))
    await waitFor(() => expect(fx.paperPhoto).toHaveBeenCalledWith('acc-1', 'ph-9'))
  })
})

it('変更していない設定は保存しない理由を出し、変更後に外す', async () => {
 render(<VisitStampsV8 />)
 await screen.findByDisplayValue(card.name)
 expect(screen.getByRole('button',{name:'保存する'}).getAttribute('aria-description')).toBe('変更していません')
 fireEvent.change(screen.getByDisplayValue(card.name), {target:{value:'新しいカード名'}})
 const save = screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement
 expect(save.disabled).toBe(false); expect(save.hasAttribute('aria-description')).toBe(false)
})

// 109: 承認は主（右）、却下は赤い文字だけ。並びは［却下］［承認］。
it('紙のカードの移行は［却下］［承認］の並びで承認が主', async () => {
  render(<VisitStampsV8 />)
  fireEvent.click(await screen.findByRole('tab', { name: /紙のカードの移行/ }))
  const approve = await screen.findByRole('button', { name: /さんの .*個を承認/ })
  const reject = screen.getByRole('button', { name: '却下' })
  expect(reject.getAttribute('data-variant')).toBe('text')
  expect(approve.getAttribute('data-variant')).toBe('primary')
  expect(Boolean(reject.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
})

it('B24: 開いた直後もキャンセルは押せる（保存中・画像登録中だけ押せない）', async () => {
 render(<VisitStampsV8 />)
 await screen.findByDisplayValue(card.name)
 const cancel = screen.getByRole('button',{name:'キャンセル'}) as HTMLButtonElement
 expect(cancel.disabled).toBe(false)
 expect(cancel.hasAttribute('aria-description')).toBe(false)
})

afterEach(() => { verifiedStaffRole(null) })

it('紙の申請却下に対象の友だち・アカウント・環境を出す', async () => {
  fx.paperRequests.mockResolvedValue({ success: true, data: [{ id: 'p1', friend_id: 'f1', line_account_id: 'acc-1', photo_url: '', stamps: 7, status: 'pending' }] })
  window.history.replaceState(null, '', '/visit-stamps?tab=paper')
  render(<VisitStampsV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '却下' }))
  const dialog = await screen.findByRole('alertdialog', { name: '申請を却下する' })
  expect(dialog.textContent).toContain('銀座店')
  expect(dialog.textContent).toContain('みさき')
  expect(dialog.textContent).toContain('環境')
})

it('記録取消の確認中にアカウントを変えたら古い取消を送らない', async () => {
  window.history.replaceState(null, '', '/visit-stamps?tab=history')
  const view = render(<VisitStampsV8 />)
  fireEvent.click((await screen.findAllByRole('button', { name: /記録のその他操作/ }))[0])
  fireEvent.click(await screen.findByRole('menuitem', { name: 'この記録を取り消す' }))
  const dialog = await screen.findByRole('alertdialog', { name: '記録を取り消す' })
  fireEvent.change(within(dialog).getByLabelText('理由'), { target: { value: '記録の誤り' } })
  fx.accountId = 'acc-2'; view.rerender(<VisitStampsV8 />)
  const old = screen.queryByRole('alertdialog', { name: '記録を取り消す' })
  if (old) fireEvent.click(within(old).getByRole('button', { name: '取り消す' }))
  expect(fx.reverse).not.toHaveBeenCalled()
})
