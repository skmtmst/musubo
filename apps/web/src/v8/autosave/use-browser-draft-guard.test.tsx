// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_DELAY_MS } from './use-draft-autosave'
import { readBrowserDraft, useBrowserDraft } from './use-browser-draft'

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

describe('useBrowserDraft 不正保存時刻・循環参照・active切替時の防御', () => {
  it('readBrowserDraft は savedAt が 0 以下や非有限、配列などの破損データを無視する', () => {
    localStorage.setItem('k-zero', JSON.stringify({ savedAt: 0, value: { a: 1 } }))
    localStorage.setItem('k-neg', JSON.stringify({ savedAt: -100, value: { a: 1 } }))
    localStorage.setItem('k-arr', JSON.stringify([1, 2, 3]))
    expect(readBrowserDraft('k-zero')).toBeNull()
    expect(readBrowserDraft('k-neg')).toBeNull()
    expect(readBrowserDraft('k-arr')).toBeNull()
  })

  it('循環参照のある値でも例外で落ちず、active=false になったときに savedAt を残さない・restore も返さない', () => {
    const circular: Record<string, unknown> = { name: 'a' }
    circular.self = circular
    const circHook = renderHook(() =>
      useBrowserDraft({ storageKey: 'k-circ', value: circular, baseline: { name: 'a' }, active: true }),
    )
    expect(circHook.result.current.dirty).toBe(false)
    circHook.unmount()

    const { result, rerender } = renderHook(
      ({ active, value }: { active: boolean; value: { name: string } }) =>
        useBrowserDraft({ storageKey: 'k-active', value, baseline: { name: 'init' }, active }),
      { initialProps: { active: true, value: { name: 'changed' } } },
    )
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    })
    expect(result.current.label).toContain('一時保存済み')

    // 閲覧のみ（active=false）になると savedAt をリセットし、再び active=true に戻しても古い「一時保存済み」表記を残さない
    rerender({ active: false, value: { name: 'changed' } })
    expect(result.current.restore()).toBeNull()

    localStorage.clear()
    rerender({ active: true, value: { name: 'changed' } })
    expect(result.current.label).toBe('保存していない変更があります')
  })
})
