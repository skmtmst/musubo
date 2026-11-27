// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import QrDialog, { type QrRoute } from './qr-dialog'

const image = vi.hoisted(() => vi.fn(async () => 'data:image/png;base64,qr'))
const pdf = vi.hoisted(() => vi.fn(async () => new Blob(['pdf'])))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: image }))
vi.mock('@/lib/api', () => ({ api: { entryRoutes: { qrPdf: pdf } } }))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
const active: QrRoute = { id: 'active', refCode: 'active', name: '有効な経路', genre: null, isActive: true }
const unknown = { id: 'unknown', refCode: 'unknown', name: '状態不明の経路', genre: null, isActive: 'false' } as unknown as QrRoute
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('状態不明の経路はQRを出さず、有効な経路へ選び直せる', async () => {
  render(<QrDialog route={unknown} routes={[unknown, active]} onClose={vi.fn()} />)
  expect(screen.getByText('経路の状態を確認できません')).toBeTruthy()
  expect(image).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'PDFで印刷' })).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: '流入経路' }), { target: { value: 'active' } })
  await waitFor(() => expect(image).toHaveBeenCalledWith(expect.stringMatching(/\/r\/active$/), expect.any(Object)))
})

it('状態不明の別経路は、有効な候補として選べない', async () => {
  render(<QrDialog route={active} routes={[active, unknown]} onClose={vi.fn()} />)
  await waitFor(() => expect(image).toHaveBeenCalled())
  expect(screen.queryByRole('option', { name: '状態不明の経路' })).toBeNull()
  fireEvent.change(screen.getByRole('combobox', { name: '流入経路' }), { target: { value: 'unknown' } })
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('有効な経路 の QR コード')
})

it('未登録の経路はこれまでどおりQRを使える', async () => {
  render(<QrDialog route={{ refCode: 'orphan', name: '未登録の経路', genre: null, isActive: null }} onClose={vi.fn()} />)
  await waitFor(() => expect(image).toHaveBeenCalledWith(expect.stringMatching(/\/r\/orphan$/), expect.any(Object)))
  expect(screen.queryByText('経路の状態を確認できません')).toBeNull()
})
