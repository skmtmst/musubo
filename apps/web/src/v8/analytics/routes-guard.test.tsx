// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsMetric, AnalyticsRoutesOverview } from '@/lib/api'

const routesOverview = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      analytics: {
        ...actual.api.analytics,
        routesOverview,
      },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

import RoutesV8 from './routes'

const ok = (value: number): AnalyticsMetric<number> => ({ value, state: 'available', reason: null })
const na: AnalyticsMetric<number> = { value: null, state: 'unavailable', reason: null }

function makeOverview(over: Partial<AnalyticsRoutesOverview['data']> = {}): AnalyticsRoutesOverview {
  return {
    lineAccountId: 'acc-1',
    timeZone: 'Asia/Tokyo',
    period: { from: '2026-09-01', to: '2026-09-30' },
    dataCutoffAt: '2026-09-30T00:00:00Z',
    data: {
      attributionModel: 'first_touch',
      attributionLabel: '初回',
      searchConsoleHref: '/search-console',
      routes: [
        {
          id: 'r1',
          refCode: 'ig',
          name: 'Instagram',
          clicks: ok(100),
          friendAdds: ok(50),
          currentFriends: ok(50),
          reactionPeople: ok(20),
          conversions: { approved: ok(10), pending: ok(0), rejected: ok(0), revenue: ok(10000) },
          adCost: ok(2000),
          costPerFriend: ok(40),
          costPerConversion: ok(200),
          profitAfterAdCost: ok(8000),
        },
      ],
      ...over,
    },
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  document.body.innerHTML = ''
})

async function renderRoutes(overview: AnalyticsRoutesOverview) {
  routesOverview.mockResolvedValue({ success: true, data: overview })
  await act(async () => {
    root.render(<RoutesV8 accountId="acc-1" />)
  })
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

describe('RoutesV8 defensive guards', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/console',
    '/\\evil.example/console',
    '//same.invalid/console',
    '/\t/evil.example/console',
    '',
  ])('omits unsafe or blank searchConsoleHref: %s', async (href) => {
    await renderRoutes(makeOverview({ searchConsoleHref: href }))
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('Search Console'))
    expect(link).toBeUndefined()
  })

  it.each(['/search-console', 'https://search.google.com/search-console'])('keeps safe searchConsoleHref: %s', async (href) => {
    await renderRoutes(makeOverview({ searchConsoleHref: href }))
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('Search Console'))
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe(href)
  })

  it('does not render NaN totals or negative flow bar widths on malformed metrics', async () => {
    const base = makeOverview()
    base.data.routes[0] = {
      ...base.data.routes[0],
      clicks: ok(-10),
      friendAdds: ok(5),
      reactionPeople: ok(Number.NaN),
      conversions: { approved: ok(2), pending: na, rejected: na, revenue: na },
    }
    await renderRoutes(base)
    expect(host.textContent).not.toContain('NaN')
    const bars = [...host.querySelectorAll<HTMLElement>('[data-size="flow"] > span')]
    expect(bars.length).toBe(4)
    for (const bar of bars) {
      expect(bar.style.width).toBe('0%')
    }
    const flowRows = [...host.querySelectorAll<HTMLElement>('section[aria-labelledby="routes-flow-title"] [title]')]
    expect(flowRows.some((row) => row.title.includes('-'))).toBe(false)
  })
})
