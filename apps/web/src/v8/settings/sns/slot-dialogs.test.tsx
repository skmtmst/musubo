// @vitest-environment happy-dom
/*
 * 追加・解除の窓（利用者承認の★`設定SNS連携_複数接続_第1段_v7.pen`
 * F3 `q9hcp9`・F4 `uB88I`・F5 `R4dYE`・F6 `JvuLH`）。
 *
 *  - 受入条件3：枠を超える追加は画面内の料金確認を通し、同意したときだけ認可へ進む。
 *    金額は共通の料金表（1枠 ¥3,300 税込）・無料期間は0円・追加した月は日割り。
 *    各サービス11個目は個別見積もりの案内で止める（認可へ進む口を出さない）。
 *  - 受入条件4：解除の確認で枠数の減りを示し、契約枠は変わらないと書く。
 *
 * 文言は承認デザインの原文をそのまま見る（画面で言い回しを作らない決め）。
 */

import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SNS_CONNECTION_LIMIT,
  planAddition,
  planRemoval,
  type SnsConnectionView,
  type SnsService,
  type SnsServiceSlots,
  type SnsSlotBilling,
  type SnsSlotsView,
} from './connection-slots'
import {
  SnsSlotAdditionDialog,
  SnsSlotPaidDialog,
  SnsSlotQuoteDialog,
  SnsSlotRemovalDialog,
  SnsSlotTrialDialog,
} from './slot-dialogs'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

const ACCOUNT = '見本アカウント'
const PAID: SnsSlotBilling = { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 }
const TRIAL: SnsSlotBilling = { kind: 'trialing' }

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function conn(service: SnsService, id: string, name = id): SnsConnectionView {
  return { id, service, name, meta: [], state: 'connected', primary: false, version: 1 }
}

function service(svc: SnsService, connected: number): SnsServiceSlots {
  return {
    service: svc,
    connections: Array.from({ length: connected }, (_, i) => conn(svc, `${svc}-${i + 1}`, `${svc} ${i + 1}`)),
  }
}

/**
 * `view(Google接続数, Instagram接続数, 契約枠)`。
 * 契約枠は両サービス共通の1つの数（1枠で両方が1個ずつ増える）。
 */
function view(g: number, ig: number, contracted: number): SnsSlotsView {
  return { contracted, googleBusiness: service('googleBusiness', g), instagram: service('instagram', ig) }
}

function overQuotaPlan(slots: SnsSlotsView, svc: SnsService, billing: SnsSlotBilling) {
  const plan = planAddition(slots, svc, billing)
  if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)
  return plan
}

function quotePlan(slots: SnsSlotsView, svc: SnsService) {
  const plan = planAddition(slots, svc, PAID)
  if (plan.kind !== 'individual-quote') throw new Error(`individual-quote のはずが ${plan.kind}`)
  return plan
}

function dialog() {
  return within(screen.getByRole('dialog'))
}

