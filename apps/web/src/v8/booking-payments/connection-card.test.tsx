// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionCard } from './cancellation'

afterEach(cleanup)
const connection = {
  connected: true, testMode: true, checkedAt: '2026/10/16 12:00', accountIdTail: '3kPq',
  dashboardUrl: 'https://dashboard.stripe.com/test/payments', canEdit: true, busy: false,
}

it('接続済みでも決済管理画面とつなぎ直しを使え、接続先と接続日を確認できる', () => {
  const reconnect = vi.fn()
  render(<ConnectionCard {...connection} onConnect={vi.fn()} onReconnect={reconnect} />)
  const dashboard = screen.getByRole('link', { name: 'Stripe の管理画面を開く' })
  expect(dashboard.getAttribute('href')).toBe(connection.dashboardUrl)
  expect(dashboard.getAttribute('target')).toBe('_blank')
  expect(screen.getByText(/acct_••••3kPq/)).toBeTruthy()
  expect(screen.getByText(/2026\/10\/16 12:00 につないだ/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'つなぎ直す' }))
  expect(reconnect).toHaveBeenCalledTimes(1)
})

it('閲覧のみでも決済管理画面を開けるが、つなぎ直す操作は灰色で押せない', () => {
  const reconnect = vi.fn()
  render(<ConnectionCard {...connection} canEdit={false} onConnect={vi.fn()} onReconnect={reconnect} />)
  expect(screen.getByRole('link', { name: 'Stripe の管理画面を開く' })).toBeTruthy()
  const button = screen.getByRole('button', { name: 'つなぎ直す' })
  expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(button)).toBe(true)
  fireEvent.click(button)
  expect(reconnect).not.toHaveBeenCalled()
})

it('未接続では管理画面を出さず、決済をつなぐ操作を保つ', () => {
  const connect = vi.fn()
  render(<ConnectionCard {...connection} connected={false} onConnect={connect} onReconnect={vi.fn()} />)
  expect(screen.queryByRole('link', { name: 'Stripe の管理画面を開く' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'つなぎ直す' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '決済をつなぐ' }))
  expect(connect).toHaveBeenCalledTimes(1)
})
