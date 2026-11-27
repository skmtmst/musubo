// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ status: 'future' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', () => ({ usePathname: () => '/friends/migrations', useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams('tab=uid') }))
vi.mock('./use-uid-migration', async original => ({
  ...await original<typeof import('./use-uid-migration')>(),
  useUidMigration: () => { const active = { id: 'run', fromAccountId: 'source', toAccountId: 'destination', createdBy: 'other', status: state.status, counts: { total: 0, auto: 0, review: 0, unmatched: 0, conflict: 0, applied: 0, failed: 0 }, decisionCounts: {}, items: [], createdAt: '2026-11-01T00:00:00Z', purpose: '見本' }; return ({ status: 'ready', active, runs: [active], accounts: [], me: null, canDecide: false, canRunExecute: false, busy: false, detailBusy: false, mappings: [], rollbackConflicts: [], unresolved: 0, page: 0 }) },
}))
import UidMigrationV8 from './uid'
afterEach(cleanup)
it.each(['future', 'constructor'])('未対応の移行状態 %s は実データの状態を断定しない', status => {
  state.status = status
  render(<UidMigrationV8 initialRunId={null} />)
  expect(screen.getByText(/移行の状態を確認できません/)).toBeTruthy()
  expect(screen.queryByText(/実データはまだ変更していません/)).toBeNull()
  expect(screen.queryByText(/テスト移行までは実データを変えません/)).toBeNull()
  expect(screen.getByRole('row', { name: /旧アカウント|source/ }).textContent).toContain('状態を確認できません')
})
