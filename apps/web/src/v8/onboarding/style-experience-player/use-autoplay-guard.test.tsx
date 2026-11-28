// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import { STYLE_EXPERIENCE_SCRIPT } from './script'
import { useStyleExperienceAutoplay } from './use-autoplay'

beforeEach(() => {
  setTestReducedMotion(false)
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('スタイル体験自動再生の範囲外ステップ指定ガード', () => {
  it('goToStepに上限超え・負数・NaNを渡しても有効な段へ丸めて自動再生を継続する', () => {
    const rootRef = { current: null as HTMLElement | null }
    const last = STYLE_EXPERIENCE_SCRIPT.styles.restaurant.scenes.length - 1

    const { result } = renderHook(() =>
      useStyleExperienceAutoplay({
        script: STYLE_EXPERIENCE_SCRIPT,
        rotation: ['restaurant'],
        repeatStyle: true,
        rootRef,
      }),
    )

    // 上限超えは最後の段へ丸まり、次のタイマーで先頭へ戻って再生が止まらない
    act(() => { result.current.goToStep(99) })
    expect(result.current.position.index).toBe(last)
    expect(result.current.scene).toBeDefined()

    const lastMs = result.current.scene.ms
    act(() => { vi.advanceTimersByTime(lastMs) })
    expect(result.current.position.index).toBe(0)
    expect(result.current.scene).toBeDefined()

    // 負数やNaNは先頭へ丸まり、次のタイマーで2段目へ進む
    act(() => { result.current.goToStep(-5) })
    expect(result.current.position.index).toBe(0)
    expect(result.current.scene).toBeDefined()

    act(() => { result.current.goToStep(Number.NaN) })
    expect(result.current.position.index).toBe(0)

    const firstMs = result.current.scene.ms
    act(() => { vi.advanceTimersByTime(firstMs) })
    expect(result.current.position.index).toBe(1)
  })
})
