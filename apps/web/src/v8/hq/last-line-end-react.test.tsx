// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LastLineEnd from './last-line-end'

let host: HTMLDivElement
let root: Root
const onSchedule = vi.fn(async (_endAt: string) => {})
const onEndNow = vi.fn(async () => {})
const onBack = vi.fn()

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  onSchedule.mockClear(); onEndNow.mockClear(); onBack.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const base = {
  lineName: 'musubo店舗', now: '2027-01-01T00:00:00+09:00',
  onSchedule, onEndNow, onBack,
} as const

describe('最後のLINEの利用終了', () => {
  it('月払いは次の請求日前日までの利用を初期選択し、終了を予約する', async () => {
    await act(async () => root.render(<LastLineEnd {...base} schedule={{ billingState: 'active', interval: 'month', nextMonthlyChargeAt: '2027-01-08T10:00:00+09:00' }} />))
    expect(host.textContent).toContain('次の請求日の前日に終了する')
    expect(host.textContent).toContain('2027年1月7日')
    expect(host.textContent).toContain('2027年1月8日の請求は発生しません')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'この内容で終了を予約する')!.click() })
    expect(onSchedule).toHaveBeenCalledWith('2027-01-07T15:00:00.000Z')
    expect(onEndNow).not.toHaveBeenCalled()
  })

  it('即時終了には別の最終確認を必須とする', async () => {
    await act(async () => root.render(<LastLineEnd {...base} schedule={{ billingState: 'active', interval: 'year', nextAnnualRenewalAt: '2027-12-08T10:00:00+09:00' }} />))
    await act(async () => { (host.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click() })
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '終了内容を確認する')!.click() })
    expect(onEndNow).not.toHaveBeenCalled()
    expect(host.textContent).toContain('この操作は取り消せません')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '今すぐ利用を終了する')!.click() })
    expect(onEndNow).toHaveBeenCalledOnce()
  })

  it('無料体験中は初回請求前日までの利用を示す', async () => {
    await act(async () => root.render(<LastLineEnd {...base} schedule={{ billingState: 'trialing', interval: 'month', trialFirstChargeAt: '2027-01-08T10:00:00+09:00' }} />))
    expect(host.textContent).toContain('無料体験の最終日まで利用する')
    expect(host.textContent).toContain('無料体験後の初回請求日')
    expect(host.textContent).toContain('2027年1月7日')
    expect(host.textContent).toContain('2027年1月8日の請求は発生しません')
  })
})
