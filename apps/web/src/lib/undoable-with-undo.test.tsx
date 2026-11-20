// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { runOptimisticWithUndo } from './undoable'
import { ApiError } from './api'

beforeEach(() => {
  clearToastsForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  clearToastsForTest()
  vi.useRealTimers()
})

const buttonByText = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((el) => el.textContent?.includes(text)) as HTMLButtonElement | undefined

describe('runOptimisticWithUndo（その場で直す）', () => {
  it('保存したら成功の知らせを出し、逆の保存は行わない', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const undoRequest = vi.fn()
    const revert = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimisticWithUndo({ request, revert, undoRequest, successMessage: '保存しました', failureMessage: '保存できませんでした。', retry: vi.fn() })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('保存しました')
    expect(buttonByText(container, '元に戻す')).toBeUndefined()
    expect(undoRequest).not.toHaveBeenCalled()
    expect(revert).not.toHaveBeenCalled()
  })

  it('失敗したら画面を戻し、口の理由と［もう一度試す］を出す。押すとやり直す', async () => {
    const revert = vi.fn()
    const retry = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimisticWithUndo({
        request: vi.fn().mockRejectedValue(new ApiError(400, '担当者が見つかりません')),
        revert, retry, successMessage: '担当をKentaにしました', failureMessage: '担当を変えられませんでした。',
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(revert).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('担当を変えられませんでした。担当者が見つかりません')
    expect(container.textContent).not.toContain('担当をKentaにしました')
    await act(async () => {
      buttonByText(container, 'もう一度試す')!.click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('機械の文（API error: 500）は出さず、言い換える', async () => {
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimisticWithUndo({ request: vi.fn().mockResolvedValue({ success: false, error: 'API error: 500' }), revert: vi.fn(), retry: vi.fn(), successMessage: 'ok', failureMessage: 'メモを保存できませんでした。' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(container.textContent).toContain('メモを保存できませんでした。通信を確かめて')
    expect(container.textContent).not.toContain('API error')
  })

  it('成功の文が空なら知らせない（管理画面 の画面は静かに終わる）', async () => {
    const onSuccess = vi.fn()
    const { container } = render(<ToastHost />)
    await act(async () => {
      runOptimisticWithUndo({ request: vi.fn().mockResolvedValue({ success: true }), revert: vi.fn(), undoRequest: vi.fn(), retry: vi.fn(), successMessage: '', failureMessage: 'x', onSuccess })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(buttonByText(container, '元に戻す')).toBeUndefined()
  })
})
