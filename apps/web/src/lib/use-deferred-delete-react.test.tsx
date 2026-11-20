// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { useDeferredDelete, type DeferredDelete } from './use-deferred-delete'

let api: DeferredDelete
function Rows({ ids }: { ids: string[] }) {
  api = useDeferredDelete()
  return (
    <ul>
      {ids.filter((id) => !api.isHidden(id)).map((id) => <li key={id}>{id}</li>)}
    </ul>
  )
}

beforeEach(() => {
  clearToastsForTest()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  clearToastsForTest()
  vi.useRealTimers()
})

const rows = () => [...document.querySelectorAll('li')].map((el) => el.textContent)

describe('削除の結果', () => {
  it('保存中は行を隠し、成功後に読み直す', async () => {
    let finish!: (value: { success: boolean }) => void
    const commit = vi.fn(() => new Promise<{ success: boolean }>(resolve => { finish = resolve }))
    const reload = vi.fn().mockResolvedValue(undefined)
    render(<><ToastHost /><Rows ids={['a', 'b']} /></>)
    await act(async () => { api.schedule({ ids: ['a'], message: '削除しました', commit, onCommitted: reload }); await Promise.resolve() })
    expect(rows()).toEqual(['b'])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('削除しました')).toBeNull()
    await act(async () => { finish({ success: true }); await vi.advanceTimersByTimeAsync(0) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(api.hiddenCount).toBe(0)
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull()
  })

  it('保存に失敗したら行を戻して知らせる', async () => {
    const commit = vi.fn().mockResolvedValue({ success: false, error: 'x' })
    render(<><ToastHost /><Rows ids={['a', 'b']} /></>)
    await act(async () => { api.schedule({ ids: ['a'], message: '消しました', commit, failureMessage: '消せませんでした。' }); await vi.advanceTimersByTimeAsync(0) })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual(['a', 'b'])
    expect(screen.getByText('消せませんでした。')).toBeTruthy()
  })
})
