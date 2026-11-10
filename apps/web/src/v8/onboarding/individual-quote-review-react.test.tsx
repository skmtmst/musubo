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
  it('LINE11個以上は未接続でも契約枠の基本料金を請求すると明示する', async () => {
    await act(async () => { renderQuote({ plannedLineCount: 11, plannedLinkedAccountsByLine: [],
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
        eleventhAndLaterLineYen: 6_500, friendAllowanceForElevenOrMore: 50_000 } }) })
    expect(host.textContent).toContain('LINE11個の契約枠・基本料金')
    expect(host.textContent).toContain('¥78,500')
    expect(host.textContent).toContain('接続済みが契約枠より少なくてもLINE基本料金を請求します')
    expect(host.textContent).not.toContain('請求額は実際の連携数で決まり')
  })
  it('12個の見積もりは契約枠・初回請求・同意をPenの順序で表示する', async () => {
    await act(async () => { renderQuote({ plannedLineCount: 12, plannedLinkedAccountsByLine: [],
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
        eleventhAndLaterLineYen: 5_900, friendAllowanceForElevenOrMore: 50_000 } }) })
    const text = host.textContent ?? ''
    expect(text).toContain('LINE12個の契約枠・基本料金¥83,800')
    expect(text).toContain('11個目以降は各¥5,900／月')
    expect(text).toContain('LINE基本料金は契約枠12個分で確定')
    expect(text).toContain('無料期間終了後に契約枠12個分の基本料金を初回請求します')
    expect(text).toContain('LINE12個の契約枠・無料期間・今後の請求を確認し、同意します')
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
    expect(text.indexOf('初回の請求について')).toBeLessThan(text.indexOf('LINE12個の契約枠・無料期間・今後の請求'))
  })
  it('内容を確認し同意したときだけクレジットカード登録へ進める', async () => {
    await act(async () => { renderQuote() })
    expect(host.textContent).toContain('¥38,900')
    expect(host.textContent).toContain('Googleマイビジネス11個')
    expect(host.textContent).toContain('退会したユーザーは累計追加数に残る')
    expect(host.querySelector('[class*="consentFooter"]')).not.toBeNull()
    expect(host.textContent).toContain('初回の請求について')
    expect(host.textContent).toContain('最初のLINEを有効化した日から始まります')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '同意してクレジットカード登録へ')!
    expect(button.disabled).toBe(true)
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(onAccept).toHaveBeenCalledWith('Q-2026-1108-01')
    expect(onResumeCardRegistration).toHaveBeenCalledWith('Q-2026-1108-01')
  })

  it('期限内に同意済みなら期限後もクレジットカード登録を再開できる', async () => {
    await act(async () => { renderQuote({ acceptedAt: '2026-12-07T14:20:00+09:00' }, '2026-12-20T00:00:00+09:00') })
    expect(host.textContent).toContain('クレジットカード登録から再開できます')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'クレジットカード登録を再開する')!
    await act(async () => { button.click() })
    expect(onResumeCardRegistration).toHaveBeenCalledWith('Q-2026-1108-01')
  })

  it('同意の保存に失敗した場合はクレジットカード登録へ進めない', async () => {
    onAccept.mockRejectedValueOnce(new Error('save failed'))
    await act(async () => { renderQuote() })
    await act(async () => { host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click() })
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '同意してクレジットカード登録へ')!
    await act(async () => { button.click() })
    expect(onResumeCardRegistration).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('処理を完了できませんでした')
  })

  it('未同意の期限切れは再発行依頼に分岐する', async () => {
    await act(async () => { renderQuote({}, '2026-12-20T00:00:00+09:00') })
    expect(host.textContent).toContain('新しい見積もりをご依頼ください')
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '再発行を依頼する')!
    await act(async () => { button.click() })
    expect(onRequestReissue).toHaveBeenCalledWith('Q-2026-1108-01')
  })
})
