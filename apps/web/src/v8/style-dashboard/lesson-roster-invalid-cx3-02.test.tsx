// @vitest-environment happy-dom
import React, { useEffect, useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LessonRoster } from './lesson-roster'
import { lessonRosterMembers, loadLessonBookings } from './lesson-roster-data'
import type { StyleRoster } from './model'

const calls = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ eventsApi: { listBookings: calls.list } }))
const booking = (id: unknown) => ({ id, event_id: 'event', status: 'confirmed', friend_display_name: '参加者' })
const noop = () => {}
function Screen() {
  const [state, setState] = useState<'loading' | 'error' | StyleRoster>('loading')
  useEffect(() => {
    const controller = new AbortController()
    void loadLessonBookings('account', 'event', 'slot', controller.signal).then(items => setState({ rowId: 'slot', head: '', title: '教室', pay: { label: '', tone: 'neutral' }, meta: '', more: '', payLinkCount: 0, members: lessonRosterMembers(items) })).catch(() => setState('error'))
    return () => controller.abort()
  }, [])
  if (state === 'loading') return <span>読込中</span>
  if (state === 'error') return <span>名簿を読み込めませんでした</span>
  return <LessonRoster roster={state} canWrite onAttend={noop} onAbsent={noop} onClose={noop} onPay={noop} onLine={noop} onCancelClass={noop} />
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('名簿の予約IDがない場合は全員出席を出さない', async () => {
  calls.list.mockResolvedValue({ items: [booking('')], total: 1, limit: 50, sort: [] })
  render(<Screen />)
  expect(await screen.findByText('名簿を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '全員出席' })).toBeNull()
})

it('ページ途中で総件数が減った場合は不完全な名簿を出さない', async () => {
  calls.list.mockResolvedValueOnce({ items: [booking('1')], total: 2, limit: 50, sort: [] }).mockResolvedValueOnce({ items: [booking('2')], total: 1, limit: 50, sort: [] })
  render(<Screen />)
  expect(await screen.findByText('名簿を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '全員出席' })).toBeNull()
})

it('途中で件数が変わっても、読み直しで揃った名簿を取得できる', async () => {
  calls.list.mockResolvedValueOnce({ items: [booking('1')], total: 2, limit: 50, sort: [] })
    .mockResolvedValueOnce({ items: [booking('2')], total: 1, limit: 50, sort: [] })
    .mockResolvedValueOnce({ items: [booking('1'), booking('2')], total: 2, limit: 50, sort: [] })
  await expect(loadLessonBookings('account', 'event', 'slot', new AbortController().signal)).rejects.toThrow('名簿が読み込みの途中で変わりました。もう一度読み込んでください。')
  const result = await loadLessonBookings('account', 'event', 'slot', new AbortController().signal)
  expect(result.map(item => item.id)).toEqual(['1', '2'])
})
