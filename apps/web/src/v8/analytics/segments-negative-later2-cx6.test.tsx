// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ get: vi.fn(), friends: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ customerSegmentsApi: api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
import SegmentsV8 from './segments'

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('合計が負のときは全員の人数を未取得と出す', async () => {
  api.get.mockResolvedValue({ success: true, data: { cells: [], outside: { count: 0 }, total: -7, computedAt: '2026-11-20T04:00:00Z', status: 'ready' } })
  render(<SegmentsV8 accountId="a" canManage />)
  expect(await screen.findByText('全員 — 人')).toBeTruthy()
  expect(screen.queryByText(/全員 -7 人/)).toBeNull()
})

it('表の外の人数が負のときは未取得と示す', async () => {
  api.get.mockResolvedValue({ success: true, data: { cells: [], outside: { count: -3 }, total: 5, computedAt: '2026-11-20T04:00:00Z', status: 'ready' } })
  render(<SegmentsV8 accountId="a" canManage />)
  expect(await screen.findByText(/来店・購入なし — 人は表の外/)).toBeTruthy()
  expect(screen.queryByText(/-3 人/)).toBeNull()
})

it.each(['not_computed', 'ready'])('表の外が null の %s は人数の案内を出さない', async (status) => {
  api.get.mockResolvedValue({ success: true, data: { cells: [], outside: { count: null }, total: null, computedAt: status === 'ready' ? '2026-11-20T04:00:00Z' : null, status } })
  render(<SegmentsV8 accountId="a" canManage />)
  expect(await screen.findByText('全員 — 人')).toBeTruthy()
  expect(screen.queryByText(/人は表の外/)).toBeNull()
})

it('マスの人数が負のときは未取得と出し、押せない', async () => {
  api.get.mockResolvedValue({ success: true, data: { cells: [{ r: 1, f: 1, name: '見本', count: -2 }], outside: { count: 0 }, total: 5, computedAt: '2026-11-20T04:00:00Z', status: 'ready' } })
  render(<SegmentsV8 accountId="a" canManage />)
  const cell = await screen.findByRole('button', { name: '見本 人数は未取得' }) as HTMLButtonElement
  expect(cell.disabled).toBe(true)
  expect(screen.queryByText(/-2 人/)).toBeNull()
  expect(api.friends).not.toHaveBeenCalled()
})
