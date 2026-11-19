// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { runOptimistic, runUndoable } from './undoable'

beforeEach(() => {
  clearToastsForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  clearToastsForTest()
  vi.useRealTimers()
})

describe('保存と結果の通知（runUndoable）', () => {
  it('保存が成功してから知らせ、取り消し操作は出さない', async () => {
    const commit = vi.fn().mockResolvedValue({ success: true })
    const undo = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runUndoable({ message: '外しました', commit, undo })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('外しました')
    expect(container.textContent).not.toContain('元に戻す')
    expect(undo).not.toHaveBeenCalled()
  })

  it('送信が失敗したら画面を元に戻して失敗の知らせを出す', async () => {
    const commit = vi.fn().mockResolvedValue({ success: false, error: 'x' })
    const undo = vi.fn()
    const onCommitError = vi.fn()
    const { container } = render(<ToastHost />)
    act(() => {
      runUndoable({
        message: '外しました',
        commit,
        undo,
        onCommitError,
        failureMessage: '外せませんでした。',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onCommitError).toHaveBeenCalledTimes(1)
    // undo とは別の復元を渡したときはそちらが使われる
    expect(undo).not.toHaveBeenCalled()
    expect(container.textContent).toContain('外せませんでした。')
  })

  it('送信が通ったら onCommitted を呼ぶ（一覧の読み直し用）', async () => {
    const commit = vi.fn().mockResolvedValue({ success: true })
    const onCommitted = vi.fn()
    render(<ToastHost />)
    act(() => {
      runUndoable({ message: '外しました', commit, undo: vi.fn(), onCommitted })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })
})

describe('先に画面を変える軽い操作（runOptimistic）', () => {
  it('保存に失敗したら元に戻して「もう一度」の知らせを出す', async () => {
    const request = vi.fn().mockResolvedValue({ success: false, error: 'x' })
    const revert = vi.fn()
    const retry = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimistic({ request, revert, failureMessage: 'できませんでした。', retry })
      await Promise.resolve()
    })
    expect(revert).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('できませんでした。')
    const retryButton = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'もう一度',
    ) as HTMLButtonElement
    act(() => {
      retryButton.click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('保存に通ったら静かに終わり onSuccess を呼ぶ', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const revert = vi.fn()
    const onSuccess = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimistic({ request, revert, failureMessage: 'x', onSuccess })
      await Promise.resolve()
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(revert).not.toHaveBeenCalled()
    expect(container.textContent ?? '').not.toContain('失敗')
  })

  it('通信自体が投げても元に戻す', async () => {
    const request = vi.fn().mockRejectedValue(new Error('network'))
    const revert = vi.fn()
    render(<ToastHost />)
    await act(async () => {
      runOptimistic({ request, revert, failureMessage: 'できませんでした。' })
      await Promise.resolve()
    })
    expect(revert).toHaveBeenCalledTimes(1)
  })
})
