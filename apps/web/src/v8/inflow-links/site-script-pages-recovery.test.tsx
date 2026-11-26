// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  pages: vi.fn(),
  summary: vi.fn(),
  trackingKey: vi.fn(),
  sites: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/inflow-links',
  useSearchParams: () => new URLSearchParams('tab=script'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '渋谷本店' },
    accounts: [{ id: 'acc-1', name: '渋谷本店' }],
    loading: false,
  }),
}))

vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => 'admin' }
})

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      siteTracking: {
        ...actual.api.siteTracking,
        pages: fixture.pages,
        summary: fixture.summary,
        trackingKey: fixture.trackingKey,
      },
      measurementSites: {
        ...actual.api.measurementSites,
        list: fixture.sites,
      },
    },
  }
})

import SiteScriptV8 from './site-script'

const sampleSummary = {
  todayEvents: 12,
  todayPageViews: 85,
  linkedEvents: 8,
  unlinkedEvents: 4,
  pathCount: 3,
  eventTypeCount: 2,
  lastEventAt: '2026-11-27T01:00:00Z',
}

const sampleSite = {
  id: 'site-1',
  label: '然 公式サイト',
  domains: ['nen.example.com'],
  createdAt: '2026-09-01T00:00:00+09:00',
  rejectedCount: 0,
  lastRejectedHost: null,
  lastRejectedAt: null,
  stoppedAt: null,
  stoppedReason: null,
  lastReceivedAt: '2026-11-27T01:00:00Z',
}

describe('サイトスクリプト：ページ別計測の失敗表示と再読込復旧', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.documentElement.dataset.theme = 'v8'
    fixture.summary.mockResolvedValue({ success: true, data: sampleSummary })
    fixture.trackingKey.mockResolvedValue({ success: true, data: { trackingKey: 'track-key-1' } })
    fixture.sites.mockResolvedValue({ success: true, data: [sampleSite] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  it('ページ別計測の取得だけ失敗したとき、偽の「同意なし」行を出さずに案内と「ページ表示を読み直す」を表示し復旧できる', async () => {
    fixture.pages
      .mockRejectedValueOnce(new Error('pages unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ host: 'nen.example.com', path: '/campaign', views: 120, visitors: 45 }],
      })

    render(<SiteScriptV8 />)

    await screen.findByText('然 公式サイト')
    expect(await screen.findByText(/ページごとの表示を読み込めませんでした/)).toBeTruthy()
    expect(screen.queryByText('同意なし')).toBeNull()

    const retryBtn = screen.getByRole('button', { name: 'ページ表示を読み直す' })
    fireEvent.click(retryBtn)

    await screen.findByText('/campaign')
    expect(screen.getByText('120')).toBeTruthy()
    expect(screen.getByText('45')).toBeTruthy()
    expect(screen.queryByText(/ページごとの表示を読み込めませんでした/)).toBeNull()
    expect(fixture.pages).toHaveBeenCalledTimes(2)
    expect(fixture.summary).toHaveBeenCalledTimes(1)
  })

  it('ページ表示を読み直す・いま届いているか確かめるの進行中は連打しても二重リクエストを出さない', async () => {
    let resolveRetryPages!: (value: unknown) => void
    let resolveRecheckSummary!: (value: unknown) => void

    fixture.pages
      .mockResolvedValueOnce({ success: false, error: 'temporary error' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetryPages = resolve }))
      .mockResolvedValue({ success: true, data: [{ host: 'nen.example.com', path: '/top', views: 10, visitors: 5 }] })

    render(<SiteScriptV8 />)
    const retryBtn = await screen.findByRole('button', { name: 'ページ表示を読み直す' })

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(fixture.pages).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveRetryPages({ success: true, data: [{ host: 'nen.example.com', path: '/top', views: 10, visitors: 5 }] })
      await Promise.resolve()
    })
    await screen.findByText('/top')

    fixture.summary.mockImplementationOnce(() => new Promise((resolve) => { resolveRecheckSummary = resolve }))
    const recheckBtn = screen.getByRole('button', { name: /いま届いているか確かめる/ })
    fireEvent.click(recheckBtn)
    await waitFor(() => expect((recheckBtn as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(recheckBtn)
    expect(fixture.summary).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveRecheckSummary({ success: true, data: sampleSummary })
      await Promise.resolve()
    })
    await waitFor(() => expect((recheckBtn as HTMLButtonElement).disabled).toBe(false))
  })
})
