// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: async (url: string) => url.startsWith('/api/operators')
    ? { success: true, data: [] }
    : { success: true, data: { thread: { id: 't1', subject: '件名', customer_name: null, customer_email: 'c@example.com', status: 'unread', assigned_staff_id: null, notes: null, revision: 1 }, messages: [], hasMoreOlder: false, oldestCursor: null, newestCursor: null } } }
})
vi.mock('@/components/chats/template-picker', () => ({ default: () => null }))
import EmailThread from './email-thread'
afterEach(() => { cleanup(); localStorage.removeItem('chat.sendMode') })

it.each([
  ['enter', 'Enter で送信', 'Shift + Enter で送信', 'shift-enter'],
  ['shift-enter', 'Shift + Enter で送信', 'Enter で送信', 'enter'],
] as const)('共通の保存値 %s を読み、切り替えを保存して読み直せる', async (saved, checkedLabel, nextLabel, nextValue) => {
  localStorage.setItem('chat.sendMode', saved)
  const view = render(<EmailThread threadId="t1" onBack={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: /送信の設定$/ }))
  expect((screen.getByRole('radio', { name: checkedLabel }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: nextLabel }))
  expect(localStorage.getItem('chat.sendMode')).toBe(nextValue)
  view.unmount()
  await act(async () => { render(<EmailThread threadId="t1" onBack={() => {}} />) })
  fireEvent.click(await screen.findByRole('button', { name: /送信の設定$/ }))
  expect((screen.getByRole('radio', { name: nextLabel }) as HTMLInputElement).checked).toBe(true)
})
