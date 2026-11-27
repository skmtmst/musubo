// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EventBookingItem } from '@/lib/api/types/events'
import { LessonRoster } from './lesson-roster'
import { toLessonRosterMember } from './lesson-roster-state'
import type { StyleRoster } from './model'

afterEach(cleanup)
const base = { id: 'b1', event_id: 'e1', status: 'confirmed', cancelled_at: null, friend_display_name: '参加者' } as EventBookingItem
const noop = () => {}
function draw(booking: EventBookingItem) {
  const onClose = vi.fn()
  const roster: StyleRoster = { rowId: 'r', head: '', title: '教室', pay: { label: '—', tone: 'neutral' }, meta: '', members: [toLessonRosterMember(booking)], more: '', payLinkCount: 0 }
  render(<LessonRoster roster={roster} canWrite={false} onClose={onClose} onPay={noop} onAttend={noop} onAbsent={noop} onLine={noop} onCancelClass={noop} />)
  return onClose
}

it('未知の予約状態を会員と決めつけず確認が必要と表示する', () => {
  const onClose = draw({ ...base, status: 'future-status' })
  expect(screen.getByText('状態を確認できません')).toBeTruthy()
  expect(screen.queryByText('会員')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '名簿を閉じる' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('参加者名が不正な形でも名簿を表示して閉じられる', () => {
  const onClose = draw({ ...base, friend_display_name: { invalid: true } } as unknown as EventBookingItem)
  expect(screen.getByText('名前なし')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '名簿を閉じる' }))
  expect(onClose).toHaveBeenCalledOnce()
})
