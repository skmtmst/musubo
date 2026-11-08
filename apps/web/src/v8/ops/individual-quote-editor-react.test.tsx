// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, type MusuboIndividualQuote } from '@line-crm/shared'
import IndividualQuoteEditor from './individual-quote-editor'

let host: HTMLDivElement
let root: Root
const onSaveDraft = vi.fn(async (_quote: MusuboIndividualQuote) => {})
const onSend = vi.fn(async (_quote: MusuboIndividualQuote) => {})

const example: MusuboIndividualQuote = {
  quoteNumber: 'Q-2026-1108-01', companyName: '株式会社サンプルフード',
  issuedAt: '2026-11-08T00:00:00+09:00', expiresAt: '2026-12-08T23:59:00+09:00',
  acceptedAt: null, supersededAt: null, interval: 'month', plannedLineCount: 1,
  plannedFriendCountExcludingBlocked: 2800,
  plannedLinkedAccountsByLine: [{ googleBusiness: 11, instagram: 1 }],
  trialPeriod: { unit: 'days', value: 30 },
  finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE }, finalAnnualLineChargeYen: null,
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onSaveDraft.mockClear()
  onSend.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!

describe('運営コンソールの個別見積もり', () => {
  it('お客様向けの表示と送信メールを確認してから送る', async () => {
    await act(async () => { root.render(<IndividualQuoteEditor initialQuote={example} recipientEmail="you@example.com"
      onSaveDraft={onSaveDraft} onSend={onSend} />) })
    expect(host.textContent).toContain('¥38,900／月')
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => { button('お客様向けの表示を確認').click() })
    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ quoteNumber: 'Q-2026-1108-01' }))
    expect(host.textContent).toContain('宛先')
    expect(host.textContent).toContain('you@example.com')
    expect(host.textContent).toContain('カード登録だけでは請求も無料期間も始まりません')
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => { button('この内容でメールを送信').click() })
    expect(onSend).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('登録メールアドレスへ見積もりを送信しました')
    expect(button('送信済み').disabled).toBe(true)
  })

  it('11個目の単価は必須で、入力後にプレビューできる', async () => {
    await act(async () => { root.render(<IndividualQuoteEditor initialQuote={{ ...example, plannedLineCount: 12 }}
      recipientEmail="you@example.com" onSaveDraft={onSaveDraft} onSend={onSend} />) })
    expect(button('お客様向けの表示を確認').disabled).toBe(true)
    const input = [...host.querySelectorAll('label')].find((item) => item.textContent?.includes('11個目以降・1個あたり'))!.querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, '6500'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(button('お客様向けの表示を確認').disabled).toBe(false)
    await act(async () => { button('お客様向けの表示を確認').click() })
    expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ finalSchedule: expect.objectContaining({ eleventhAndLaterLineYen: 6500, friendAllowanceForElevenOrMore: 50000 }) }))
  })
})
