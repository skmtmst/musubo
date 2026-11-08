// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, type MusuboIndividualQuote } from '@line-crm/shared'
import IndividualQuoteReview from './individual-quote-review'

let host: HTMLDivElement
let root: Root
const onAccept = vi.fn(async () => {})
const onResumeCardRegistration = vi.fn()
const onRequestReissue = vi.fn(async () => {})
const onOpenLatestQuote = vi.fn()
const quote: MusuboIndividualQuote = {
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
  for (const spy of [onAccept, onResumeCardRegistration, onRequestReissue, onOpenLatestQuote]) spy.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function renderQuote(changes: Partial<MusuboIndividualQuote> = {}, now = '2026-11-09T00:00:00+09:00') {
  return root.render(<IndividualQuoteReview quote={{ ...quote, ...changes }} now={now} onAccept={onAccept}
    onResumeCardRegistration={onResumeCardRegistration} onRequestReissue={onRequestReissue}
    onOpenLatestQuote={onOpenLatestQuote} />)
}

describe('お客様の個別見積もり', () => {
  it('内容を確認し同意したときだけカード登録へ進める', async () => {
    await act(async () => { renderQuote() })
    expect(host.textContent).toContain('¥38,900')
    expect(host.textContent).toContain('Googleマイビジネス11個')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '同意してカード登録へ')!
    expect(button.disabled).toBe(true)
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(onAccept).toHaveBeenCalledWith('Q-2026-1108-01')
  })

  it('期限内に同意済みなら期限後もカード登録を再開できる', async () => {
    await act(async () => { renderQuote({ acceptedAt: '2026-12-07T14:20:00+09:00' }, '2026-12-20T00:00:00+09:00') })
    expect(host.textContent).toContain('カード登録から再開できます')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'カード登録を再開する')!
    await act(async () => { button.click() })
    expect(onResumeCardRegistration).toHaveBeenCalledWith('Q-2026-1108-01')
  })

  it('未同意の期限切れは再発行依頼に分岐する', async () => {
    await act(async () => { renderQuote({}, '2026-12-20T00:00:00+09:00') })
    expect(host.textContent).toContain('新しい見積もりをご依頼ください')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '再発行を依頼する')!
    await act(async () => { button.click() })
    expect(onRequestReissue).toHaveBeenCalledWith('Q-2026-1108-01')
  })
})
