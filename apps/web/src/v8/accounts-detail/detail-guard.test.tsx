// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountDetailView } from './view'

const fx = vi.hoisted(() => ({
  search: 'id=acc-1',
  role: 'owner' as string | null,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/accounts/detail',
  useSearchParams: () => new URLSearchParams(fx.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '本店' }, accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {}, useSettingsNavInline: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => fx.role }
})
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
vi.mock('./senders-card', () => ({ default: () => <div data-testid="senders-card" /> }))

import AccountDetailV8 from './detail'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

function makeStoppedAccount(): AccountDetailView {
  return {
    id: 'acc-1',
    channelId: '@nen-test',
    name: '然-NEN-TEST',
    loginChannelId: 'login-1',
    liffId: null,
    isActive: false,
    inactivatedAt: 'invalid-date',
    inactiveReasonDetail: '点検中',
    channelAccessTokenConfigured: true,
    channelSecretConfigured: true,
    loginChannelSecretConfigured: true,
    channelAccessTokenLast4: 'x9Qa',
    channelAccessTokenUpdatedAt: '2026-09-28T01:10:00.000Z',
    channelSecretLast4: null,
    channelSecretUpdatedAt: null,
    loginChannelSecretLast4: null,
    loginChannelSecretUpdatedAt: null,
    isDefault: false,
    archivedAt: null,
    friendCapacity: 5000,
    capacityWarnAt: 4500,
    iconUrl: null,
    country: '日本',
    role: '検証用',
    displayOrder: 0,
    ogSiteName: null,
    ogDefaultDescription: null,
    ogDefaultImageUrl: null,
    parentLineAccountId: 'parent-1',
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    stats: { friendCount: 100, activeScenarios: 0, messagesThisMonth: 0 },
    webhook: { expectedUrl: 'https://api.example/webhook', actualUrl: 'https://api.example/webhook', active: true, status: 'matched', checkedAt: null },
    connection: { lastTestAt: '2026-10-01T21:00:00.000Z', lastTestStatus: 'succeeded', lastReceivedAt: 'not-a-valid-date' },
  } as AccountDetailView
}

describe('AccountDetailV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.search = 'id=acc-1'
    fx.role = 'owner'
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('不正な停止日時・最終受信日時で壊れた文言を出さず、一覧APIが非配列でも落ちない。閲覧のみへ権限が下がると開いた編集窓を閉じる', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/test-recipients')) return json({ success: true, data: [] })
      if (url.includes('/skipped-deliveries')) {
        return json({ success: true, data: [{ id: 's-1', kind: 'broadcast', title: 'お知らせ', skippedAt: 'bad-ts' }] })
      }
      if (/\/api\/line-accounts\/acc-1$/.test(url)) return json({ success: true, data: makeStoppedAccount() })
      // 親アカウント一覧が破損（配列でない）
      if (/\/api\/line-accounts(\?|$)/.test(url)) return json({ success: true, data: { broken: true } })
      return json({ success: true, data: null })
    }))

    const view = render(<AccountDetailV8 />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '然-NEN-TEST' })).toBeTruthy()
    })

    // 破損した親アカウント一覧でクラッシュせず再読み込み案内が出る
    expect(screen.getByText('読み込めませんでした')).toBeTruthy()

    // 不正な最終受信日時で「最後の受信 」と欠けた文言を出さない
    expect(screen.queryByText(/最後の受信/)).toBeNull()

    // 不正な停止日時で「— から止まっています」と出さず、理由は保って表示する
    expect(screen.queryByText(/— から止まっています/)).toBeNull()
    expect(screen.getByText('止まっています（理由: 点検中）')).toBeTruthy()

    // 不正な見送り日時で「一斉配信・—」にならない
    expect(screen.queryByText(/一斉配信・—/)).toBeNull()

    // 編集ダイアログを開いた状態で権限が閲覧のみへ下がると自動で閉じる
    fireEvent.click(screen.getByRole('button', { name: '編集する' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    fx.role = 'viewer'
    view.rerender(<AccountDetailV8 />)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})
