// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VisitStampCard, VisitStampQr } from '@line-crm/shared'

const api = vi.hoisted(() => ({
  storefrontQr: vi.fn(),
  issueStorefrontQr: vi.fn(),
  issueStaffQr: vi.fn(),
  staffQrStatus: vi.fn(),
  revokeStaffQr: vi.fn(),
}))

vi.mock('@/lib/visit-stamps-api', () => ({ visitStampsApi: api }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: async () => 'data:image/png;base64,cQ==' }))

import { StaffQr, StorefrontQr } from './qr'

const card = {
  id: 'card-1',
  name: '来店スタンプ',
  version: 1,
  settings: { mode: 'count', amountUnit: 1000, maxPerVisit: 3 },
} as VisitStampCard

function makeQr(overrides: Partial<VisitStampQr> = {}): VisitStampQr {
  return {
    id: 'qr-1',
    status: 'active',
    url: 'https://example.test/qr-1',
    issuedAt: '2026-11-27T00:00:00Z',
    expiresAt: '2026-11-27T00:00:30Z',
    serverTime: '2026-11-27T00:00:00Z',
    count: 1,
    ...overrides,
  } as VisitStampQr
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('来店スタンプQRの連打防止と初回読み込み再試行', () => {
  it('店頭QRの初回読み込みに失敗すると「もう一度読み込む」を出し、再試行で表示できる', async () => {
    api.storefrontQr
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ data: makeQr({ id: 'qr-active', url: 'https://example.test/storefront' }) })

    render(<StorefrontQr card={card} accountId="acc-1" shop="本店" canManage />)

    const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
    expect(screen.queryByRole('button', { name: '店頭のQRを作る' })).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.click(retry)

    expect(await screen.findByRole('button', { name: '保存・印刷' })).toBeTruthy()
    expect(api.storefrontQr).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  })

  it('店頭QRの発行ボタンを連打しても発行要求は1回だけ送る', async () => {
    api.storefrontQr.mockResolvedValue({ data: null })
    let resolveIssue!: (value: { data: VisitStampQr }) => void
    api.issueStorefrontQr.mockImplementation(
      () => new Promise<{ data: VisitStampQr }>(resolve => { resolveIssue = resolve }),
    )

    render(<StorefrontQr card={card} accountId="acc-1" shop="本店" canManage />)

    const createButton = await screen.findByRole('button', { name: '店頭のQRを作る' })
    fireEvent.click(createButton)
    fireEvent.click(createButton)

    expect(api.issueStorefrontQr).toHaveBeenCalledTimes(1)

    resolveIssue({ data: makeQr({ id: 'qr-created' }) })
    expect(await screen.findByRole('button', { name: '保存・印刷' })).toBeTruthy()
  })

  it('担当者QRの「QR を出す」と「続けて出す」を連打しても1回ずつしか発行しない', async () => {
    let resolveOpen!: (value: { data: VisitStampQr }) => void
    let resolveMore!: (value: { data: VisitStampQr }) => void
    api.issueStaffQr
      .mockImplementationOnce(() => new Promise<{ data: VisitStampQr }>(resolve => { resolveOpen = resolve }))
      .mockImplementationOnce(() => new Promise<{ data: VisitStampQr }>(resolve => { resolveMore = resolve }))
    api.staffQrStatus.mockResolvedValue({
      data: {
        qr: makeQr({ id: 'qr-used', status: 'used' }),
        result: { friendName: '田中', wallet: { balance: 2 } },
      },
    })
    api.revokeStaffQr.mockResolvedValue({ success: true })

    render(<StaffQr card={card} accountId="acc-1" shop="本店" onClose={() => {}} />)

    const openButton = screen.getByRole('button', { name: 'QR を出す' })
    fireEvent.click(openButton)
    fireEvent.click(openButton)
    expect(api.issueStaffQr).toHaveBeenCalledTimes(1)

    resolveOpen({ data: makeQr({ id: 'qr-used', status: 'used' }) })
    const moreButton = await screen.findByRole('button', { name: '続けて出す' })

    fireEvent.click(moreButton)
    fireEvent.click(moreButton)
    expect(api.issueStaffQr).toHaveBeenCalledTimes(2)

    resolveMore({ data: makeQr({ id: 'qr-next', status: 'active' }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '続けて出す' })).toBeNull())
  })
})
