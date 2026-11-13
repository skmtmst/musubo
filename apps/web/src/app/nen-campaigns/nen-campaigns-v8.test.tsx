// @vitest-environment happy-dom
/*
 * ★V8-B NEN配信（・・・）の骨格。
 * データの持ち方は 管理画面（page.tsx）と同じ。ここでは見せ方だけを見る。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

import NenCampaignsV8 from '@/v8/nen-campaigns/list'
import type { NenCampaignsListProps as NenOverviewProps } from '@/v8/nen-campaigns/list'

const baseProps: NenOverviewProps = {
  tab: 'auto',
  topAction: null,
  onTabChange: () => undefined,
  settings: [
    {
      campaignKey: 'review_request', label: '口コミのお願い', category: 'follow_up',
      triggerEvent: 'ec.order.delivered', delayDays: 10, deliveryTime: '10:00:00',
      isEnabled: true, title: '口コミ', bodyText: '本文', buttonLabel: null,
      buttonUrl: null, imageUrl: null, dedupWindowDays: 30, excludeFormRespondents: true,
      afterActions: [], formIssue: null, updatedAt: 'v1',
    },
    {
      campaignKey: 'birthday_coupon', label: 'お誕生日クーポン', category: 'birthday',
      triggerEvent: 'pet.birthday', delayDays: 3, deliveryTime: '10:00:00',
      isEnabled: false, title: '誕生日', bodyText: '本文', buttonLabel: null,
      buttonUrl: null, imageUrl: null, dedupWindowDays: 0, excludeFormRespondents: false,
      afterActions: [], formIssue: null, updatedAt: 'v1',
    },
  ],
  columns: [
    {
      id: 'c1', externalId: null, slug: 'aki', title: '秋の食事、量はどれくらい？',
      category: '季節のこと', excerpt: '概要', introText: '', articleUrl: 'https://example.com/a',
      imageUrl: null, publishedAt: '2026-09-26T00:00:00+09:00', deliveryStatus: 'sent',
      deliveryAt: null, lineAccountId: 'account-a', updatedAt: 'v1',
      targetMode: 'all', targetTagId: null, completionEventName: null,
      completionTagId: null, sourceColumnId: null,
    },
  ],
  columnsTotal: 1,
  kpis: {
    monthLabel: '9月', sentThisMonth: 1820, sentLastMonth: 1580, openRate: 64,
    orders: null, orderAmount: null, undelivered: null, blocked: 1, unfollowed: 2,
  },
  flowMetrics: {
    range: { from: '2026-09-01', to: '2026-09-30', days: 30 },
    summary: { active: 1, paused: 1, planned: 0, sent: 1820, associatedConversions: 0, associatedConversionAmount: 0 },
    flows: [
      {
        campaignKey: 'review_request', label: '口コミのお願い', category: 'follow_up',
        isEnabled: true, planned: 0, sent: 241, failed: 0, skipped: 0, openRate: { value: null, state: 'unavailable', reason: null },
        associatedConversions: 0, associatedConversionAmount: 0, attribution: '',
      },
    ],
  },
  columnMetrics: {
    range: { from: '2026-09-01', to: '2026-09-30', days: 30 },
    summary: { total: 1, sent: 1, drafts: 0, scheduled: 0, unread: null, associatedConversions: 0, associatedConversionAmount: 0 },
    columns: [
      {
        id: 'c1', title: '秋の食事', category: '季節のこと', deliveryStatus: 'sent',
        publishedAt: '2026-09-26T00:00:00+09:00', deliveryAt: null,
        period: { from: null, to: null }, targeted: 100, sent: 100, pending: 0, failed: 0,
        articleOpened: { value: 60, rate: 60, state: 'available', reason: null },
        unread: null, completionRate: { value: null, rate: null, state: 'unavailable', reason: null },
        associatedConversions: 0, associatedConversionAmount: 0, attribution: '',
      },
    ],
  },
  deliveryList: {
    range: { from: '2026-09-01', to: '2026-09-30', days: 30 },
    summary: {
      pending: 0, processing: 0, sent: 1, skipped: 0, failed: 1, cancelled: 0,
      retryRequired: 0, unmetReasons: {}, skippedReasons: {},
    },
    deliveries: [
      {
        id: 'd1', campaignKey: 'review_request', label: '口コミのお願い',
        friendId: 'f1', friendName: '見本 169', lineAccountName: 'ACC',
        scheduledAt: '2026-09-30T10:00:00+09:00', sentAt: null, status: 'failed',
        attempts: 5, unmetReason: '通信の混雑', unmetReasonCode: null,
        reaction: { value: null, state: 'unavailable', reason: '取得不可' },
        version: 1, updatedAt: 'v1',
      },
    ],
    pagination: { total: 1, limit: 20, cursor: '0', nextCursor: null },
  },
  deliveryDetail: null,
  friends: [],
  testFriendId: '',
  onTestFriendChange: () => undefined,
  accountId: 'account-a',
  loading: false,
  tabError: '',
  onRetryTab: () => undefined,
  kpisFailed: false,
  notice: null,
  saving: null,
  testing: null,
  previewCampaignKey: null,
  onPreviewCampaign: () => undefined,
  onToggleSetting: () => undefined,
  onTestSend: () => undefined,
  coupon: { isEnabled: false, codePrefix: '', benefitLabel: '', discountAmount: 0, validityDays: 0, leapYearPolicy: 'feb28' as const },
  couponOpen: false,
  onCouponOpenChange: () => undefined,
  onCouponChange: () => undefined,
  onSaveCoupon: () => undefined,
  savingCoupon: false,
  selectedColumnId: null,
  onSelectColumn: () => undefined,
  audienceCount: null,
  plan: { when: 'now', scheduledAt: '' },
  onPlanChange: () => undefined,
  introDraft: '',
  onIntroChange: () => undefined,
  onSaveIntro: () => undefined,
  savingColumnId: null,
  onDeliverColumn: () => undefined,
  onDuplicateColumn: () => undefined,
  duplicatingColumnId: null,
  onTestColumn: () => undefined,
  onShowDelivery: () => undefined,
  onRetryDelivery: () => undefined,
  onChangeDeliveryView: () => undefined,
}

afterEach(cleanup)

describe('NEN配信 V8', () => {
  it('自動配信は MuhWR の印で表と札を出す', () => {
    const { container } = render(<NenCampaignsV8 {...baseProps} tab="auto" />)
    expect(container.querySelector('[data-design-node="MuhWR"]')).toBeTruthy()
    const heads = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    for (const head of ['配信', 'きっかけ', '対象', '9月 送信', '注文', '状態', '操作']) {
      expect(heads).toContain(head)
    }
    expect(screen.getByText('口コミのお願い')).toBeTruthy()
    expect(screen.getByTitle('止めている配信だけ出します')).toBeTruthy()
  })

  it('コラムは Jxmqh の印で表を出す', () => {
    const { container } = render(<NenCampaignsV8 {...baseProps} tab="columns" />)
    expect(container.querySelector('[data-design-node="Jxmqh"]')).toBeTruthy()
    const heads = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    for (const head of ['コラム', '分類', '公開日', 'LINE 配信', '閲覧']) {
      expect(heads).toContain(head)
    }
    expect(screen.getByText('秋の食事、量はどれくらい？')).toBeTruthy()
  })

  it('送った履歴は Tj7n4 の印で表と再送の導線を出す', () => {
    const { container } = render(<NenCampaignsV8 {...baseProps} tab="history" />)
    expect(container.querySelector('[data-design-node="Tj7n4"]')).toBeTruthy()
    const heads = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    for (const head of ['いつ・だれに', '配信', '状態', 'きっかけ', '開封']) {
      expect(heads).toContain(head)
    }
    expect(screen.getByText('見本 169', { exact: false })).toBeTruthy()
  })
})

it('選んだコラムの紹介文を入力でき、変更を保存側へ渡す',()=>{
 const change=vi.fn()
 render(<NenCampaignsV8 {...baseProps} tab="columns" selectedColumnId="c1" introDraft="元の紹介文" onIntroChange={change}/>)
 const input=screen.getByRole('textbox',{name:'LINE に出る紹介文'}) as HTMLTextAreaElement
 expect(input.value).toBe('元の紹介文')
 fireEvent.change(input,{target:{value:'新しい紹介文'}})
 expect(change).toHaveBeenCalledWith('新しい紹介文')
})
