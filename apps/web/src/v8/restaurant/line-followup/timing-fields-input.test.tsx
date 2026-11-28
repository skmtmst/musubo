// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantFollowupTiming, RestaurantFollowupTrigger } from '@line-crm/shared'
import { FollowupTimingFields } from './timing-fields'

afterEach(cleanup)

function ControlledHarness({
  trigger,
  initial,
  onEmit,
}: {
  trigger: RestaurantFollowupTrigger
  initial: RestaurantFollowupTiming
  onEmit: (next: RestaurantFollowupTiming) => void
}) {
  const [value, setValue] = useState<RestaurantFollowupTiming>(initial)
  return (
    <FollowupTimingFields
      trigger={trigger}
      value={value}
      onChange={(next) => {
        onEmit(next)
        setValue(next)
      }}
    />
  )
}

describe('FollowupTimingFields の数値入力と単位追従', () => {
  it('待つ時間の数値欄を空にしても NaN を渡さず、入力し直せる', () => {
    const onEmit = vi.fn()
    render(
      <ControlledHarness
        trigger="post_visit"
        initial={{ mode: 'countdown', offsetMinutes: 180 }}
        onEmit={onEmit}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }) as HTMLInputElement
    expect(input.value).toBe('3')

    fireEvent.change(input, { target: { value: '' } })
    expect(onEmit).not.toHaveBeenCalled()
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { value: '5' } })
    expect(onEmit).toHaveBeenCalledTimes(1)
    expect(onEmit).toHaveBeenCalledWith({ mode: 'countdown', offsetMinutes: 300 })
    expect(input.value).toBe('5')
  })

  it('日と時刻の「何日前」欄を空にしても NaN を渡さず、NaN が渡っても表示に残さない', () => {
    const onEmit = vi.fn()
    const view = render(
      <ControlledHarness
        trigger="reservation_24h"
        initial={{ mode: 'time', offsetDays: -2, sendAtTime: '18:00' }}
        onEmit={onEmit}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: '予約の何日前' }) as HTMLInputElement
    expect(input.value).toBe('2')

    fireEvent.change(input, { target: { value: '' } })
    expect(onEmit).not.toHaveBeenCalled()
    expect(input.value).toBe('')

    fireEvent.blur(input)
    expect(input.value).toBe('2')

    // 外部から NaN が入ってきた場合でも「NaN」表示を残さない
    view.rerender(
      <FollowupTimingFields
        trigger="reservation_24h"
        value={{ mode: 'time', offsetDays: Number.NaN, sendAtTime: '18:00' }}
        onChange={onEmit}
      />,
    )
    const fallbackInput = screen.getByRole('spinbutton', { name: '予約の何日前' }) as HTMLInputElement
    expect(fallbackInput.value).toBe('')
  })

  it('外から offsetMinutes が変わったら単位も追従し、自分で選んだ単位での入力は勝手に跳ねない', () => {
    const onChange = vi.fn()
    const view = render(
      <FollowupTimingFields
        trigger="post_visit"
        value={{ mode: 'countdown', offsetMinutes: 180 }}
        onChange={onChange}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }) as HTMLInputElement
    const unitButton = screen.getByRole('button', { name: '時間の単位' })
    expect(unitButton.textContent).toContain('時間')
    expect(input.value).toBe('3')

    // 外部から 45 分に変わった場合、単位も「分」へ追従し 0.75 時間にならない
    view.rerender(
      <FollowupTimingFields
        trigger="post_visit"
        value={{ mode: 'countdown', offsetMinutes: 45 }}
        onChange={onChange}
      />,
    )
    expect(unitButton.textContent).toContain('分')
    expect(input.value).toBe('45')

    // 外部から 1 日（1440 分）に変わった場合、単位も「日」へ追従する
    view.rerender(
      <FollowupTimingFields
        trigger="post_visit"
        value={{ mode: 'countdown', offsetMinutes: 1440 }}
        onChange={onChange}
      />,
    )
    expect(unitButton.textContent).toContain('日')
    expect(input.value).toBe('1')

    // 自分で「分」を選び直して 120 を入れた場合は、親から 120 が返っても「時間」へ勝手に跳ねない
    fireEvent.click(unitButton)
    fireEvent.click(screen.getByRole('button', { name: '分' }))
    expect(unitButton.textContent).toContain('分')
    fireEvent.change(input, { target: { value: '120' } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'countdown', offsetMinutes: 120 })
    view.rerender(
      <FollowupTimingFields
        trigger="post_visit"
        value={{ mode: 'countdown', offsetMinutes: 120 }}
        onChange={onChange}
      />,
    )
    expect(unitButton.textContent).toContain('分')
    expect(input.value).toBe('120')
  })
})
