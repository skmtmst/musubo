// @vitest-environment happy-dom
/*
 * シナリオ配信結果の購読集計KPI表示（読み込み中・失敗）と再読み込み連打防止の振る舞い。
 * - 購読一覧の取得に失敗したとき、「途中」カードが通常文のまま残らず「読み込めませんでした」を表示する
 * - 購読一覧を読み込んでいる間は、「途中」カードが読み込み中表示になる
 * - 購読一覧の再読み込みを連打しても二重通信にならず、成功で通常の件数と補足文へ戻る
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reference = vi.hoisted(() => ({
  scenario: vi.fn(),
  stats: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'owner',
}))
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: (...args: unknown[]) => reference.scenario(...args),
    stats: (...args: unknown[]) => reference.stats(...args),
    invalidateScenario: () => {},
  },
}))

import ScenarioResultsV8 from './results'

const SCENARIO = {
  id: 'sc-1',
  name: '新規登録フォロー',
  description: null,
  triggerType: 'friend_add',
  triggerTagId: null,
  isActive: true,
  deliveryMode: 'elapsed',
  allowConcurrent: true,
  displayOrder: 0,
  folderId: null,
  lineAccountId: 'account-a',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  steps: [{ id: 'st-1', scenarioId: 'sc-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, deliveryTime: '10:00' }],
}

const STATS = {
  enrolledTotal: 10,
  activeNow: 4,
  completed: 6,
  paused: 0,
  steps: [{ stepOrder: 1, reachedCount: 10, reachRate: 1 }],
}

const RUNS_SUCCESS = {
  summary: { active: 3, paused: 1, completed: 6, delivering: 0 },
  subscriptions: [
    {
      id: 'sub-1',
      friendId: 'f-1',
      friendName: '鈴木 一郎',
      status: 'active',
      confirmationRevision: 1,
      currentStepOrder: 1,
      startedAt: '2026-09-01T00:00:00.000Z',
      nextDeliveryAt: '2026-10-04T01:00:00.000Z',
      pauseReason: null,
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  pagination: { total: 1, limit: 50, cursor: '', nextCursor: null },
  testSends: [],
  quota: { limit: null, used: null, remaining: null, state: 'unavailable', reason: null, asOf: '' },
  concurrentBroadcasts: [],
  scenarioClickTotal: 0,
  steps: [{ id: 'st-1', stepOrder: 1, delivered: 10, opened: { value: null, state: 'unavailable', reason: null }, clicked: { value: null, state: 'unavailable', reason: null }, failed: { value: 0, state: 'available', reason: null } }],
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  reference.scenario.mockResolvedValue({ success: true, data: SCENARIO })
  reference.stats.mockResolvedValue({ success: true, data: STATS })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('シナリオ配信結果の失敗表示と再試行', () => {
  it('購読一覧が失敗したとき「途中」KPIに「読み込めませんでした」を出し、再読み込み連打を抑えて復旧できる', async () => {
    let runsCalls = 0
    let resolveRetry!: (res: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/api/scenarios/sc-1/runs') {
        runsCalls += 1
        if (runsCalls === 1) return json({ success: false, error: 'down' }, 500)
        return new Promise<Response>((resolve) => { resolveRetry = resolve })
      }
      return json({ success: true, data: {} })
    }))

    const { container } = render(<ScenarioResultsV8 />)

    await screen.findByText('購読一覧を読み込めませんでした')
    const cards = [...container.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    const inProgressCard = cards.find((el) => (el.textContent ?? '').includes('途中'))!
    expect(inProgressCard).toBeTruthy()
    expect(inProgressCard.textContent).toContain('読み込めませんでした')
    expect(inProgressCard.textContent).not.toContain('再参加を含む購読')

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(runsCalls).toBe(2))

    resolveRetry(json({ success: true, data: RUNS_SUCCESS }))
    await screen.findByText('鈴木 一郎')
    expect(inProgressCard.textContent).toContain('4')
    expect(inProgressCard.textContent).toContain('再参加を含む購読')
    expect(runsCalls).toBe(2)
  })

  it('購読一覧の読み込み中は「途中」KPIが読み込み中表示になる', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/api/scenarios/sc-1/runs') return new Promise<Response>(() => {})
      return json({ success: true, data: {} })
    }))

    const { container } = render(<ScenarioResultsV8 />)

    await screen.findByRole('heading', { name: '通ごとの反応' })
    const cards = [...container.querySelectorAll('[data-kpi-strip] > [data-design-version]')]
    const inProgressCard = cards.find((el) => (el.textContent ?? '').includes('途中'))!
    expect(inProgressCard).toBeTruthy()
    expect(inProgressCard.getAttribute('aria-busy')).toBe('true')
    expect(inProgressCard.textContent).toContain('読み込んでいます')
  })
})
