// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideSetupComplete } from './guide-last-step'

afterEach(() => { cleanup(); vi.clearAllMocks() })

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
