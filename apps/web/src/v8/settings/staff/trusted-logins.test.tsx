// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const calls = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ fetchApi: calls.fetch }))
import TrustedLogins from './trusted-logins'

afterEach(() => { cleanup(); vi.resetAllMocks() })

it('信頼済みの接続元を表示し、確認後に1件外す', async () => {
  calls.fetch.mockResolvedValueOnce({ success: true, data: [{ id: 'record-1', ipPrefix: '203.0.*.*', confirmedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-01-30T00:00:00Z', current: true }] })
    .mockResolvedValueOnce({ success: true, data: null })
    .mockResolvedValueOnce({ success: true, data: [] })
  render(<TrustedLogins />)
  expect(await screen.findByText('接続元：203.0.*.*（この端末）')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '信頼を外す' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(dialog.querySelector('button[data-variant="primary"]')!)
  await waitFor(() => expect(calls.fetch).toHaveBeenCalledWith('/api/auth/trusted-logins/record-1', { method: 'DELETE' }))
  expect(await screen.findByText('信頼済みの端末はありません。')).toBeTruthy()
})

it('解除失敗は窓だけで知らせ、一覧を読み直す', async () => {
  const row = { id: 'record-1', ipPrefix: '203.0.*.*', confirmedAt: '2026-11-01T00:00:00Z', expiresAt: '2027-01-30T00:00:00Z', current: true }
  calls.fetch.mockResolvedValueOnce({ success: true, data: [row] }).mockRejectedValueOnce(new Error('conflict')).mockResolvedValueOnce({ success: true, data: [] })
  render(<TrustedLogins />)
  fireEvent.click(await screen.findByRole('button', { name: '信頼を外す' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(dialog.querySelector('button[data-variant="primary"]')!)
  expect(await screen.findByText('信頼を外せませんでした。最新の一覧を確認してください')).toBeTruthy()
  expect(await screen.findByText('信頼済みの端末はありません。')).toBeTruthy()
  expect(calls.fetch).toHaveBeenCalledTimes(3)
})
