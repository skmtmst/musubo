// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_WORDS, autosaveLabel, savedAgoLabel, useDraftAutosave } from './use-draft-autosave'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('useDraftAutosave ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('非有限な時刻で「NaN秒前」を出さない', () => {
    expect(savedAgoLabel(Number.NaN, Date.now())).toBe('—')
    expect(autosaveLabel({
      autosaving: false,
      failed: false,
      dirty: false,
      savedAt: Number.NaN,
      now: Date.now(),
    })).toBe('下書き保存済み')
  })

  it('自動保存の実行中に手動保存（markSaved）が成功した場合、遅れて返った古い自動保存の失敗で失敗状態を上書きしない', async () => {
    const inflight = deferred<boolean>()
    const save = vi.fn(() => inflight.promise)
    let latest!: ReturnType<typeof useDraftAutosave>

    function Harness({ text, saved, active = true }: { text: string; saved: string; active?: boolean }) {
      latest = useDraftAutosave({
        fingerprint: text,
        dirty: text !== saved,
        active,
        enabled: true,
        paused: false,
        save,
      })
      return null
    }

    const view = render(<Harness text="draft-1" saved="" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(latest.autosaving).toBe(true)

    // 自動保存の応答待ちの間に手動保存が成功
    act(() => { latest.markSaved() })
    view.rerender(<Harness text="draft-1" saved="draft-1" />)

    // 古い自動保存が失敗で返っても失敗フラグを立てず、autosaving も確実に解除される
    await act(async () => { inflight.resolve(false); await Promise.resolve() })
    expect(latest.autosaving).toBe(false)
    expect(latest.failed).toBe(false)
    expect(latest.label).not.toBe(AUTOSAVE_WORDS.failed)
  })
})
