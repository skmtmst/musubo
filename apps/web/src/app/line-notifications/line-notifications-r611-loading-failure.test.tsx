// @vitest-environment happy-dom
/*
 * R611（第245回監査）：顧客通知設定の一覧GETが503になると、
 * 一覧は失敗と再読み込みを出すのに、上部の件数と送信枠だけが
 * 「取得中」のまま残っていた。待てば出ると誤読され、一覧の
 * 再読み込みへ進みにくい。
 *
 * ここでは実物の LineNotificationsPage を mount し、
 * 失敗→上部も失敗表示＋一覧の再読み込みへの案内→読み直して復帰、
 * を実DOMで固定する。実送信はしない。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { customerNotificationKpis } from '@/v8/settings/line-notifications/customer-kpis'

const fixture = vi.hoisted(() => ({
  operatorList: vi.fn(),
  settings: vi.fn(),
  overview: vi.fn(),
  definitions: vi.fn(),
  metrics: vi.fn(),
  sendCounts: vi.fn(),
  quota: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/line-notifications',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: 'テスト店' },
  }),
}))

vi.mock('@/components/layout/merged-tabs', () => ({
  default: ({ tabs }: { tabs: Array<{ key: string; label: string }> }) =>
    <nav aria-label="LINE通知のタブ">{tabs.map((tab) => <span key={tab.key}>{tab.label}</span>)}</nav>,
  useMergedTab: () => 'customer',
}))

vi.mock('@/v8/settings/line-notifications/runs-tab', () => ({ default: () => null }))
vi.mock('@/v8/settings/line-notifications/operator-tab', () => ({ default: () => null }))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number) {
      super(`API error ${status}`)
      this.status = status
    }
  }
  return {
    ApiError,
    fetchApi: fixture.quota,
    api: {
      ecCommerce: {
        settings: fixture.settings,
        overview: fixture.overview,
        testSend: vi.fn(),
      },
      accountSettings: { getTestRecipients: vi.fn() },
      lineNotifications: {
        operatorRules: { list: fixture.operatorList },
        definitions: fixture.definitions,
        metrics: fixture.metrics,
        sendCounts: fixture.sendCounts,
        updateDraft: vi.fn(),
        publishDefinition: vi.fn(),
        stopDefinition: vi.fn(),
        createDefinition: vi.fn(),
      },
    },
  }
})

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffIdentity: () => null, useStaffRole: () => 'owner', canManageRole: (role: string) => role === 'owner' || role === 'admin' }))

import LineNotificationsPage from './page'

const SETTING = {
  eventType: 'ec.order.confirmed',
  label: '注文完了',
  isEnabled: true,
  title: 'ご注文ありがとうございます',
  introText: 'ご注文を受け付けました。',
  outroText: 'またのご利用をお待ちしています。',
  category: 'order' as const,
  buttonLabel: '',
  buttonUrl: '',
  imageUrl: '',
  displayOrder: 0,
  fixedFields: ['注文番号'],
  fixedPreview: '',
  updatedAt: '2026-09-27T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.operatorList.mockResolvedValue({ success: true, data: { summary: { total: 7 }, items: [] } })
  fixture.settings.mockResolvedValue({ success: true, data: [SETTING] })
  fixture.overview.mockResolvedValue({ success: true, data: { last24h: 0, failed: 0, byType: [] } })
  fixture.definitions.mockResolvedValue({ success: true, data: [] })
  fixture.metrics.mockResolvedValue({ success: true, data: { items: [] } })
  fixture.sendCounts.mockResolvedValue({
    success: true,
    data: { sentToday: 5, sentLast30d: 30, byEventType: [{ eventType: 'ec.order.confirmed', today: 5, last30d: 30 }] },
  })
  fixture.quota.mockResolvedValue({
    success: true,
    data: { quota: { state: 'available', total: 500, used: 10, remaining: 490, asOf: '2026-09-15T00:00:00Z' } },
  })
  vi.stubGlobal('React', React)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('R611 一覧の取得失敗後は上部も「取得中」のままにしない', () => {
  it('失敗後は上部も取得できなかったことを示し、一覧の再読み込みへ案内する', async () => {
    fixture.settings.mockRejectedValueOnce(new Error('503'))

    render(<LineNotificationsPage />)

    // 一覧は失敗と再読み込み。
    await waitFor(() => expect(screen.getByText('顧客へのお知らせを読み込めませんでした')).toBeTruthy())
    // 上部の件数・送信枠は「取得中」のままではなく、取れなかったことを示す。
    await waitFor(() => expect(screen.getByText(/お知らせの件数は取得失敗です/)).toBeTruthy())
    // 板  の4枚のうち3枚（今日送った・この30日・今月の送信枠）が取得失敗を示す。
    expect(screen.getAllByText('取得失敗').length).toBeGreaterThanOrEqual(3)
    expect(screen.queryByText(/取得中/)).toBeNull()
    // 一覧の再読み込みへ案内する（読み直しの口は一覧が持つのでボタンは足さない）。
    expect(screen.getByText(/下の一覧の「もう一度読み込む」から読み直してください/)).toBeTruthy()
  })

  it('一覧の「もう一度読み込む」で上部も一覧も復帰する', async () => {
    fixture.settings.mockRejectedValueOnce(new Error('503'))

    render(<LineNotificationsPage />)

    await waitFor(() => expect(screen.getByText('顧客へのお知らせを読み込めませんでした')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => expect(fixture.settings).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /の内容を編集$/ })).toBeTruthy())
    // 板  の4枚が戻る（数カードと表の見出し）。
    expect(screen.getAllByText('この30日')).toHaveLength(2)
    expect(screen.queryByText(/から読み直してください/)).toBeNull()
    expect(screen.queryByText('取得失敗')).toBeNull()
  })
})

describe('R611 customer-kpis の失敗注記（器の試験）', () => {
  const base = {
    ready: false, sentToday: null, sentLast30d: null,
    sentBreakdown: '', failed: null, quota: null,
  } as const

  it('loadFailed のときは値を「—」のまま注記だけ失敗の言葉へ変える', () => {
    const kpis = customerNotificationKpis({ ...base, loadFailed: true })
    expect(kpis.every((kpi) => kpi.value === null)).toBe(true)
    // 板  の4枚。
    expect(kpis.find((kpi) => kpi.label === '今日 送った')?.note).toBe('取得失敗')
    expect(kpis.find((kpi) => kpi.label === 'この30日')?.note).toBe('取得失敗')
    expect(kpis.find((kpi) => kpi.label === '今月の送信枠')?.note).toBe('取得失敗')
  })

  it('loadFailed がなければ今までどおり「取得中」', () => {
    const kpis = customerNotificationKpis({ ...base })
    expect(kpis.find((kpi) => kpi.label === '今日 送った')?.note).toBe('種類別の件数は未取得')
    expect(kpis.find((kpi) => kpi.label === '今月の送信枠')?.note).toBe('送信枠を取得中')
  })
})
