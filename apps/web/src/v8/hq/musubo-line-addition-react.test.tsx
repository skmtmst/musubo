// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/transport/errors'
import type { MusuboLineAdditionPending, MusuboLineAdditionState } from '@/lib/api/features/musubo-line-addition'
import MusuboLineAddition from './musubo-line-addition'

const nav = vi.hoisted(() => ({ query: '', push: vi.fn(), replace: vi.fn() }))
const calls = vi.hoisted(() => ({ get: vi.fn(), reconcile: vi.fn(), accept: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.query),
}))
vi.mock('@/lib/api', async () => ({
  ApiError: (await import('@/lib/api/transport/errors')).ApiError,
  api: { musuboLineAddition: calls },
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/components/step-up-prompt', () => ({
  default: ({ request }: { request: { retry: (key: string) => void } }) =>
    <button type="button" onClick={() => request.retry('test-step-up')}>本人確認を完了する</button>,
  isStepUpRequired: (error: { code?: string }) => error.code === 'STEP_UP_REQUIRED',
}))

const pending: MusuboLineAdditionPending = {
  id: 'addition-one', lineAccountId: 'line-one', status: 'awaiting_payment', amountDueYen: 6700,
  expiresAt: '2099-01-20T18:00:00+09:00', canConnect: false, activationPending: false,
  paymentUrl: 'https://invoice.stripe.com/test',
}
const paid: MusuboLineAdditionPending = { ...pending, status: 'paid', activationPending: true, paymentUrl: null }
const activated: MusuboLineAdditionPending = { ...pending, status: 'activated', paymentUrl: null }
const quote: MusuboLineAdditionState = {
  activeLineCount: 1,
  price: {
    addedLineOrdinal: 2, coreIncrementYen: 7900, coreIncrementInterval: 'month',
    headquartersIncrementMonthlyYen: 5500, dueNowYen: 6700, contractedLineCapacity: 2,
  },
  recurringAfter: { coreYen: 13800, coreInterval: 'month', optionsYen: 5500 },
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.resetAllMocks()
  nav.query = '?accountId=line-one'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function button(label: string) {
  return Array.from(host.querySelectorAll('button')).find(element => element.textContent === label)
}
function link(label: string) {
  return Array.from(host.querySelectorAll('a')).find(element => element.textContent === label)
}
async function render() {
  await act(async () => { root.render(<MusuboLineAddition />) })
}

describe('決済後に同じLINEの登録を再開', () => {
  it('未払いから既存のStripe請求へ進め、更新には再請求を使わない', async () => {
    calls.get.mockResolvedValue({ success: true, data: { ...quote, addition: pending } })
    calls.reconcile.mockResolvedValue({ success: true, data: activated })
    await render()
    expect(calls.get).toHaveBeenCalledWith({ accountId: 'line-one' })
    expect(host.textContent).toContain('LINE追加のお支払いが未完了です')
    expect(link('Stripeでお支払いを確認')?.getAttribute('href')).toBe(pending.paymentUrl)
    expect(link('LINE登録を続ける')).toBeUndefined()
    await act(async () => { button('決済状況を更新')!.click() })
    expect(calls.reconcile).toHaveBeenCalledExactlyOnceWith({ additionId: 'addition-one' })
    expect(calls.accept).not.toHaveBeenCalled()
    expect(host.textContent).toContain('追加したLINEを利用できます')
    expect(link('LINE登録を続ける')?.getAttribute('href')).toBe('/accounts/new?resume=line-one')
    expect(link('Stripeでお支払いを確認')).toBeUndefined()
  })

  it('決済反映待ちの更新に失敗しても同じ対象で再試行できる', async () => {
    calls.get.mockResolvedValue({ success: true, data: { ...quote, addition: paid } })
    calls.reconcile.mockRejectedValueOnce(new ApiError(409)).mockResolvedValueOnce({ success: true, data: activated })
    await render()
    expect(host.textContent).toContain('追加分のお支払いを確認しています')
    expect(link('Stripeでお支払いを確認')).toBeUndefined()
    await act(async () => { button('決済状況を更新')!.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('決済状況を確認できませんでした')
    await act(async () => { button('決済状況を更新')!.click() })
    expect(calls.reconcile.mock.calls).toEqual([[{ additionId: 'addition-one' }], [{ additionId: 'addition-one' }]])
    expect(calls.accept).not.toHaveBeenCalled()
    expect(link('LINE登録を続ける')?.getAttribute('href')).toBe('/accounts/new?resume=line-one')
  })

  it('決済済みでページを再読込しても次の追加へ進まず、保存済みの対象を再開する', async () => {
    nav.query = '?additionId=addition-one'
    calls.get.mockResolvedValue({ success: true, data: { ...quote, activeLineCount: 2, addition: activated } })
    await render()
    expect(calls.get).toHaveBeenCalledExactlyOnceWith({ additionId: 'addition-one' })
    expect(link('LINE登録を続ける')?.getAttribute('href')).toBe('/accounts/new?resume=line-one')
    expect(button('確認してLINE接続へ')).toBeUndefined()
    expect(calls.reconcile).not.toHaveBeenCalled()
    expect(calls.accept).not.toHaveBeenCalled()
  })

  it('URLのアカウントと一致しない決済済み情報を再開しない', async () => {
    calls.get.mockResolvedValue({ success: true, data: { ...quote, addition: { ...activated, lineAccountId: 'other-line' } } })
    await render()
    expect(host.textContent).toContain('登録を再開できませんでした')
    expect(link('アカウント一覧へ')?.getAttribute('href')).toBe('/accounts')
    expect(link('LINE登録を続ける')).toBeUndefined()
    expect(calls.reconcile).not.toHaveBeenCalled()
  })

  it('一覧から保留中の決済を開いたときも同じ追加をURLに保持する', async () => {
    nav.query = ''
    calls.get.mockResolvedValue({ success: true, data: { ...quote, pending } })
    await render()
    expect(nav.replace).toHaveBeenCalledWith('/hq/billing/line-addition?additionId=addition-one')
    expect(button('決済状況を更新')).toBeDefined()
  })

  it('追加の新規申し込みには従来の本人確認を使う', async () => {
    nav.query = ''
    calls.get.mockResolvedValue({ success: true, data: quote })
    calls.accept.mockRejectedValueOnce(new ApiError(401, undefined, 'STEP_UP_REQUIRED'))
      .mockResolvedValueOnce({ success: true, data: { ...pending, lineAccountId: null, canConnect: true } })
    await render()
    await act(async () => { button('確認してLINE接続へ')!.click() })
    await act(async () => { button('本人確認を完了する')!.click() })
    expect(calls.accept.mock.calls).toEqual([
      [{ activeLineCount: 1, amountDueYen: 6700 }, undefined],
      [{ activeLineCount: 1, amountDueYen: 6700 }, 'test-step-up'],
    ])
    expect(nav.push).toHaveBeenCalledWith('/accounts/new')
    expect(calls.reconcile).not.toHaveBeenCalled()
  })
})
