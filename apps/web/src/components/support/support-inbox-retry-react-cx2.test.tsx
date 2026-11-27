// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ fail: false, calls: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: async (url: string) => {
    fixture.calls(url)
    if (fixture.fail) throw new Error('offline')
    return { success: true, data: { items: [] } }
  } }
})
import SupportInbox from './support-inbox'

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  fixture.fail = false
  fixture.calls.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('一覧の更新が連続で失敗したら理由と再試行を出し、復帰できる', async () => {
  await act(async () => { render(<SupportInbox />) })
  expect(fixture.calls).toHaveBeenCalledTimes(1)
  fixture.fail = true
  for (const delay of [5000, 10000, 20000, 40000, 60000]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
  }
  expect(screen.getByText(/お問い合わせ一覧の更新を一時停止しています/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: '再試行する' })
  const previousCalls = fixture.calls.mock.calls.length
  fixture.fail = false
  await act(async () => { fireEvent.click(retry) })
  expect(fixture.calls.mock.calls.length).toBeGreaterThan(previousCalls)
  expect(screen.queryByText(/お問い合わせ一覧の更新を一時停止しています/)).toBeNull()
})
