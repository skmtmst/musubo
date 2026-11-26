// @vitest-environment happy-dom
/*
 * 受信箱A-2 右の欄でその場で直す：本物の右の欄（FriendInfoSidebar）を描き、口（api）だけを差し替える。
 * 対応状況・担当・タグを外す・メモの競合・購入の宛先・閲覧のみは inbox-panel-inline-edit-react.test.tsx が見る。
 * ここはその残り：
 * - タグは選ぶ窓で付け、窓で作ったタグも付ける（1つずつ送る）
 * - メモは書くのをやめて1秒たってから1回だけ保存する
 * - 友だち情報は押すとその場で書き換えて保存する
 * - 購入は直近3件と、その合計
 * - キーボード T・M・S（書く欄の中では効かない）
 * - 前払いのみの印へ、アカウント・相手・解除できるかを渡す
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async original => ({ ...await original<typeof import('next/navigation')>(), useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))

const mocks = vi.hoisted(() => ({
  role: 'owner',
  metadata: {} as Record<string, unknown>,
  tags: [] as Array<{ id: string; name: string; color: string }>,
  update: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  orders: vi.fn(),
  updateMetadata: vi.fn(),
  createTag: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  return {
    ...actual,
    api: {
      staff: { me: async () => ({ success: true, data: { role: mocks.role, permissionViewKeys: ['/chats', '/friends'] } }) },
      friends: {
        get: (id: string) => ok({
          id, originalId: id, displayName: 'Kyohei Yamamoto', pictureUrl: null, isFollowing: true, metadata: mocks.metadata,
          realName: '山本 恭平', systemDisplayName: null, refCode: null, firstTrackedLinkName: null,
          createdAt: '2025-08-13T15:00:00.000Z', formSubmissions: [], formSubmissionTotal: 0,
          tags: [{ id: 'tag-a', name: '未契約', color: '#8B938D' }],
        }),
        mileage: () => ok({ summary: { programName: 'm', available: 0, pending: 0 }, history: [] }),
        richMenu: () => ok({ id: null, name: null, isDefault: true }),
        upcoming: () => ok({ nextBooking: null, nextAutoDelivery: null }),
        addTag: mocks.addTag,
        removeTag: mocks.removeTag,
        updateMetadata: mocks.updateMetadata,
      },
      friendFields: { forFriend: () => ok({ items: [] }) },
      tags: { list: () => ok(mocks.tags), create: mocks.createTag },
      tagGroups: { list: () => ok([]) },
      ecCommerce: { orders: mocks.orders },
      chats: { update: mocks.update, get: vi.fn() },
    },
  }
})
/* 前払いのみの印は予約の部品（v8/booking）が持つ。ここでは渡した値だけを見る。 */
vi.mock('@/v8/booking/prepay-badge', () => ({
  default: ({ accountId, friendId, canEdit }: { accountId: string; friendId: string; canEdit: boolean }) =>
    React.createElement('span', { 'data-testid': 'prepay', 'data-account': accountId, 'data-friend': friendId, 'data-can-edit': String(canEdit) }),
}))
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string; id?: string; value: string; onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement('select', { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
}))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))

import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import FriendInfoSidebar from './friend-info-sidebar'
import CommandPalette from '@/components/shared/command-palette'

let host: HTMLDivElement
let root: Root

async function eventually(check: () => void, tries = 60) {
  let last: unknown
  for (let i = 0; i < tries; i += 1) {
    try { check(); return } catch (error) { last = error }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  }
  throw last
}
const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const memoArea = () => document.getElementById('inbox-panel-memo') as HTMLTextAreaElement | null
const tagPicker = () => document.getElementById('inbox-panel-tag-picker')!

