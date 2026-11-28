// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1',
  style: 'restaurant',
  buttons: [
    { label: '予約する', feature: 'booking' },
    { label: 'お知らせ', feature: 'broadcasts' },
    { label: 'メニュー', feature: 'forms' },
    { label: 'クーポン', feature: 'coupons' },
    { label: 'スタンプ', feature: 'stamps' },
    { label: '地図', feature: 'location' },
    { label: '追加ボタン', feature: 'toString' },
  ],
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.accountId }) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/hooks/use-account-style', async (original) => ({
  ...await original<typeof import('@/hooks/use-account-style')>(),
  useAccountStyle: () => ({ data: { style: fx.style }, error: null, stale: false, status: 'ready', reload: vi.fn() }),
}))
vi.mock('@/v8/onboarding/public/use-starter-menu/index', () => ({
  useStarterMenu: () => ({ buttons: fx.buttons, loading: false, error: null, reload: vi.fn() }),
}))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: {
    starterSet: vi.fn(async () => ({ success: true, data: { definition: { items: [] } } })),
    starterItems: vi.fn(async () => ({ success: true, data: { items: [] } })),
    warnings: vi.fn(async () => ({ success: true, data: { items: [] } })),
  },
}))

import RichMenuSampleV8 from './sample'

beforeEach(() => {
  fx.accountId = 'acc-1'
  fx.style = 'restaurant'
  fx.buttons = [
    { label: '予約する', feature: 'booking' },
    { label: 'お知らせ', feature: 'broadcasts' },
    { label: 'メニュー', feature: 'forms' },
    { label: 'クーポン', feature: 'coupons' },
    { label: 'スタンプ', feature: 'stamps' },
    { label: '地図', feature: 'location' },
    { label: '追加ボタン', feature: 'toString' },
  ]
})

afterEach(() => cleanup())

describe('RichMenuSampleV8 選択範囲外・面番号超過・プロトタイプキー防御', () => {
  it('7個目のボタンでも面ラベルに undefined を出さず、ボタン数が少ないスタイルへ切り替わっても押したとき欄が消えない', () => {
    const view = render(<RichMenuSampleV8 />)

    // 7個目のボタン（feature: 'toString'）を選ぶ
    fireEvent.click(screen.getAllByRole('button', { name: '追加ボタン' })[0])
    expect(screen.getByText('押したとき（7 追加ボタン）')).toBeTruthy()
    expect(document.body.textContent).not.toContain('undefined')

    // ボタン数が2個だけの別アカウント・スタイルへ切り替える
    fx.accountId = 'acc-2'
    fx.style = 'lesson'
    fx.buttons = [
      { label: 'レッスン予約', feature: 'booking' },
      { label: 'お知らせ一覧', feature: 'broadcasts' },
    ]
    view.rerender(<RichMenuSampleV8 />)

    // 選択位置が範囲外のまま消えず、先頭ボタンのプレビューへ戻る
    expect(screen.getByText('押したとき（A レッスン予約）')).toBeTruthy()
  })
})
