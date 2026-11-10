// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ cardStatus: vi.fn(), cardSetup: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, hqBilling: { ...actual.api.hqBilling, ...calls } } }
})
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import CardRegistration, { isStripeCardSetupUrl } from './card-registration'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  calls.cardStatus.mockReset()
  calls.cardSetup.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Stripeクレジットカード登録からLINE接続へ', () => {
  it('Stripe以外やHTTPの転送先を開かない', () => {
    expect(isStripeCardSetupUrl('https://checkout.stripe.com/c/setup/abc')).toBe(true)
    expect(isStripeCardSetupUrl('http://checkout.stripe.com/c/setup/abc')).toBe(false)
    expect(isStripeCardSetupUrl('https://checkout.stripe.com.evil.example/c/setup/abc')).toBe(false)
    expect(isStripeCardSetupUrl('/accounts/new')).toBe(false)
  })

  it('未登録のときはStripeの登録画面を開き、カード情報をmusuboの入力欄に持たない', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: false } })
    calls.cardSetup.mockResolvedValue({ success: true, data: { url: 'https://checkout.stripe.com/c/setup/test' } })
    const open = vi.fn()
    await act(async () => { root.render(<CardRegistration onOpenStripe={open} />) })
    expect(host.textContent).toContain('クレジットカードを登録してください')
    expect(host.textContent).toContain('musuboにカード番号やセキュリティコードは保存されません')
    expect(host.querySelector('input')).toBeNull()
    const button = [...host.querySelectorAll('button')].find((element) => element.textContent?.includes('Stripeでクレジットカードを登録する'))!
    await act(async () => { button.click() })
    expect(calls.cardSetup).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.com/c/setup/test')
  })

  it('戻りURLだけで成功にせず、サーバーで登録済みを確認してからLINEへ進める', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: true } })
    const next = vi.fn()
    await act(async () => { root.render(<CardRegistration returnState="success" onContinue={next} />) })
    expect(calls.cardStatus).toHaveBeenCalledOnce()
    expect(calls.cardStatus).toHaveBeenCalledWith({ cache: 'reload' })
    expect(host.textContent).toContain('カードの登録が完了しました')
    const button = [...host.querySelectorAll('button')].find((element) => element.textContent?.includes('LINEアカウントの接続へ'))!
    await act(async () => { button.click() })
    expect(next).toHaveBeenCalledOnce()
  })

  it('Stripeから戻った直後にWebhookが未反映でも、再照会して登録完了を表示する', async () => {
    vi.useFakeTimers()
    try {
      calls.cardStatus
        .mockResolvedValueOnce({ success: true, data: { registered: false } })
        .mockResolvedValueOnce({ success: true, data: { registered: true } })
      await act(async () => { root.render(<CardRegistration returnState="success" />) })
      expect(host.textContent).toContain('カードの登録状況を確認しています')
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(calls.cardStatus).toHaveBeenCalledTimes(2)
      expect(calls.cardStatus).toHaveBeenNthCalledWith(2, { cache: 'reload' })
      expect(host.textContent).toContain('カードの登録が完了しました')
    } finally { vi.useRealTimers() }
  })

  it('登録が中断されたら料金を保ったまま再開を案内する', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: false } })
    await act(async () => { root.render(<CardRegistration returnState="cancel" />) })
    expect(host.textContent).toContain('クレジットカード登録はまだ完了していません')
    expect(host.textContent).toContain('料金の確認内容を保ったまま')
    expect(host.textContent).toContain('カードを登録し直す')
    expect(host.textContent).not.toContain('LINEアカウントの接続へ')
  })
})
