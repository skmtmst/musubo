// @vitest-environment happy-dom
/*
 * M501：停止・再開の429で「少し待ってからもう一度」の案内が出ることを、
 * 本物の React で確かめる試験。
 *
 * 見るのは2つだけ：429のとき待って再試行する文言が出ること、
 * 429以外の失敗（ここでは500）ではその文言が出ないこと。
 * 文言そのものは共通部品（`describeApiFailure`）が持つ。ここでは
 * 画面が失敗の状態を共通部品へ渡していることを見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner',
}))

const net = vi.hoisted(() => ({
  /** 停止・再開の結果。'rateLimited' は429。 */
  toggleResult: 'rateLimited' as 'rateLimited' | 'serverError',
  calls: vi.fn(),
}))

const SETTING = {
  campaignKey: 'birthday',
  label: 'お誕生日配信',
  category: 'birthday' as const,
  triggerEvent: null,
  delayDays: 0,
  deliveryTime: '10:00',
  isEnabled: true,
  title: 'お誕生日おめでとう',
  bodyText: '本文',
  buttonLabel: null,
  buttonUrl: null,
  imageUrl: null,
  dedupWindowDays: 30,
  excludeFormRespondents: false,
  afterActions: [],
  formIssue: null,
  updatedAt: '2026-09-01T00:00:00+09:00',
}

const FLOW_METRICS = {
  range: { from: '2026-09-01', to: '2026-09-30' },
  summary: { active: 1, paused: 0, planned: 0, sent: 1, associatedConversions: 0, associatedConversionAmount: 0 },
  flows: [],
}

const COLUMN_METRICS = {
  range: { from: '2026-09-01', to: '2026-09-30' },
  summary: { total: 0, sent: 0, drafts: 0, scheduled: 0, unread: null, associatedConversions: 0, associatedConversionAmount: 0 },
  columns: [],
}

function deliveryList() {
  return {
    range: { days: 30, from: '2026-08-02', to: '2026-09-01' },
    summary: {
      pending: 0, processing: 0, sent: 1, skipped: 0, failed: 0,
      cancelled: 0, retryRequired: 0, unmetReasons: {},
    },
    deliveries: [],
    pagination: { total: 0, limit: 50, cursor: '0', nextCursor: null },
  }
}

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      accountSettings: {
        ...actual.api.accountSettings,
        getTestRecipients: async () => ({ success: true, data: [] }),
      },
      nenCampaigns: {
        ...actual.api.nenCampaigns,
        settings: async () => ({ success: true, data: [SETTING] }),
        columns: async () => ({ success: true, data: [], pagination: { total: 0, limit: 200, offset: 0 } }),
        flowMetrics: async () => ({ success: true, data: FLOW_METRICS }),
        columnMetrics: async () => ({ success: true, data: COLUMN_METRICS }),
        deliveries: async () => ({ success: true, data: deliveryList() }),
        birthdayCoupon: async () => ({
          success: true,
          data: {
            isEnabled: true, codePrefix: 'NENBDAY', benefitLabel: 'お誕生日月限定クーポン',
            discountAmount: 500, validityDays: 31, leapYearPolicy: 'feb28' as const,
            updatedAt: '2026-09-01T00:00:00+09:00',
          },
        }),
        setEnabled: async (...args: unknown[]) => {
          net.calls(...args)
          if (net.toggleResult === 'rateLimited') {
            throw new actual.ApiError(429, 'API error: 429')
          }
          throw new actual.ApiError(500, 'API error: 500')
        },
      },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', selectedAccount: null }),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageChrome: () => ({}) }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/nen-campaigns',
  useSearchParams: () => new URLSearchParams(),
}))

const { default: NenCampaignsPage } = await import('./page')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function findButtonByLabel(label: string): HTMLButtonElement | undefined {
  // 行メニューは表の外（portal）に出るため、文書全体から探す。
  return [...document.querySelectorAll('button[role="menuitem"]')]
    .find((node) => (node.textContent ?? '').trim() === label) as HTMLButtonElement | undefined
}

function openRowMenu(): HTMLButtonElement {
  const menu = [...container.querySelectorAll('button')]
    .find((node) => (node.getAttribute('aria-label') ?? '') === '「お誕生日配信」の操作') as HTMLButtonElement | undefined
  expect(menu, `行の「…」操作がある（描画内容: ${(container.textContent ?? '').slice(0, 200)}）`).toBeTruthy()
  return menu!
}

beforeEach(() => {
  net.toggleResult = 'rateLimited'
  net.calls.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('M501 停止・再開の混雑時の案内', () => {
  it('429では待って再試行する案内が出る', async () => {
    await act(async () => {
      root.render(<NenCampaignsPage />)
    })
    await flush()

    await act(async () => {
      openRowMenu().click()
    })
    await flush()
    const stop = findButtonByLabel('止める')
    expect(stop, '「止める」操作がある').toBeTruthy()
    await act(async () => {
      stop!.click()
    })
    await flush()
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '止める')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm!.click() })
    await flush()

    expect(net.calls).toHaveBeenCalledWith('account-1', 'birthday', false, SETTING.updatedAt)
    // 待って再試行する案内。汎用の「切り替えられませんでした」だけではない。
    expect(container.textContent).toContain('少し待ってから')
    expect(container.textContent).toContain('もう一度お試しください')
  })

  it('429以外の失敗では混雑の案内を出さない', async () => {
    net.toggleResult = 'serverError'
    await act(async () => {
      root.render(<NenCampaignsPage />)
    })
    await flush()

    await act(async () => {
      openRowMenu().click()
    })
    await flush()
    const stop = findButtonByLabel('止める')
    expect(stop, '「止める」操作がある').toBeTruthy()
    await act(async () => {
      stop!.click()
    })
    await flush()
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === '止める')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm!.click() })
    await flush()

    expect(container.textContent).toContain('切り替え')
    expect(container.textContent).not.toContain('少し待ってから')
  })
})
