import { getPageAction } from '@/test-utils/page-action'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
/*
 * 運用状態の外側（板 Y4LkX1・I2V65v・OHwbU）を描いて見る。
 *
 * - タブは板の並び（健全性チェック・更新履歴・緊急コントロール）。オーナーには見張りのタブが続く。
 * - 題は板の頭の1つだけで、h1 を重ねない。説明は「？」から開く。
 * - アカウント一覧の取得に失敗したら黙らせず、読み直せる。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import EmergencyScreen from './screen'
import EmergencyPage from '@/app/emergency/page'
import type { OperationHealthResult, OperationHealthSnapshot } from '@/lib/api'
import { clearAdminVersionCache } from '@/lib/admin-version-cache'
import { formatTime } from '@/lib/format'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const state = vi.hoisted(() => ({
  tab: 'health',
  from: '',
  accountCalls: 0,
  accounts: [] as Array<() => Promise<unknown>>,
  health: null as OperationHealthSnapshot | null,
  healthCalls: [] as string[],
}))

vi.mock('@/contexts/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
const roleState = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'viewer' }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => roleState.role, useStaffIdentity: () => ({ role: roleState.role, readOnly: false }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/emergency',
  useSearchParams: () => new URLSearchParams(`tab=${state.tab}&from=${state.from}`),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], selectedAccountId: 'account-1', selectedAccount: null, loading: false }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      health: {
        ...actual.api.health,
        accounts: () => {
          state.accountCalls += 1
          const next = state.accounts.shift()
          return (next ? next() : Promise.resolve({ success: true, data: [] })) as Promise<never>
        },
      },
      operations: {
        ...actual.api.operations,
        health: (accountId: string) => {
          state.healthCalls.push(accountId)
          return (state.health ? Promise.resolve({ success: true, data: state.health }) : new Promise(() => undefined)) as Promise<never>
        },
        alerts: () => Promise.resolve({ success: true, data: [] }) as Promise<never>,
        history: () => Promise.resolve({ success: true, data: [] }) as Promise<never>,
        lineReceipts: () => Promise.resolve({ success: true, data: [] }) as Promise<never>,
      },
    },
  }
})

afterEach(() => {
  cleanup()
  state.tab = 'health'
  state.from = ''
  state.accountCalls = 0
  state.accounts = []
  state.health = null
  state.healthCalls = []
})

async function renderScreen(tab: string) {
  state.tab = tab
  const view = render(<EmergencyScreen renderControl={() => <p>緊急コントロールの中身</p>} renderHistory={() => <p>更新履歴の中身</p>} />)
  await act(async () => { await Promise.resolve() })
  return view
}

async function openHelp() {
  fireEvent.click(screen.getByRole('button', { name: '運用状態の説明' }))
  await act(async () => { await Promise.resolve() })
}

describe('運用状態の外側', () => {
  it('統括からの移動ではタブと更新履歴に戻り先を保持する', async () => {
    state.tab = 'history'
    state.from = 'hq'
    render(<EmergencyScreen />)
    expect(screen.getByRole('tab', { name: '緊急コントロール' }).getAttribute('href')).toBe('/emergency?tab=control&from=hq')
    expect(screen.getByRole('tab', { name: '健全性チェック' }).getAttribute('href')).toBe('/emergency?from=hq')
    expect(screen.getByRole('link', { name: 'アップデート履歴を見る' }).getAttribute('href')).toBe('/updates?from=hq')
  })

  it('実入口から取得済みの健全性の行を設定型の本文へ描く', async () => {
    const now = new Date().toISOString()
    const keys = ['line_connection', 'monitoring_heartbeat', 'external_integrations', 'message_quota', 'friend_change', 'webhook', 'dispatch_jobs', 'infra_canary', 'credential_expiry'] as const
    state.health = {
      latestRun: {
        id: 'run-1', lineAccountId: 'account-1',
        source: 'scheduled', status: 'completed', overallStatus: 'normal',
        startedAt: now, completedAt: now,
        results: keys.map((checkKey, index): OperationHealthResult => ({
          id: `result-${index}`, runId: 'run-1', checkKey, status: 'normal', summary: `確認済み-${checkKey}`,
          value: null, threshold: null, source: 'fixture', observedAt: now,
        })),
      },
      overallStatus: 'normal', lastCheckedAt: now, nextCheckAt: null, serverNow: now,
    }
    clearAdminVersionCache()
    const unexpected: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input))
      if (url.pathname === '/admin/version') return new Response(JSON.stringify({ version: '0.0.0-test' }), { status: 200 })
      unexpected.push(url.pathname)
      throw new Error(`未定義の取得: ${url.pathname}`)
    })
    try {
      render(<EmergencyPage />)
      const table = screen.getByRole('table', { name: '確かめていること', exact: true })
      const result = within(table).getByText('Webhook が届いているか', { exact: true })
      const row = result.closest('[role="row"]')!
      await waitFor(() => expect(within(row).getAllByRole('cell')[1].textContent).toBe('正常'))
      expect(within(row).getAllByRole('cell')[2].textContent).toBe(formatTime(now))
      expect(within(row).getAllByRole('cell')[3].textContent).toBe('受け取りの失敗が続くと「注意」')
      expect(result.closest('[data-template-region="content"]')?.closest('[data-page-template="settings"]')).toBeTruthy()
      expect(state.healthCalls).toEqual(['account-1'])
      expect(within(table).getAllByRole('row')).toHaveLength(10)
      expect(unexpected).toEqual([])
    } finally {
      cleanup()
      fetchSpy.mockRestore()
      clearAdminVersionCache()
    }
  })

  it('健全性チェックは板 Y4LkX1。タブは板の並びで、題は1つ、h1 を重ねない', async () => {
    const view = await renderScreen('health')
    expect(view.container.querySelector('[data-page-template="settings"]')?.getAttribute('data-design-node')).toBe('Y4LkX1')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['健全性チェック', '更新履歴', '緊急コントロール', 'セキュリティの見張り'])
    expect(screen.getByRole('tab', { name: '健全性チェック' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { name: '運用状態' })).toBeTruthy()
    // 画面の題が唯一の h1。上の帯のパンくずは見出しにしないので、h1 は題の1つだけ。
    expect([...view.container.querySelectorAll('h1')].map((el) => el.textContent)).toEqual(['運用状態'])
    expect(screen.getByRole('button', { name: 'いますぐ確かめる' })).toBeTruthy()
    await openHelp()
    expect(screen.getByText(/9 つの項目を5分ごとに自動で確かめます。/)).toBeTruthy()
  })

  it('閲覧のみには［いますぐ確かめる］を灰色＋理由で出し、押しても確かめ直さない', async () => {
    roleState.role = 'viewer'
    verifiedStaffRole('viewer')
    try {
      await renderScreen('health')
      const run = screen.getByRole('button', { name: 'いますぐ確かめる' })
      expect(run.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(run)
      expect(screen.queryByText('確認中…')).toBeNull()
    } finally {
      roleState.role = 'owner'
    }
  })

  it('緊急コントロールは板 OHwbU。説明は止め方で、オーナーには緊急停止の主ボタンを出す', async () => {
    const view = await renderScreen('control')
    expect(view.container.querySelector('[data-page-template="settings"]')?.getAttribute('data-design-node')).toBe('OHwbU')
    expect(screen.getByText('緊急コントロールの中身')).toBeTruthy()
    expect(getPageAction({ name: '緊急停止する' })).toBeTruthy()
    await openHelp()
    expect(screen.getByText('止める配信を選び、理由を入力して緊急停止します。')).toBeTruthy()
  })

  it('更新履歴は板 I2V65v。説明は時間順の記録', async () => {
    const view = await renderScreen('history')
    expect(view.container.querySelector('[data-page-template="settings"]')?.getAttribute('data-design-node')).toBe('I2V65v')
    expect(screen.getByText('更新履歴の中身')).toBeTruthy()
    await openHelp()
    expect(screen.getByText('エラー、緊急停止、システム更新、設定変更を時間順に確認できます。')).toBeTruthy()
  })
})

describe('アカウント一覧の取得失敗', () => {
  it('失敗の応答は黙らせず、読み直して成功すれば知らせを消す', async () => {
    state.accounts = [() => Promise.resolve({ success: false, error: 'down' })]
    await renderScreen('health')
    expect(await screen.findByText(/アカウント一覧を読み込めませんでした。/)).toBeTruthy()
    expect(state.accountCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.queryByText(/アカウント一覧を読み込めませんでした。/)).toBeNull())
    expect(state.accountCalls).toBe(2)
  })

  it('通信の失敗（例外）も黙らせない', async () => {
    state.accounts = [() => Promise.reject(new Error('network down'))]
    await renderScreen('control')
    expect(await screen.findByText(/アカウント一覧を読み込めませんでした。/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
  })
})
