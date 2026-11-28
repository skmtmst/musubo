// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RowActions } from './row-actions'
import buttonStyles from './button.module.css'

afterEach(cleanup)
it('詳細リンクと主操作は小さいボタンで描き、操作できる', () => {
  const onClick = vi.fn()
  const view = render(<RowActions detail={{ href: '/items/1' }} />)
  const link = screen.getByRole('link', { name: '詳細' })
  expect(link.classList.contains(buttonStyles.compact)).toBe(true)
  expect(link.getAttribute('href')).toBe('/items/1')
  view.rerender(<RowActions primary={{ label: '確認する', onClick }} />)
  const button = screen.getByRole('button', { name: '確認する' })
  expect(button.classList.contains(buttonStyles.compact)).toBe(true)
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledTimes(1)
})
