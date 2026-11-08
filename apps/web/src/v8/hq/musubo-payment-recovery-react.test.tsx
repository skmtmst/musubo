// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MusuboPaymentRecovery, { type MusuboPaymentRecoveryView } from './musubo-payment-recovery'

let host: HTMLDivElement
let root: Root
const onPrimary = vi.fn(async () => {})
const onSecondary = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onPrimary.mockClear(); onSecondary.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function renderView(view: MusuboPaymentRecoveryView) {
  return root.render(<MusuboPaymentRecovery view={view} onPrimary={onPrimary} onSecondary={onSecondary} />)
}
const invoice: MusuboPaymentRecoveryView = {
  kind: 'invoice', state: 'grace', amountYen: 5900,
  invoiceDate: '2026-12-08T10:00:00+09:00', graceDeadline: '2026-12-15T10:00:00+09:00',
  nextAutomaticRetryAt: '2026-12-11T10:00:00+09:00',
}
const addition: MusuboPaymentRecoveryView = {
  kind: 'addition', state: 'failed', amountYen: 6700,
  addedLineOrdinal: 2, activeLineCount: 1, holdUntil: '2027-01-20T18:00:00+09:00',
}

describe('決済失敗と回復の画面', () => {
  it('有料請求失敗では7日の猶予と利用継続を示す', async () => {
    await act(async () => { renderView(invoice) })
    expect(host.textContent).toContain('利用継続中')
    expect(host.textContent).toContain('2026年12月15日 10:00')
    expect(host.textContent).toContain('¥5,900')
    const pay = [...host.querySelectorAll('button')].find((item) => item.textContent === 'お支払いへ進む')!
    await act(async () => { pay.click() })
    expect(onPrimary).toHaveBeenCalledOnce()
  })

  it('追加決済失敗では追加分だけ保留し、既存のLINEを継続表示する', async () => {
    await act(async () => { renderView(addition) })
    expect(host.textContent).toContain('利用中のLINE 1個はそのまま使えます')
    expect(host.textContent).toContain('追加は保留中')
    expect(host.textContent).toContain('決済成功まで有効化しません')
    expect(host.textContent).toContain('カードを確認して再試行')
  })

  it('追加決済確認中は再請求を促さず、期限切れなら再見積もりへ進む', async () => {
    await act(async () => { renderView({ ...addition, state: 'processing' }) })
    expect(host.textContent).toContain('決済状況を更新')
    expect(host.textContent).toContain('このボタンで新たな決済は発生しません')
    await act(async () => { renderView({ ...addition, state: 'expired' }) })
    expect(host.textContent).toContain('日割り額が変わるため、最新の料金に再同意')
    expect(host.textContent).toContain('料金を再確認する')
  })

  it('決済成功日時が未反映の間に猶予期限を支払日として表示しない', async () => {
    await act(async () => { renderView({ ...invoice, state: 'recovered' }) })
    expect(host.textContent).toContain('お支払い確認日確認中')
    expect(host.textContent).not.toContain('2026年12月15日 10:00')
  })
})
