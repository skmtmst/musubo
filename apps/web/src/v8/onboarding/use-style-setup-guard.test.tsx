// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStyleSetup } from './use-style-setup'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  warnings: vi.fn(),
  starterItems: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: api }))
vi.mock('@/lib/api/transport/read-cache', () => ({ invalidateApiReads: api.invalidate }))

describe('useStyleSetup 不正応答形のフェイルクローズ', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    api.get.mockResolvedValue({ success: true, data: { style: 'standard', version: 1, answers: {} } })
    api.warnings.mockResolvedValue({ success: true, data: { items: [] } })
    api.starterItems.mockResolvedValue({ success: true, data: { items: [] } })
  })

  afterEach(() => {
    cleanup()
  })

  it('warnings.data.items が配列でない不正応答を ready にせず error 状態にする', async () => {
    api.warnings.mockResolvedValueOnce({ success: true, data: { items: 'broken' } })
    const { result } = renderHook(() => useStyleSetup('acc-1', 'owner'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
  })

  it('state.data が null や starterItems.data.items が欠損した不正応答を error 状態にする', async () => {
    api.get.mockResolvedValueOnce({ success: true, data: null })
    const first = renderHook(() => useStyleSetup('acc-1', 'owner'))
    await waitFor(() => expect(first.result.current.status).toBe('error'))
    expect(first.result.current.data).toBeNull()
    first.unmount()

    api.starterItems.mockResolvedValueOnce({ success: true, data: null })
    const second = renderHook(() => useStyleSetup('acc-2', 'owner'))
    await waitFor(() => expect(second.result.current.status).toBe('error'))
    expect(second.result.current.data).toBeNull()
  })
})
