// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkedAccountAddition from './linked-account-addition'

let host: HTMLDivElement
let root: Root
const onContinue = vi.fn(async () => {})
const onBack = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  onContinue.mockClear(); onBack.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const base = { lineName: '青山店LINE', slotUnitYen: 3_300, onContinue, onBack }

describe('追加連携枠の確認', () => {
  it('多いほうの連携数が増えたときだけ日割り額を表示し、同意後に進む', async () => {
    await act(async () => { root.render(<LinkedAccountAddition {...base} service="googleBusiness"
      before={{ googleBusiness: 2, instagram: 2 }} billing={{ kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 }} />) })
    expect(document.body.textContent).toContain('追加連携枠の料金を確認')
    expect(document.body.textContent).toContain('＋¥3,300 / 月')
    expect(document.body.textContent).toContain('決済成功時のお支払い ¥1,650')
    expect(document.body.textContent).toContain('追加枠 1枠→2枠')
    await act(async () => { [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes('料金に同意'))!.click() })
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('Instagramが既存のGoogleマイビジネス件数に追いつく場合は決済なし', async () => {
    await act(async () => { root.render(<LinkedAccountAddition {...base} service="instagram"
      before={{ googleBusiness: 2, instagram: 1 }} billing={{ kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 }} />) })
    expect(document.body.textContent).toContain('追加料金はかかりません')
    expect(document.body.textContent).toContain('追加枠 1枠のまま')
    expect(document.body.textContent).toContain('カード決済はありません')
    expect(document.body.textContent).toContain('Instagramの連携へ')
  })

  it('無料期間中は今の請求を0円と表示する', async () => {
    await act(async () => { root.render(<LinkedAccountAddition {...base} service="instagram"
      before={{ googleBusiness: 1, instagram: 1 }} billing={{ kind: 'trialing' }} />) })
    expect(document.body.textContent).toContain('＋¥3,300 / 月')
    expect(document.body.textContent).toContain('無料期間中のため今は請求しません')
  })

  it('特別料金で単価0円なら枠数の増加と決済不要の両方を正しく示す', async () => {
    await act(async () => { root.render(<LinkedAccountAddition {...base} slotUnitYen={0} service="googleBusiness"
      before={{ googleBusiness: 2, instagram: 2 }} billing={{ kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 }} />) })
    expect(document.body.textContent).toContain('追加枠 1枠→2枠')
    expect(document.body.textContent).toContain('追加枠の料金は0円です')
    expect(document.body.textContent).toContain('料金の同意や決済は不要です')
  })

  it('11個目は通常料金の確認画面に進めず、戻る案内を表示する', async () => {
    await act(async () => { root.render(<LinkedAccountAddition {...base} service="googleBusiness"
      before={{ googleBusiness: 10, instagram: 1 }} billing={{ kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 }} />) })
    expect(document.body.textContent).toContain('料金を表示できません')
    expect(document.body.textContent).not.toContain('料金に同意して連携へ')
    await act(async () => { document.body.querySelector('button')!.click() })
    expect(onBack).toHaveBeenCalledOnce()
  })
})
