// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRegistrationImport } from './use-registration-import'

const calls = vi.hoisted(() => ({ read: vi.fn(), step: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { followerImportState: calls.read, stepFollowerImport: calls.step } } }))

const running = { phase: 'importing_ids', received: 1, imported: 0, alreadyPresent: 0, reactivated: 0, claimedUnassigned: 0, conflicts: 0, invalid: 0, profilesProcessed: 0, profilesUpdated: 0, lastError: null }
const ok = (data: unknown) => ({ success: true, data })

beforeEach(() => { vi.useFakeTimers(); calls.read.mockReset(); calls.step.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('取り込み実行の失敗は状態取得の成功で消えず、実行が成功したら消える', async () => {
  calls.step.mockResolvedValueOnce({ success: false }).mockResolvedValue(ok({ state: running, busy: true }))
  calls.read.mockResolvedValue(ok(running))
  const view = renderHook(() => useRegistrationImport('account', true, 'importing_ids', true, false))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(view.result.current.importRequestError).toBe(true)
  expect(view.result.current.importAttention).toBe(true)
  await act(async () => { await view.result.current.refreshImport() })
  expect(view.result.current.importRequestError).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls.step).toHaveBeenCalledTimes(2)
  expect(view.result.current.importRequestError).toBe(false)
})

it('状態取得の失敗は取り込み実行の成功で消えず、読み直し成功で消える', async () => {
  calls.read.mockResolvedValueOnce({ success: false }).mockResolvedValue(ok(running))
  calls.step.mockResolvedValue(ok({ state: running, busy: true }))
  const view = renderHook(() => useRegistrationImport('account', true, 'importing_ids', true, false))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(view.result.current.importRequestError).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(calls.step).toHaveBeenCalledTimes(2)
  expect(view.result.current.importRequestError).toBe(true)
  await act(async () => { await view.result.current.refreshImport() })
  expect(view.result.current.importRequestError).toBe(false)
})
