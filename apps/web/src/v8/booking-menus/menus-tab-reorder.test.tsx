// @vitest-environment happy-dom
/*
 * 予約メニュー一覧の並び替え（オーナー点検 2026-10-08）。
 *
 * 直す前: つまみと「つかめる」カーソルは出ていたが、ドラッグの処理が無く、
 * 上下キーと「…」の上へ／下へでしか動かせなかった。検索中も「…」の上へ／下へが出て、
 * 絞った並びの番号と全体の並びの番号がずれていた。
 *
 * 決まり： ドラッグ・上下キー・「…」の上へ／下へは同じ結果。検索中・閲覧のみは
 * つまみを出さず理由を言う。保存に失敗したら元の位置へ戻して理由を出す。
 */
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushListUrlState } from '@/components/shared/list-url-state'
import type { BookingMenu } from '@/lib/api'

const deleteMenu = vi.hoisted(() => vi.fn())
const updateMenu = vi.hoisted(() => vi.fn())
const reorderMenus = vi.hoisted(() => vi.fn())
const toasts = vi.hoisted(() => [] as string[])

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, bookingApi: { ...actual.bookingApi, updateMenu, reorderMenus, deleteMenu } }
})
vi.mock('@/components/shared/toast', () => ({ notifyToast: (message: string) => { toasts.push(message) }, notifySaved: (message: string) => { toasts.push(message) } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
}))
vi.mock('../menu-version-history', () => ({ default: () => null }))

import { MenusTabV8 } from './tabs/menus-tab'

type ServerMenu = { id: string; name: string; sort_order: number; version: number }
let server: ServerMenu[] = []
let failOnCall = 0
let calls = 0

function toMenu(row: ServerMenu): BookingMenu {
  return {
    id: row.id, name: row.name, sort_order: row.sort_order, version: row.version,
    duration_minutes: 30, is_active: 1, description: null, category_label: null,
    assigned_staff: [], booking_count_30_days: 0,
  } as unknown as BookingMenu
}

function Harness({ canEdit = true }: { canEdit?: boolean }) {
  const [menus, setMenus] = useState(() => server.map(toMenu))
  return (
    <MenusTabV8
      accountId="account-a"
      menus={menus}
      status="ready"
      error={null}
      menuCount={menus.length}
      canEdit={canEdit}
      onReload={() => setMenus(server.map(toMenu))}
      onOpenStaff={() => {}}
    />
  )
}

beforeEach(() => {
  flushListUrlState()
  window.history.replaceState(null, "", "/")
  server = [
    { id: 'a', name: 'カット', sort_order: 10, version: 1 },
    { id: 'b', name: 'カラー', sort_order: 20, version: 1 },
    { id: 'c', name: 'パーマ', sort_order: 30, version: 1 },
  ]
  failOnCall = 0
  calls = 0
  toasts.length = 0
  deleteMenu.mockReset()
  updateMenu.mockReset()
  reorderMenus.mockReset().mockImplementation(async (_account: string, body: { changes: Array<{ id: string; expectedVersion: number; sortOrder: number }> }) => {
    calls += 1
    if (failOnCall && calls === failOnCall) throw new Error('network')
    for (const change of body.changes) {
      if (server.find((row) => row.id === change.id)?.version !== change.expectedVersion) throw new Error('conflict')
    }
    for (const change of body.changes) {
      const row = server.find((row) => row.id === change.id)!
      row.sort_order = change.sortOrder; row.version += 1
    }
    return { ok: true, versions: server.map((row) => ({ id: row.id, version: row.version })) }
  })
})
afterEach(cleanup)

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

function shownNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-reorder-id]')].map((row) => row.dataset.reorderId ?? '')
}

function serverOrder(): string[] {
  return [...server].sort((x, y) => x.sort_order - y.sort_order).map((row) => row.id)
}

function handleOf(name: string) {
  return screen.getByRole('button', { name: `「${name}」を並び替える（ドラッグ・↑↓キー）` })
}

async function moveBy(how: 'drag' | 'key' | 'menu', container: HTMLElement) {
  if (how === 'key') {
    fireEvent.keyDown(handleOf('カット'), { key: 'ArrowDown' })
  } else if (how === 'menu') {
    fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^下へ/ }))
  } else {
    const target = container.querySelector<HTMLElement>('[data-reorder-id="b"]')!
    fireEvent.dragStart(handleOf('カット'))
    fireEvent.dragEnter(target)
    fireEvent.dragOver(target)
    fireEvent.drop(target)
  }
  await flush()
}

