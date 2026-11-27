// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BookingRequest, BookingVisitMark } from '@/lib/api'
const fixture = vi.hoisted(() => ({ mark: null as BookingVisitMark | null, getToday: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', () => ({ bookingApi: { getToday: fixture.getToday, postVisitMark: fixture.post, deleteVisitMark: vi.fn() } }))
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import PeopleDayList from './day-list'
import { usePeopleVisitMarks } from './use-visit-marks'
const row = { id: 'fixture', starts_at: '2026-10-04T05:00:00Z', ends_at: '2026-10-04T06:00:00Z', status: 'confirmed', friend_name: '見本', menu_name: '見本', staff_name: '見本' } as BookingRequest
function View() { const visits = usePeopleVisitMarks('a', '2026-10-04', true, () => {}); return <><PeopleDayList rows={[row]} canMark visits={visits} onOpen={() => {}} /><ToastHost /></> }
afterEach(() => { cleanup(); clearToastsForTest(); vi.clearAllMocks() })
it('応答が途切れた場合は結果を断定せず、読み直すと保存済みの印が見える', async () => {
  fixture.mark = null
  fixture.getToday.mockImplementation(async () => ({ bookings: [{ id: row.id, visit_mark: fixture.mark }] }))
  fixture.post.mockImplementation(async () => { fixture.mark = { kind: 'visited', late_minutes: null } as BookingVisitMark; throw new Error('network') })
  render(<View />)
  await waitFor(() => expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '来店した' }))
  expect(await screen.findByText(/印の変更を確認できません/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  expect(await screen.findByRole('button', { name: '取り消す' })).toBeTruthy()
})
it('印の結果が欠けている応答も成功と見せず、読み直して確かめられる', async () => {
  fixture.mark = null
  fixture.getToday.mockImplementation(async () => ({ bookings: [{ id: row.id, visit_mark: fixture.mark }] }))
  fixture.post.mockImplementation(async () => { fixture.mark = { kind: 'visited', late_minutes: null } as BookingVisitMark; return { visit_mark: null } })
  render(<View />)
  await waitFor(() => expect((screen.getByRole('button', { name: '来店した' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '来店した' }))
  expect(await screen.findByText(/印の変更を確認できません/)).toBeTruthy()
  expect(screen.queryByText('来店しました')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  expect(await screen.findByRole('button', { name: '取り消す' })).toBeTruthy()
})
