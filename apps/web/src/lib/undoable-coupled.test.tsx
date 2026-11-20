// @vitest-environment happy-dom
/*
 * R623/R624 の結合再現（Toast + runUndoable/runOptimistic）。
 * fake timers + stub commit で、実APIを叩かずに画面と保存の一致を見る。
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest, undoLatestToast } from '@/components/shared/toast'
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

describe('保存と知らせ', () => {
  it('保存が終わるまで成功を知らせず、成功後は取り消しを出さない', async () => {
    let finish!: (value: { success: boolean }) => void
    const commit = vi.fn(() => new Promise<{ success: boolean }>(resolve => { finish = resolve }))
    const undo = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => { runUndoable({ message: '外しました', commit, undo }); await Promise.resolve() })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('外しました')
    await act(async () => { finish({ success: true }); await Promise.resolve() })
    expect(container.textContent).toContain('外しました')
    expect(container.textContent).not.toContain('元に戻す')
    expect(undoLatestToast()).toBe(false)
    expect(undo).not.toHaveBeenCalled()
  })

  it('もう一度だけのとき⌘Zは何もしない（クリックの再試行は残す）', async () => {
    const retry = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimistic({
        request: vi.fn().mockResolvedValue({ success: false, error: 'x' }),
        revert: vi.fn(),
        failureMessage: '付けられませんでした。',
        retry,
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    expect(retry).not.toHaveBeenCalled()
    // 知らせは残る
    expect(container.textContent).toContain('付けられませんでした。')
    // 押しての再試行はできるまま
    const retryButton = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === 'もう一度',
    ) as HTMLButtonElement
    act(() => {
      retryButton.click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
