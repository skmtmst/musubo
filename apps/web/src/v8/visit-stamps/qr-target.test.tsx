// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { VisitStampCard } from '@line-crm/shared'

const api = vi.hoisted(() => ({ storefrontQr: vi.fn(), issueStorefrontQr: vi.fn() }))
vi.mock('@/lib/visit-stamps-api', () => ({ visitStampsApi: api }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: async () => 'data:image/png;base64,cQ==' }))
import { StorefrontQr } from './qr'

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('店頭QRの再発行前にカードとアカウントと環境を示す', async () => {
  api.storefrontQr.mockResolvedValue({ data: { id: 'qr1', status: 'active', url: 'https://example.test/qr', issuedAt: '2026-10-01T00:00:00Z' } })
  const card = { id: 'card1', name: '来店カード', version: 1, settings: {} } as VisitStampCard
  render(<StorefrontQr card={card} accountId="account-a" shop="本店" canManage />)
  fireEvent.click(await screen.findByRole('button', { name: '作り直す' }))
  const dialog = screen.getByRole('alertdialog')
  expect(within(dialog).getByText('来店カード')).toBeTruthy()
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(api.issueStorefrontQr).not.toHaveBeenCalled()
})

it('アカウントが切り替わると以前の再発行確認は使えない', async () => {
  api.storefrontQr.mockResolvedValue({ data: { id: 'qr1', status: 'active', url: 'https://example.test/qr', issuedAt: '2026-10-01T00:00:00Z' } })
  const card = { id: 'card1', name: '来店カード', version: 1, settings: {} } as VisitStampCard
  const view = render(<StorefrontQr card={card} accountId="account-a" shop="本店" canManage />)
  fireEvent.click(await screen.findByRole('button', { name: '作り直す' }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  view.rerender(<StorefrontQr card={card} accountId="account-b" shop="支店" canManage />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(api.issueStorefrontQr).not.toHaveBeenCalled()
})

it('閉じた再発行確認を開き直しても古い確定を使えない', async () => {
  api.storefrontQr.mockResolvedValue({ data: { id: 'qr1', status: 'active', url: 'https://example.test/qr', issuedAt: '2026-10-01T00:00:00Z' } })
  const card = { id: 'card1', name: '来店カード', version: 1, settings: {} } as VisitStampCard
  render(<StorefrontQr card={card} accountId="account-a" shop="本店" canManage />)
  fireEvent.click(await screen.findByRole('button', { name: '作り直す' }))
  const dialog = screen.getByRole('alertdialog')
  const button = within(dialog).getByRole('button', { name: '作り直す' })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '作り直す' }))
  oldClick({ preventDefault() {}, stopPropagation() {} })
  expect(api.issueStorefrontQr).not.toHaveBeenCalled()
})
