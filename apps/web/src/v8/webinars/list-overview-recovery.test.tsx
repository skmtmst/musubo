// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webinars',
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: 'account-a' as string | null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import WebinarListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const sampleWebinar = {
  id: 'webinar-1',
  accountId: 'account-a',
  title: 'NEN活用スタートセミナー',
  slug: 'nen-start',
  status: 'active',
  videoPrefix: 'videos/nen-start',
  durationSeconds: 872,
  schedule: [],
  cta: null,
  tagOnAttend: null,
  tagOnCtaClick: null,
  folderId: null,
  folderName: null,
  registrationCount: 124,
  viewerCount: 98,
  publicationState: 'always',
  publicationStartsAt: null,
  publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

const okOverview = {
  success: true,
  data: {
    state: 'available',
    registrationMode: 'people',
    metrics: {
      webinars: { value: 4, state: 'available', reason: null },
      activeWebinars: { value: 2, state: 'available', reason: null },
      registrations: { value: 124, state: 'available', reason: null },
      registrationBookings: { value: 130, state: 'available', reason: null },
      viewers: { value: 98, state: 'available', reason: null },
      viewRate: { value: 0.79, state: 'available', reason: null },
      ctaTotalClicks: { value: 41, state: 'available', reason: null },
      ctaUniquePeople: { value: 35, state: 'available', reason: null },
    },
  },
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  window.history.replaceState(null, '', '/webinars')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('V8 ウェビナー一覧の集計読み込みと失敗復帰', () => {
  it('集計の初回読み込み中は数の帯に読み込み骨格を出し、完了後に数値へ切り替える', async () => {
    let resolveOverview!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/overview')) {
        return new Promise<Response>((resolve) => { resolveOverview = resolve })
      }
      if (url.pathname.includes('/folders')) return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname.endsWith('/api/webinars')) {
        return Promise.resolve(json({ data: { items: [sampleWebinar], total: 1, limit: 20, sort: [] } }))
      }
      return Promise.resolve(json({ data: null }))
    })

    act(() => { root.render(<WebinarListV8 />) })
    await flush()

    const stats = host.querySelector('[data-template-region="stats"]')!
    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(4)

    await act(async () => { resolveOverview(json(okOverview)) })
    await flush()

    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(0)
    expect(stats.textContent).toContain('124')
  })

  it('集計APIが success:false を返したときに失敗と再試行を出し、一覧を読み直さずその場で復帰する', async () => {
    let overviewCalls = 0
    let listCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/overview')) {
        overviewCalls += 1
        if (overviewCalls === 1) return Promise.resolve(json({ success: false, error: 'temporary overview failure' }, 200))
        return Promise.resolve(json(okOverview))
      }
      if (url.pathname.includes('/folders')) return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname.endsWith('/api/webinars')) {
        if (url.searchParams.get('limit') !== '1') listCalls += 1
        return Promise.resolve(json({ data: { items: [sampleWebinar], total: 1, limit: 20, sort: [] } }))
      }
      return Promise.resolve(json({ data: null }))
    })

    act(() => { root.render(<WebinarListV8 />) })
    await flush()

    expect(host.textContent).toContain('NEN活用スタートセミナー')
    const stats = host.querySelector('[data-template-region="stats"]') as HTMLElement
    expect(stats.textContent).toContain('集計を表示できませんでした。')
    expect(stats.textContent).toContain('集計を読み込めませんでした')
    const retryBtn = within(stats).getByRole('button', { name: '集計を読み直す' })
    const listCallsBefore = listCalls

    await act(async () => { retryBtn.click() })
    await flush()

    expect(overviewCalls).toBe(2)
    expect(listCalls).toBe(listCallsBefore)
    expect(stats.textContent).toContain('124')
    expect(stats.textContent).not.toContain('集計を表示できませんでした。')
  })

  it('一覧の取得失敗時は単一の再試行ボタンからその場で読み直して復帰する', async () => {
    let listCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/overview')) return Promise.resolve(json(okOverview))
      if (url.pathname.includes('/folders')) return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname.endsWith('/api/webinars')) {
        if (url.searchParams.get('limit') !== '1') {
          listCalls += 1
          if (listCalls === 1) return Promise.resolve(json({ success: false, error: 'unavailable' }, 503))
        }
        return Promise.resolve(json({ data: { items: [sampleWebinar], total: 1, limit: 20, sort: [] } }))
      }
      return Promise.resolve(json({ data: null }))
    })

    act(() => { root.render(<WebinarListV8 />) })
    await flush()

    const errBlock = host.querySelector('[data-list-state="error"]') as HTMLElement
    expect(errBlock).toBeTruthy()
    const retryButtons = within(errBlock).getAllByRole('button', { name: 'もう一度読み込む' })
    expect(retryButtons).toHaveLength(1)

    await act(async () => { retryButtons[0].click() })
    await flush()

    expect(listCalls).toBe(2)
    expect(host.textContent).toContain('NEN活用スタートセミナー')
  })
})
