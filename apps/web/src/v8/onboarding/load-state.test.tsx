// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ get: vi.fn(), warnings: vi.fn(), starterItems: vi.fn(), progress: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { get: net.progress } } }))
import { useStyleSetup } from './use-style-setup'
import { useFirstRun } from './use-first-run'
afterEach(cleanup)
const ok = (data: unknown) => ({ success: true, data })

it('初期設定の取得失敗を表示用のerrorにし、再取得で保存済み状態へ戻る', async () => {
  net.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok({ style: 'consult', version: 3 }))
  net.warnings.mockResolvedValue(ok({ items: [] }))
  net.starterItems.mockResolvedValue(ok({ items: [] }))
  const { result } = renderHook(() => useStyleSetup('a', 'owner'))
  await waitFor(() => expect(result.current.status).toBe('error'))
  expect(result.current.data).toBeNull()
  await act(async () => result.current.reload())
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.data?.state).toMatchObject({ style: 'consult', version: 3 })
})

it('別アカウントへ切替後の遅い返事で上書きしない', async () => {
  let resolveOld!: (value: unknown) => void
  net.progress.mockImplementation((id: string) => id === 'a' ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null }] })))
  const { result, rerender } = renderHook(({ id }) => useFirstRun(id), { initialProps: { id: 'a' } })
  rerender({ id: 'b' })
  await waitFor(() => expect(result.current.status).toBe('ready'))
  await act(async () => { resolveOld(ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null }] })) })
  /* 済みの「使う機能」は一覧から外れるので、遅い返事の見張りは別の段で行う。 */
  expect(result.current.steps.find((step) => step.key === 'attributes')?.state).toBe('done')
})

it('役割が分からない時は初期質問APIを読まない', () => {
  net.get.mockClear()
  const { result } = renderHook(() => useStyleSetup('a', null))
  expect(result.current.status).toBe('idle')
  expect(net.get).not.toHaveBeenCalled()
})
