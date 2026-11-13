// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountStyle } from '@line-crm/shared'
import ListView from './list'
import { reservation, tables } from '../booking-kit/test-data'

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account' }) }))
vi.mock('./use-ledger-floor', () => ({ useLedgerFloor: () => ({ floor: null, error: null, reload: vi.fn() }) }))
vi.mock('@/components/shared/reservation-board', () => ({ default: ({ renderBody, entries }: { renderBody: (body: React.ReactNode) => React.ReactNode; entries: Array<{ id: string; contactLabel?: string }> }) => renderBody(<div>{entries.map(entry => <span key={entry.id}>{entry.contactLabel}</span>)}</div>) }))
afterEach(cleanup)

it.each([
  ['standard', 'お客さま'], ['restaurant', 'お客さま'], ['salon', 'お客さま'],
  ['consult', '相談者'], ['lesson', '会員'], ['ec', 'お客さま'],
] as const)('%s の予約一覧は%sという言葉で情報を説明する', (style: AccountStyle, person: string) => {
  const rows = [reservation('line', { customer_name: '架空の人', line_uid: 'private-line-id' }), reservation('phone', { customer_name: '別の人', line_uid: null, customer_phone: '09012345678' })]
  const { container } = render(<ListView accountStyle={style} view="list" rows={rows} total={2} tables={tables} page={1} period="all" status="all"
    busy={false} canWrite={false} canImport={false} day={new Date()} onDay={vi.fn()} storeId="store" onView={vi.fn()}
    onPeriod={vi.fn()} onStatus={vi.fn()} onPage={vi.fn()} onImport={vi.fn()} onCreate={vi.fn()} onEdit={vi.fn()} onOpen={vi.fn()} onCancel={vi.fn()} onRestore={vi.fn()} />)
  expect(screen.getByText(`表示中の予約に登録された${person}の情報です。`)).toBeTruthy()
  expect(screen.getAllByText('LINEと連携済み')).toHaveLength(2)
  expect(container.textContent).not.toContain('LINE UID')
  expect(container.textContent).not.toContain('名寄せ')
  expect(container.textContent).not.toContain('private-line-id')
  expect(container.textContent).not.toContain('09012345678')
})
