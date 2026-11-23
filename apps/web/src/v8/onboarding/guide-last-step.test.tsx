// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideReceiveFirstMessage } from './guide-last-step'

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
