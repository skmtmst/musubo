// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IndividualQuoteInquiry, { individualQuoteInquiryBody } from './individual-quote-inquiry'
import type { PricingSelection } from './pricing'

let host: HTMLDivElement
let root: Root
const submit = vi.fn(async () => 'ticket-123')
const onSubmitted = vi.fn()
const lineQuote: PricingSelection = {
  lineCount: 11, friendCountExcludingBlocked: 2800,
  googleBusinessCount: 1, instagramCount: 1, interval: 'month',
}

beforeEach(() => {
  submit.mockClear()
  onSubmitted.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function typeInto(selector: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Penの個別見積もり問い合わせ', () => {
  it('LINE 11個以上の内容を既存受付へ送信して控えを表示する', async () => {
    await act(async () => { root.render(<IndividualQuoteInquiry selection={lineQuote} submit={submit} onSubmitted={onSubmitted} />) })
    expect(host.textContent).toContain('お見積もりのお問い合わせ')
    expect(host.textContent).toContain('11個以上')
    await act(async () => { typeInto('#exact-line-count', '12') })
    await act(async () => { typeInto('#inquiry-notes', 'Googleマイビジネス12個') })
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('この内容で問い合わせる'))!
    await act(async () => { button.click() })
    expect(submit).toHaveBeenCalledWith('個別見積もりのお問い合わせ', expect.stringContaining('具体的な予定数: 12個'))
    expect(submit.mock.calls[0]?.[1]).toContain('Googleマイビジネス12個')
    expect(onSubmitted).toHaveBeenCalledWith('ticket-123')
    expect(host.textContent).toContain('お問い合わせを受け付けました')
    expect(host.querySelector('a[href="/hq/support/detail?id=ticket-123"]')).not.toBeNull()
  })

  it('11未満の具体数を拒否し、連携先11個以上なら各サービス数を送る', async () => {
    await act(async () => { root.render(<IndividualQuoteInquiry selection={lineQuote} submit={submit} />) })
    await act(async () => { typeInto('#exact-line-count', '9') })
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('この内容で問い合わせる'))!
    expect(button.hasAttribute('disabled')).toBe(true)
    await act(async () => { root.render(<IndividualQuoteInquiry selection={{ ...lineQuote, lineCount: 1,
      googleBusinessCount: 11, instagramCount: 2, friendCountExcludingBlocked: null }} submit={submit} />) })
    expect(host.querySelector('#exact-line-count')).toBeNull()
    expect(host.textContent).toContain('Googleマイビジネスの連携予定数')
    expect(individualQuoteInquiryBody({ ...lineQuote, lineCount: 1, googleBusinessCount: 11,
      instagramCount: 2, friendCountExcludingBlocked: null, interval: 'year' }, '', '')).toContain('Instagramアカウントの連携予定: 2個')
  })

  it('通信失敗後も入力内容を残し再送できる', async () => {
    submit.mockRejectedValueOnce(new Error('network'))
    await act(async () => { root.render(<IndividualQuoteInquiry selection={lineQuote} submit={submit} />) })
    await act(async () => { typeInto('#inquiry-notes', '予定は未定です') })
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('この内容で問い合わせる'))!
    await act(async () => { button.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('送信できませんでした')
    expect(host.querySelector<HTMLTextAreaElement>('#inquiry-notes')?.value).toBe('予定は未定です')
    await act(async () => { button.click() })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('お問い合わせを受け付けました')
  })
})