describe('予約メニューの並び替え', () => {
  it.each([true, false])('並びの案内は編集権限 %s に合う', (canEdit) => {
    render(<Harness canEdit={canEdit} />)
    expect(screen.getByText(/上から並んだ順に、お客さまの画面に出ます/)).toBeTruthy()
    expect(Boolean(screen.queryByText(/つまみで並べ替えます/))).toBe(canEdit)
  })
  it('ドラッグ・上下キー・「…」の下へは同じ結果になり、読み直しても残る', async () => {
    const results: string[][] = []
    for (const how of ['drag', 'key', 'menu'] as const) {
      cleanup()
      server.forEach((row, index) => { row.sort_order = (index + 1) * 10 })
      server.sort((x, y) => x.sort_order - y.sort_order)
      const { container } = render(<Harness />)
      expect(shownNames(container)).toEqual(['a', 'b', 'c'])
      await moveBy(how, container)
      expect(serverOrder(), how).toEqual(['b', 'a', 'c'])
      results.push(shownNames(container))
    }
    expect(results).toEqual([['b', 'a', 'c'], ['b', 'a', 'c'], ['b', 'a', 'c']])
  })

  it('ドラッグで2つ以上離れた位置へも動かせる', async () => {
    const { container } = render(<Harness />)
    const target = container.querySelector<HTMLElement>('[data-reorder-id="c"]')!
    fireEvent.dragStart(handleOf('カット'))
    fireEvent.dragEnter(target)
    fireEvent.dragOver(target)
    fireEvent.drop(target)
    await flush()
    expect(serverOrder()).toEqual(['b', 'c', 'a'])
    expect(shownNames(container)).toEqual(['b', 'c', 'a'])
  })

  it('検索中・閲覧のみはつまみを出さず、「…」にも上へ・下へを出さない', async () => {
    const { container, unmount } = render(<Harness />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'メニュー名で探す' }), { target: { value: 'カ' } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) })
    expect(container.querySelector('[data-reorder-handle]')).toBeNull()
    expect(container.querySelector('[data-reorder-disabled]')?.getAttribute('title')).toBe('検索を外すと動かせます')
    fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
    const labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)
    expect(labels.some((label) => label?.startsWith('上へ') || label?.startsWith('下へ'))).toBe(false)
    unmount()
    const viewer = render(<Harness canEdit={false} />)
    expect(viewer.container.querySelector('[data-reorder-handle]')).toBeNull()
    expect(viewer.container.querySelector('[data-reorder-disabled]')?.getAttribute('title')).toBe('閲覧のみのため並び替えできません')
  })

  it('一括保存が失敗したら、元の位置で理由を出す', async () => {
    failOnCall = 1
    const { container } = render(<Harness />)
    fireEvent.keyDown(handleOf('カット'), { key: 'ArrowDown' })
    await flush()
    expect(server.map((row) => [row.id, row.sort_order])).toEqual([['a', 10], ['b', 20], ['c', 30]])
    expect(shownNames(container)).toEqual(['a', 'b', 'c'])
    expect(toasts.at(-1)).toContain('予約メニューを保存できませんでした')
  })
})

describe('一括並べ替えの失敗（WEB052）', () => {
  it('個別更新へ戻らず、全件を元の順番で残す', async () => {
    reorderMenus.mockRejectedValueOnce(new Error('network'))
    const { container } = render(<Harness />)
    await moveBy('key', container)
    expect(updateMenu).not.toHaveBeenCalled()
    expect(serverOrder()).toEqual(['a', 'b', 'c'])
    expect(shownNames(container)).toEqual(['a', 'b', 'c'])
    expect(toasts.at(-1)).toContain('予約メニューを保存できませんでした')
  })
})

 it('WEB052：並び替えは変更分の版を添えて一括で確定する', async () => {
   const { container } = render(<Harness />)
   await moveBy('key', container)
   expect(updateMenu).not.toHaveBeenCalled()
   expect(reorderMenus).toHaveBeenCalledWith('account-a', expect.objectContaining({ changes: expect.arrayContaining([
     expect.objectContaining({ id: 'a', expectedVersion: 1 }),
     expect.objectContaining({ id: 'b', expectedVersion: 1 }),
   ]) }))
 })


it('予約メニューの削除は確認まで送らず、予約がある場合の理由を窓に残す', async () => {
  deleteMenu.mockRejectedValue(Object.assign(new Error('menu_has_bookings'), { status: 409 }))
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(deleteMenu).not.toHaveBeenCalled()
  const dialog = screen.getByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
  await flush()
  expect(deleteMenu).toHaveBeenCalledWith('account-a', 'a')
  expect(dialog.textContent).toContain('予約が付いているため削除できません')
  expect(server).toHaveLength(3)
})

it('予約メニュー削除の対象を示し、切替前の確定は送らない', () => {
  const props = { menus: server.map(toMenu), status: 'ready' as const, error: null, menuCount: 3, canEdit: true, onReload: vi.fn(), onOpenStaff: vi.fn() }
  const view = render(<MenusTabV8 {...props} accountId="account-a" />)
  fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.textContent).toContain('LINEアカウント')
  const confirm = within(dialog).getByRole('button', { name: '削除する' })
  const key = Object.keys(confirm).find(item => item.startsWith('__reactProps$'))!
  const oldConfirm = (confirm as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  view.rerender(<MenusTabV8 {...props} accountId="account-b" />)
  view.rerender(<MenusTabV8 {...props} accountId="account-a" />)
  act(() => oldConfirm({ preventDefault() {}, stopPropagation() {} }))
  expect(deleteMenu).not.toHaveBeenCalled()
})

it('アカウント切替中の古い行は削除できず、再取得後は選べる', () => {
  const props = { menus: server.map(toMenu), status: 'ready' as const, error: null, menuCount: 3, canEdit: true, onReload: vi.fn(), onOpenStaff: vi.fn() }
  const view = render(<MenusTabV8 {...props} accountId="account-a" />)
  view.rerender(<MenusTabV8 {...props} accountId="account-b" />)
  fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  view.rerender(<MenusTabV8 {...props} accountId="account-b" status="loading" />)
  view.rerender(<MenusTabV8 {...props} accountId="account-b" />)
  fireEvent.click(screen.getByRole('button', { name: '「カット」のそのほかの操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('LINEアカウント')
})
