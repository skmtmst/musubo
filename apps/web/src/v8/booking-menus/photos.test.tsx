// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookingPhotoCatalog, MediaItem } from '@line-crm/shared'

const net = vi.hoisted(() => ({ list: vi.fn(), saveMenu: vi.fn(), saveStaff: vi.fn(), saveStore: vi.fn(), media: vi.fn(), saved: vi.fn() }))
vi.mock('@/lib/api-booking-photos', () => ({ bookingPhotosApi: net }))
vi.mock('@/lib/api', () => ({ api: { media: { list: net.media, contentUrl: (id: string, a: string) => `/api/media/${id}/content?accountId=${a}` } } }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: net.saved }))
const { default: Photos } = await import('./photos')
const { V8TabEditContext } = await import('./tabs/shared')

const photo = (id: string) => ({ mediaId: id, url: `https://worker.test/media/${id}/content` })
function catalog(): BookingPhotoCatalog {
  return { menus: [{ id: 'm', name: 'カット', version: 4, photo: photo('old') }], staff: [{ id: 's', name: '山田', version: 2, photo: null }],
    store: { id: 'bs', version: 3, photos: { exterior: photo('old'), interior: photo('inside'), waiting: null }, order: ['exterior', 'interior', 'waiting'] } }
}
const candidate = (id: string, lineAccountId: string | null = 'a'): MediaItem => ({
  id, lineAccountId, filename: `候補${id}.png`, kind: 'image', folderId: null, mimeType: 'image/png', sizeBytes: 10, width: 30, height: 30,
  durationMs: null, url: `https://worker.test/media/${id}/content`, uploadedBy: null, createdAt: '2026-10-19',
})
beforeEach(() => {
  vi.clearAllMocks()
  const nativeRect = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const section = this.closest('[aria-label="お店の写真"]')
    const card = this.closest('[data-design-part="card"]')
    if (!section || !card) return nativeRect.call(this)
    const cards = [...section.querySelectorAll('[data-design-part="card"]')]
    return new DOMRect(cards.indexOf(card) * 300, 100, 280, 400)
  })
  net.list.mockResolvedValue({ success: true, data: catalog() })
  net.media.mockResolvedValue({ success: true, data: { items: [candidate('new'), candidate('shared', null), candidate('foreign', 'b')], total: 3 } })
  for (const save of [net.saveMenu, net.saveStaff, net.saveStore]) save.mockResolvedValue({ success: true, data: { version: 5 } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function show(permissions = { canEditMenus: true, canEditSettings: true }, accountId = 'a', register = vi.fn()) {
  return render(<V8TabEditContext.Provider value={register}><Photos key={accountId} accountId={accountId} {...permissions} /></V8TabEditContext.Provider>)
}
function storeCards() {
  return within(screen.getByRole('region', { name: 'お店の写真', exact: true })).getAllByRole('region')
}
function orderLabels() { return storeCards().map(card => card.getAttribute('aria-label')) }
async function liftPhoto(name: string) {
  const handle = await screen.findByRole('button', { name: `${name}の写真を並べ替え`, exact: true })
  handle.focus()
  fireEvent.keyDown(handle, { key: ' ', code: 'Space' })
  await waitFor(() => expect(handle.getAttribute('aria-pressed')).toBe('true'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return handle
}
async function movePhoto(name: string, key: 'ArrowLeft' | 'ArrowRight', destination: string, finish = 'Space') {
  const handle = await liftPhoto(name)
  fireEvent.keyDown(document, { key, code: key })
  await waitFor(() => expect(document.body.textContent).toContain(`${name}の写真を${orderLabels().indexOf(`${destination}の写真`) + 1}番目へ移動します。`))
  fireEvent.keyDown(document, { key: finish === 'Space' ? ' ' : finish, code: finish })
  await waitFor(() => expect(handle.getAttribute('aria-pressed')).not.toBe('true'))
}

async function pick(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name}の写真を選択する` }))
  fireEvent.click(await screen.findByRole('option', { name: /候補new/ }))
}

describe('BA-19 予約写真の編集', () => {
  it('同店メディアだけを選び、版付き保存・差替え・解除を行う', async () => {
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'カットの写真を選択する' }))
    await screen.findByRole('option', { name: /候補new/ })
    expect(screen.queryByRole('option', { name: /候補shared|候補foreign/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /候補new/ }))
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    await waitFor(() => expect(net.saveMenu).toHaveBeenCalledWith('a', 'm', { expectedVersion: 4, mediaId: 'new' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'カットの写真を保存する' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を外す' }))
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    await waitFor(() => expect(net.saveMenu).toHaveBeenLastCalledWith('a', 'm', { expectedVersion: 5, mediaId: null }))
    expect(net.saved).toHaveBeenCalled()
  })
  it('店の写真は3枠のまま順と解除を一緒に保存する', async () => {
    show()
    await movePhoto('外観', 'ArrowRight', '店内')
    const section = screen.getByRole('region', { name: 'お店の写真' })
    expect(within(section).getAllByRole('region').map(el => el.getAttribute('aria-label'))).toEqual(['店内の写真', '外観の写真', '待合の写真'])
    fireEvent.click(screen.getByRole('button', { name: '外観の写真を外す' }))
    fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
    await waitFor(() => expect(net.saveStore).toHaveBeenCalledWith('a', { expectedVersion: 3, order: ['interior', 'exterior', 'waiting'], visibility: { exterior: false, interior: false, waiting: false }, photos: { exterior: null, interior: 'inside', waiting: null } }))
  })
  it('スタッフの写真も専用の版で保存する', async () => {
    show()
    await pick('山田')
    fireEvent.click(screen.getByRole('button', { name: '山田の写真を保存する' }))
    await waitFor(() => expect(net.saveStaff).toHaveBeenCalledWith('a', 's', { expectedVersion: 2, mediaId: 'new' }))
  })
  it('保存の二重クリックを1回にし、503でも選択を残して再試行できる', async () => {
    let fail!: (error: unknown) => void
    net.saveMenu.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    show()
    await pick('カット')
    const save = screen.getByRole('button', { name: 'カットの写真を保存する' })
    fireEvent.click(save); fireEvent.click(save)
    expect(net.saveMenu).toHaveBeenCalledTimes(1)
    await act(async () => fail({ status: 503 }))
    expect((await screen.findByRole('alert')).textContent).toContain('入力は残しています')
    expect(net.saved).not.toHaveBeenCalled()
    const card = screen.getByRole('region', { name: 'カットの写真' })
    expect(within(card).getByRole('img').getAttribute('src')).toContain('/new/')
    fireEvent.click(save)
    await waitFor(() => expect(net.saveMenu).toHaveBeenCalledTimes(2))
  })
  it('409の後は入力を残し、最新の版を読み直してから明示保存する', async () => {
    net.saveMenu.mockRejectedValueOnce({ status: 409 })
    const latest = catalog(); latest.menus[0]!.version = 8
    net.list.mockResolvedValueOnce({ success: true, data: catalog() }).mockResolvedValueOnce({ success: true, data: latest })
    show()
    await pick('カット')
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('ほかの人が更新しました')
    expect((screen.getByRole('button', { name: 'カットの写真を保存する' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '入力を残して読み直す' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'カットの写真を保存する' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    await waitFor(() => expect(net.saveMenu).toHaveBeenLastCalledWith('a', 'm', { expectedVersion: 8, mediaId: 'new' }))
  })
  it('閲覧のみには選択・解除・順変更・保存を出さず、メニューだけの鍵も分ける', async () => {
    const view = show({ canEditMenus: false, canEditSettings: false })
    await screen.findByRole('region', { name: 'カットの写真' })
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    view.rerender(<Photos accountId="a" canEditMenus canEditSettings={false} />)
    expect(await screen.findByRole('button', { name: 'カットの写真を選択する' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '山田の写真を選択する' })).toBeNull()
    expect(screen.queryByRole('button', { name: '外観の写真を並べ替え' })).toBeNull()
    expect(storeCards().map(card => card.querySelector('[data-photo-position]')?.textContent)).toEqual(['1', '2', '3'])
  })
  it('読込失敗は空状態にせず読み直せる', async () => {
    net.list.mockRejectedValueOnce(new Error('offline'))
    show()
    expect(await screen.findByText('写真を読み込めませんでした')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /もう一度|読み直す/ }))
    expect(await screen.findByRole('button', { name: 'カットの写真を選択する' })).toBeTruthy()
  })
  it('写真の入力エラーは保存したメニューの欄へ出し、選び直すと消す', async () => {
    net.saveMenu.mockRejectedValueOnce({ status: 400, fields: { mediaId: 'この写真は退避されています' } })
    show()
    await pick('カット')
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    const card = screen.getByRole('region', { name: 'カットの写真' })
    expect(await within(card).findByText('この写真は退避されています')).toBeTruthy()
    expect(net.saved).not.toHaveBeenCalled()
    expect(within(card).getByRole('group').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('region', { name: '外観の写真' }).querySelector('[aria-invalid="true"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を外す' }))
    expect(within(card).queryByText('この写真は退避されています')).toBeNull()
    expect(within(card).getByRole('group').getAttribute('aria-invalid')).toBeNull()
  })
  it('店の欄名を該当する写真へ結び、写真を直すまで入力を残す', async () => {
    net.saveStore.mockRejectedValueOnce({ status: 422, fields: { 'photos.interior': '店内の写真を選び直してください' } })
    show()
    await movePhoto('外観', 'ArrowRight', '店内')
    fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
    const inside = screen.getByRole('region', { name: '店内の写真' })
    expect(await within(inside).findByText('店内の写真を選び直してください')).toBeTruthy()
    expect(within(inside).getByRole('group').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('region', { name: '外観の写真' }).querySelector('[aria-invalid="true"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'お店の写真を保存する' })).toBeTruthy()
  })
  it('欄名のない写真検査エラーも対象へ返し、再保存の成功で消す', async () => {
    net.saveStaff.mockRejectedValueOnce({ status: 400 })
    show()
    await pick('山田')
    fireEvent.click(screen.getByRole('button', { name: '山田の写真を保存する' }))
    const card = screen.getByRole('region', { name: '山田の写真' })
    expect(await within(card).findByText('写真の選び方を確かめて、もう一度保存してください。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '山田の写真を保存する' }))
    await waitFor(() => expect(within(card).queryByText('写真の選び方を確かめて、もう一度保存してください。')).toBeNull())
    await waitFor(() => expect(screen.queryByRole('button', { name: '山田の写真を保存する' })).toBeNull())
  })
  it('書きかけを既存の離脱確認へ渡す', async () => {
    const register = vi.fn()
    show(undefined, 'a', register)
    await pick('カット')
    await waitFor(() => expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true, subject: '写真の変更' })))
  })
  it('アカウントを切り替えた後の古い読込を反映しない', async () => {
    let finish!: (value: unknown) => void
    net.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const next = catalog(); next.menus[0]!.name = 'B店の相談'
    net.list.mockResolvedValueOnce({ success: true, data: next })
    const view = show()
    view.rerender(<Photos key="b" accountId="b" canEditMenus canEditSettings />)
    await screen.findByRole('button', { name: 'B店の相談の写真を選択する' })
    await act(async () => finish({ success: true, data: catalog() }))
    expect(screen.queryByRole('button', { name: 'カットの写真を選択する' })).toBeNull()
    expect(screen.getByRole('button', { name: 'B店の相談の写真を選択する' })).toBeTruthy()
  })
  it('切替前の保存の返事で、新しいアカウントの写真や保存通知を変えない', async () => {
    let finish!: (value: unknown) => void
    net.saveMenu.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = show()
    await pick('カット')
    fireEvent.click(screen.getByRole('button', { name: 'カットの写真を保存する' }))
    const next = catalog(); next.menus[0]!.name = 'B店の相談'
    net.list.mockResolvedValueOnce({ success: true, data: next })
    view.rerender(<Photos key="b" accountId="b" canEditMenus canEditSettings />)
    await screen.findByRole('button', { name: 'B店の相談の写真を選択する' })
    await act(async () => finish({ success: true, data: { version: 99 } }))
    expect(screen.getByRole('region', { name: 'B店の相談の写真' }).querySelector('img')?.getAttribute('src')).toContain('/old/')
    expect(net.saved).not.toHaveBeenCalled()
  })
  it('公開の選択だけでも書きかけになり、写真・順・版と一緒に保存して読み直せる', async () => {
    const register = vi.fn()
    const view = show(undefined, 'a', register)
    const exterior = await screen.findByRole('checkbox', { name: '外観をお客さまの予約画面に出す' })
    expect((exterior as HTMLInputElement).checked).toBe(false)
    fireEvent.click(exterior)
    await waitFor(() => expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })))
    fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
    const visibility = { exterior: true, interior: false, waiting: false }
    await waitFor(() => expect(net.saveStore).toHaveBeenCalledWith('a', { expectedVersion: 3, order: ['exterior', 'interior', 'waiting'], photos: { exterior: 'old', interior: 'inside', waiting: null }, visibility }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'お店の写真を保存する' })).toBeNull())
    expect((exterior as HTMLInputElement).checked).toBe(true)
    view.unmount()
    const latest = catalog(); latest.store!.visibility = visibility; latest.store!.version = 5
    net.list.mockResolvedValue({ success: true, data: latest })
    show()
    expect((await screen.findByRole('checkbox', { name: '外観をお客さまの予約画面に出す' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: '店内をお客さまの予約画面に出す' }) as HTMLInputElement).checked).toBe(false)
  })
  it.each([503, 409])('公開設定の保存が%sでも選択を残し、読み直しで他人の変更を保って再保存する', async status => {
    net.saveStore.mockRejectedValueOnce({ status })
    const latest = catalog(); latest.store!.version = 8; latest.store!.visibility = { exterior: false, interior: true, waiting: false }
    net.list.mockResolvedValueOnce({ success: true, data: catalog() }).mockResolvedValueOnce({ success: true, data: latest })
    show()
    fireEvent.click(await screen.findByRole('checkbox', { name: '外観をお客さまの予約画面に出す' }))
    fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
    await screen.findByRole('alert')
    expect((screen.getByRole('checkbox', { name: '外観をお客さまの予約画面に出す' }) as HTMLInputElement).checked).toBe(true)
    expect(net.saved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '入力を残して読み直す' }))
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '店内をお客さまの予約画面に出す' }) as HTMLInputElement).checked).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
    await waitFor(() => expect(net.saveStore).toHaveBeenLastCalledWith('a', expect.objectContaining({ expectedVersion: 8, visibility: { exterior: true, interior: true, waiting: false } })))
  })
  it('閲覧のみは公開の切り替えも隠し、空の写真の操作枠はほかのカードとそろえる', async () => {
    const view = show({ canEditMenus: false, canEditSettings: false })
    await screen.findByRole('region', { name: 'お店の写真' })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    view.unmount()
    show()
    const waiting = await screen.findByRole('region', { name: '待合の写真' })
    expect((within(waiting).getByRole('button', { name: '待合の写真を外す' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('閲覧のみでも写真ごとの公開設定を読め、操作や保存はできない', async () => {
    const latest = catalog()
    latest.store!.visibility = { exterior: true, interior: false, waiting: false }
    net.list.mockResolvedValue({ success: true, data: latest })
    show({ canEditMenus: false, canEditSettings: false })
    for (const [name, label] of [['外観', '出す'], ['店内', '出さない'], ['待合', '出さない']]) {
      const card = await screen.findByRole('region', { name: `${name}の写真` })
      expect(within(card).getByText(`お客さまの予約画面に${label}`)).toBeTruthy()
      expect(within(card).queryAllByRole('button')).toHaveLength(0)
      expect(within(card).queryAllByRole('checkbox')).toHaveLength(0)
    }
    expect(net.saveStore).not.toHaveBeenCalled()
  })

});

it('店舗の順序を番号と共通つまみで示し、選択と外すの2操作と写真無しの理由を保つ', async () => {
  show()
  const waiting = await screen.findByRole('region', { name: '待合の写真', exact: true })
  expect(storeCards().map(card => card.querySelector('[data-photo-position]')?.textContent)).toEqual(['1', '2', '3'])
  for (const card of storeCards()) {
    expect(card.querySelector('[data-reorder-handle]')).not.toBeNull()
    expect(within(card).getAllByRole('button')).toHaveLength(3)
  }
  expect(screen.queryByRole('button', { name: /を前へ|を後へ/ })).toBeNull()
  expect(screen.queryByText('これが先頭の写真です。')).toBeNull()
  expect(screen.queryByText('これが最後の写真です。')).toBeNull()
  expect(within(waiting).getByText('写真はありません。')).toBeTruthy()
  expect((within(waiting).getByRole('button', { name: '待合の写真を外す', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  expect(within(waiting).getAllByRole('group')).toHaveLength(1)
  expect(screen.getByRole('region', { name: 'カットの写真' }).querySelector('[data-photo-position]')).toBeNull()
  expect(net.saveStore).not.toHaveBeenCalled()
})

it('キーボードのEscで並替を取消し、drop後の番号と書きかけは既存取消口で元に戻る', async () => {
  const register = vi.fn()
  show(undefined, 'a', register)
  await movePhoto('外観', 'ArrowRight', '店内', 'Escape')
  expect(orderLabels()).toEqual(['外観の写真', '店内の写真', '待合の写真'])
  expect(screen.queryByRole('button', { name: 'お店の写真を保存する' })).toBeNull()
  await movePhoto('外観', 'ArrowRight', '店内')
  expect(orderLabels()).toEqual(['店内の写真', '外観の写真', '待合の写真'])
  expect(storeCards().map(card => card.querySelector('[data-photo-position]')?.textContent)).toEqual(['1', '2', '3'])
  expect(net.saveStore).not.toHaveBeenCalled()
  await waitFor(() => expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })))
  await act(async () => register.mock.calls.at(-1)![0].onReset())
  expect(orderLabels()).toEqual(['外観の写真', '店内の写真', '待合の写真'])
  expect(screen.queryByRole('button', { name: 'お店の写真を保存する' })).toBeNull()
})

it('順変更の競合時は下書きを残し、再取得した版でだけ明示保存する', async () => {
  net.saveStore.mockRejectedValueOnce({ status: 409 })
  const latest = catalog(); latest.store!.version = 8
  net.list.mockResolvedValueOnce({ success: true, data: catalog() }).mockResolvedValueOnce({ success: true, data: latest })
  show()
  await movePhoto('外観', 'ArrowRight', '店内')
  fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
  await screen.findByRole('alert')
  expect(orderLabels()).toEqual(['店内の写真', '外観の写真', '待合の写真'])
  expect(screen.queryByRole('button', { name: '外観の写真を並べ替え' })).toBeNull()
  expect((screen.getByRole('button', { name: 'お店の写真を保存する' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '入力を残して読み直す' }))
  await screen.findByRole('button', { name: '外観の写真を並べ替え' })
  fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
  await waitFor(() => expect(net.saveStore).toHaveBeenLastCalledWith('a', expect.objectContaining({ expectedVersion: 8, order: ['interior', 'exterior', 'waiting'] })))
})

it('保存中は並替を隠して番号を保持し、遅い保存が新アカウントへ届かない', async () => {
  let finish!: (value: unknown) => void
  net.saveStore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = show()
  await movePhoto('外観', 'ArrowRight', '店内')
  fireEvent.click(screen.getByRole('button', { name: 'お店の写真を保存する' }))
  expect(screen.queryByRole('button', { name: '外観の写真を並べ替え' })).toBeNull()
  expect(storeCards().map(card => card.querySelector('[data-photo-position]')?.textContent)).toEqual(['1', '2', '3'])
  view.rerender(<Photos key="b" accountId="b" canEditMenus canEditSettings />)
  await screen.findByRole('button', { name: '外観の写真を並べ替え' })
  await act(async () => finish({ success: true, data: { version: 99 } }))
  expect(orderLabels()).toEqual(['外観の写真', '店内の写真', '待合の写真'])
  expect(screen.queryByRole('button', { name: 'お店の写真を保存する' })).toBeNull()
  expect(net.saved).not.toHaveBeenCalled()
})

it('持ち上げ中のアカウント切替では旧dragを取消し、新店の順や書きかけを変えない', async () => {
  const view = show()
  await liftPhoto('外観')
  view.rerender(<Photos key="b" accountId="b" canEditMenus canEditSettings />)
  await screen.findByRole('button', { name: '外観の写真を並べ替え' })
  fireEvent.keyDown(document, { key: 'ArrowRight', code: 'ArrowRight' })
  fireEvent.keyDown(document, { key: ' ', code: 'Space' })
  expect(orderLabels()).toEqual(['外観の写真', '店内の写真', '待合の写真'])
  expect(screen.queryByRole('button', { name: 'お店の写真を保存する' })).toBeNull()
  expect(net.saveStore).not.toHaveBeenCalled()
})
