// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'
import StyleSettingDemo from './style-setting-demo'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('スタイル設定見本のスタイル切替時の範囲外防止', () => {
  it('動きを減らす設定で5手順から4手順のスタイルへ切り替えても最終手順と進捗バーが範囲内に収まる', () => {
    setTestReducedMotion(true)
    const view = render(<StyleSettingDemo style="restaurant" />)

    expect(screen.getByText('追加する', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('value')).toBe('5')
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('max')).toBe('5')

    view.rerender(<StyleSettingDemo style="salon" />)

    expect(screen.getByText('変更を保存する', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('value')).toBe('4')
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('max')).toBe('4')
  })

  it('通常再生で5段目の停止状態から4手順のスタイルへ切り替えると先頭から再開する', () => {
    setTestReducedMotion(false)
    vi.useFakeTimers()
    const view = render(<StyleSettingDemo style="restaurant" />)

    for (let i = 0; i < 4; i += 1) {
      act(() => { vi.advanceTimersByTime(2800) })
    }
    expect(screen.getByText('追加する', { selector: 'strong' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '止める' }))

    view.rerender(<StyleSettingDemo style="salon" />)

    expect(screen.getByText('予約設定を開く', { selector: 'strong' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('value')).toBe('1')
    expect(screen.getByRole('progressbar', { name: '操作の進み' }).getAttribute('max')).toBe('4')
    expect(screen.getByRole('button', { name: '止める' })).toBeTruthy()
  })
})
