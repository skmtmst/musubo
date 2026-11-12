// @vitest-environment happy-dom
/*
 * ★V8 の時刻の欄（Pencil 提案 YCOoR「時刻を選ぶ（打つ＋2列から選ぶ）」・オーナー 2026-10-08）。
 * 動きを守る：打った値の直し方・範囲外は直さず理由・2列で選ぶ・キー操作・
 * 日本語の変換中の Enter・分のきざみ。値は今までどおり `HH:mm`。
 */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DateTimeField, { TimeField } from './date-time-field'
import TimeFieldV8, { normalizeTimeInput, snapToStep } from './time-field-v8'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

function Harness({ initial = '', step, minuteStep }: { initial?: string; step?: number; minuteStep?: number }) {
  const [value, setValue] = useState(initial)
  return (
    <form onSubmit={(event) => { event.preventDefault(); throw new Error('送ってはいけない') }}>
      <TimeField value={value} onChange={setValue} step={step} minuteStep={minuteStep} aria-label="時刻（日本時間）" />
      <output data-testid="value">{value}</output>
    </form>
  )
}

const input = () => screen.getByRole('combobox', { name: '時刻（日本時間）' }) as HTMLInputElement
const valueText = () => screen.getByTestId('value').textContent

it('時計なしの欄からも時と分を選べ、閲覧のみでは開かない', () => {
  const change = vi.fn()
  const { rerender } = render(<TimeFieldV8 defaultValue="09:00" pickerTrigger="field" aria-label="開始" onChange={change} />)
  expect(screen.queryByRole('button', { name: '時刻の一覧を開く' })).toBeNull()
  fireEvent.click(screen.getByRole('combobox', { name: '開始' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(within(screen.getByRole('listbox', { name: '時' })).getByRole('option', { name: '10' }))
  fireEvent.click(within(screen.getByRole('listbox', { name: '分' })).getByRole('option', { name: '15' }))
  expect(change).toHaveBeenLastCalledWith('10:15')
  fireEvent.keyDown(screen.getByRole('combobox', { name: '開始' }), { key: 'Escape' })
  rerender(<TimeFieldV8 value="09:00" pickerTrigger="field" aria-label="開始" readOnly />)
  fireEvent.click(screen.getByRole('combobox', { name: '開始' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

function typeAndCommit(text: string, key: 'Enter' | 'blur' = 'Enter') {
  const field = input()
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value: text } })
  if (key === 'Enter') fireEvent.keyDown(field, { key: 'Enter' })
  else fireEvent.blur(field)
}

describe('打った値の直し方', () => {
  it.each([
    ['0900', '09:00'],
    ['900', '09:00'],
    ['9:00', '09:00'],
    ['9', '09:00'],
    ['930', '09:30'],
    ['９：３０', '09:30'],
    ['9時30分', '09:30'],
    ['23:59', '23:59'],
  ])('「%s」は %s', (typed, expected) => {
    expect(normalizeTimeInput(typed)).toEqual({ kind: 'ok', time: { hours: Number(expected.slice(0, 2)), minutes: Number(expected.slice(3)) }, note: null })
  })

  it('空は空（消す）', () => {
    expect(normalizeTimeInput('  ')).toEqual({ kind: 'empty' })
  })

  it('欄に打って Enter で 09:00 になり、欄は「09 : 00」。フォームは送らない', () => {
    render(<Harness />)
    expect(input().placeholder).toBe('-- : --')
    typeAndCommit('0900')
    expect(valueText()).toBe('09:00')
    expect(input().value).toBe('09 : 00')
  })

  it('欄から外れたときも決まる', () => {
    render(<Harness />)
    typeAndCommit('9:15', 'blur')
    expect(valueText()).toBe('09:15')
  })

  it('範囲外は直さず理由を出す（値はそのまま）', () => {
    render(<Harness initial="08:00" />)
    typeAndCommit('2500')
    expect(valueText()).toBe('08:00')
    expect(screen.getByRole('alert').textContent).toContain('時は 0〜23')
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().value).toBe('2500')
    typeAndCommit('0975')
    expect(valueText()).toBe('08:00')
    expect(screen.getByRole('alert').textContent).toContain('分は 0〜59')
    typeAndCommit('あいう')
    expect(screen.getByRole('alert').textContent).toContain('0900')
  })

  it('全部消して決めると空になる', () => {
    render(<Harness initial="08:00" />)
    typeAndCommit('')
    expect(valueText()).toBe('')
  })
})

describe('分のきざみ', () => {
  it('きざみに合わない分は近い方へ合わせて知らせる', () => {
    expect(normalizeTimeInput('0903', 5)).toEqual({ kind: 'ok', time: { hours: 9, minutes: 5 }, note: '5分きざみなので 09:05 にしました' })
    expect(normalizeTimeInput('0907', 15)).toMatchObject({ time: { hours: 9, minutes: 0 } })
    expect(snapToStep({ hours: 23, minutes: 58 }, 5).time).toEqual({ hours: 23, minutes: 55 })
    expect(snapToStep({ hours: 9, minutes: 58 }, 5).time).toEqual({ hours: 10, minutes: 0 })
  })

  it('欄で打ったときも合わせて知らせる', () => {
    render(<Harness minuteStep={5} />)
    typeAndCommit('0903')
    expect(valueText()).toBe('09:05')
    expect(screen.getByText('5分きざみなので 09:05 にしました')).toBeTruthy()
  })

  it('分の列は呼ぶ側のきざみ（minuteStep 15 → 4行、step=300 秒 → 12行、既定は 60行）', () => {
    const { unmount } = render(<Harness minuteStep={15} />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    expect(within(screen.getByRole('listbox', { name: '分' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['00', '15', '30', '45'])
    unmount()
    const second = render(<Harness step={300} />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    expect(within(screen.getByRole('listbox', { name: '分' })).getAllByRole('option')).toHaveLength(12)
    second.unmount()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    expect(within(screen.getByRole('listbox', { name: '分' })).getAllByRole('option')).toHaveLength(60)
    expect(within(screen.getByRole('listbox', { name: '時' })).getAllByRole('option')).toHaveLength(24)
  })

  it('きざみに合わない既存の値は、触っただけでは変えない', () => {
    render(<Harness initial="09:03" minuteStep={5} />)
    fireEvent.focus(input())
    fireEvent.blur(input())
    expect(valueText()).toBe('09:03')
  })
})

describe('2列から選ぶ', () => {
  it('時計で開き、時を押すと値が入って開いたまま、分を押すと決まって閉じる', () => {
    render(<Harness initial="09:00" />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    const dialog = screen.getByRole('dialog', { name: '時刻を選ぶ' })
    const hours = within(dialog).getByRole('listbox', { name: '時' })
    expect(within(hours).getByRole('option', { selected: true }).textContent).toBe('09')
    fireEvent.click(within(hours).getByRole('option', { name: '14' }))
    expect(valueText()).toBe('14:00')
    expect(screen.getByRole('dialog', { name: '時刻を選ぶ' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('listbox', { name: '分' })).getByRole('option', { name: '30' }))
    expect(valueText()).toBe('14:30')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input().value).toBe('14 : 30')
  })

  it('空のとき分だけ先に押すと 10時で入る（管理画面 と同じ既定）', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(within(screen.getByRole('listbox', { name: '分' })).getByRole('option', { name: '45' }))
    expect(valueText()).toBe('10:45')
  })

  it('「消す」で空になり閉じる。「今の時刻」で値が入り閉じる', () => {
    render(<Harness initial="09:00" />)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(screen.getByRole('button', { name: '消す' }))
    expect(valueText()).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(screen.getByRole('button', { name: '今の時刻' }))
    expect(valueText()).toMatch(/^\d{2}:\d{2}$/)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('外を押すと閉じる', () => {
    render(<><Harness initial="09:00" /><button type="button">外</button></>)
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    act(() => {
      screen.getByRole('button', { name: '外' }).dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(valueText()).toBe('09:00')
  })
})

describe('キー操作', () => {
  it('欄で↓で開き、上下で動き、Enter で時を決めて分へ、左右で列を移り、Enter で決めて閉じる', () => {
    render(<Harness initial="09:00" minuteStep={5} />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const hours = screen.getByRole('listbox', { name: '時' })
    expect(document.activeElement).toBe(hours)
    fireEvent.keyDown(hours, { key: 'ArrowDown' })
    fireEvent.keyDown(hours, { key: 'ArrowDown' })
    fireEvent.keyDown(hours, { key: 'ArrowUp' })
    // 動かしただけでは決めない
    expect(valueText()).toBe('09:00')
    fireEvent.keyDown(hours, { key: 'Enter' })
    expect(valueText()).toBe('10:00')
    const minutes = screen.getByRole('listbox', { name: '分' })
    expect(document.activeElement).toBe(minutes)
    fireEvent.keyDown(minutes, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(hours)
    fireEvent.keyDown(hours, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(minutes)
    fireEvent.keyDown(minutes, { key: 'ArrowDown' })
    fireEvent.keyDown(minutes, { key: 'ArrowDown' })
    fireEvent.keyDown(minutes, { key: 'Enter' })
    expect(valueText()).toBe('10:10')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('Esc で閉じて欄へ戻る（値は変えない）', () => {
    render(<Harness initial="09:00" />)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const hours = screen.getByRole('listbox', { name: '時' })
    fireEvent.keyDown(hours, { key: 'ArrowDown' })
    fireEvent.keyDown(hours, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(input())
    expect(valueText()).toBe('09:00')
  })

  it('日本語の変換中の Enter では決めない（欄も列も）', () => {
    render(<Harness initial="08:00" />)
    const field = input()
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: '0930' } })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    expect(valueText()).toBe('08:00')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(valueText()).toBe('09:30')

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    const hours = screen.getByRole('listbox', { name: '時' })
    fireEvent.keyDown(hours, { key: 'ArrowDown' })
    fireEvent.keyDown(hours, { key: 'Enter', isComposing: true })
    expect(valueText()).toBe('09:30')
    fireEvent.keyDown(hours, { key: 'Enter', keyCode: 229 })
    expect(valueText()).toBe('09:30')
  })
})

describe('欄の高さの口（size）', () => {
  const frame = (name: string) => screen.getByRole('combobox', { name }).parentElement as HTMLElement
  it('既定は印なし（36）、field は日付の欄と並ぶ 36、compact は細い欄の 32', () => {
    render(
      <>
        <TimeField aria-label="既定" value="09:00" />
        <TimeField aria-label="日付と並ぶ" size="field" value="09:00" />
        <TimeField aria-label="表の中" size="compact" value="09:00" />
      </>,
    )
    expect(frame('既定').dataset.size).toBeUndefined()
    expect(frame('日付と並ぶ').dataset.size).toBe('field')
    expect(frame('表の中').dataset.size).toBe('compact')
  })
})

describe('日時の欄の時刻の部分も同じ部品', () => {
  it('V8 では時刻の欄（打てる）が出て、打った時刻で日時の値が替わる', () => {
    function DtHarness() {
      const [value, setValue] = useState('2026-10-01T10:00')
      return (
        <>
          <DateTimeField value={value} onChange={setValue} aria-label="予約日時" />
          <output data-testid="value">{value}</output>
        </>
      )
    }
    render(<DtHarness />)
    fireEvent.click(screen.getByRole('button', { name: '予約日時' }))
    const dialog = screen.getByRole('dialog', { name: '日時を選ぶ' })
    expect(within(dialog).queryByRole('button', { name: '時' })).toBeNull()
    const time = within(dialog).getByRole('combobox', { name: '時刻' }) as HTMLInputElement
    expect(time.value).toBe('10 : 00')
    // 日付の欄（36）と並ぶので高さは field（絵のZU4Ae）。
    expect((time.parentElement as HTMLElement).dataset.size).toBe('field')
    fireEvent.focus(time)
    fireEvent.change(time, { target: { value: '1430' } })
    fireEvent.keyDown(time, { key: 'Enter' })
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }))
    expect(screen.getByTestId('value').textContent).toBe('2026-10-01T14:30')
  })
})


describe('終了時刻の24時', () => {
  it('終了欄だけ24:00を受け付け、24:30と通常欄の24:00を拒む', () => {
    expect(normalizeTimeInput('24:00', 30, true)).toMatchObject({ kind: 'ok', time: { hours: 24, minutes: 0 } })
    expect(normalizeTimeInput('24:30', 30, true).kind).toBe('error')
    expect(normalizeTimeInput('24:00', 30).kind).toBe('error')
  })
})
