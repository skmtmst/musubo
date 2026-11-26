// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FirstMessageState } from '@/lib/first-message-api'
import { GuideFirstMessage } from './guide-first-message'

const api = vi.hoisted(() => ({ status: vi.fn(), send: vi.fn(), identity: vi.fn() }))
vi.mock('@/lib/first-message-api', () => ({ firstMessageApi: api }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') }))

const state = (status: FirstMessageState['status'], overrides: Partial<FirstMessageState> = {}): FirstMessageState => ({
  status,
  accountName: '試験店',
  friendUrl: 'https://line.me/R/ti/p/%40fake',
  retryAt: null,
  verificationPending: false,
  ...overrides,
})
const props = () => ({ accountId: 'selected-store', step: 8, total: 8, onReceived: vi.fn(), onLater: vi.fn() })

afterEach(() => { cleanup(); vi.resetAllMocks() })

it('waits for LINE receipt and survives a reload without sending again', async () => {
  api.status.mockResolvedValueOnce(state('ready')).mockResolvedValueOnce(state('sent')).mockResolvedValueOnce(state('received'))
  let finish!: (value: FirstMessageState) => void
  api.send.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const callbacks = props()
  const view = render(<GuideFirstMessage {...callbacks} />)
  const send = await screen.findByRole('button', { name: '自分のLINEにテスト送信' })
  fireEvent.click(send)
  fireEvent.click(send)
  expect(api.send).toHaveBeenCalledExactlyOnceWith('selected-store')
  expect(screen.getByText('テストメッセージを送信中…')).toBeTruthy()
  finish(state('sent'))
  await screen.findByText('LINEが送信を受け付けました')
  expect(callbacks.onReceived).not.toHaveBeenCalled()

  view.unmount()
  render(<GuideFirstMessage {...callbacks} />)
  expect(await screen.findByText('LINEが送信を受け付けました')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '自分のLINEにテスト送信' })).toBeNull()
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(callbacks.onReceived).toHaveBeenCalledOnce())
  expect(api.send).toHaveBeenCalledOnce()
})

it('checks an uncertain result without resending', async () => {
  api.status.mockResolvedValueOnce(state('ready')).mockResolvedValueOnce(state('unknown')).mockResolvedValueOnce(state('received'))
  api.send.mockRejectedValue(new Error('connection closed'))
  const callbacks = props()
  render(<GuideFirstMessage {...callbacks} />)
  fireEvent.click(await screen.findByRole('button', { name: '自分のLINEにテスト送信' }))
  expect(await screen.findByText('送信結果を確認できませんでした')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '送信結果を確認する' }))
  await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2))
  expect(api.send).toHaveBeenCalledOnce()
  expect(callbacks.onReceived).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: '送信結果を確認する' }))
  await waitFor(() => expect(callbacks.onReceived).toHaveBeenCalledOnce())
  expect(api.send).toHaveBeenCalledOnce()
})

it('opens a store-scoped verification link and waits before enabling test send', async () => {
  const verificationUrl = 'https://line.me/R/oaMessage/%40fake/?fake-code'
  api.status.mockResolvedValueOnce(state('identity_required'))
    .mockResolvedValueOnce(state('identity_required', { verificationPending: true }))
    .mockResolvedValueOnce(state('ready'))
  api.identity.mockResolvedValue({ verificationUrl })
  render(<GuideFirstMessage {...props()} />)
  fireEvent.click(await screen.findByRole('button', { name: '自分のLINEを確認' }))
  expect((await screen.findByRole('link', { name: 'お店のLINEを開く' })).getAttribute('href')).toBe(verificationUrl)
  expect(await screen.findByRole('img', { name: '本人確認用のQRコード' })).toBeTruthy()
  expect(api.send).not.toHaveBeenCalled()
  fireEvent(window, new Event('focus'))
  expect(await screen.findByRole('button', { name: '自分のLINEにテスト送信' })).toBeTruthy()
  expect(screen.queryByRole('img', { name: '本人確認用のQRコード' })).toBeNull()
})

it('closes the first message guide from the close button', async () => {
  api.status.mockResolvedValue(state('ready'))
  const callbacks = props()
  render(<GuideFirstMessage {...callbacks} />)
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(callbacks.onLater).toHaveBeenCalledOnce()
})
