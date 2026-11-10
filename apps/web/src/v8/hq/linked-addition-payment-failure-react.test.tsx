// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkedAdditionPaymentFailure from './linked-addition-payment-failure'

let host: HTMLDivElement
let root: Root
const onRetry = vi.fn(async () => {})
const onCancel = vi.fn()
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); onRetry.mockClear(); onCancel.mockClear() })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('追加連携枠の決済失敗', () => {
  it('新しい連携だけ保留し、既存利用を継続する案内と日割り額を示す', async () => {
    await act(async () => { root.render(<LinkedAdditionPaymentFailure view={{
      lineName: '公式LINE A', service: 'googleBusiness', addedOrdinal: 2, activeServiceCount: 1,
      amountYen: 1_650, monthlyIncreaseYen: 3_300, monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30,
    }} onRetry={onRetry} onCancel={onCancel} />) })
    expect(host.textContent).toContain('Googleマイビジネス2個目の連携は有効化待ち')
    expect(host.textContent).toContain('既存のLINEと連携先は通常どおり利用できます')
    expect(host.textContent).toContain('¥1,650')
    expect(host.textContent).toContain('＋¥3,300／月')
    expect(host.textContent).toContain('musuboには保存しません')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'カードを確認して再試行')!.click() })
    expect(onRetry).toHaveBeenCalledOnce()
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '追加を取り消す')!.click() })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
