// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CustomerInfoMileage from './customer-info-mileage'

afterEach(cleanup)

test('読込失敗は残高0と区別し、同じ顧客の再試行を呼ぶ', () => {
  const retry = vi.fn()
  render(<CustomerInfoMileage state={{ kind: 'error' }} onRetry={retry} />)
  expect(screen.getByText('マイルを読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '再試行する' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('店でマイルを使っていないときは取得失敗にせず、再試行も残高も出さない', () => {
  render(<CustomerInfoMileage state={{ kind: 'disabled' }} onRetry={() => undefined} />)
  expect(screen.getByText('マイルは使っていません')).toBeTruthy()
  expect(screen.queryByText('マイルを読み込めませんでした')).toBeNull()
  expect(screen.queryByRole('button', { name: '再試行する' })).toBeNull()
  expect(screen.queryByText('0')).toBeNull()
})

test('取得した0・確定待ち・記録を同時に出し、別の顧客へ切り替わったら前の記録を残さない', () => {
  const summary = { programId: 'p', programName: '店のマイル', available: 0, pending: 50, lifetimeEarned: 50, spent: 0 }
  const entry = { id: 'e', entryType: 'grant' as const, status: 'pending' as const, amount: 50, reason: '来店', source: 'visit', sourceEventId: null, sourceReferenceId: null, ruleName: null, mode: 'automatic' as const, executedByStaffName: null, occurredAt: '2026-10-12T00:00:00Z' }
  const view = render(<CustomerInfoMileage state={{ kind: 'data', summary, history: [entry] }} onRetry={() => undefined} />)
  expect(screen.getByText('0')).toBeTruthy()
  expect(screen.getByText('確定待ち 50')).toBeTruthy()
  expect(screen.getByText('来店')).toBeTruthy()
  expect(screen.getByText('+50')).toBeTruthy()
  view.rerender(<CustomerInfoMileage state={{ kind: 'data', summary: { ...summary, pending: 0, available: 120 }, history: [] }} onRetry={() => undefined} />)
  expect(screen.getByText('120')).toBeTruthy()
  expect(screen.queryByText('来店')).toBeNull()
  expect(screen.queryByText('確定待ち 50')).toBeNull()
  expect(screen.getByText('まだマイル履歴はありません')).toBeTruthy()
})
