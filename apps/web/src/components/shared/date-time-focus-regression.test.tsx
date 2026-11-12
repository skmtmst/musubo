// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DateTimeField, { TimeField } from './date-time-field'
beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  // ブラウザでは visibility:hidden の子へ focus できない。happy-dom でも同じ制約で試す。
  const focus = HTMLElement.prototype.focus
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
    if (this.closest<HTMLElement>('[data-menu-portal]')?.style.visibility === 'hidden') return
    focus.call(this, options)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme })
it('WEB-027: ArrowDown後にポータルが描画されてから日付へ焦点を移し、Escで元へ戻す', () => {
  render(<DateTimeField aria-label="予約日時" defaultValue="2026-10-01T10:00" />)
  const trigger = screen.getByRole('button', { name: '予約日時' })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const date = screen.getByRole('button', { name: '2026年10月1日（木）' })
  expect(document.activeElement).toBe(date)
  fireEvent.keyDown(date, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '2026年10月1日（木）' }))
})
it('時刻欄のArrowDownは時の列へ移し、分の選択・Escの戻りを保つ', () => {
  render(<TimeField aria-label="時刻" defaultValue="10:00" />)
  const input = screen.getByRole('combobox', { name: '時刻' })
  input.focus()
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('listbox', { name: '時' }))
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(screen.getByRole('listbox', { name: '分' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(document.activeElement).toBe(input)
})
