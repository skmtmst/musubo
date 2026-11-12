// @vitest-environment happy-dom
/*
 * 日時の選択・時刻の選択（★管理画面 `Fw065` の仲間）。
 * 値は今までどおり（日時 `YYYY-MM-DDTHH:mm`・時刻 `HH:mm`、空は ''）で、
 * 表示だけ日本語。保存の中身は変えない。
 */
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DateTimeField, {
  TimeField,
  formatDateTimeLabel,
  formatTimeLabel,
  parseDateTime,
  parseTime,
} from './date-time-field'

afterEach(() => { cleanup(); vi.useRealTimers() })

function DateTimeHarness({ initial = '2026-10-01T10:00' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <DateTimeField value={value} onChange={setValue} aria-label="送る日時" />
      <output data-testid="value">{value}</output>
    </>
  )
}

function TimeHarness({ initial = '10:00' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <TimeField value={value} onChange={setValue} aria-label="始まる時刻" />
      <output data-testid="value">{value}</output>
    </>
  )
}

describe('日時の選択（V8）', () => {
  it('親が秒0を整えても同じ日時なら確定でき、変更なしでは通知しない', () => {
    const onChange = vi.fn()
    const view = render(<DateTimeField value="2026-10-01T10:00:00" onChange={onChange} aria-label="送る日時" />)
    fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
    view.rerender(<DateTimeField value="2026-10-01T10:00" onChange={onChange} aria-label="送る日時" />)
    const confirm = screen.getByRole('button', { name: '確定' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('日時の窓の中の日付選択には名前付きのグループがある', () => {
    render(<DateTimeHarness />)
    fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
    expect(screen.getByRole('group', { name: '日付を選ぶ' })).toBeTruthy()
  })
  it('表示は「2026年10月1日（木）10:00」、値は YYYY-MM-DDTHH:mm のまま', () => {
    render(<DateTimeHarness />)
    expect(screen.getByRole('button', { name: '送る日時' }).textContent).toContain('2026年10月1日（木）10:00')
    expect(formatDateTimeLabel(parseDateTime('2026-10-01T10:00')!)).toBe('2026年10月1日（木）10:00')
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  })

  it('空は置き場所文。秒付きの既存値も読む', () => {
    render(<DateTimeHarness initial="" />)
    expect(screen.getByRole('button', { name: '送る日時' }).textContent).toContain('日時を選ぶ')
    expect(parseDateTime('2026-10-01T10:00:59')).toEqual({
      date: new Date(2026, 9, 1),
      hours: 10,
      minutes: 0,
    })
    expect(parseDateTime('')).toBeNull()
    expect(parseDateTime('2026-10-01')).toBeNull()
    expect(parseDateTime('2026-10-01T25:00')).toBeNull()
  })

  it('日本で日付が変わった直後の今日を選ぶと、日本の日付と10:00で値が決まる', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T15:00:00Z'))
    /*
     * 固定の日付ボタン名で押すと、その日が「今日」のとき名前が
     * 「…、今日」に変わって見つからない（月初境界で落ちた）。
     * 足もとの「今日」ボタンは常にあるので、それで「その月の中の
     * 1日を選ぶ」ことだけを確かめる。
     */
    render(<DateTimeHarness initial="" />)
    fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
    expect(screen.getByRole('dialog', { name: '日時を選ぶ' })).toBeTruthy()
    const ymd = '2026-10-10'
    fireEvent.click(screen.getByRole('button', { name: '今日' }))
    fireEvent.click(screen.getByRole('button', { name: '確定' }))
    expect(screen.getByTestId('value').textContent).toBe(`${ymd}T10:00`)
    const expected = formatDateTimeLabel(parseDateTime(`${ymd}T10:00`)!)
    expect(screen.getByRole('button', { name: '送る日時' }).textContent).toContain(expected)
  })

  it('時・分は確定まで仮の値で、確定すると反映する', () => {
    render(<DateTimeHarness />)
    fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
    const time = screen.getByRole('combobox', { name: '時刻' })
    fireEvent.change(time, { target: { value: '0900' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
    fireEvent.change(time, { target: { value: '0930' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
    expect(screen.getByRole('dialog', { name: '日時を選ぶ' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '確定' }))
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T09:30')
  })

  it('↓で開く。Escで閉じて欄へ戻る。×で空にできる', () => {
    render(<DateTimeHarness />)
    const trigger = screen.getByRole('button', { name: '送る日時' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.getByRole('dialog', { name: '日時を選ぶ' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: '日時を選ぶ' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(screen.getByRole('button', { name: '日時を消す' }))
    expect(screen.getByTestId('value').textContent).toBe('')
    expect(trigger.textContent).toContain('日時を選ぶ')
  })

  it('お任せ式（defaultValue）でも時を変えられる', () => {
    const onChange = vi.fn()
    render(<DateTimeField defaultValue="2026-10-01T10:00" onChange={onChange} aria-label="送る日時" />)
    fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
    const time = screen.getByRole('combobox', { name: '時刻' })
    fireEvent.change(time, { target: { value: '1800' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '確定' }))
    expect(onChange).toHaveBeenCalledWith('2026-10-01T18:00')
    expect(screen.getByRole('button', { name: '送る日時' }).textContent).toContain('2026年10月1日（木）18:00')
  })
})

describe('時刻の選択（V8）', () => {
  it('表示は「10:00」、値は HH:mm のまま', () => {
    render(<TimeHarness />)
    expect((screen.getByRole('combobox', { name: '始まる時刻' }) as HTMLInputElement).value).toBe('10 : 00')
    expect(formatTimeLabel(parseTime('10:00')!)).toBe('10:00')
    expect(parseTime('')).toBeNull()
    expect(parseTime('24:00')).toBeNull()
    expect(parseTime('10:00:59')!.minutes).toBe(0)
  })

  it('分を変えると値が替わる。消す口で空にできる', () => {
    render(<TimeHarness />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    expect(screen.getByRole('dialog', { name: '時刻を選ぶ' })).toBeTruthy()
    fireEvent.click(screen.getByRole('listbox', { name: '分' }).querySelector('[role="option"][id$="-m-30"]')!)
    expect(screen.getByTestId('value').textContent).toBe('10:30')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(screen.getByRole('button', { name: '消す' }))
    expect(screen.getByTestId('value').textContent).toBe('')
    expect((screen.getByRole('combobox', { name: '始まる時刻' }) as HTMLInputElement).placeholder).toBe('-- : --')
  })
})

it('日時内の日付選択は確定まで反映せず、キャンセルで元に戻る', () => {
  render(<DateTimeHarness />)
  fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
  fireEvent.click(screen.getByRole('button', { name: '2026年10月2日（金）' }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
  fireEvent.click(screen.getByRole('button', { name: '2026年10月2日（金）' }))
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-02T10:00')
})

it('日時の暦の仮選択はEscや外へのクリックで反映されない', () => {
  render(<DateTimeHarness />)
  fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
  fireEvent.click(screen.getByRole('button', { name: '2026年10月2日（金）' }))
  fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' })
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  if (!screen.queryByRole('dialog', { name:'日時を選ぶ' })) fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
  fireEvent.click(screen.getByRole('button', { name: '2026年10月2日（金）' }))
  fireEvent.pointerDown(document.body)
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
})

it('同じ窓の時刻欄へ移っても仮の日付を保持し、確定するまで反映しない', () => {
  render(<DateTimeHarness />)
  fireEvent.click(screen.getByRole('button', { name: '送る日時' }))
  fireEvent.click(screen.getByRole('button', { name: '2026年10月2日（金）' }))
  fireEvent.pointerDown(screen.getByRole('combobox', { name: '時刻' }))
  expect(screen.queryByRole('dialog', { name:'日付を選ぶ' })).toBeNull()
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-02T10:00')
})
