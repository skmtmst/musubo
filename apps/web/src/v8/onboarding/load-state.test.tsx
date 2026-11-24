// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ get: vi.fn(), warnings: vi.fn(), starterItems: vi.fn(), progress: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { get: net.progress } } }))
import { useStyleSetup } from './use-style-setup'
import { useFirstRun } from './use-first-run'
import { useSetupMutationRefresh } from './use-setup-mutation-refresh'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'
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

it('保存直後は他画面の札を消さず、はじめの設定へ移動した時は古い済みを隠して新しい進捗を受け取る', async () => {
  let resolveNew!: (value: unknown) => void
  const resultFor = (state: string) => ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state, href: '/tags?tab=tags', reason: null }] })
  net.progress.mockReset().mockResolvedValueOnce(resultFor('done')).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
  function Screen({ path }: { path: string }) {
    const run = useFirstRun('a')
    useSetupMutationRefresh('a', run.refresh, path, run.markStale)
    const step = run.steps.find(item => item.key === 'attributes')
    const chipCount = step?.state === 'done' ? '札 1' : '札 0'
    const listText = path === '/getting-started' && (run.status === 'loading' || run.revalidating) ? '確認中' : step?.state === 'done' ? '済み 1' : '未完了 0'
    return <div><span>{path}</span><span>{chipCount}</span><span>{listText}</span></div>
  }
  const view = render(<Screen path="/settings" />)
  await screen.findByText('済み 1')
  expect(screen.getByText('札 1')).toBeTruthy()
  act(() => { window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'a' } })) })
  expect(screen.getByText('札 1')).toBeTruthy()
  expect(screen.getByText('済み 1')).toBeTruthy()
  view.rerender(<Screen path="/getting-started" />)
  await waitFor(() => expect(net.progress).toHaveBeenCalledTimes(2))
  expect(screen.getByText('/getting-started')).toBeTruthy()
  expect(screen.getByText('札 1')).toBeTruthy()
  expect(screen.queryByText('済み 1')).toBeNull()
  expect(screen.getByText('確認中')).toBeTruthy()
  await act(async () => { resolveNew(resultFor('todo')) })
  expect(await screen.findByText('未完了 0')).toBeTruthy()
  expect(screen.getByText('札 0')).toBeTruthy()
})

it('再読込中に後ろの読み直しが割り込んで失敗しても、読み込み中で固まらず失敗として再試行できる', async () => {
  let resolveReload!: (value: unknown) => void
  const readyPayload = ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null }] })
  net.progress.mockReset()
    .mockResolvedValueOnce(readyPayload)
    .mockImplementationOnce(() => new Promise(resolve => { resolveReload = resolve }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(readyPayload)
  const { result } = renderHook(() => useFirstRun('a'))
  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => { result.current.reload() })
  expect(result.current.status).toBe('loading')
  act(() => { result.current.refresh() })
  await waitFor(() => expect(result.current.status).toBe('error'))
  await act(async () => { resolveReload(readyPayload) })
  expect(result.current.status).toBe('error')
  act(() => { result.current.reload() })
  await waitFor(() => expect(result.current.status).toBe('ready'))
})
