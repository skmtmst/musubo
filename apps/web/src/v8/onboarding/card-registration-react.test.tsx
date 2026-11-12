// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ cardStatus: vi.fn(), cardSetup: vi.fn(), cardConfirm: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, hqBilling: { ...actual.api.hqBilling, ...calls } } }
})

import CardRegistration, { isStripeCardSetupUrl } from './card-registration'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const props = () => ({ onContinue: vi.fn(), onBackToPricing: vi.fn(), onOpenCheckout: vi.fn() })

describe('料金確認からクレジットカード登録を経てLINE接続へ', () => {
  it('決済サービス以外やHTTPの転送先を開かない', () => {
    expect(isStripeCardSetupUrl('https://checkout.stripe.com/c/setup/abc')).toBe(true)
    expect(isStripeCardSetupUrl('http://checkout.stripe.com/c/setup/abc')).toBe(false)
    expect(isStripeCardSetupUrl('https://checkout.stripe.com.evil.example/c/setup/abc')).toBe(false)
    expect(isStripeCardSetupUrl('/accounts/new')).toBe(false)
  })

  it('未登録なら途中の案内画面を出さずにカード登録へ進む', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: false } })
    calls.cardSetup.mockResolvedValue({ success: true, data: { url: 'https://checkout.stripe.com/c/setup/test' } })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} />) })
    expect(calls.cardSetup).toHaveBeenCalledOnce()
    expect(action.onOpenCheckout).toHaveBeenCalledWith('https://checkout.stripe.com/c/setup/test')
    expect(host.textContent).not.toContain('クレジットカードを登録してください')
    expect(host.querySelector('input')).toBeNull()
  })

  it('親画面の再描画でカード登録セッションを重複作成しない', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: false } })
    calls.cardSetup.mockResolvedValue({ success: true, data: { url: 'https://checkout.stripe.com/c/setup/test' } })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} />) })
    await act(async () => { root.render(<CardRegistration {...action} onContinue={vi.fn()} />) })
    expect(calls.cardSetup).toHaveBeenCalledOnce()
    expect(action.onOpenCheckout).toHaveBeenCalledOnce()
  })

  it('完了したセッションをサーバーで照合し、別の結果画面なしでLINEへ進む', async () => {
    calls.cardConfirm.mockResolvedValue({ success: true, data: { registered: true } })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} returnState="success" sessionId="cs_test_123456" />) })
    expect(calls.cardConfirm).toHaveBeenCalledWith('cs_test_123456')
    expect(action.onContinue).toHaveBeenCalledOnce()
    expect(calls.cardSetup).not.toHaveBeenCalled()
  })

  it('戻り先URLだけでは完了と扱わない', async () => {
    calls.cardConfirm.mockResolvedValue({ success: false, error: 'invalid' })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} returnState="success" sessionId="cs_test_123456" />) })
    expect(action.onContinue).not.toHaveBeenCalled()
    expect(host.textContent).toContain('クレジットカード登録を確認できませんでした')
  })

  it('既存の成功URLはサーバーの登録状態を照合して復帰する', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: true } })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} returnState="success" />) })
    expect(action.onContinue).toHaveBeenCalledOnce()
    expect(calls.cardConfirm).not.toHaveBeenCalled()
  })

  it('中断時は料金確認へ戻し、新しいカード登録を自動作成しない', async () => {
    calls.cardStatus.mockResolvedValue({ success: true, data: { registered: false } })
    const action = props()
    await act(async () => { root.render(<CardRegistration {...action} returnState="cancel" />) })
    expect(action.onBackToPricing).toHaveBeenCalledOnce()
    expect(calls.cardSetup).not.toHaveBeenCalled()
  })
})
