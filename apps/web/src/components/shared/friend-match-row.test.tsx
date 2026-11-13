// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FriendMatchRow from './friend-match-row'

afterEach(cleanup)

it('名前・補足と選択状態を出し、行で選択を変更できる', () => {
  const select = vi.fn()
  const view = render(<FriendMatchRow name="見本 143" description="LINE の友だち・090" selected={false} inset onSelect={select} />)
  fireEvent.click(screen.getByRole('button', { name: /見本 143/ }))
  expect(select).toHaveBeenCalledOnce()
  view.rerender(<FriendMatchRow name="見本 143" description="LINE の友だち・090" selected inset onSelect={select} />)
  expect(screen.getByRole('button', { pressed: true }).textContent).toContain('選択中')
  expect(screen.getByText('LINE の友だち・090')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { pressed: true }))
  expect(select).toHaveBeenCalledTimes(2)
})

it('選択済みの要約でも選び直す操作を名前で押せる', () => {
  const clear = vi.fn()
  render(<FriendMatchRow name="見本 143" description="来店 3 回" selected avatar={false} onClear={clear} />)
  fireEvent.click(screen.getByRole('button', { name: '選び直す', exact: true }))
  expect(clear).toHaveBeenCalledOnce()
  expect(screen.getByText('見本 143').getAttribute('title')).toBe('見本 143')
})
