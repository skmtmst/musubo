// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OnboardingPricing from './pricing'
import PricingQuoteFlow from './pricing-quote-flow'
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared'

let host: HTMLDivElement
let root: Root
const continueFlow = vi.fn(async () => {})
const contactFlow = vi.fn(async () => {})

beforeEach(() => {
  continueFlow.mockClear()
  contactFlow.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function selectValue(id: string, value: string) {
  const trigger = host.querySelector<HTMLButtonElement>('#' + id)!
  await act(async () => { trigger.click() })
  const label = value === '11' ? '11個以上' : `${value}個`
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"] button')]
    .find((button) => button.title === label)!
  await act(async () => { option.click() })
}
function inputValue(id: string, value: string) {
  const input = host.querySelector<HTMLInputElement>('#' + id)!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Penの利用料金確認', () => {
  it('個別見積もり画面から戻っても入力した予定を保つ', async () => {
    await act(async () => { root.render(<PricingQuoteFlow onContinue={continueFlow} />) })
    await selectValue('line-count', '11')
    await act(async () => { inputValue('friend-count', '2800') })
    const contact = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('お問い合わせフォームへ'))!
    await act(async () => { contact.click() })
    expect(host.textContent).toContain('お見積もりのお問い合わせ')
    const back = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('ご利用予定を修正'))!
    await act(async () => { back.click() })
    expect(host.querySelector('#line-count [data-select-value]')?.textContent).toBe('11個以上')
    expect(host.querySelector<HTMLInputElement>('#friend-count')?.value).toBe('2800')
    expect(host.textContent).toContain('お問い合わせフォームへ')
  })

  it('1個を初期選択し、友だちと追加連携枠に応じた料金を示す', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    expect(host.querySelector('#line-count [data-select-value]')?.textContent).toBe('1個')
    expect(host.textContent).toContain('友だち数を入力すると')
    await act(async () => { inputValue('friend-count', '2800') })
    expect(host.textContent).toContain('¥5,900 / 月')
    await selectValue('google-count', '2')
    expect(host.textContent).toContain('LINE 1個の基本料金')
    expect(host.textContent).toContain('追加連携枠 1枠')
    expect(host.textContent).toContain('¥3,300 / 月')
    expect(host.textContent).toContain('¥9,200 / 月')
    const agree = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    await act(async () => { agree.click() })
    const proceed = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('同意してカード登録へ'))!
    await act(async () => { proceed.click() })
    expect(continueFlow).toHaveBeenCalledWith(expect.objectContaining({ lineCount: 1, friendCountExcludingBlocked: 2800, googleBusinessCount: 2 }))
  })

  it('友だち超過を基本料金へ重複加算せず、内訳と合計を示す', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { inputValue('friend-count', '13001') })
    expect(host.textContent).toContain('¥5,900 / 月')
    expect(host.textContent).toContain('¥2,200 / 月')
    expect(host.textContent).toContain('¥8,100 / 月')
  })

  it('11個以上は金額と同意欄を出さず、問い合わせに進む', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await selectValue('line-count', '11')
    expect(host.textContent).toContain('料金は個別にご案内します')
    expect(host.textContent).not.toContain('本日の請求')
    expect(host.querySelector('input[type=checkbox]')).toBeNull()
    const details = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('標準料金のしくみを見る'))!
    await act(async () => { details.click() })
    expect(host.textContent).toContain('友だち数の基準と超過料金は、個別のお見積もり')
    expect(host.textContent).not.toContain('例｜LINE 1個の場合')
    const close = [...host.querySelectorAll('button')].find((button) => button.textContent === '料金確認に戻る')!
    await act(async () => { close.click() })
    const contact = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('お問い合わせフォームへ'))!
    await act(async () => { contact.click() })
    expect(contactFlow).toHaveBeenCalledWith(expect.objectContaining({ lineCount: 11, friendCountExcludingBlocked: null }))
  })

  it('複数LINEでは各LINEの連携数を先取りせず、追加枠を予定料金に含めない', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { inputValue('friend-count', '2800') })
    await selectValue('google-count', '2')
    expect(host.textContent).toContain('¥9,200 / 月')
    await selectValue('line-count', '2')
    expect(host.querySelector('#google-count')).toBeNull()
    expect(host.querySelector('#instagram-count')).toBeNull()
    expect(host.textContent).toContain('ここで表示する予定料金には追加連携枠を含みません')
    expect(host.textContent).toContain('¥19,300 / 月')
    expect(host.textContent).not.toContain('追加連携枠 1枠')
    const agree = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    await act(async () => { agree.click() })
    const proceed = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('同意してカード登録へ'))!
    await act(async () => { proceed.click() })
    expect(continueFlow).toHaveBeenCalledWith(expect.objectContaining({ lineCount: 2, googleBusinessCount: 1, instagramCount: 1 }))
  })

  it('特別条件の割引はLINE基本料金だけに適用し、年払いのオプションは月次と示す', async () => {
    await act(async () => { root.render(<OnboardingPricing
      condition={{ name: '特別条件A', trialPeriod: { unit: 'months', value: 3 },
        lineBasicDiscountPercent: 50, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE }}
      onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { inputValue('friend-count', '2800') })
    await selectValue('google-count', '2')
    expect(host.textContent).toContain('¥6,250 / 月')
    const annual = [...host.querySelectorAll('button')].find((button) => button.textContent === '年払い')!
    await act(async () => { annual.click() })
    expect(host.textContent).toContain('¥31,860 / 年')
    expect(host.textContent).toContain('オプション料金¥3,300／月は毎月別に請求します')
    expect(host.textContent).toContain('3か月無料')
  })
})