describe('F3 枠を超える追加・支払い中（受入条件3）', () => {
  function renderPaid(over: Partial<React.ComponentProps<typeof SnsSlotPaidDialog>> = {}) {
    const props = {
      plan: overQuotaPlan(view(1, 1, 1), 'googleBusiness', PAID),
      accountName: ACCOUNT,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      ...over,
    }
    render(<SnsSlotPaidDialog {...props} />)
    return props
  }

  it('月額の増分・増えたあとの料金・日割りの支払いを承認デザインの文言で出す', () => {
    renderPaid()
    const win = dialog()

    expect(screen.getByRole('dialog', { name: /追加連携枠の料金を確認/ })).toBeTruthy()
    expect(win.getByText(/契約枠（Googleマイビジネス 1個）を使い切っているため/)).toBeTruthy()

    expect(win.getByText('次回からの月額増分（税込）')).toBeTruthy()
    expect(win.getByText('＋¥3,300 / 月')).toBeTruthy()
    expect(
      win.getByText('Googleマイビジネス 1個 → 2個 ・ 契約枠 1個｜有料の追加枠 0枠 → 1枠'),
    ).toBeTruthy()

    expect(win.getByText('追加後の連携枠料金（税込）')).toBeTruthy()
    expect(win.getByText('¥3,300 / 月')).toBeTruthy()

    // 残り日数はサーバーの値をそのまま書き、支払いは日割り（15/30日 → ¥1,650）。
    expect(win.getByText('今回の追加分（次の月次請求まで残り15/30日の見込み）')).toBeTruthy()
    expect(win.getByText('決済成功時のお支払い ¥1,650（税込）')).toBeTruthy()
  })

  it('すでに有料枠があるときは増えたあとの合計を出す', () => {
    renderPaid({ plan: overQuotaPlan(view(3, 3, 3), 'instagram', PAID) })
    const win = dialog()

    expect(win.getByText('＋¥3,300 / 月')).toBeTruthy()
    // 多いほうが4個になるので3枠（契約枠3個 = すでに2枠ぶん）。
    expect(win.getByText('¥9,900 / 月')).toBeTruthy()
    expect(win.getByText('Instagram 3個 → 4個 ・ 契約枠 3個｜有料の追加枠 2枠 → 3枠')).toBeTruthy()
  })

  it('同意したときだけ認可へ進み、戻るでは進まない', () => {
    const props = renderPaid()

    fireEvent.click(dialog().getByRole('button', { name: '戻る' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()

    fireEvent.click(dialog().getByRole('button', { name: '料金に同意して連携へ' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('決済が失敗したときはその場に知らせを出す', () => {
    renderPaid({ error: 'カードの決済に失敗しました。' })
    expect(dialog().getByText('カードの決済に失敗しました。')).toBeTruthy()
  })
})

describe('F4 枠を超える追加・無料期間（受入条件3）', () => {
  it('追加料金0円と、無料期間が終わったあとの料金を出す', () => {
    render(
      <SnsSlotTrialDialog
        plan={overQuotaPlan(view(1, 1, 1), 'instagram', TRIAL)}
        accountName={ACCOUNT}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    const win = dialog()

    expect(screen.getByRole('dialog', { name: /追加料金はかかりません/ })).toBeTruthy()
    expect(win.getByText('追加枠の料金は0円です')).toBeTruthy()
    expect(win.getByText('追加料金 ¥0')).toBeTruthy()
    expect(win.getByText('無料期間終了後の連携枠料金（税込）')).toBeTruthy()
    expect(win.getByText('¥3,300 / 月')).toBeTruthy()
    expect(win.getByText('今回のお支払い')).toBeTruthy()
    expect(win.getByText('¥0｜無料期間中のため今は請求しません')).toBeTruthy()
    // 英字で終わるサービス名のうしろに空白を1つ置く（承認デザインの表記）。
    expect(win.getByRole('button', { name: 'Instagram の連携へ' })).toBeTruthy()
  })

  it('枠超過の窓は無料期間なら F4、支払い中なら F3 を選ぶ', () => {
    const base = {
      accountName: ACCOUNT,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }

    const { unmount } = render(
      <SnsSlotAdditionDialog plan={overQuotaPlan(view(1, 0, 1), 'googleBusiness', TRIAL)} {...base} />,
    )
    expect(screen.getByRole('dialog', { name: /追加料金はかかりません/ })).toBeTruthy()
    unmount()

    render(<SnsSlotAdditionDialog plan={overQuotaPlan(view(1, 0, 1), 'googleBusiness', PAID)} {...base} />)
    expect(screen.getByRole('dialog', { name: /追加連携枠の料金を確認/ })).toBeTruthy()
  })
})

describe('F5 11個目の個別見積もり（受入条件3）', () => {
  it('上限といまの連携数・契約枠を出し、認可へ進む口は置かない', () => {
    const slots = view(SNS_CONNECTION_LIMIT, 2, 2)
    const onContact = vi.fn()
    render(
      <SnsSlotQuoteDialog
        plan={quotePlan(slots, 'googleBusiness')}
        slots={slots}
        onCancel={vi.fn()}
        onContact={onContact}
      />,
    )
    const win = dialog()

    expect(screen.getByRole('dialog', { name: /追加の連携は個別見積もりになります/ })).toBeTruthy()
    expect(win.getByText(/上限の10個に達しています。11個目からは料金を個別にお見積もりします/)).toBeTruthy()

    expect(win.getByText('いまの連携数')).toBeTruthy()
    // 上限に達したほうにだけ（上限）を付ける。
    expect(win.getByText('Googleマイビジネス 10個（上限）・ Instagram 2個')).toBeTruthy()
    expect(win.getByText('契約枠：Googleマイビジネス 2個 ・ Instagram 2個')).toBeTruthy()

    // 「連携へ」進むボタンは無く、問い合わせだけ。
    expect(win.queryByRole('button', { name: /連携へ/ })).toBeNull()
    // 窓の×と同じことばになるので、どちらかがあればよい。
    expect(win.getAllByRole('button', { name: '閉じる' }).length).toBeGreaterThan(0)
    fireEvent.click(win.getByRole('button', { name: 'お問い合わせへ' }))
    expect(onContact).toHaveBeenCalledTimes(1)
  })
})

describe('F6 解除の確認（受入条件4）', () => {
  function removal(slots: SnsSlotsView, svc: SnsService, index: number) {
    return planRemoval(slots, svc, slots[svc].connections[index]!)
  }

  it('解除する1件・連携数の減り・契約枠は変わらないことを書く', () => {
    const slots = view(3, 2, 2)
    render(
      <SnsSlotRemovalDialog
        plan={removal(slots, 'googleBusiness', 2)}
        accountName={ACCOUNT}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    const win = dialog()

    expect(screen.getByRole('dialog', { name: /Google ビジネスの接続を解除しますか？/ })).toBeTruthy()
    // ほかの連携と LINE の接続は続く（データは消えない）。
    expect(win.getByText(/ほかの連携と LINE\s*の接続は続きます/)).toBeTruthy()

    expect(win.getByText('LINEアカウント')).toBeTruthy()
    expect(win.getByText(ACCOUNT)).toBeTruthy()
    expect(win.getByText('解除する連携先')).toBeTruthy()
    expect(win.getByText('googleBusiness 3（Google ビジネス）')).toBeTruthy()
    expect(win.getByText('Googleマイビジネスの連携数')).toBeTruthy()
    expect(win.getByText('3個 → 2個')).toBeTruthy()
    expect(win.getByText('契約枠')).toBeTruthy()
    expect(win.getByText('2個（変わりません）')).toBeTruthy()
    expect(win.getByText('有料の追加連携枠')).toBeTruthy()
    // 多いほうが3個→2個に減るので、有料枠も1枠減る。
    expect(win.getByText('2枠 → 1枠')).toBeTruthy()
  })

  it('次回の請求日が分かるときだけ減額の箱を出す', () => {
    const slots = view(3, 2, 2)
    const plan = removal(slots, 'googleBusiness', 2)
    const base = { plan, accountName: ACCOUNT, onCancel: vi.fn(), onConfirm: vi.fn() }

    // 請求日が分からないあいだは金額も日付も作らない。
    const { unmount } = render(<SnsSlotRemovalDialog {...base} nextBillingLabel={null} />)
    expect(screen.queryByText('次回の月次請求から')).toBeNull()
    unmount()

    render(<SnsSlotRemovalDialog {...base} nextBillingLabel="12月1日" />)
    const win = dialog()
    expect(win.getByText('次回の月次請求から')).toBeTruthy()
    expect(win.getByText('−¥3,300 / 月（税込）')).toBeTruthy()
    expect(
      win.getByText('12月1日から1枠あたり¥3,300の減額を反映します。今回分の返金はありません。'),
    ).toBeTruthy()
  })

  it('多いほうの連携数が変わらない解除では減額の箱を出さない', () => {
    const slots = view(2, 2, 2)
    render(
      <SnsSlotRemovalDialog
        plan={removal(slots, 'googleBusiness', 1)}
        accountName={ACCOUNT}
        nextBillingLabel="12月1日"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    // Instagram が2個のままなので、多いほうは2個で変わらない。
    expect(dialog().getByText('1枠 → 1枠')).toBeTruthy()
    expect(screen.queryByText('次回の月次請求から')).toBeNull()
  })

  it('解除するで進み、戻るでは進まない', () => {
    const slots = view(2, 2, 2)
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <SnsSlotRemovalDialog
        plan={removal(slots, 'instagram', 0)}
        accountName={ACCOUNT}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(dialog().getByRole('button', { name: '戻る' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(dialog().getByRole('button', { name: '解除する' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
