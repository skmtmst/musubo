// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, me: async () => ({ success: true, data: { id: 'staff-a', role: 'owner' } }) } }, fetchApi: fixture.fetch }
})
import { ApiError } from '@/lib/api'
import PendingInboxCard from './pending-inbox-card'

const empty = { success: true, data: { items: [], summary: { total: 0, line: 0, email: 0, emailUnread: 0, oldestWaitMinutes: null } } }
const populated = { success: true, data: { items: [{ id: 'line:f1', channel: 'line', customerName: '確認する人', preview: 'こんにちは', lastIncomingAt: '2026-11-27T00:00:00Z' }], summary: { total: 1, line: 1, email: 0, emailUnread: 0, oldestWaitMinutes: 10 } } }
beforeEach(() => { fixture.fetch.mockReset(); window.localStorage.clear() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

it.each(['reject', 'unsuccessful'] as const)('%sの読込失敗と0件を区別し、再試行で回復する', async (failure) => {
  let reject!: (error: Error) => void
  let finish!: (value: unknown) => void
  fixture.fetch.mockReturnValueOnce(new Promise((resolve, fail) => { finish = resolve; reject = fail })).mockResolvedValueOnce(empty)
  render(<PendingInboxCard />)
  expect(screen.getByText('読み込んでいます…')).toBeTruthy()
  expect(screen.queryByText('返信を待っている問い合わせはありません。')).toBeNull()
  await act(async () => { if (failure === 'reject') reject(new Error('private error')); else finish({ success: false }) })
  expect(await screen.findByText('データを読み込めませんでした。')).toBeTruthy()
  expect(screen.queryByText('返信を待っている問い合わせはありません。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('返信を待っている問い合わせはありません。')).toBeTruthy()
  expect(screen.queryByText('データを読み込めませんでした。')).toBeNull()
  expect(screen.queryByText(/最新の状態に更新できませんでした/)).toBeNull()
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
})

it('権限不足は0件や通信失敗と区別する', async () => {
  fixture.fetch.mockRejectedValueOnce(new ApiError(403, 'private error'))
  render(<PendingInboxCard />)
  expect(await screen.findByText('見る権限がありません。')).toBeTruthy()
  expect(screen.queryByText('返信を待っている問い合わせはありません。')).toBeNull()
  expect(screen.queryByText('データを読み込めませんでした。')).toBeNull()
})

it('成功後の更新失敗は前の一覧と最終更新時刻を残し、読み直せる', async () => {
  fixture.fetch.mockResolvedValueOnce(populated).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(empty)
  render(<PendingInboxCard />)
  expect((await screen.findAllByText('確認する人')).length).toBeGreaterThan(0)
  fireEvent.focus(window)
  expect(await screen.findByText(/最新の状態に更新できませんでした/)).toBeTruthy()
  expect(screen.getByText(/最終更新/)).toBeTruthy()
  expect(screen.getAllByText('確認する人').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('返信を待っている問い合わせはありません。')).toBeTruthy()
  expect(screen.queryAllByText('確認する人')).toHaveLength(0)
})

it.each(['success', 'failure'] as const)('遅い古い%s結果で新しい結果を上書きしない', async (outcome) => {
  let finish!: (value: unknown) => void
  let fail!: (error: Error) => void
  fixture.fetch.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject })).mockResolvedValueOnce(empty)
  render(<PendingInboxCard />)
  await waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1))
  fireEvent.focus(window)
  expect(await screen.findByText('返信を待っている問い合わせはありません。')).toBeTruthy()
  await act(async () => { if (outcome === 'success') finish(populated); else fail(new Error('old failure')) })
  expect(screen.queryAllByText('確認する人')).toHaveLength(0)
  expect(screen.getByText('返信を待っている問い合わせはありません。')).toBeTruthy()
  expect(screen.queryByText(/最新の状態に更新できませんでした/)).toBeNull()
})
