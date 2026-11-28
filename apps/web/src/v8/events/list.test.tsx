// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 イベント予約の一覧（src/v8/events/list.tsx）の動きの試験。BEHAVIOR.md の決まりを守る。
 * 見るだけの人には「イベントを作る」を置かず閲覧のみの帯を出す・統括には置く・行の名前の前にフォルダの丸。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const duplicate = vi.hoisted(() => vi.fn())
const remove = vi.hoisted(() => vi.fn())
const account = vi.hoisted(() => ({ id: 'account-a' }))
const fetchApi = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return { ...actual, fetchApi, eventsApi: { ...actual.eventsApi, duplicate, deleteEvent: remove }, api: { ...api, folders: { ...api.folders, list: listFolders } } }
})
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: account.id, loading: false }),
}))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '対象の店' }, { id: 'account-b', name: 'もう一つの店' }] })) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import EventsListV8 from './list'

it('イベント一覧の畳んだフォルダ欄から追加の窓を開ける', async () => {
  await render()
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ' }))
  const menu = document.querySelector('[data-select-menu]') as HTMLElement
  fireEvent.click(within(menu).getByRole('button', { name: 'フォルダを追加' }))
  expect(await screen.findByRole('textbox', { name: 'フォルダ名' })).toBeTruthy()
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const event = {
  id: 'ev-1', name: '秋のしつけ教室', venue_name: '渋谷ベース 3F', venue_url: null, image_url: null, description: null,
  description_centered: 0, max_bookings_per_friend: 1, requires_approval: 1, approval_deadline_hours: 24,
  cancel_deadline_hours_before: 24, reminder_day_before_enabled: 1, reminder_hours_before: null, is_published: 1,
  lifecycle_status: 'published', folderId: 'folder-class', sort_order: 1, created_at: '2026-09-01', updated_at: '2026-09-02',
  version: 1, next_slot_starts_at: '2099-10-12T05:00:00.000Z', total_capacity: 20, total_active: 18, pending_count: 2,
  visible_tag_id: null, visible_tag_name: null, target_type: 'single',
}

it('共有イベントの削除では全アカウントの名前と件数を示す', async () => {
  fetchApi.mockImplementation(async () => ({ items: [{ ...event, target_type: 'multi-account-dedup', account_ids: '["account-a","account-b"]' }], total: 1, summary: null }))
  await render()
  fireEvent.click(screen.getByRole('button', { name: /秋のしつけ教室.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(await screen.findByText('もう一つの店')).toBeTruthy()
  expect(screen.getByText('2件')).toBeTruthy()
})

it('イベント削除の確認に操作先と環境を示す', async () => {
  await render()
  fireEvent.click(screen.getByRole('button', { name: /秋のしつけ教室.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(screen.getByText('LINEアカウント')).toBeTruthy()
  expect(screen.getByText('環境')).toBeTruthy()
  expect(await screen.findByText('対象の店')).toBeTruthy()
})

it('アカウントを切り替えて戻しても古いイベント削除は送らない', async () => {
  await render()
  fireEvent.click(screen.getByRole('button', { name: /秋のしつけ教室.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const button = screen.getByRole('button', { name: '削除する', exact: true })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  account.id = 'account-b'; await render()
  account.id = 'account-a'; await render()
  await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
  expect(remove).not.toHaveBeenCalled()
})

async function render() {
  await act(async () => {
    root.render(<EventsListV8 />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  account.id = 'account-a'
  remove.mockReset()
  duplicate.mockReset()
  fetchApi.mockReset()
  fetchApi.mockImplementation(async () => ({ items: [event], total: 1, summary: null }))
  listFolders.mockReset()
  listFolders.mockResolvedValue({ success: true, data: [{ id: 'folder-class', kind: 'event', name: '教室', color: '#2f6fde', itemCount: 1 }], unfiledCount: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  window.history.replaceState(null, '', '/events')
  role.value = 'owner'
})

const createLink = () => [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('イベントを作る'))

describe('V8 イベント予約の一覧', () => {
  it('フォルダ追加中の名前を、画面を離れる前に確認する', async () => {
    await render()
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダを追加' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '作成途中の教室' } })
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    expect((screen.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement).value).toBe('作成途中の教室')
    link.remove()
  })

  it('フォルダ編集で色だけ変えても移動前に確認する', async () => {
    await render()
    fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「教室」の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '色を変更する' }))
    fireEvent.click(screen.getByRole('button', { name: /フォルダの色/ }))
    fireEvent.click(screen.getByRole('radio', { name: '赤' }))
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    link.remove()
  })
  it('詳細でイベント名を編集中に移動すると入力を保って確認する', async () => {
    window.history.replaceState(null, '', '/events?event=ev-1')
    await render()
    fireEvent.click(await screen.findByRole('button', { name: 'イベント名を変更する' }))
    const input = screen.getByRole('textbox', { name: 'イベント名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '編集中の名前' } })
    fireEvent.blur(input)
    const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
    fireEvent.click(link)
    expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'イベント名' }) as HTMLInputElement).value).toBe('編集中の名前')
    link.remove()
  })
  it('絞り込みと並び順を別に選び、同時に使える', async () => {
    await render()
    fireEvent.click(screen.getByLabelText('よく使う絞り込み'))
    expect(screen.queryByRole('option', { name: 'イベント名の順に並べる' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '満席のイベントだけ' }))
    await waitFor(() => expect(fetchApi.mock.calls.some(([path]) => new URL(String(path), 'http://worker.test').searchParams.get('filter') === 'full')).toBe(true))
    fireEvent.click(screen.getByLabelText('並び順'))
    fireEvent.click(screen.getByRole('button', { name: 'イベント名順' }))
    await waitFor(() => expect(fetchApi.mock.calls.some(([path]) => {
      const params = new URL(String(path), 'http://worker.test').searchParams
      return params.get('filter') === 'full' && params.get('sort') === 'name'
    })).toBe(true))
  })
  it('統括には「イベントを作る」を置き、閲覧のみの帯は出さない', async () => {
    role.value = verifiedStaffRole('owner')
    await render()
    expect(createLink()?.getAttribute('href')).toBe('/events/new')
    expect(host.textContent).not.toContain('閲覧のみで見ています')
  })

  it('見るだけの人には「イベントを作る」を置かず、閲覧のみの帯を出す（2026-10-06 オーナー決定）', async () => {
    role.value = verifiedStaffRole('staff')
    await render()
    expect(createLink()).toBeUndefined()
    expect(host.textContent).toContain('閲覧のみで見ています')
  })

  it('公開前のイベントは状態を「下書き」と出し、「準備中」と言わない', async () => {
    fetchApi.mockImplementation(async () => ({ items: [{ ...event, is_published: 0, lifecycle_status: 'draft' }], total: 1, summary: null }))
    await render()
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('秋のしつけ教室'))
    expect(row?.textContent).toContain('下書き')
    expect(row?.textContent).not.toContain('公開中')
    expect(host.textContent).not.toContain('準備中')
  })

  it('行の名前の前に、左の列と同じフォルダの丸が付く', async () => {
    await render()
    const dot = host.querySelector('[data-folder-dot]')
    expect(dot?.getAttribute('aria-label')).toBe('フォルダ：教室')
    expect(host.textContent).toContain('秋のしつけ教室')
  })
})


it('一覧の複製は確認窓なしで保存済み版を送り、下書きの行を追加して光らせる', async () => {
  duplicate.mockImplementation(async () => {
    fetchApi.mockImplementation(async (path: string) => new URL(path, 'http://worker.test').searchParams.get('highlight') === 'copy'
      ? { items: [{ ...event, id: 'copy', name: '複製した教室', lifecycle_status: 'draft', is_published: 0 }, event], total: 2, summary: null }
      : { items: [event], total: 2, summary: null })
    return { id: 'copy', lifecycle_status: 'draft' }
  })
  await render()
  fireEvent.click(screen.getByRole('button', { name: /秋のしつけ教室.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '複製する' }))
  await waitFor(() => expect(duplicate).toHaveBeenCalledWith('account-a', 'ev-1', 1))
  await waitFor(() => expect(host.querySelector('[data-row-id="copy"]')?.getAttribute('aria-selected')).toBe('true'))
  await waitFor(() => expect(fetchApi.mock.calls.some(([path]) => new URL(String(path), 'http://worker.test').searchParams.get('highlight') === 'copy')).toBe(true))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('閲覧のみの行の操作には複製とフォルダ移動を出さない', async () => {
  role.value = verifiedStaffRole('staff')
  await render()
  fireEvent.click(screen.getByRole('button', { name: /秋のしつけ教室.*操作/ }))
  expect(screen.queryByRole('menuitem', { name: '複製する' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'フォルダへ移す' })).toBeNull()
})

afterEach(() => { verifiedStaffRole(null) })


describe('保存した開催回の日時表示', () => {
  function response(overrides: Record<string, unknown>) {
    fetchApi.mockResolvedValue({ items: [{ ...event, ...overrides }], total: 1, summary: null })
  }
  const row = () => host.querySelector('[data-row-id="ev-1"]')!

  it.each([
    { is_published: 0, lifecycle_status: 'draft', state: '下書き' },
    { is_published: 1, lifecycle_status: 'published', state: '終了' },
  ])('過去の保存回を直近の回として表示し、$state の判定と定員を保つ', async ({ state, ...status }) => {
    response({ ...status, next_slot_starts_at: null, latest_past_slot_starts_at: '2000-11-02T05:00:00.000Z', total_capacity: 23, total_active: 0 })
    await render()
    expect(row().textContent).toContain('11/2（木）14:00直近の回')
    expect(row().textContent).toContain('0 / 23')
    expect(row().textContent).toContain(state)
    expect(row().textContent).not.toContain('日時未設定')
  })

  it('過去の回もあっても次の回の日時と説明を優先する', async () => {
    response({ next_slot_starts_at: '2099-10-12T06:00:00.000Z', latest_past_slot_starts_at: '2000-11-02T05:00:00.000Z' })
    await render()
    expect(row().textContent).toContain('15:00次の回')
    expect(row().textContent).not.toContain('直近の回')
    expect(row().textContent).not.toContain('14:00')
  })

  it.each([undefined, null, '', 'not-a-date', '2026', '2000-02-31T05:00:00.000Z', '2000-11-02T24:00:00Z'])('旧応答・未取得・不正な過去日時を推測しない（%s）', async (past) => {
    response({ next_slot_starts_at: null, ...(past === undefined ? {} : { latest_past_slot_starts_at: past }) })
    await render()
    expect(row().textContent).toContain('日時未設定')
    expect(row().textContent).not.toContain('直近の回')
  })

  it('日時が未設定の公開中イベントは、保存した公開状態を終了にしない', async () => {
    response({ is_published: 1, lifecycle_status: 'published', next_slot_starts_at: null, latest_past_slot_starts_at: null, total_capacity: null })
    await render()
    expect(row().textContent).toContain('日時未設定')
    expect(row().textContent).toContain('公開中')
    expect(row().textContent).not.toContain('終了')
  })

  it('時差付きの有効な過去日時は日本時間で表示する', async () => {
    response({ next_slot_starts_at: null, latest_past_slot_starts_at: '2000-11-02T14:00:00+09:00' })
    await render()
    expect(row().textContent).toContain('11/2（木）14:00直近の回')
  })

  it('同じ行の詳細見出しにも保存済みの過去日時を表示する', async () => {
    const previousUrl = window.location.href
    try {
      window.history.replaceState(null, '', '/events?event=ev-1')
      response({ next_slot_starts_at: null, latest_past_slot_starts_at: '2000-11-02T05:00:00.000Z' })
      await render()
      const panel = screen.getByRole('dialog', { name: '秋のしつけ教室' })
      const description = document.getElementById(panel.getAttribute('aria-describedby')!)
      expect(description?.textContent).toContain('11/2（木）14:00')
      expect(description?.textContent).not.toContain('日時未設定')
    } finally {
      window.history.replaceState(null, '', previousUrl)
    }
  })
})
