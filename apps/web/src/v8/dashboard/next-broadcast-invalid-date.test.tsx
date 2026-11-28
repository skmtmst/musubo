// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ upcoming: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { dashboard: { upcoming: net.upcoming } } }))
const { useNextBroadcast, kpiFillCell } = await import('./kpi-fill')
afterEach(() => { cleanup(); vi.clearAllMocks() })
function Subject() {
 const nextBroadcast = useNextBroadcast('a', true)
 return <>{kpiFillCell('fill-next-broadcast', { data: null, overviewFailed: false, trendAvailable: false, today: '2026-11-27', activeFriendsCompare: null, nextBroadcast })}</>
}
it('次の配信の日時が読めないとき、画面を壊さず読み込み失敗を表示する', async () => {
 net.upcoming.mockResolvedValue({ success: true, data: { items: [{ kind: 'broadcast', title: '見本', startsAt: 'invalid' }] } })
 render(<Subject />)
 expect(await screen.findByText('読み込めませんでした')).toBeTruthy()
 expect(screen.queryByText('予約した配信はありません')).toBeNull()
})
it.each([
  ['一覧がない', null],
  ['空の行がある', [null]],
  ['名前が不正', [{ kind: 'broadcast', title: {}, startsAt: '2026-12-01T00:00:00Z' }]],
])('%s場合も空の予定と誤認しない', async (_label, items) => {
 net.upcoming.mockResolvedValue({ success: true, data: { items } })
 render(<Subject />)
 expect(await screen.findByText('読み込めませんでした')).toBeTruthy()
 expect(screen.queryByText('予約した配信はありません')).toBeNull()
})
