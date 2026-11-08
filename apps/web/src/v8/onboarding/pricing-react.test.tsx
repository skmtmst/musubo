// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OnboardingPricing from './pricing'
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

function selectValue(id: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>('#' + id)!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
function inputValue(id: string, value: string) {
  const input = host.querySelector<HTMLInputElement>('#' + id)!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Penの利用料金確認', () => {
  it('1個を初期選択し、友だちと追加連携枠に応じた料金を示す', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    expect(host.querySelector<HTMLSelectElement>('#line-count')?.value).toBe('1')
    expect(host.textContent).toContain('友だち数を入力すると')
    await act(async () => { inputValue('friend-count', '2800') })
    expect(host.textContent).toContain('¥5,900 / 月')
    await act(async () => { selectValue('google-count', '2') })
    expect(host.textContent).toContain('LINE 1個の基本料金（追加連携枠を除く）')
    expect(host.textContent).toContain('追加連携枠1枠を利用した場合')
    expect(host.textContent).toContain('¥9,200 / 月')
    const agree = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    await act(async () => { agree.click() })
    const proceed = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('同意してカード登録へ'))!
    await act(async () => { proceed.click() })
    expect(continueFlow).toHaveBeenCalledWith(expect.objectContaining({ lineCount: 1, friendCountExcludingBlocked: 2800, googleBusinessCount: 2 }))
  })

  it('友だち超過を基本料金へ重複加算せず、追加料金として分けて表示する', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { inputValue('friend-count', '13001') })
    expect(host.textContent).toContain('¥5,900 / 月')
    expect(host.textContent).toContain('¥2,200 / 月')
    expect(host.textContent).not.toContain('¥8,100 / 月')
  })

  it('11個以上は金額と同意欄を出さず、問い合わせに進む', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { selectValue('line-count', '11') })
    expect(host.textContent).toContain('料金は個別にご案内します')
    expect(host.textContent).not.toContain('本日の請求')
    expect(host.querySelector('input[type=checkbox]')).toBeNull()
    const contact = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('お問い合わせフォームへ'))!
    await act(async () => { contact.click() })
    expect(contactFlow).toHaveBeenCalledWith(expect.objectContaining({ lineCount: 11, friendCountExcludingBlocked: null }))
  })

  it('複数LINEでは各LINEの連携数を先取りせず、追加枠を予定料金に含めない', async () => {
    await act(async () => { root.render(<OnboardingPricing onContinue={continueFlow} onContact={contactFlow} />) })
    await act(async () => { inputValue('friend-count', '2800') })
    await act(async () => { selectValue('google-count', '2') })
    expect(host.textContent).toContain('¥9,200 / 月')
    await act(async () => { selectValue('line-count', '2') })
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
    await act(async () => { selectValue('google-count', '2') })
    expect(host.textContent).toContain('¥6,250 / 月')
    const annual = [...host.querySelectorAll('button')].find((button) => button.textContent === '年払い')!
    await act(async () => { annual.click() })
    expect(host.textContent).toContain('¥31,860 / 年')
    expect(host.textContent).toContain('オプション料金¥3,300／月は毎月別に請求します')
    expect(host.textContent).toContain('3か月無料')
  })
})
