// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ generate: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: fixture.generate }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, entryRoutes: { list: vi.fn(), get: fixture.get } } }
})
import QrDialog from '@/components/dashboard/qr-dialog'
import { ApiError } from '@/lib/api'
import type { EntryRoute } from '@line-crm/shared'

const base = { onClose: () => {}, accountName: 'お店', baseLink: 'https://example.com/base' }
const resource = { title: '配布用', url: 'https://example.com/link' }
beforeEach(() => { fixture.generate.mockReset().mockResolvedValue('data:image/png;base64,fixture'); fixture.get.mockReset() })
afterEach(cleanup)

it('閉じている間は作らず、開いて使える時だけQRを作る', async () => {
  const view = render(<QrDialog {...base} open={false} resource={resource} />)
  await act(async () => { await Promise.resolve() })
  expect(fixture.generate).not.toHaveBeenCalled()
  view.rerender(<QrDialog {...base} open resource={resource} />)
  await waitFor(() => expect(fixture.generate).toHaveBeenCalledWith(resource.url, expect.any(Object)))
})

it('停止中の経路ではQRを作らない', async () => {
  render(<QrDialog {...base} open resource={{ ...resource, stopped: true }} />)
  await act(async () => { await Promise.resolve() })
  expect(fixture.generate).not.toHaveBeenCalled()
})

it('経路の読込失敗ではQRを作らない', async () => {
  render(<QrDialog {...base} open routes={[]} routesError />)
  await act(async () => { await Promise.resolve() })
  expect(fixture.generate).not.toHaveBeenCalled()
})

it('見つからない経路ではQRを作らない', async () => {
  fixture.get.mockRejectedValue(new ApiError(404, 'not found'))
  render(<QrDialog {...base} open routes={[]} initialRouteId="missing" />)
  await waitFor(() => expect(fixture.get).toHaveBeenCalled())
  await act(async () => { await Promise.resolve() })
  expect(fixture.generate).not.toHaveBeenCalled()
})

it('一覧にある停止中の経路でもQRを作らない', async () => {
  const route: EntryRoute = { id: 'stopped', name: '停止中', refCode: 'code', isActive: false, genre: null, tagId: null, scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: false, stoppedAt: null, stoppedReason: null, createdAt: '', updatedAt: '' }
  render(<QrDialog {...base} open routes={[route]} initialRouteId="stopped" />)
  await act(async () => { await Promise.resolve() })
  expect(fixture.generate).not.toHaveBeenCalled()
})
