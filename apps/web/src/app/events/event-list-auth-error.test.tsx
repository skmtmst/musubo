// @vitest-environment happy-dom
/*
 * R601: イベント一覧の 403（権限不足）と 503（通信失敗）を言い分ける。
 *
 * 以前はどちらも同じ「通信失敗・再読み込み」の1枚だった。権限が無い人が
 * 通信環境を調べたり何度も読み直したりしてしまう。見る筋書き:
 *   1. 403 は権限不足の1枚（管理者への依頼、権限を確認後に読み直せる）
 *   2. 503 は通信失敗の1枚（再読み込み口あり）
 *   3. 404 も通信失敗側（再読み込み口あり）
 *   4. 正常・空は今までどおり
 *   5. 503 のあと再読み込みで直れば一覧に戻る
 *   6. 失敗時の件数は「—」（0件と読ませない）
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventListItem } from '@/lib/api'

const listEvents = vi.hoisted(() => vi.fn())
const staffMe = vi.hoisted(() => vi.fn())
const selected = vi.hoisted(() => ({ account: 'acc-1' }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: (path: string) => {
      const params = new URL(path, 'http://worker.test').searchParams
      return params.get('filter') === 'pending' && params.get('limit') === '1'
        ? Promise.resolve({ items: [], total: 0 }) : listEvents(path)
    },
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: staffMe },
      folders: { ...actual.api.folders, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    },
    eventsApi: { ...actual.eventsApi, listEvents },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: selected.account }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
}))

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import { ApiError } from '@/lib/api'
import EventsListPage from './page'

function item(over: Partial<EventListItem>): EventListItem {
  return {
    id: 'e1',
    name: '体験レッスン',
    venue_name: null,
    venue_url: null,
    image_url: null,
    description: null,
    description_centered: 0,
    max_bookings_per_friend: null,
    requires_approval: 0,
    approval_deadline_hours: 24,
    cancel_deadline_hours_before: null,
    reminder_day_before_enabled: 1,
    reminder_hours_before: null,
    is_published: 1,
    sort_order: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    version: 1,
    next_slot_starts_at: '2099-06-01T01:00:00.000Z',
    total_capacity: 10,
    total_active: 3,
    pending_count: 0,
    visible_tag_id: null,
    visible_tag_name: null,
    ...over,
  }
}

function listPayload() {
  return {
    items: [item({ id: 'e1' })],
    total: 1,
    limit: 20,
    sort: [],
    summary: {
      upcoming_slots: 1,
      upcoming_active: 3,
      upcoming_capacity: 10,
      fill_rate: 30,
      nearly_full: 0,
      low_applications: 0,
      nearest_upcoming_starts_at: '2099-06-01T01:00:00.000Z',
      nearest_low_starts_at: null,
    },
  }
}

function staffPayload(role: string) {
  return {
    success: true,
    data: {
      id: 'me',
      name: '運用者',
      email: null,
      role,
      lineLinked: false,
      twoFactorEnabled: false,
      isActive: true,
      permissionKeys: [],
      notificationPreferences: {},
      inviteStatus: 'active',
      createdAt: '',
      updatedAt: '',
      assignedLineAccountId: null,
      canAccessDescendantAccounts: false,
    },
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  selected.account = 'acc-1'
  history.replaceState({}, '', '/events')
  window.dispatchEvent(new PopStateEvent('popstate'))
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  listEvents.mockReset()
  staffMe.mockReset()
  staffMe.mockResolvedValue(staffPayload('owner'))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderPage() {
  await act(async () => { root.render(<EventsListPage />) })
  await flush()
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function retryButton(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('button')]
    .find((b) => b.textContent?.includes('もう一度読み込む')) ?? null
}

describe('R601 イベント一覧の権限不足と通信失敗の言い分け', () => {
  it('店を切り替えた後に前の一覧が届いても新しい一覧を保つ', async () => {
    let resolveOld!: (value: unknown) => void
    listEvents.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    listEvents.mockResolvedValue({ ...listPayload(), items: [item({ id: 'new', name: '新しい店舗' })] })
    await renderPage()
    selected.account = 'acc-2'
    await renderPage()
    expect(bodyText()).toContain('新しい店舗')
    await act(async () => { resolveOld({ ...listPayload(), items: [item({ id: 'old', name: '前の店舗' })] }) })
    await flush()
    expect(bodyText()).toContain('新しい店舗')
    expect(bodyText()).not.toContain('前の店舗')
  })

  it('店を切り替えた後に前の一覧が失敗しても新しい一覧を保つ', async () => {
    let rejectOld!: (error: Error) => void
    listEvents.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
    listEvents.mockResolvedValue({ ...listPayload(), items: [item({ id: 'new', name: '新しい店舗' })] })
    await renderPage()
    selected.account = 'acc-2'
    await renderPage()
    expect(bodyText()).toContain('新しい店舗')
    await act(async () => { rejectOld(new Error('old account failed')) })
    await flush()
    expect(bodyText()).toContain('新しい店舗')
    expect(bodyText()).not.toContain('登録したイベントは消えていません')
  })

  it('403 は権限不足の1枚で、管理者への依頼を出し、権限を確認後に読み直せる', async () => {
    listEvents.mockRejectedValue(new ApiError(403, 'forbidden'))
    await renderPage()
    expect(bodyText()).toContain('イベントを見る権限がありません')
    expect(bodyText()).toContain('管理者に権限を確かめてください。')
    expect(retryButton(), '権限を確認した後に読み直せる').toBeTruthy()
  })

  it('503 は通信失敗の1枚で、再読み込み口を出す', async () => {
    listEvents.mockRejectedValue(new ApiError(503, 'Service Unavailable'))
    await renderPage()
    expect(bodyText()).toContain('登録したイベントは消えていません')
    expect(bodyText()).not.toContain('権限がありません')
    expect(retryButton(), '通信失敗は読み直せる').toBeTruthy()
  })

  it('404 も通信失敗側の1枚で、再読み込み口を出す', async () => {
    listEvents.mockRejectedValue(new ApiError(404, 'not found'))
    await renderPage()
    expect(bodyText()).toContain('登録したイベントは消えていません')
    expect(bodyText()).not.toContain('権限がありません')
    expect(retryButton()).toBeTruthy()
  })

  it('正常は行が出る', async () => {
    listEvents.mockResolvedValue(listPayload())
    await renderPage()
    expect(bodyText()).toContain('体験レッスン')
  })

  it('空は「まだありません」と作る口が出る', async () => {
    listEvents.mockResolvedValue({ items: [], total: 0, limit: 20, sort: [] })
    await renderPage()
    expect(bodyText()).toContain('まだイベントがありません')
    expect(document.querySelector('a[href="/events/new"]')?.textContent).toContain('イベントを作る')
    expect([...document.querySelectorAll('[data-kpi-presentation]')].every((kpi) => kpi.textContent?.includes('0'))).toBe(true)
  })

  it('503 のあと再読み込みで直れば一覧に戻る', async () => {
    listEvents.mockRejectedValueOnce(new ApiError(503, 'Service Unavailable'))
    listEvents.mockResolvedValue(listPayload())
    await renderPage()
    expect(bodyText()).toContain('登録したイベントは消えていません')
    const retry = retryButton()
    expect(retry, '再読み込み口がある').toBeTruthy()
    await act(async () => { retry!.click() })
    await flush()
    expect(bodyText()).toContain('体験レッスン')
  })

  it('403 のとき件数は「—」（0件と読ませない）', async () => {
    listEvents.mockRejectedValue(new ApiError(403, 'forbidden'))
    await renderPage()
    expect(bodyText()).toContain('—')
    const kpis = host.querySelector('[data-kpi-strip]')!
    expect(kpis.querySelectorAll('[data-kpi-number]')).toHaveLength(4)
    expect(kpis.textContent).not.toContain('0件')
    expect([...kpis.querySelectorAll('[data-kpi-number]')].every(el=>el.textContent==='—')).toBe(true)
  })

  it('一覧上部の件数は表示のみで、タブや操作ボタンとして扱わない', async () => {
    listEvents.mockResolvedValue(listPayload())
    await renderPage()
    const kpis = document.querySelector('[data-design="KPIs"]')!
    expect(kpis.textContent).toContain('これからの回')
    expect(kpis.querySelector('[role="tab"]')).toBeNull()
    const buttons = [...kpis.querySelectorAll('button, a')]
    expect(buttons.every((button) => button.getAttribute('aria-label')?.endsWith('の説明'))).toBe(true)
  })

  it('申し込みが少ない回の日付と残り日数は既存の説明で確認できる', async () => {
    const payload = listPayload()
    const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
    listEvents.mockResolvedValue({ ...payload, summary: { ...payload.summary, low_applications: 1, nearest_low_starts_at: start } })
    await renderPage()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="この画面の説明"]')!.click() })
    const note = document.querySelector<HTMLElement>('[role="note"][id]')!
    expect(note.textContent).toContain('申し込みが少ないのは')
    expect(note.textContent).toContain('あと2日です')
  })
})
