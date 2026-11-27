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

describe('FollowupTimingFields の単位切り替え時の整数丸め', () => {
  it('割り切れない単位へ切り替えても小数にならず、最も近い正の整数（時間・日）へそろえる', () => {
    const onEmit = vi.fn()
    render(
      <ControlledHarness
        trigger="reservation_created"
        initial={{ mode: 'countdown', offsetMinutes: 5 }}
        onEmit={onEmit}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }) as HTMLInputElement
    const unitButton = screen.getByRole('button', { name: '時間の単位' })
    expect(input.value).toBe('5')

    // 5分 → 時間：0.0833... ではなく 1時間（60分）にそろえる
    fireEvent.click(unitButton)
    fireEvent.click(screen.getByRole('button', { name: '時間' }))
    expect(input.value).toBe('1')
    expect(onEmit).toHaveBeenLastCalledWith({ mode: 'countdown', offsetMinutes: 60 })

    // 3時間（180分）にしてから日へ切り替え：0.125 ではなく 1日（1440分）にそろえる
    fireEvent.change(input, { target: { value: '3' } })
    expect(onEmit).toHaveBeenLastCalledWith({ mode: 'countdown', offsetMinutes: 180 })

    fireEvent.click(unitButton)
    fireEvent.click(screen.getByRole('button', { name: '日' }))
    expect(input.value).toBe('1')
    expect(onEmit).toHaveBeenLastCalledWith({ mode: 'countdown', offsetMinutes: 1440 })
  })

  it('予約前のカウントダウンでも負号を保ったまま整数へそろえ、割り切れるときは値を変えない', () => {
    const onEmit = vi.fn()
    render(
      <ControlledHarness
        trigger="reservation_2h"
        initial={{ mode: 'countdown', offsetMinutes: -90 }}
        onEmit={onEmit}
      />,
    )

    const input = screen.getByRole('spinbutton', { name: '予約までの時間' }) as HTMLInputElement
    const unitButton = screen.getByRole('button', { name: '時間の単位' })
    expect(input.value).toBe('90')

    // -90分 → 時間：1.5 ではなく 2時間前（-120分）へそろえる
    fireEvent.click(unitButton)
    fireEvent.click(screen.getByRole('button', { name: '時間' }))
    expect(input.value).toBe('2')
    expect(onEmit).toHaveBeenCalledTimes(1)
    expect(onEmit).toHaveBeenLastCalledWith({ mode: 'countdown', offsetMinutes: -120 })

    // 2時間（-120分）→ 分：割り切れるので余分な onChange を呼ばず 120 のまま表示する
    fireEvent.click(unitButton)
    fireEvent.click(screen.getByRole('button', { name: '分' }))
    expect(input.value).toBe('120')
    expect(onEmit).toHaveBeenCalledTimes(1)
  })
})
