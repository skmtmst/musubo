// @vitest-environment happy-dom
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchApi } from '@/lib/api/transport/request'
import { useSetupMutationRefresh } from './use-setup-mutation-refresh'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('削除に成功した後、共通の仕組みが進捗を読み直し札の値を更新する', async () => {
  let done = 5
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    requests.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/scenarios/s1' && init?.method === 'DELETE') { done = 4; return new Response(null, { status: 204 }) }
    if (path === '/api/getting-started') return Response.json({ success: true, data: { done } })
    return Response.json({ success: false }, { status: 400 })
  }))
  const received = vi.fn()
  renderHook(() => useSetupMutationRefresh('a', () => { void fetchApi<{ data: { done: number } }>('/api/getting-started?account_id=a').then(result => received(result.data.done)) }))
  await fetchApi('/api/scenarios/s1?account_id=a', { method: 'DELETE' })
  await waitFor(() => expect(received).toHaveBeenCalledWith(4))
  expect(requests).toEqual(['DELETE /api/scenarios/s1', 'GET /api/getting-started'])
})

it('失敗、読み取り、別アカウントの変更、ガイド操作では読み直さない', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/api/error') return Response.json({ success: false }, { status: 400 })
      return Response.json(path === '/api/failure' ? { success: false } : { success: true })
    }))
    const refresh = vi.fn()
    renderHook(() => useSetupMutationRefresh('a', refresh))
    await fetchApi('/api/scenarios?account_id=a')
    await fetchApi('/api/failure?account_id=a', { method: 'POST' })
    await expect(fetchApi('/api/error?account_id=a', { method: 'POST' })).rejects.toThrow()
    await fetchApi('/api/scenarios/s1?account_id=b', { method: 'DELETE' })
    await fetchApi('/api/getting-started/guide?account_id=a', { method: 'PUT' })
    await fetchApi('/api/forms/f1/routing/preview?account_id=a', { method: 'POST' })
    await vi.advanceTimersByTimeAsync(600)
    expect(refresh).not.toHaveBeenCalled()
    await fetchApi('/api/tags?account_id=a', { method: 'POST' })
    await fetchApi('/api/friend-fields?account_id=a', { method: 'PATCH' })
    await vi.advanceTimersByTimeAsync(600)
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
