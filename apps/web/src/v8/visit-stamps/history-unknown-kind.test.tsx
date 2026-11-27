// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { VisitStampEntry } from '@line-crm/shared'
import { historyRows } from './display'
import HistoryTable from './history-table'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/visit-stamps', useRouter: () => ({ replace: vi.fn() }) }))
afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__'])('未対応の記録 %s を一覧に表示する', kind => {
  const entry = { id: 'entry-1', friendId: 'friend-1', kind, delta: 1, reason: '', actorId: null, createdAt: '2026-10-14T10:00:00Z' } as VisitStampEntry
  render(<HistoryTable rows={historyRows([entry], () => undefined)} friendName={() => '見本'} canManage onOpenFriend={vi.fn()} onReverse={vi.fn()} />)
  expect(screen.getByText(kind)).toBeTruthy()
  expect(screen.getByText('+1 個')).toBeTruthy()
})
