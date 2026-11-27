// @vitest-environment happy-dom
/*
 * V8 統括の請求（src/v8/hq/billing.tsx・板 ）の動きの試験（2026-10-08 オーナー）。
 * いま契約しているプランに「利用中」と押せない［いまのプラン］、ほかのカードに［このプランに変える］。
 * 課金の対象外でも API がプランを返せばそれを「利用中」にする。変えるボタンはオーナーだけ。
 * 押すと確認の窓を出し、確定は今ある口（支払いの管理＝Stripe の画面／運営へのお問い合わせ）へ渡す。
 * 申込（checkout）は新しく呼ばない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillingPlanView, BillingSummary } from '@/lib/hq-billing'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const summary = vi.hoisted(() => vi.fn())
const invoices = vi.hoisted(() => vi.fn())
const checkout = vi.hoisted(() => vi.fn())
const portal = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const metrics = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/helpers/hq-billing', () => ({ fetchHqBillingMetrics: metrics }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return { ...actual, api: { ...actual.api, hqBilling: { summary, invoices, checkout, portal } } }
})
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...(await importOriginal()),
  useStaffRole: () => role.value,
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/billing',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

import HqBillingV8 from './billing'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const plan = (key: BillingPlanView['key'], name: string, current = false): BillingPlanView => ({
  key, name, description: `${name}の説明`, cta: 'checkout', monthlyYen: 9800, yearlyYen: 99000,
  priceFromStripe: true, yearlyPriceFromStripe: true, monthlyImages: 50, maxStaff: 3, features: ['LINE公式アカウント 1'],
  recommended: key === 'standard', available: true, yearlyAvailable: true, current,
})

const baseSummary = (over: Partial<BillingSummary>): BillingSummary => ({
  state: 'active', planKey: 'standard', planInterval: 'month', planName: 'スタンダード', planStatus: 'active',
  trialEndsAt: null, trialEndsLabel: null, trialDaysLeft: null, trialMonthlyImages: 0,
  currentPeriodEndsAt: '2026-11-01T00:00:00Z', currentPeriodEndsLabel: '11/1（日）', canSend: true, canGenerate: true,
  blockedReason: null, dataRetentionDays: 90, stripeReady: true, portalAvailable: true,
  plans: [plan('light', 'ライト'), plan('standard', 'スタンダード', true), plan('pro', 'プロ')],
  ...over,
})

let root: Root | null = null

const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() }) }
const render = async (data: BillingSummary, who: string | null = 'owner') => {
  role.value = who
  summary.mockResolvedValue({ success: true, data })
  invoices.mockResolvedValue({ success: true, data: [] })
  portal.mockResolvedValue({ success: true, data: { url: 'https://billing.stripe.test/session' } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<HqBillingV8 />) })
  await flush()
}
const cards = () => Array.from(document.querySelectorAll('section')).filter((s) => s.querySelector('h2') && s.textContent?.includes('の説明'))
const card = (name: string) => cards().find((s) => s.querySelector('h2')?.textContent === name)!
const buttonsIn = (el: Element) => Array.from(el.querySelectorAll('button')).map((b) => ({ text: b.textContent?.trim(), disabled: b.disabled }))
const buttonByText = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined

beforeEach(() => {
  metrics.mockResolvedValue({ success: true, data: {
    thisMonthBilledYen: null, contractCount: 1, activeAccountCount: 5,
    trialCount: 0, unpaidInvoiceCount: null, nextBillingAt: null,
  } })
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('V8 統括の請求：いまのプランと変えるボタン', () => {
  it('集計の項目が届かなければ未取得を出し、欠けた数を文字列や0で表示しない', async () => {
    metrics.mockResolvedValue({ success: true, data: {} })
    await render(baseSummary({}))
    const band = document.querySelector('[data-template-region="stats"]')!
    expect(band.textContent).toContain('未取得')
    expect(band.textContent).not.toContain('undefined')
    expect(band.textContent).not.toContain('NaN')
    expect(band.textContent).not.toContain('0アカウント')
  })

  it('保存済み集計を表示し、実測0・未取得・統括単位の契約を区別する', async () => {
    metrics.mockResolvedValue({ success: true, data: {
      thisMonthBilledYen: 0, contractCount: 1, activeAccountCount: 5,
      trialCount: 0, unpaidInvoiceCount: 0, nextBillingAt: '2026-11-01T00:00:00+09:00',
    } })
    await render(baseSummary({}))
    const band = document.querySelector('[data-template-region="stats"]')!
    expect(band.textContent).toContain('¥0')
    expect(band.textContent).toContain('1契約')
    expect(band.textContent).toContain('稼働中 5アカウント')
    expect(band.textContent).toContain('0件')
    expect(band.textContent).toContain('11/01')
    expect(band.textContent).not.toContain('未取得')
  })

  it('集計だけ失敗してもプランを残し、再読込後は未取得を0にしない', async () => {
    metrics.mockRejectedValueOnce(new Error('offline'))
    await render(baseSummary({}))
    expect(card('スタンダード').textContent).toContain('利用中')
    expect(document.body.textContent).toContain('読み込めませんでした')
    const retry = document.querySelector('[data-template-region="stats"] button') as HTMLButtonElement
    expect(retry).not.toBeNull()
    await act(async () => retry.click())
    await flush()
    expect(metrics).toHaveBeenCalledTimes(2)
    const band = document.querySelector('[data-template-region="stats"]')!
    expect(band.textContent).toContain('今月の請求は未取得')
    expect(band.textContent).toContain('請求の記録は未取得')
    expect(band.textContent).not.toContain('¥0')
  })

  it('閲覧のみには集計の管理者専用APIを呼ばず、プラン閲覧は維持する', async () => {
    await render(baseSummary({}), 'viewer')
    expect(metrics).not.toHaveBeenCalled()
    expect(card('スタンダード').textContent).toContain('利用中')
    expect(document.querySelector('[data-template-region="stats"]')).toBeNull()
  })

  it('契約中：いまのプランに「利用中」と押せない［いまのプラン］、ほかは［このプランに変える］', async () => {
    await render(baseSummary({}))
    const current = card('スタンダード')
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(current.textContent).toContain('利用中')
    expect(buttonsIn(current)).toEqual([{ text: 'いまのプラン', disabled: true }])
    for (const name of ['ライト', 'プロ']) {
      expect(card(name).textContent).not.toContain('利用中')
      expect(buttonsIn(card(name))).toEqual([{ text: 'このプランに変更する', disabled: false }])
    }
    expect(document.body.textContent).toContain('いまのプラン：スタンダード（月払い ¥9,800）・次回の更新日 11/1（日）')
  })

  it('［このプランに変える］は確認の窓を出し、確定で支払いの管理（Stripe の画面）を開く。申込は呼ばない', async () => {
    await render(baseSummary({}))
    await act(async () => { card('プロ').querySelector('button')!.click() })
    await flush()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('プロに変えますか')
    expect(dialog.textContent).toContain('差額と適用日')
    expect(portal).not.toHaveBeenCalled()
    await act(async () => { buttonByText('Stripe の画面を開く')!.click() })
    await flush()
    expect(portal).toHaveBeenCalledTimes(1)
    expect(checkout).not.toHaveBeenCalled()
  })

  it('課金の対象外でも API がプランを返せば「利用中」。変えるのは運営へのお問い合わせへ渡す', async () => {
    await render(baseSummary({
      state: 'exempt', planStatus: 'exempt', planKey: 'standard', planName: 'スタンダード', portalAvailable: false,
      plans: [plan('light', 'ライト'), plan('standard', 'スタンダード'), plan('pro', 'プロ')],
    }))
    expect(card('スタンダード').textContent).toContain('利用中')
    expect(buttonsIn(card('スタンダード'))).toEqual([{ text: 'いまのプラン', disabled: true }])
    expect(buttonsIn(card('ライト'))).toEqual([{ text: 'このプランに変更する', disabled: false }])
    expect(document.body.textContent).toContain('いまのプラン：スタンダード（課金の対象外）')
    await act(async () => { card('ライト').querySelector('button')!.click() })
    await flush()
    await act(async () => { buttonByText('お問い合わせへ')!.click() })
    await flush()
    expect(push).toHaveBeenCalledWith('/hq/support')
    expect(checkout).not.toHaveBeenCalled()
    expect(portal).not.toHaveBeenCalled()
  })

  it('課金の対象外で API がプランを返さないときは「利用中」を出さず、ボタンは［このプランにする］', async () => {
    await render(baseSummary({
      state: 'exempt', planStatus: 'exempt', planKey: null, planName: null, planInterval: null, portalAvailable: false,
      plans: [plan('light', 'ライト'), plan('standard', 'スタンダード'), plan('pro', 'プロ')],
    }))
    expect(document.body.textContent).not.toContain('利用中')
    expect(document.body.textContent).toContain('課金の対象外です。この統括は運営用のため')
    for (const name of ['ライト', 'スタンダード', 'プロ']) {
      expect(buttonsIn(card(name))).toEqual([{ text: 'このプランにする', disabled: false }])
    }
  })

  it.each(['admin', 'viewer'])('オーナー以外（%s）には変えるボタンを出さない（いまのプランの印は出す）', async (who) => {
    await render(baseSummary({}), who)
    expect(card('スタンダード').textContent).toContain('利用中')
    expect(buttonsIn(card('ライト'))).toEqual([])
    expect(buttonsIn(card('プロ'))).toEqual([])
    expect(buttonByText('このプランに変更する')).toBeUndefined()
  })
})
