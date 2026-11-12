// @vitest-environment happy-dom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ListView from './list'
import { reservation } from '../booking-kit/test-data'

const fixture = vi.hoisted(() => ({
  allPages: vi.fn(),
  board: null as null | { loadPrintEntries: () => Promise<Array<{ status: string }>>; printContext: string; formatListDateTime: (value: string) => string; renderBody: (body: React.ReactNode) => React.ReactNode },
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account' }) }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({
  reservationBoardApi: { floors: async () => ({ data: [] }) },
  allBoardPages: fixture.allPages,
}))
vi.mock('@/components/shared/reservation-board', () => ({ default: (props: NonNullable<typeof fixture.board>) => {
  fixture.board = props
  return <>{props.renderBody(<div />)}</>
} }))
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-14T03:00:00Z'))
  fixture.allPages.mockReset().mockResolvedValue([{ status: 'confirmed' }, { status: 'cancelled' }])
})
afterEach(() => { cleanup(); vi.useRealTimers(); fixture.board = null })

it.each([
  ['upcoming', '2026-10-13T15:00:00.000Z', '2100-01-01T00:00:00Z', '今後の予約'],
  ['past', '1970-01-01T00:00:00Z', '2026-10-13T15:00:00.000Z', '過去の予約'],
  ['all', '1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'すべての予約'],
])('印刷も画面の期間 %s・状態・店舗を使って全ページを読む', async (period, from, to, label) => {
  render(<ListView view="list" rows={[]} total={0} tables={[]} page={1} period={period} status="confirmed"
    busy={false} canWrite={false} canImport={false} day={new Date()} onDay={vi.fn()} storeId="store" storeName="試験店"
    onView={vi.fn()} onPeriod={vi.fn()} onStatus={vi.fn()} onPage={vi.fn()} onImport={vi.fn()}
    onCreate={vi.fn()} onEdit={vi.fn()} onOpen={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} />)
  expect(await fixture.board!.loadPrintEntries()).toEqual([{ status: 'confirmed' }])
  expect(fixture.allPages).toHaveBeenCalledWith('seats', 'account', from, to, 'store')
  expect(fixture.board!.printContext).toContain(label)
})

// R11: 帯は大事な4つまで。5つ目の未配席は帯の下の短い1行に残す。
it('R11: 帯は4枚で未配席は下の1行、行き先は今日の配席', () => {
  const onView = vi.fn()
  const rows = [
    reservation('r1', { status: 'confirmed', table_id: null, guest_count: 2 }),
    reservation('r2', { status: 'confirmed', table_id: 't1', guest_count: 3 }),
  ]
  const view = render(<ListView view="list" rows={rows as never} total={2} tables={[]} page={1} period="all" status="all"
    busy={false} canWrite={false} canImport={false} day={new Date()} onDay={vi.fn()} storeId="store" storeName="試験店"
    onView={onView} onPeriod={vi.fn()} onStatus={vi.fn()} onPage={vi.fn()} onImport={vi.fn()}
    onCreate={vi.fn()} onEdit={vi.fn()} onOpen={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} />)
  // 帯の中は4枚だけ。
  expect(view.container.querySelectorAll('[data-kpi-strip] [data-kpi-presentation]').length).toBe(4)
  // 5つ目は帯の下の短い1行。
  const line = screen.getByText(/未配席 1 件/)
  expect(line.closest('[data-kpi-strip]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '今日の配席へ →' }))
  expect(onView).toHaveBeenCalledWith('today')
})

it('予約記録には取消を含み、来店人数は表示中の有効な予約だけと分かる', () => {
 const rows = [reservation('live', { status:'confirmed', guest_count: 2 }), reservation('cancelled', { status:'cancelled', guest_count: 3 })]
 const {container} = render(<ListView view="list" rows={rows as never} total={2} tables={[]} page={1} period="all" status="all"
   busy={false} canWrite={false} canImport={false} day={new Date()} onDay={vi.fn()} storeId="store" onView={vi.fn()}
   onPeriod={vi.fn()} onStatus={vi.fn()} onPage={vi.fn()} onImport={vi.fn()} onCreate={vi.fn()} onEdit={vi.fn()} onOpen={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} />)
 const cards = [...container.querySelectorAll('[data-kpi-presentation]')]
 expect(cards.find(card => card.textContent?.includes('予約記録'))?.textContent).toContain('取消・押さえを含む')
 expect(cards.find(card => card.textContent?.includes('ご来店人数'))?.textContent).toContain('表示中の有効な予約')
})

it('予約の一覧と顧客カルテは同じ年付き日時を使う', () => {
 const startsAt = '2026-10-01T09:00:00Z'
 const rows = [reservation('one', { status: 'confirmed', starts_at: startsAt })]
 render(<ListView view="list" rows={rows as never} total={1} tables={[]} page={1} period="all" status="all"
   busy={false} canWrite={false} canImport={false} day={new Date()} onDay={vi.fn()} storeId="store" onView={vi.fn()}
   onPeriod={vi.fn()} onStatus={vi.fn()} onPage={vi.fn()} onImport={vi.fn()} onCreate={vi.fn()} onEdit={vi.fn()} onOpen={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} />)
 expect(fixture.board?.formatListDateTime(startsAt)).toBe('2026/10/01 18:00')
 expect(screen.getByText('直近：2026/10/01 18:00 / 2名')).toBeTruthy()
})