async function renderPanel(accountId: string | undefined = 'account-a', withPalette = false) {
  await act(async () => {
    root.render(
      <>
        <FriendInfoSidebar
          friendId="friend-0"
          chatId="friend-0"
          accountId={accountId}
          revision={3}
          chatStatus={{ status: 'unread', notes: '前のメモ' }}
          operators={[{ id: 'op-k', name: 'Kenta' }]}
          operatorId="op-k"
        />
        <ToastHost />
        {withPalette ? <CommandPalette items={[{ href: '/friends', label: '友だち' }]} /> : null}
      </>,
    )
  })
  await eventually(() => { expect(host.querySelector('[data-customer-info-panel] section[aria-label="対応"]')).toBeTruthy() })
}

async function typeMemo(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(memoArea()!, text)
    memoArea()!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string, target: EventTarget = document) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
  // 移す先へのフォーカスは次の描画の枠で行う。
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })
}

beforeEach(() => {
  mocks.role = 'owner'
  mocks.metadata = {}
  mocks.tags = [{ id: 'tag-b', name: 'VIP', color: '#8B938D' }]
  clearToastsForTest()
  for (const mock of [mocks.update, mocks.addTag, mocks.removeTag, mocks.orders, mocks.updateMetadata, mocks.createTag]) mock.mockReset()
  mocks.orders.mockResolvedValue({ success: true, data: { items: [] } })
  mocks.update.mockResolvedValue({ success: true, data: { revision: 4 } })
  mocks.addTag.mockResolvedValue({ success: true, data: null })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  window.localStorage.setItem('lh_staff_role', 'owner')
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  clearToastsForTest()
  window.localStorage.removeItem('lh_staff_role')
  window.localStorage.removeItem('lh_staff_view_permissions')
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('受信箱A-2 右の欄でその場で直す', () => {
  it('タグは選ぶ窓で選んだ物だけを付け、今あるタグは送り直さない', async () => {
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    fireEvent.click(within(tagPicker()).getByRole('button', { name: /^タグを探して付ける/ }))
    const dialog = await screen.findByRole('dialog', { name: 'タグを選ぶ' })
    await eventually(() => { expect(within(dialog).getByRole('checkbox', { name: 'VIP' })).toBeTruthy() })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'VIP' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^選ぶ（\d+件）$/ }))
    await eventually(() => { expect(mocks.addTag).toHaveBeenCalledWith('friend-0', 'tag-b') })
    expect(mocks.addTag).toHaveBeenCalledTimes(1)
    expect(mocks.removeTag).not.toHaveBeenCalled()
  })

  it('選ぶ窓の「タグを作る」で作ったタグも、［選ぶ］で付ける', async () => {
    mocks.createTag.mockImplementation(async ({ name }: { name: string }) => {
      const created = { id: 'tag-new', name, color: '#8B938D' }
      mocks.tags = [...mocks.tags, created]
      return { success: true, data: created }
    })
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('section[aria-label="タグ"] button[aria-controls="inbox-panel-tag-picker"]')!.click() })
    fireEvent.click(within(tagPicker()).getByRole('button', { name: /^タグを探して付ける/ }))
    const dialog = await screen.findByRole('dialog', { name: 'タグを選ぶ' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'タグを作る' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '新しいタグの名前' }), { target: { value: '新規客' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '作る' })) })
    expect(mocks.createTag).toHaveBeenCalledExactlyOnceWith({ name: '新規客' })
    fireEvent.click(within(dialog).getByRole('button', { name: /^選ぶ（\d+件）$/ }))
    await eventually(() => { expect(mocks.addTag).toHaveBeenCalledWith('friend-0', 'tag-new') })
  })

  it('メモは書くのをやめて1秒たってから、最後の文だけを1回保存する', async () => {
    await renderPanel()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="メモを編集"]')!.click() })
    await typeMemo('書きかけ')
    await typeMemo('書き終わったメモ')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })
    expect(mocks.update).not.toHaveBeenCalled()
    await eventually(() => { expect(mocks.update).toHaveBeenCalledTimes(1) })
    expect(mocks.update).toHaveBeenCalledWith('friend-0', { notes: '書き終わったメモ', revision: 3 })
  })

  it('友だち情報は押すとその場で書き換え、Enter でその項目だけ保存する', async () => {
    mocks.metadata = { plan: 'ゴールド', _internal: '出さない' }
    mocks.updateMetadata.mockResolvedValue({ success: true, data: null })
    await renderPanel()
    await act(async () => { button('顧客情報をすべて表示')?.click() })
    await eventually(() => { expect(document.querySelector('button[aria-label="planを変更する"]')).toBeTruthy() })
    expect(document.querySelector('button[aria-label="_internalを変更する"]')).toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="planを変更する"]')!.click() })
    const input = document.querySelector<HTMLInputElement>('input[aria-label="plan"]')!
    fireEvent.change(input, { target: { value: 'プラチナ' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await eventually(() => { expect(mocks.updateMetadata).toHaveBeenCalledExactlyOnceWith('friend-0', { plan: 'プラチナ' }) })
  })

  it('購入は直近3件だけを並べ、その3件の合計を出す', async () => {
    mocks.orders.mockResolvedValue({ success: true, data: { items: [
      { id: 'o1', friendId: 'friend-0', orderNumber: '注文1', totalAmount: 1000, orderedAt: '2026-10-04T00:00:00Z' },
      { id: 'o2', friendId: 'friend-0', orderNumber: '注文2', totalAmount: 2000, orderedAt: '2026-10-03T00:00:00Z' },
      { id: 'o3', friendId: 'friend-0', orderNumber: '注文3', totalAmount: 3000, orderedAt: '2026-10-02T00:00:00Z' },
      { id: 'o4', friendId: 'friend-0', orderNumber: '注文4', totalAmount: 4000, orderedAt: '2026-10-01T00:00:00Z' },
    ] } })
    await renderPanel()
    await act(async () => { button('顧客情報をすべて表示')?.click() })
    await eventually(() => { expect(host.textContent).toContain('注文3') })
    expect(mocks.orders).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }))
    expect(host.textContent).not.toContain('注文4')
    expect(host.textContent).toContain('合計 6,000')
  })

  it('キーボード T でタグ、M でメモ、S で対応を開く。書く欄の中では効かない', async () => {
    await renderPanel()
    expect(tagPicker().hidden).toBe(true)
    expect(memoArea()).toBeNull()
    expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeNull()

    await press('m')
    await eventually(() => { expect(document.activeElement).toBe(memoArea()) })
    // メモ欄で字を打っても、ほかの欄は開かない。
    await press('t', memoArea()!)
    await press('s', memoArea()!)
    expect(tagPicker().hidden).toBe(true)
    expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeNull()

    memoArea()!.blur()
    await press('s')
    expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeTruthy()
    await press('t')
    expect(tagPicker().hidden).toBe(false)
  })

  it('⌘K の候補で S を押しても受信箱の対応状況を開かず、閉じると S が使える', async () => {
    await renderPanel('account-a', true)
    await act(async () => { fireEvent.keyDown(document, { key: 'k', metaKey: true }) })
    const option = screen.getByRole('option', { name: '友だち' })
    option.focus()
    await press('s', option)
    expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeNull()
    await press('Escape', option)
    await press('s')
    expect(document.querySelector('[aria-label="対応状況を変える"]')).toBeTruthy()
  })

  it('前払いのみの印へアカウントと相手を渡し、解除できるのは管理者だけ', async () => {
    await renderPanel()
    await eventually(() => { expect(screen.getByTestId('prepay')).toBeTruthy() })
    expect(screen.getByTestId('prepay').dataset).toMatchObject({ account: 'account-a', friend: 'friend-0', canEdit: 'true' })

    await act(async () => { root.unmount() })
    root = createRoot(host)
    mocks.role = 'staff'
    window.localStorage.setItem('lh_staff_role', 'staff')
    window.localStorage.setItem('lh_staff_view_permissions', '["/chats","/friends"]')
    await renderPanel()
    await eventually(() => { expect(screen.getByTestId('prepay').dataset.canEdit).toBe('false') })
  })

  it('アカウントが分からないときは前払いのみの印を出さない', async () => {
    await renderPanel('')
    expect(screen.queryByTestId('prepay')).toBeNull()
  })
})
