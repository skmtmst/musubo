// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ qr: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: mocks.qr }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, entryRoutes: { ...actual.api.entryRoutes, get: mocks.get } } }
})
import QrDialog from './qr-dialog'
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('経路の回復と未知の経路への変更が同時でも、基準URLのQRを作らない', async () => {
  mocks.qr.mockResolvedValue('data:image/png;base64,fixture')
  mocks.get.mockImplementation(() => new Promise(() => {}))
  const props = { open: true, onClose: () => {}, accountName: '店舗', baseLink: 'https://example.invalid/base', routes: [] }
  const view = render(<QrDialog {...props} routesError initialRouteId="" />)
  expect(screen.getByText('経路を読み込めませんでした')).toBeTruthy()
  view.rerender(<QrDialog {...props} routesError={false} initialRouteId="unknown" />)
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('unknown'))
  expect(mocks.qr).not.toHaveBeenCalledWith(props.baseLink, expect.anything())
  expect(screen.queryByAltText('友だち追加QRコード')).toBeNull()
})
