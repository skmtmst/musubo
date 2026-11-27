// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ settings: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' } }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...(await original<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  const empty = vi.fn().mockResolvedValue({ success: true, data: [] })
  return { ...actual, api: { ...actual.api,
    nenCampaigns: { ...actual.api.nenCampaigns, settings: fixture.settings, overview: vi.fn().mockResolvedValue({ success: true, data: { jobs: { pendingByCampaign: {} } } }) },
    forms: { ...actual.api.forms, list: empty }, accountSettings: { ...actual.api.accountSettings, getTestRecipientLoginUsers: empty },
    friendFields: { ...actual.api.friendFields, list: empty }, commonVars: { ...actual.api.commonVars, list: empty },
  } }
})
import CampaignEdit from '@/v8/nen-campaigns/edit'

afterEach(() => { cleanup(); vi.clearAllMocks() })

function setting(campaignKey: string, triggerEvent: string) {
  return { campaignKey, triggerEvent, label: '架空の配信', category: 'follow_up', delayDays: 10, deliveryTime: '10:00:00', isEnabled: true,
    title: 'お知らせ', bodyText: '架空のお知らせです', buttonLabel: '', buttonUrl: '', imageUrl: null, dedupWindowDays: 30,
    excludeFormRespondents: false, afterActions: [], formIssue: null, updatedAt: '2026-01-01T00:00:00Z' }
}

it.each([
  ['ec.order.confirmed', '注文を受け付けた'],
  ['ec.order.shipped', '商品を発送した'],
  ['ec.order.delivered', '注文が届いた'],
])('きっかけ%sを利用者向けに表示する', async (event, label) => {
  fixture.settings.mockResolvedValue({ success: true, data: [setting('review_request', event)] })
  const view = render(<CampaignEdit campaignKey="review_request" />)
  expect(await screen.findByText(label)).toBeTruthy()
  expect(screen.queryByText(event)).toBeNull()
  expect(view.container.querySelector('[data-template-region="preview"]')?.textContent).toContain('発送から10日後 10:00 に届きます')
})

it('誕生日は設定値を使わず固定日時と理由を示す', async () => {
  fixture.settings.mockResolvedValue({ success: true, data: [setting('birthday_coupon', 'pet.birthday')] })
  const view = render(<CampaignEdit campaignKey="birthday_coupon" />)
  expect(await screen.findByText('ペットの誕生日')).toBeTruthy()
  expect(screen.getByText('10:00（固定）')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'きっかけからの日数' })).toBeNull()
  expect(screen.queryByRole('button', { name: '送る時刻' })).toBeNull()
  expect(screen.getByRole('link', { name: 'キャンセル' }).getAttribute('href')).toBe('/nen-campaigns')
  expect(screen.getByText('架空の配信（配信を直す）')).toBeTruthy()
  expect(screen.getByText('誕生日のきっかけ・日時は配信の実行処理で固定されています。')).toBeTruthy()
  expect(view.container.querySelector('[data-template-region="preview"]')?.textContent).toContain('誕生日の3日前 10:00 に届きます')
  expect(screen.getByText('この配信は1通で届きます')).toBeTruthy()
})
