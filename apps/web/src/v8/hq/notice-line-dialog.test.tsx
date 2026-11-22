// @vitest-environment happy-dom
/*
 * 監査 WEB213：契約者専用 LINE の案内。読めなかったら「まだ設定されていません」と言わず、
 * 開き直したら前の確認コードを残さない。
 */
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

const net = vi.hoisted(() => ({ lineRegistration: vi.fn(), lineRegistrationStatus: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, hqNotices: {
    ...actual.api.hqNotices,
    lineRegistration: (...args: unknown[]) => net.lineRegistration(...args),
    lineRegistrationStatus: (...args: unknown[]) => net.lineRegistrationStatus(...args),
  } } }
})
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }))

import NoticeLineDialogV8 from './notice-line-dialog'
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

test('読めなかったら「まだ設定されていません」と言わない', async () => {
  net.lineRegistration.mockRejectedValue(new Error('down'))
  render(<NoticeLineDialogV8 open onClose={() => undefined} />)
  await waitFor(() => expect(screen.getByText(/案内を読み込めませんでした/)).toBeTruthy())
  expect(screen.queryByText(/まだ運営側で設定されていません/)).toBeNull()
})

test('開き直したとき、前の確認コードを出したままにしない', async () => {
  net.lineRegistration.mockResolvedValueOnce({ success: true, data: { available: true, addFriendUrl: 'https://line.me/x', accountName: '運営', linked: false, code: '123456', codeExpiresAt: new Date(Date.now() + 60_000).toISOString() } })
  const view = render(<NoticeLineDialogV8 open onClose={() => undefined} />)
  await waitFor(() => expect(screen.getByLabelText('確認コード 123456')).toBeTruthy())
  net.lineRegistration.mockImplementation(() => new Promise(() => undefined))
  view.rerender(<NoticeLineDialogV8 open={false} onClose={() => undefined} />)
  await act(async () => { view.rerender(<NoticeLineDialogV8 open onClose={() => undefined} />) })
  expect(screen.queryByLabelText('確認コード 123456')).toBeNull()
})

test('PenどおりPCのQRと紐づけ理由を示し、友だち追加リンクは置かない', async () => {
  net.lineRegistration.mockResolvedValue({ success: true, data: { available: true, accountName: 'musubo契約者様 通知専用', basicId: '@540qlkhn', addFriendUrl: 'https://line.me/R/ti/p/@540qlkhn', linked: false, code: '123456', codeExpiresAt: new Date(Date.now() + 60_000).toISOString() } })
  render(<NoticeLineDialogV8 open onClose={() => undefined} />)
  await waitFor(() => expect(screen.getByAltText('musubo契約者様 通知専用 の友だち追加QRコード')).toBeTruthy())
  expect(screen.getByText('PC画面のQRをスマートフォンのLINEで読み取ります。')).toBeTruthy()
  expect(screen.getByText(/運営が契約先に必要なお知らせだけを/)).toBeTruthy()
  expect(screen.queryByRole('link', { name: /友だち追加/ })).toBeNull()
  expect(screen.getByLabelText('確認コード 123456')).toBeTruthy()
})

test('24時間の期限が切れたコードは表示せず、更新して新しいコードを出す', async () => {
  const base = { available: true, accountName: '通知専用', basicId: '@540qlkhn', addFriendUrl: 'https://line.me/R/ti/p/@540qlkhn', linked: false }
  net.lineRegistration
    .mockResolvedValueOnce({ success: true, data: { ...base, code: '111111', codeExpiresAt: new Date(Date.now() - 1000).toISOString() } })
    .mockResolvedValueOnce({ success: true, data: { ...base, code: '222222', codeExpiresAt: new Date(Date.now() + 60_000).toISOString() } })
  render(<NoticeLineDialogV8 open onClose={() => undefined} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '新しいコードを表示' })).toBeTruthy())
  expect(screen.queryByLabelText('確認コード 111111')).toBeNull()
  await act(async () => { screen.getByRole('button', { name: '新しいコードを表示' }).click() })
  await waitFor(() => expect(screen.getByLabelText('確認コード 222222')).toBeTruthy())
})

test.each([undefined, true])('連携の確認後に確認コードを消す（自動終了 %s）', async (closeWhenLinked) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  net.lineRegistration.mockResolvedValue({ success: true, data: { available: true, accountName: '通知専用', basicId: '@540qlkhn', addFriendUrl: 'https://line.me/R/ti/p/@540qlkhn', linked: false, code: '123456', codeExpiresAt: new Date(Date.now() + 60_000).toISOString() } })
  net.lineRegistrationStatus
    .mockResolvedValueOnce({ success: true, data: { linked: false } })
    .mockResolvedValueOnce({ success: true, data: { linked: true } })
  const onClose = vi.fn()
  await act(async () => { render(<NoticeLineDialogV8 open onClose={onClose} closeWhenLinked={closeWhenLinked} />) })
  expect(screen.getByLabelText('確認コード 123456')).toBeTruthy()

  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getByLabelText('確認コード 123456')).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()

  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.queryByLabelText('確認コード 123456')).toBeNull()
  if (closeWhenLinked) {
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  } else {
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'LINEとの連携が完了しています' })).toBeTruthy()
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(net.lineRegistrationStatus).toHaveBeenCalledTimes(2)
})
