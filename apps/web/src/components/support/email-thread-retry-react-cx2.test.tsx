// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ fail: false, calls: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: async (url: string) => {
    if (url.startsWith('/api/operators')) return { success: true, data: [] }
    fixture.calls(url)
    if (fixture.fail) throw new Error('offline')
    return { success: true, data: { thread: { id: 't1', subject: '件名', customer_name: null, customer_email: 'c@example.com', status: 'unread', assigned_staff_id: null, notes: null, revision: 1 }, messages: [], hasMoreOlder: false, oldestCursor: null, newestCursor: null } }
  } }
})
vi.mock('@/components/chats/template-picker', () => ({ default: () => null }))
import EmailThread from './email-thread'

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  fixture.fail = false
  fixture.calls.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('更新の失敗が続くと停止理由と再試行を出し、復帰できる', async () => {
  await act(async () => { render(<EmailThread threadId="t1" onBack={() => {}} />) })
  expect(screen.getByText('メール・件名')).toBeTruthy()
  fixture.fail = true
  for (const delay of [5000, 10000, 20000, 40000, 60000]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
  }
  expect(screen.getByText(/会話の更新を一時停止しています/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: '再試行する' })
  const previousCalls = fixture.calls.mock.calls.length
  fixture.fail = false
  await act(async () => { fireEvent.click(retry) })
  expect(fixture.calls.mock.calls.length).toBeGreaterThan(previousCalls)
  expect(screen.queryByText(/会話の更新を一時停止しています/)).toBeNull()
  expect(screen.getByText('メール・件名')).toBeTruthy()
})
