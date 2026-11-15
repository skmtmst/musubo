// @vitest-environment happy-dom
/*
 * 08b の再開導線（承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen 枠 Bnkcl）。
 * Pen の SuTRi どおり「続きからガイドで進める」「ガイドを最初から開始」と注記がこの順で並ぶこと・
 * 止めた所から続けられること・行き先が実在する段だけを案内すること・
 * チェックは実データで付くという注記が狭い幅でも出ることを見張る。
 * 一時停止はガイドバー側（枠 orKSi の共通ルール）なので、ここには出さない。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstStepsGuideFooter, type FirstStepsGuide } from './first-steps'

afterEach(cleanup)

const guide = (overrides: Partial<FirstStepsGuide> = {}): FirstStepsGuide => ({
  phase: 'idle',
  anchor: { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables' },
  pausedAnchor: null,
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(),
  ...overrides,
})

describe('はじめにやることの再開導線', () => {
  it('Pen の順で2つの操作と注記を出す', () => {
    const value = guide()
    render(<FirstStepsGuideFooter guide={value} />)
    const texts = Array.from(document.body.querySelectorAll('button, p')).map(node => node.textContent)
    expect(texts).toEqual(['続きからガイドで進める', 'ガイドを最初から開始', 'チェックは設定の実データで自動判定。ガイドを使わなくても付きます'])
    fireEvent.click(screen.getByRole('button', { name: '続きからガイドで進める' }))
    expect(value.start).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを最初から開始' }))
    expect(value.reset).toHaveBeenCalled()
  })

  it('案内中も操作は同じで、一時停止はここに出さない', () => {
    const value = guide({ phase: 'active' })
    render(<FirstStepsGuideFooter guide={value} />)
    expect(screen.getByRole('button', { name: '続きからガイドで進める' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '一時停止' })).toBeNull()
  })

  it('一時停止は止めた段から再開する', () => {
    const value = guide({ phase: 'paused', anchor: null, pausedAnchor: { key: 'hours', label: '営業時間を設定する', href: '/settings/hours' } })
    render(<FirstStepsGuideFooter guide={value} />)
    fireEvent.click(screen.getByRole('button', { name: '続きからガイドで進める' }))
    expect(value.resume).toHaveBeenCalled()
  })

  it('行き先が無い時と9項目が済んだ時は案内しない', () => {
    const { container } = render(<FirstStepsGuideFooter guide={guide({ anchor: null })} />)
    expect(container.textContent).toBe('')
    cleanup()
    const done = render(<FirstStepsGuideFooter guide={guide({ phase: 'done' })} />)
    expect(done.container.textContent).toBe('')
  })
})
