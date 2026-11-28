// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Pagination from '@/components/shared/pagination'

afterEach(cleanup)

it('ページが多い一覧で先頭・現在・末尾を表示し、末尾へ移れる', () => {
  const change = vi.fn()
  render(<Pagination page={6} pageCount={12} onPageChange={change} />)
  const navigation = screen.getByRole('navigation', { name: 'ページ送り' })
  expect(within(navigation).getAllByRole('button', { name: /ページ目へ/ }).map(button => button.textContent)).toEqual(['1', '6', '12'])
  expect(within(navigation).getAllByText('…')).toHaveLength(2)
  expect(within(navigation).getByLabelText('1ページ目へ')).toBeTruthy()
  expect(within(navigation).getByLabelText('6ページ目へ').getAttribute('aria-current')).toBe('page')
  expect(within(navigation).queryByLabelText('5ページ目へ')).toBeNull()
  fireEvent.click(within(navigation).getByLabelText('12ページ目へ'))
  expect(change).toHaveBeenCalledWith(12)
})
