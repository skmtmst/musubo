// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideReceiveFirstMessage, GuideSetupComplete } from './guide-last-step'

const qrToDataURL = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,AAAA'))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('選択した公式アカウントの友だち追加画面をQRにする', async () => {
  const props = { step: 8, total: 8, watchExpired: false, onRewatch: vi.fn(), onLater: vi.fn() }
  const result = render(<GuideReceiveFirstMessage {...props} basicId="@123abcd" />)
  await screen.findByRole('img', { name: '友だち追加のQRコード' })
  expect(qrToDataURL).toHaveBeenLastCalledWith('https://line.me/R/ti/p/@123abcd', { width: 300, margin: 2 })
  result.rerender(<GuideReceiveFirstMessage {...props} basicId="other-store" />)
  await screen.findByRole('img', { name: '友だち追加のQRコード' })
  expect(qrToDataURL).toHaveBeenLastCalledWith('https://line.me/R/ti/p/@other-store', { width: 300, margin: 2 })
})

it('Basic IDがない間はQRを出さず、接続情報を読み直せる', async () => {
  const onReload = vi.fn(async () => {})
  render(<GuideReceiveFirstMessage basicId={null} step={8} total={8} watchExpired={false}
    onReload={onReload} onRewatch={vi.fn()} onLater={vi.fn()} />)
  expect(screen.getByText('QRコードを表示できませんでした')).toBeTruthy()
  expect(qrToDataURL).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(onReload).toHaveBeenCalledOnce())
})

it('すでに友だち追加した人が同じアカウントのテスト送信を開ける', () => {
  const onTest = vi.fn()
  render(<GuideReceiveFirstMessage basicId="@123abcd" step={8} total={8} watchExpired={false}
    onRewatch={vi.fn()} onLater={vi.fn()} onTest={onTest} />)
  expect(screen.getByRole('heading', { name: 'すでに友だち追加している場合' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'テスト送信を開く' }))
  expect(onTest).toHaveBeenCalledOnce()
})

it('受付開始の表示に実測を使い、完了の保存失敗時は確認をやり直せる', async () => {
  const acknowledge = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const navigate = vi.fn()
  const view = render(<GuideSetupComplete onAcknowledge={acknowledge} onNavigate={navigate} />)
  expect(screen.getByText(/LINEでの予約受付状況を確認できませんでした/)).toBeTruthy()
  view.rerender(<GuideSetupComplete exposure={{ reservationLink: true, publicReservationMenu: true, availableCapacity: false }} onAcknowledge={acknowledge} onNavigate={navigate} />)
  expect(screen.getByText(/LINEで予約を受け付けるには/)).toBeTruthy()
  view.rerender(<GuideSetupComplete exposure={{ reservationLink: true, publicReservationMenu: true, availableCapacity: true }} onAcknowledge={acknowledge} onNavigate={navigate} />)
  expect(screen.getByText(/LINEからの予約を受け付けています/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'ダッシュボードへ' }))
  const retry = await screen.findByRole('button', { name: 'もう一度確かめる' })
  expect(navigate).not.toHaveBeenCalled()
  fireEvent.click(retry)
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
})
