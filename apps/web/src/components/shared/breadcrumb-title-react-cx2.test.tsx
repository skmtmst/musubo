// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import Breadcrumb from './breadcrumb'

afterEach(cleanup)
it('省略された現在地を全文確認できる', () => {
  const name = '春の新商品を案内する長い名前のテンプレート'
  render(<Breadcrumb items={[{ label: '一覧', href: '/items' }, { label: name }]} />)
  const current = screen.getByText(name)
  expect(current.getAttribute('title')).toBe(name)
  expect(current.getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('link', { name: '一覧' }).getAttribute('href')).toBe('/items')
})
it('リンクのない途中の階層も名前を全文確認できる', () => {
  render(<Breadcrumb items={[{ label: '長い途中の階層' }, { label: '現在地' }]} />)
  expect(screen.getByText('長い途中の階層').getAttribute('title')).toBe('長い途中の階層')
})
