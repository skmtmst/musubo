// @vitest-environment happy-dom
/*
 * 08b の再開導線（承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen 枠 Bnkcl）。
 * 止めた所から続けられること・行き先が実在する段だけを案内すること・
 * チェックは実データで付くという注記が狭い幅でも出ることを見張る。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstStepsGuideBand, type FirstStepsGuide } from './first-steps'

afterEach(cleanup)

const guide = (overrides: Partial<FirstStepsGuide> = {}): FirstStepsGuide => ({
  phase: 'idle',
  anchor: { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables' },
  pausedAnchor: null,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(),
  ...overrides,
})

describe('はじめにやることの再開導線', () => {
  it('始める前は次の段を示し、続きからと最初からを出す', () => {
    const value = guide()
    render(<FirstStepsGuideBand guide={value} />)
    expect(screen.getByText('次は「卓と席を登録する」です')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '続きからガイドで進める' }))
    expect(value.start).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを最初から開始' }))
    expect(value.reset).toHaveBeenCalled()
  })

  it('案内中は実在する行き先へのリンクと一時停止を出す', () => {
    const value = guide({ phase: 'active' })
    render(<FirstStepsGuideBand guide={value} />)
    expect(screen.getByRole('link', { name: '卓と席を登録するをガイドで開く' }).getAttribute('href')).toBe('/restaurant-test/tables')
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }))
    expect(value.pause).toHaveBeenCalled()
  })

  it('一時停止は止めた段から再開する', () => {
    const value = guide({ phase: 'paused', anchor: null, pausedAnchor: { key: 'hours', label: '営業時間を設定する', href: '/settings/hours' } })
    render(<FirstStepsGuideBand guide={value} />)
    expect(screen.getByText('次は「営業時間を設定する」です')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '続きからガイドで進める' }))
    expect(value.resume).toHaveBeenCalled()
  })

  it('行き先が無い時と9項目が済んだ時は案内しない', () => {
    const { container } = render(<FirstStepsGuideBand guide={guide({ anchor: null })} />)
    expect(container.textContent).toBe('')
    cleanup()
    const done = render(<FirstStepsGuideBand guide={guide({ phase: 'done' })} />)
    expect(done.container.textContent).toBe('')
  })
})
