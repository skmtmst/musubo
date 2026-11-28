// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpeningDate } from '@line-crm/shared'

vi.mock('@/components/shared/date-field', () => ({
  default: ({
    id,
    value,
    min,
    max,
    disabled,
    onChange,
  }: {
    id?: string
    value: string
    min?: string
    max?: string
    disabled?: boolean
    onChange: (value: string) => void
  }) => (
    <input
      id={id}
      type="date"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}))

import { DateEditor, type DateEditorValue } from './hours-date-editor'

const originalDay = (date: string): OpeningDate => ({
  date,
  closed: false,
  periods: [{ open: '11:00', close: '22:00' }],
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DateEditor の範囲・切替・無効状態の整合性', () => {
  it('期間入力に今日より前の日付が含まれても、受付範囲内の日付だけを親へ渡す', () => {
    const onChange = vi.fn<(value: DateEditorValue | null) => void>()
    render(
      <DateEditor
        today="2026-11-04"
        initialMode="range"
        original={originalDay}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByLabelText('開始日'), { target: { value: '2026-11-02' } })
    fireEvent.change(screen.getByLabelText('終了日'), { target: { value: '2026-11-05' } })

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dates: ['2026-11-04', '2026-11-05'],
      }),
    )

    fireEvent.change(screen.getByLabelText('終了日'), { target: { value: '2026-11-03' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('日付を選ぶ→期間で選ぶ→日付を選ぶへ戻したとき、画面に残る選択を親へ伝え直す', () => {
    const onChange = vi.fn<(value: DateEditorValue | null) => void>()
    render(
      <DateEditor
        today="2026-11-04"
        original={originalDay}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '2026-11-14', exact: true }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dates: ['2026-11-14'],
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '期間で選ぶ' }))
    expect(onChange).toHaveBeenLastCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: '日付を選ぶ' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dates: ['2026-11-14'],
      }),
    )
  })

  it('無効状態のときは選び方の切替とメモ追加を押せず、値を変えない', () => {
    const onChange = vi.fn<(value: DateEditorValue | null) => void>()
    render(
      <DateEditor
        today="2026-11-04"
        initialDates={['2026-11-14']}
        original={originalDay}
        onChange={onChange}
        disabled
      />,
    )

    const rangeButton = screen.getByRole('button', { name: '期間で選ぶ' }) as HTMLButtonElement
    const memoButton = screen.getByRole('button', { name: 'メモを追加' }) as HTMLButtonElement

    expect(rangeButton.disabled).toBe(true)
    expect(memoButton.disabled).toBe(true)

    fireEvent.click(rangeButton)
    fireEvent.click(memoButton)

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'メモ' })).toBeNull()
  })
})
