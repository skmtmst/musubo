// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import PeopleVisitActions from './visit-actions'
afterEach(cleanup)

it.each([
  ['restaurant', '来店した'], ['salon', '来店した'], ['consult', '面談済みにする'], ['lesson', '出席'],
] as const)('%sでは辞書の言葉を出し、既存の同じ来店印APIへつなぐ', (style, label) => {
  const mark = vi.fn()
  render(<PeopleVisitActions usageStyle={style} mark={null} ready busy={false} canMark onMark={mark} onUnmark={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(mark).toHaveBeenCalledExactlyOnceWith('visited')
  if (style === 'consult' || style === 'lesson') expect(screen.queryByRole('button', { name: '来店した' })).toBeNull()
})

it('業種が変わっても閲覧のみには出欠を変えるボタンを灰色で出し、押しても印を付けない', () => {
  const mark = vi.fn()
  render(<PeopleVisitActions usageStyle="lesson" mark={null} ready busy={false} canMark={false} onMark={mark} onUnmark={vi.fn()} />)
  const button = screen.getByRole('button', { name: '出席' })
  expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(mark).not.toHaveBeenCalled()
})

it('閲覧のみにも付いている印は見せる', () => {
  render(<PeopleVisitActions usageStyle="lesson" mark={{ kind: 'visited' } as never} ready busy={false} canMark={false} onMark={vi.fn()} onUnmark={vi.fn()} />)
  expect(screen.getByText('出席')).toBeTruthy()
})
