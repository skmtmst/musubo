// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { api } from '@/lib/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/automations',
  useSearchParams: () => new URLSearchParams(''),
}))

const account = vi.hoisted(() => ({ id: 'account-a' as string | null }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: account.id, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => verifiedStaffRole('owner') }
})

import AutomationListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const sampleAutomations = [
  {
    id: 'au-1',
    name: '問い合わせを担当へ知らせる',
    description: null,
    eventType: 'message_received',
    triggerConfig: {},
    conditions: {},
    actions: [{ type: 'notify_staff', params: {} }],
    isActive: true,
    priority: 1,
    lineAccountId: 'account-a',
    status: 'active',
    versionId: 'au-1-v',
    version: 1,
    confirmationRevision: 3,
    executionCount30d: 312,
    failureCount30d: 2,
    lastRunAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  },
]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  window.history.replaceState({}, '', '/automations')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
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

describe('V8 オートメーション一覧の数の帯読み込みと条件外集計の再試行', () => {
  it('初回読み込み中は数の帯に読み込み骨格を出し、完了後に数値へ切り替える', async () => {
    let resolveList!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/automations') {
        return new Promise<Response>((resolve) => { resolveList = resolve })
      }
      if (url.pathname === '/api/automation-runs') {
        return Promise.resolve(json({ success: true, data: { summary: { total: 500, executed: 312, skipped: 48, failed: 2 }, items: [], pagination: { total: 0, limit: 1, offset: 0 } } }))
      }
      if (url.pathname === '/api/automation-templates') return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname === '/api/common-actions') return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname === '/api/folders') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AutomationListV8 />) })
    await flush()

    const band = host.querySelector('[aria-label="ルールの数の帯"]')!
    expect(band.querySelectorAll('[data-kpi-skeleton]').length).toBe(4)

    await act(async () => {
      resolveList(json({ success: true, data: sampleAutomations, summary: { active: 1, stopped: 0, executionCount30d: 312, failureCount30d: 2 } }))
    })
    await flush()

    expect(band.querySelectorAll('[data-kpi-skeleton]').length).toBe(0)
    expect(band.textContent).toContain('48')
  })

  it('条件外集計だけ失敗したときに理由と再試行を出し、一覧を読み直さずその場で復帰する', async () => {
    let listCalls = 0
    let runsCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/automations') {
        listCalls += 1
        return Promise.resolve(json({ success: true, data: sampleAutomations, summary: { active: 1, stopped: 0, executionCount30d: 312, failureCount30d: 2 } }))
      }
      if (url.pathname === '/api/automation-runs') {
        runsCalls += 1
        if (runsCalls === 1) return Promise.resolve(json({ success: false, error: 'temporary failure' }, 500))
        return Promise.resolve(json({ success: true, data: { summary: { total: 500, executed: 312, skipped: 1240, failed: 2 }, items: [], pagination: { total: 0, limit: 1, offset: 0 } } }))
      }
      if (url.pathname === '/api/automation-templates') return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname === '/api/common-actions') return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname === '/api/folders') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AutomationListV8 />) })
    await flush()

    expect(host.textContent).toContain('問い合わせを担当へ知らせる')
    const band = host.querySelector('[aria-label="ルールの数の帯"]') as HTMLElement
    expect(band.textContent).toContain('条件に外れた回数を読み込めませんでした')
    const retryBtn = within(band).getByRole('button', { name: 'もう一度読み込む' })
    const listCallsBeforeRetry = listCalls

    await act(async () => { retryBtn.click() })
    await flush()

    expect(runsCalls).toBe(2)
    expect(listCalls).toBe(listCallsBeforeRetry)
    expect(band.textContent).toContain('1,240')
    expect(band.textContent).not.toContain('条件に外れた回数を読み込めませんでした')
  })

  it('アカウント切替時に前のアカウントの遅れたフォルダ応答で上書きしない', async () => {
    let resolveOldFolders!: (value: Awaited<ReturnType<typeof api.folders.list>>) => void
    vi.spyOn(api.folders, 'list').mockImplementation((_kind, accountId) => {
      if (accountId === 'account-a') {
        return new Promise((resolve) => { resolveOldFolders = resolve })
      }
      return Promise.resolve({
        success: true,
        data: [{ id: 'f-new', name: '新しい店舗フォルダ', kind: 'automation', color: '#3b82f6', sortOrder: 0, parentId: null }],
      } as unknown as Awaited<ReturnType<typeof api.folders.list>>)
    })
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/automations') {
        return Promise.resolve(json({ success: true, data: sampleAutomations, summary: { active: 1, stopped: 0, executionCount30d: 312, failureCount30d: 2 } }))
      }
      if (url.pathname === '/api/automation-runs') {
        return Promise.resolve(json({ success: true, data: { summary: { total: 500, executed: 312, skipped: 10, failed: 2 }, items: [], pagination: { total: 0, limit: 1, offset: 0 } } }))
      }
      if (url.pathname === '/api/automation-templates') return Promise.resolve(json({ success: true, data: [] }))
      if (url.pathname === '/api/common-actions') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AutomationListV8 />) })
    await flush()

    account.id = 'account-b'
    act(() => { root.render(<AutomationListV8 />) })
    await flush()

    expect(host.textContent).toContain('新しい店舗フォルダ')
    await act(async () => {
      resolveOldFolders({
        success: true,
        data: [{ id: 'f-old', name: '古い店舗フォルダ', kind: 'automation', color: '#ef4444', sortOrder: 0, parentId: null }],
      } as unknown as Awaited<ReturnType<typeof api.folders.list>>)
    })
    await flush()

    expect(host.textContent).toContain('新しい店舗フォルダ')
    expect(host.textContent).not.toContain('古い店舗フォルダ')
  })
})
