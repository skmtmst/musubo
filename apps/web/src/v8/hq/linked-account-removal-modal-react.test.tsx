// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LinkedAccountRemovalModal from './linked-account-removal-modal'

let host: HTMLDivElement
let root: Root
const onConfirm = vi.fn(async () => {})
const onBack = vi.fn()
const onAccounts = vi.fn()
const onBilling = vi.fn()

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  onConfirm.mockClear(); onBack.mockClear(); onAccounts.mockClear(); onBilling.mockClear()
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const base = {
  lineName: '公式LINE A', connectionName: '青山店', service: 'googleBusiness' as const,
  before: { googleBusiness: 3, instagram: 2 }, slotUnitYen: 3_300,
  nextMonthlyChargeAt: '2027-02-08T00:00:00+09:00', onBack,
}

describe('追加連携枠の解除', () => {
  it('連携の即時停止と次回請求からの減額を確認して解除する', async () => {
    await act(async () => { root.render(<LinkedAccountRemovalModal {...base} phase="review" onConfirm={onConfirm} />) })
    expect(host.textContent).toContain('青山店」を今すぐ停止します')
    expect(host.textContent).toContain('−¥3,300 / 月')
    expect(host.textContent).toContain('2027年2月8日')
    expect(host.textContent).toContain('支払済み期間の返金はなく')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('この連携を解除'))!.click() })
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('解除しても多いほうが変わらなければ減額なしと表示する', async () => {
    await act(async () => { root.render(<LinkedAccountRemovalModal {...base} service="instagram" phase="review" onConfirm={onConfirm} />) })
    expect(host.textContent).toContain('¥0 / 月（変更なし）')
    expect(host.textContent).toContain('追加枠の料金は変わりません')
  })

  it('解除完了後は再追加時の減額再計算を伝え、アカウントと請求を開ける', async () => {
    await act(async () => { root.render(<LinkedAccountRemovalModal {...base} phase="complete" onAccounts={onAccounts} onBilling={onBilling} />) })
    expect(host.textContent).toContain('連携を解除しました')
    expect(host.textContent).toContain('再追加した場合は減額予定を再計算します')
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'アカウント一覧へ')!.click() })
    expect(onAccounts).toHaveBeenCalledOnce()
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '請求を見る')!.click() })
    expect(onBilling).toHaveBeenCalledOnce()
  })

  it('減額がない解除の完了画面では支払済み枠が空くと誤案内しない', async () => {
    await act(async () => { root.render(<LinkedAccountRemovalModal {...base} service="instagram" phase="complete" onAccounts={onAccounts} onBilling={onBilling} />) })
    expect(host.textContent).toContain('ほかの連携先は引き続き利用できます')
    expect(host.textContent).not.toContain('支払済みの枠は')
  })

  it('有効な月次請求日がなければ減額日を推測せず先に進めない', async () => {
    await act(async () => { root.render(<LinkedAccountRemovalModal {...base} nextMonthlyChargeAt="" phase="review" onConfirm={onConfirm} />) })
    expect(host.textContent).toContain('料金を表示できません')
    expect(host.textContent).not.toContain('この連携を解除する')
  })
})
