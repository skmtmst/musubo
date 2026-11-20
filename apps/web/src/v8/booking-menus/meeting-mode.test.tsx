// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getMenuUrl: vi.fn(), saveMenuUrl: vi.fn(), fetchApi: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCalendarApi: api }))
vi.mock('@/lib/api', () => ({ fetchApi: api.fetchApi }))
const { useMenuMeeting } = await import('./meeting-mode')
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('自動発行を版付きで保存し、再読み込みできる', async () => {
  api.getMenuUrl.mockResolvedValue({ data: { url: null, version: 3, issuance: 'manual' } })
  api.saveMenuUrl.mockResolvedValue({ data: { url: null, version: 5, issuance: 'automatic' } })
  const { result } = renderHook(() => useMenuMeeting('account', 'menu', 'online'))
  await waitFor(() => expect(result.current.url).not.toBeNull())
  act(() => result.current.setIssuance('automatic'))
  await act(async () => { expect(await result.current.save('menu', 4)).toBe(5) })
  expect(api.saveMenuUrl).toHaveBeenCalledWith('account', 'menu', null, 4, 'automatic')
  expect(result.current.dirty).toBe(false)
})

it('保存せずに戻すと発行方法を元に戻す', async () => {
  api.getMenuUrl.mockResolvedValue({ data: { url: null, version: 3, issuance: 'automatic' } })
  const { result } = renderHook(() => useMenuMeeting('account', 'menu', 'online'))
  await waitFor(() => expect(result.current.issuance).toBe('automatic'))
  act(() => result.current.setIssuance('manual'))
  act(() => result.current.reset())
  expect(result.current.issuance).toBe('automatic')
  expect(result.current.dirty).toBe(false)
})
