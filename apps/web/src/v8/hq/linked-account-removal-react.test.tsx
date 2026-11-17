// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkedAccountRemoval, { type LinkedAccountRemovalView } from './linked-account-removal'

let host: HTMLDivElement
let root: Root
const onRemove = vi.fn(async () => {})
const onBack = vi.fn()
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); onRemove.mockClear(); onBack.mockClear() })
afterEach(() => { act(() => root.unmount()); host.remove() })

const view: LinkedAccountRemovalView = {
  phase: 'confirm', lineName: 'musubo店舗', service: 'googleBusiness', linkedAccountName: '銀座店',
  before: { googleBusiness: 3, instagram: 2 }, after: { googleBusiness: 2, instagram: 2 },
  linkedAccountSlotYen: 3300, nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', billingInterval: 'year',
}

describe('追加連携枠の解除', () => {
  it('連携数が3個から2個なら即時停止と翌月の減額を別々に表示する', async () => {
    await act(async () => root.render(<LinkedAccountRemoval view={view} onRemove={onRemove} onBack={onBack} />))
    expect(host.textContent).toContain('Googleマイビジネス')
    expect(host.textContent).toContain('3個 → 2個')
    expect(host.textContent).toContain('2枠 → 1枠')
    expect(host.textContent).toContain('−¥3,300')
    expect(host.textContent).toContain('解除後すぐ')
    expect(host.textContent).toContain('2027年2月8日')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'この連携を解除する')!.click() })
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('少ないほうを解除しても追加枠が減らなければ料金は変えない', async () => {
    await act(async () => root.render(<LinkedAccountRemoval view={{ ...view, service: 'instagram', before: { googleBusiness: 3, instagram: 2 }, after: { googleBusiness: 3, instagram: 1 } }} onRemove={onRemove} onBack={onBack} />))
    expect(host.textContent).toContain('料金変更なし')
    expect(host.textContent).toContain('2枠 → 2枠')
  })

  it('解除完了後は次回請求までの枠再利用を案内する', async () => {
    await act(async () => root.render(<LinkedAccountRemoval view={{ ...view, phase: 'complete' }} onRemove={onRemove} onBack={onBack} />))
    expect(host.textContent).toContain('解除済み')
    expect(host.textContent).toContain('次回の月次請求までは、お支払い済みの追加枠に別の連携先を設定できます')
  })
})
