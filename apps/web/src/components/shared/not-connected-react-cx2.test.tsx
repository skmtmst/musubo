// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BlockedAction } from './not-connected'

afterEach(cleanup)

it('理由があるときは操作を止め、理由を本文で知らせる', () => {
  const onClick = vi.fn()
  const view = render(<BlockedAction reason="接続を確認してください" onClick={onClick}>送信する</BlockedAction>)
  const button = screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
  const reason = screen.getByText('接続を確認してください')
  expect(reason.tagName).toBe('P')
  expect(reason.hasAttribute('data-blocked-reason')).toBe(true)
  expect(reason.getAttribute('title')).toBeNull()
  expect(button.getAttribute('title')).toBeNull()
  expect(view.container.querySelector('[title="接続を確認してください"]')).toBeNull()
})

it('理由が解消すると操作でき、理由は消える', () => {
  const onClick = vi.fn()
  const view = render(<BlockedAction reason="接続を確認してください" onClick={onClick}>送信する</BlockedAction>)
  view.rerender(<BlockedAction reason={null} onClick={onClick}>送信する</BlockedAction>)
  const button = screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(screen.queryByText('接続を確認してください')).toBeNull()
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledTimes(1)
})
