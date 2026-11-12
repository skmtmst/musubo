// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DateTimeField from './date-time-field'

afterEach(cleanup)
function Example() {
  const [value, setValue] = useState('2026-10-01T10:00')
  return <><DateTimeField value={value} onChange={setValue} aria-label="予定日時" /><output data-testid="value">{value}</output></>
}

it('一つの窓で日付と時刻を選び、確定するまでは元の日時を変えない', () => {
  render(<Example />)
  fireEvent.click(screen.getByRole('button', { name: '予定日時' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('grid')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /2026年10月2日/ }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  expect(screen.getByTestId('value').textContent).toBe('2026-10-02T10:00')
})

it('Esc は選択を破棄する', () => {
  render(<Example />)
  fireEvent.click(screen.getByRole('button', { name: '予定日時' }))
  fireEvent.click(screen.getByRole('button', { name: /2026年10月2日/ }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByTestId('value').textContent).toBe('2026-10-01T10:00')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('時刻を変更してから日時を消して確定できる', () => {
  render(<Example />)
  fireEvent.click(screen.getByRole('button', { name: '予定日時' }))
  const time = screen.getByRole('combobox', { name: '時刻' })
  fireEvent.focus(time)
  fireEvent.change(time, { target: { value: '1430' } })
  fireEvent.keyDown(time, { key: 'Enter' })
  fireEvent.click(screen.getByRole('button', { name: '消す' }))
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
  expect(screen.getByTestId('value').textContent).toBe('')
})

it('窓を開いた後に外側の値が変わったら古い選択を確定できない', () => {
  const onChange = vi.fn()
  const view = render(<DateTimeField value="2026-10-01T10:00" onChange={onChange} aria-label="予定日時" />)
  fireEvent.click(screen.getByRole('button', { name: '予定日時' }))
  fireEvent.click(screen.getByRole('button', { name: /2026年10月2日/ }))
  view.rerender(<DateTimeField value="2026-10-03T11:00" onChange={onChange} aria-label="予定日時" />)
  expect((screen.getByRole('button', { name: '確定' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})
