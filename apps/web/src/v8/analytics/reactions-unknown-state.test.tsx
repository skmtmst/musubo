// @vitest-environment happy-dom
import React, { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { flushListUrlState } from '@/components/shared/list-url-state'
import type { ExportAction } from './parts'

const m = vi.hoisted(() => ({
  tab: 'friends', account: 'account-a', register: null as ((action: ExportAction | null) => void) | null,
  friends: vi.fn(), reactions: vi.fn(), routes: vi.fn(), usage: vi.fn(), urls: vi.fn(),
  saved: vi.fn(), snapshots: vi.fn(), fields: vi.fn(), funnels: vi.fn(), latest: vi.fn(),
  report: vi.fn(), exportReport: vi.fn(), runCross: vi.fn(), crossResult: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/analytics', useSearchParams: () => new URLSearchParams(`tab=${m.tab}`) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: m.account, loading: false, accounts: [] }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('./parts', async original => {
  const actual = await original<typeof import('./parts')>()
  return { ...actual, useRegisterExport: (...args: Parameters<typeof actual.useRegisterExport>) => {
    // Observe the real parent's callback; the real registration hook still runs unchanged.
    m.register = React.useContext(actual.AnalyticsExportContextV8)
    actual.useRegisterExport(...args)
  } }
})
vi.mock('@/lib/api/helpers/gap3', () => ({ customerSegmentsApi: { get: () => new Promise(() => {}) } }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    friendFields: { ...actual.api.friendFields, list: m.fields },
    featureSettings: { ...actual.api.featureSettings, visibility: async () => ({ success: true, data: { features: {} } }) },
    conversions: { ...actual.api.conversions, definitionReport: m.report, exportDefinitions: m.exportReport },
    analytics: { ...actual.api.analytics, friendsOverview: m.friends, reactionsOverview: m.reactions, routesOverview: m.routes,
      usageOverview: m.usage, urlClicksOverview: m.urls, runCross: m.runCross, crossResult: m.crossResult,
      saved: { ...actual.api.analytics.saved, list: m.saved, snapshots: m.snapshots },
      v6Funnels: { ...actual.api.analytics.v6Funnels, list: m.funnels, latestRun: m.latest },
      reportSchedules: { ...actual.api.analytics.reportSchedules, list: async () => ({ success: true, data: { items: [], recentOneTime: [] } }) },
    },
  } }
})
import AnalyticsV8 from './analytics'
import { ApiError } from '@/lib/api'

const metric = (value = 0) => ({ value, state: 'available', reason: null })
const metrics = (keys: string[]) => Object.fromEntries(keys.map(key => [key, metric()]))
const envelope = (data: object) => ({ success: true, data: { lineAccountId: 'account-a', timeZone: 'Asia/Tokyo', period: { from: '2026-10-01', to: '2026-10-31' }, dataCutoffAt: '2026-10-31T00:00:00Z', data } })
const friends = (state = 'available', stateReason: string | null = null) => envelope({ state, stateReason, metrics: metrics(['added', 'removed', 'net', 'currentFriends', 'firstTime', 'returning']), days: [], campaigns: [], historyAvailableFrom: null })
const routes = () => envelope({ routes: [], attributionModel: 'first_touch', attributionLabel: '初回', searchConsoleHref: 'https://example.test' })
const saved = () => ({ id: 'saved-1', name: '保存した分析A', kind: 'cross', createdByName: '担当者', currentVersionNumber: 1, updatedAt: '2026-10-01T00:00:00Z', latestSnapshot: null, snapshotCount: 0 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const header = () => document.querySelector('[data-page-heading-actions]') as HTMLElement
const csvs = () => screen.getAllByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement[]
const headerCsv = () => within(header()).getByRole('button', { name: 'CSVで書き出す' }) as HTMLButtonElement
function blocked(button: HTMLButtonElement, reason: string) {
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-description')).toBe(reason)
  expect(within(button.parentElement!).getAllByRole('status').filter(node => node.textContent === reason)).toHaveLength(1)
  fireEvent.click(button)
}
function enabled(button: HTMLButtonElement) {
  expect(button.disabled).toBe(false)
  expect(button.hasAttribute('aria-description')).toBe(false)
  expect(within(button.parentElement!).queryByRole('status')).toBeNull()
}
beforeEach(() => {
  m.tab = 'friends'; m.account = 'account-a'; m.register = null
  verifiedStaffRole('owner'); sessionStorage.clear(); flushListUrlState()
  window.history.replaceState(null, '', '/analytics'); window.dispatchEvent(new PopStateEvent('popstate'))
  for (const mock of [m.friends, m.reactions, m.routes, m.usage, m.urls, m.saved, m.snapshots, m.fields, m.funnels, m.latest, m.report, m.exportReport, m.runCross, m.crossResult]) mock.mockReset().mockImplementation(() => new Promise(() => {}))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); verifiedStaffRole(null); vi.restoreAllMocks() })

it.each(['toString', 'constructor', '__proto__'])('配信分析：未対応の状態 %s は未取得と表示する', async state => {
  m.tab = 'reactions'
  const data = metrics(['sent', 'delivered', 'opened', 'lineClicked', 'trackedClicks', 'unavailableCampaigns'])
  data.delivered = { value: null as unknown as number, state, reason: null }
  data.unavailableCampaigns = { value: null as unknown as number, state, reason: null }
  m.reactions.mockResolvedValue(envelope({ metrics: data, campaigns: [], campaignsTruncation: { limit: 50, broadcast: false, scenario: false }, trackedClickHours: [], clickDefinition: '' }))
  render(<AnalyticsV8 />)
  for (const title of ['届いた人', '取得できない配信']) {
    await waitFor(() => expect(screen.getByText(title).closest('[data-kpi-presentation]')?.textContent).toContain('未取得'))
  }
})
