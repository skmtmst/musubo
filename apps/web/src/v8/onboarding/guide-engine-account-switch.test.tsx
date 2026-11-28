// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGuideEngine, type GuideSummary } from './guide-engine'

const server = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { gettingStarted: { guide: server } } }))

const summaryPending: GuideSummary = {
  steps: [
    { key: 'accounts', label: 'LINEをつなぐ', href: '/settings/line', done: true },
    { key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu', done: false },
    { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: false },
  ],
  done: 1,
  total: 3,
}

const summaryFinished: GuideSummary = {
  steps: [
    { key: 'accounts', label: 'LINEをつなぐ', href: '/settings/line', done: true },
    { key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu', done: true },
    { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: true },
  ],
  done: 3,
  total: 3,
}

function Harness({ accountId, summary }: { accountId: string; summary: GuideSummary }) {
  const g = useGuideEngine(accountId, summary, true, 'staff-1')
  return (
    <div>
      <output data-testid="loading">{String(g.loading)}</output>
      <output data-testid="phase">{g.phase}</output>
      <output data-testid="step">{g.stepKey ?? ''}</output>
      <output data-testid="anchor">{g.anchor?.key ?? ''}</output>
      <button type="button" onClick={g.start}>開始</button>
      <button type="button" onClick={() => g.advanceProcedure(true)}>この段を見送る</button>
      <button type="button" onClick={() => void g.complete?.()}>完了する</button>
    </div>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  server.get.mockResolvedValue({ success: true, data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  server.save.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
})

describe('useGuideEngine のアカウント切替と完了の二重実行防止', () => {
  it('A で見送った段が B へ切り替えたあとに引き継がれない', async () => {
    const view = render(<Harness accountId="acc-a" summary={summaryPending} />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: '開始' }))
    expect(screen.getByTestId('step').textContent).toBe('richMenu')

    fireEvent.click(screen.getByRole('button', { name: 'この段を見送る' }))
    expect(screen.getByTestId('anchor').textContent).toBe('attributes')

    view.rerender(<Harness accountId="acc-b" summary={summaryPending} />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    expect(screen.getByTestId('anchor').textContent).toBe('richMenu')
  })

  it('A で保存待ちのまま B へ切り替えたら、A の古いキュー保存を後から送らない', async () => {
    let resolveSave1!: (value: unknown) => void
    server.save
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSave1 = resolve }))
      .mockResolvedValue({ success: true })

    const view = render(<Harness accountId="acc-a" summary={summaryPending} />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: '開始' }))
    await waitFor(() => expect(server.save).toHaveBeenCalledTimes(1))

    // 2件目の保存をキューへ積んだ直後に別アカウントへ切り替える
    fireEvent.click(screen.getByRole('button', { name: 'この段を見送る' }))
    view.rerender(<Harness accountId="acc-b" summary={summaryPending} />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    resolveSave1({ success: true })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(server.save).toHaveBeenCalledTimes(1)
  })

  it('完了操作を連続で押しても complete 保存を二重に送らない', async () => {
    let resolveDone!: (value: unknown) => void
    server.get.mockResolvedValue({ success: true, data: { phase: 'active', stepKey: 'attributes', procedureIndex: 1 } })
    server.save.mockImplementationOnce(() => new Promise((resolve) => { resolveDone = resolve }))

    render(<Harness accountId="acc-a" summary={summaryFinished} />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    const doneButton = screen.getByRole('button', { name: '完了する' })
    fireEvent.click(doneButton)
    fireEvent.click(doneButton)

    await waitFor(() => expect(server.save).toHaveBeenCalledTimes(1))
    resolveDone({ success: true })
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('done'))
    expect(server.save).toHaveBeenCalledTimes(1)
  })
})
