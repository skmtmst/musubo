// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/conversions',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => verifiedStaffRole('owner') }
})

vi.mock('@/lib/use-narrow-viewport', () => ({
  useNarrowViewport: () => false,
}))

import ConversionListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const sampleItem = {
  id: 'cp-1',
  name: '商品を買った',
  sourceType: 'ec_order_confirmed',
  value: null,
  measureMethod: 'webhook',
  targetUrl: null,
  countRepeat: true,
  attributionDays: 90,
  sourceConfig: {},
  deduplicationMode: 'every',
  deduplicationWindowDays: null,
  valueMode: 'source',
  reversalPolicy: 'source_cancelled',
  lineAccountId: 'account-a',
  status: 'active',
  state: 'active',
  stateReason: null,
  ingest: { configured: true, disabledAt: null },
  version: 3,
  usageCount: 2,
  usageNames: ['ファネル 1', 'アフィリエイト 1'],
  metrics: {
    recordedCount: 52,
    netCount: 52,
    reversedCount: null,
    reversedValue: null,
    netValue: 412000,
    reversalState: 'unavailable',
    reversalReason: '',
    cancellationCount: null,
    cancellationValue: null,
  },
  stoppedAt: null,
  createdAt: '2026-01-10T00:00:00.000Z',
  updatedAt: '2026-08-25T09:00:00.000Z',
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/conversions')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  verifiedStaffRole(null)
  host.remove()
  delete document.documentElement.dataset.theme
})

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('V8 コンバージョン一覧の集計再読み込みと停止影響のその場再試行', () => {
  it('初回読み込み中は数の帯4マスに読み込み骨格を出し、完了後に数値へ切り替える', async () => {
    let resolveDefs!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/conversions/definitions') {
        return new Promise<Response>((resolve) => { resolveDefs = resolve })
      }
      if (url.pathname === '/api/conversions/report') {
        return Promise.resolve(json({ success: true, data: { kpis: { netCount: 52, previousNetCount: 40, netValue: 412000 }, byDefinition: [] } }))
      }
      if (url.pathname === '/api/folders') return Promise.resolve(json({ success: true, data: [], unfiledCount: 1 }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<ConversionListV8 accountId="account-a" />) })
    await flush()

    const stats = host.querySelector('[data-template-region="stats"]')!
    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(4)

    await act(async () => {
      resolveDefs(json({
        success: true,
        data: {
          items: [sampleItem],
          stateCounts: { active: 1, draft: 0, stopped: 0, invalid: 0, sourceStopped: 0, unused: 0 },
          range: {},
          pagination: { total: 1, limit: 100, cursor: '0', nextCursor: null },
        },
      }))
    })
    await flush()

    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(0)
    expect(stats.textContent).toContain('52')
  })

  it('集計だけ失敗したときに該当KPIへ理由と再試行を出し、連打を防ぎながら一覧を再取得せず復帰する', async () => {
    let defsCalls = 0
    let reportCalls = 0
    let resolveRetry!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/conversions/definitions') {
        defsCalls += 1
        return Promise.resolve(json({
          success: true,
          data: {
            items: [sampleItem],
            stateCounts: { active: 1, draft: 0, stopped: 0, invalid: 0, sourceStopped: 0, unused: 0 },
            range: {},
            pagination: { total: 1, limit: 100, cursor: '0', nextCursor: null },
          },
        }))
      }
      if (url.pathname === '/api/conversions/report') {
        reportCalls += 1
        if (reportCalls === 1) return Promise.resolve(json({ success: false, error: 'report timeout' }, 500))
        return new Promise<Response>((resolve) => { resolveRetry = resolve })
      }
      if (url.pathname === '/api/folders') return Promise.resolve(json({ success: true, data: [], unfiledCount: 1 }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<ConversionListV8 accountId="account-a" />) })
    await flush()

    const stats = host.querySelector('[data-template-region="stats"]') as HTMLElement
    expect(stats.textContent).toContain('集計を表示できませんでした。一覧はそのまま使えます。')
    const cardRetries = within(stats).getAllByRole('button', { name: 'もう一度読み込む' })
    expect(cardRetries).toHaveLength(2)
    expect(stats.textContent).toContain('集計を読み込めませんでした')

    const defsBefore = defsCalls
    await act(async () => {
      cardRetries[0].click()
      cardRetries[0].click()
    })
    await flush()

    expect(reportCalls).toBe(2)
    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(2)

    await act(async () => {
      resolveRetry(json({ success: true, data: { kpis: { netCount: 88, previousNetCount: 70, netValue: 510000 }, byDefinition: [] } }))
    })
    await flush()

    expect(defsCalls).toBe(defsBefore)
    expect(stats.textContent).toContain('88')
    expect(stats.textContent).not.toContain('集計を読み込めませんでした')
  })

  it('停止確認ダイアログで影響の読み込みに失敗したとき、閉じずにその場で影響を読み直せる', async () => {
    let impactCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/conversions/definitions') {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [sampleItem],
            stateCounts: { active: 1, draft: 0, stopped: 0, invalid: 0, sourceStopped: 0, unused: 0 },
            range: {},
            pagination: { total: 1, limit: 100, cursor: '0', nextCursor: null },
          },
        }))
      }
      if (url.pathname === '/api/conversions/report') {
        return Promise.resolve(json({ success: true, data: { kpis: { netCount: 52, previousNetCount: 40, netValue: 412000 }, byDefinition: [] } }))
      }
      if (url.pathname === '/api/folders') return Promise.resolve(json({ success: true, data: [], unfiledCount: 1 }))
      if (url.pathname.endsWith('/delete-impact')) {
        impactCalls += 1
        if (impactCalls === 1) return Promise.resolve(json({ success: false, error: 'temporary' }, 503))
        return Promise.resolve(json({
          success: true,
          data: {
            definition: { ...sampleItem, version: 3 },
            usages: [],
            eventCount: 52,
            canDelete: false,
            stopImpact: { affectedUsageCount: 2, preservesPastEvents: true, preservesUsages: true },
            replacementCandidates: [],
          },
        }))
      }
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<ConversionListV8 accountId="account-a" />) })
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '成果地点「商品を買った」の操作' }))
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: '止める' }))
    await flush()

    const dialog = screen.getByRole('dialog', { name: '「商品を買った」を止めますか？' })
    const retryImpactBtn = within(dialog).getByRole('button', { name: '影響を読み直す' })
    fireEvent.click(retryImpactBtn)
    await flush()

    expect(impactCalls).toBe(2)
    expect(dialog.textContent).toContain('2か所で使われています。どうしますか。')
    expect(within(dialog).queryByRole('button', { name: '影響を読み直す' })).toBeNull()
  })
})
