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

it('入口の確認中は進捗を隠し、同じアカウントの確認後は取得済みの値を使う', async () => {
  net.progress.mockReset().mockResolvedValue(ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags', reason: null }] }))
  const view = renderHook(({ enabled }) => useFirstRun('a', enabled), { initialProps: { enabled: true } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  view.rerender({ enabled: false })
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.steps).toEqual([])
  view.rerender({ enabled: true })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(net.progress).toHaveBeenCalledTimes(1)
})

it('入口の確認中に先読みを始めても確認完了まで隠し、完了時は同じ取得結果を使う', async () => {
  let resolveLoad!: (value: unknown) => void
  net.progress.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveLoad = resolve }))
  const view = renderHook(({ enabled }) => useFirstRun('a', enabled, false, 'staff-owner', true), { initialProps: { enabled: false } })
  expect(net.progress).toHaveBeenCalledTimes(1)
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.steps).toEqual([])
  view.rerender({ enabled: true })
  expect(net.progress).toHaveBeenCalledTimes(1)
  await act(async () => { resolveLoad(ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags', reason: null }] })) })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(net.progress).toHaveBeenCalledTimes(1)
})

it('担当者や権限が変わった直後は前の進捗を表示しない', async () => {
  let resolveNext!: (value: unknown) => void
  const payload = ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags', reason: null }] })
  net.progress.mockReset().mockResolvedValueOnce(payload).mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve }))
  const view = renderHook(({ identity }) => useFirstRun('a', true, false, identity), { initialProps: { identity: 'staff-owner' } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  view.rerender({ identity: 'staff-viewer' })
  expect(view.result.current.status).toBe('loading')
  expect(view.result.current.steps).toEqual([])
  await act(async () => { resolveNext(payload) })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  expect(net.progress).toHaveBeenCalledTimes(2)
})

it('保存後に入口の確認が入った場合は、確認後に読み直して古い進捗を表示しない', async () => {
  let resolveNext!: (value: unknown) => void
  const payload = (state: string) => ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state, href: '/tags', reason: null }] })
  net.progress.mockReset().mockResolvedValueOnce(payload('done')).mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve }))
  const view = renderHook(({ enabled }) => useFirstRun('a', enabled), { initialProps: { enabled: true } })
  await waitFor(() => expect(view.result.current.status).toBe('ready'))
  act(() => view.result.current.markStale())
  view.rerender({ enabled: false })
  act(() => view.result.current.refresh())
  view.rerender({ enabled: true })
  expect(view.result.current.status).toBe('loading')
  await waitFor(() => expect(net.progress).toHaveBeenCalledTimes(2))
  await act(async () => { resolveNext(payload('todo')) })
  await waitFor(() => expect(view.result.current.steps.find(step => step.key === 'attributes')?.state).toBe('todo'))
})

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

it('保存後の再取得が失敗したら、札の直前値は保ちつつ再確認失敗を記録して古い完了を一覧へ戻さない', async () => {
  const readyPayload = ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null }] })
  net.progress.mockReset().mockResolvedValueOnce(readyPayload).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(readyPayload)
  const { result } = renderHook(() => useFirstRun('a'))
  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.markStale())
  expect(result.current.revalidating).toBe(true)
  expect(result.current.revalidationStatus).toBe('loading')

  act(() => result.current.refresh())
  await waitFor(() => expect(net.progress).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.revalidationStatus).toBe('error'))
  expect(result.current.revalidationError).toBeInstanceOf(Error)
  /* 上の帯の札だけは直前の数を出したまま保つ。 */
  expect(result.current.status).toBe('ready')
  expect(result.current.steps.find((step) => step.key === 'attributes')?.state).toBe('done')

  act(() => result.current.reload())
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.revalidationStatus).toBe('idle')
  expect(result.current.revalidationError).toBeNull()
})

it('前の読み直しの応答が次の保存より後に来ても、結果も確認中の印も変えない', async () => {
  let resolveOld!: (value: unknown) => void
  const donePayload = ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'done', href: '/tags?tab=tags', reason: null }] })
  const stalePayload = ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null }] })
  net.progress.mockReset()
    .mockResolvedValueOnce(donePayload)
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const { result } = renderHook(() => useFirstRun('a'))
  await waitFor(() => expect(result.current.status).toBe('ready'))

  act(() => result.current.refresh())
  act(() => result.current.markStale())
  expect(result.current.revalidating).toBe(true)

  await act(async () => { resolveOld(stalePayload) })
  expect(result.current.revalidating).toBe(true)
  expect(result.current.steps.find((step) => step.key === 'attributes')?.state).toBe('done')
})

it('連続の保存・先に始まった読み直しの応答・画面の移動・次の読み直し成功まで順番どおりに反映する', async () => {
  vi.useFakeTimers()
  try {
    let resolveEarlierRefresh!: (value: unknown) => void
    let resolveAfterNavigate!: (value: unknown) => void
    const payloadFor = (state: 'done' | 'todo') => ok({ steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }, { key: 'attributes', state, href: '/tags?tab=tags', reason: null }] })
    net.progress.mockReset()
      .mockResolvedValueOnce(payloadFor('done'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveEarlierRefresh = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveAfterNavigate = resolve }))

    function Screen({ path }: { path: string }) {
      const run = useFirstRun('a')
      useSetupMutationRefresh('a', run.refresh, path, run.markStale)
      const step = run.steps.find(item => item.key === 'attributes')
      const chip = step?.state === 'done' ? '札 1' : '札 0'
      const list = path !== '/getting-started'
        ? '別画面'
        : run.status !== 'ready' || run.revalidating
          ? '確認中'
          : run.revalidationError
            ? '再確認失敗'
            : step?.state === 'done'
              ? '一覧 済み'
              : '一覧 未完了'
      return <div><span>{chip}</span><span>{list}</span><button type="button" onClick={run.refresh}>先行読込</button></div>
    }

    const view = render(<Screen path="/tags" />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('札 1')).toBeTruthy()

    /* 1. 先に始まった裏の読み直しが進行中に、連続して2回保存が成功する */
    act(() => { screen.getByRole('button', { name: '先行読込' }).click() })
    expect(net.progress).toHaveBeenCalledTimes(2)
    act(() => { window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'a' } })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => { window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'a' } })) })

    /* 2. 先に始まった読み直しの応答が返っても、確認中の印も結果も変えない */
    await act(async () => { resolveEarlierRefresh(payloadFor('done')) })
    view.rerender(<Screen path="/getting-started" />)
    expect(net.progress).toHaveBeenCalledTimes(3)
    expect(screen.getByText('札 1')).toBeTruthy()
    expect(screen.getByText('確認中')).toBeTruthy()
    expect(screen.queryByText('一覧 済み')).toBeNull()

    /* 3. 画面移動で即座に始まった読み直しは500ms後も二重に走らず、成功で一覧と札を更新する */
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(net.progress).toHaveBeenCalledTimes(3)
    await act(async () => { resolveAfterNavigate(payloadFor('todo')) })
    expect(screen.getByText('一覧 未完了')).toBeTruthy()
    expect(screen.getByText('札 0')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})
