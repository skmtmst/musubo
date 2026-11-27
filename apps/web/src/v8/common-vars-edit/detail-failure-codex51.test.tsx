// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  account: { selectedAccountId: 'a' as string | null, selectedAccount: { id: 'a', name: '管理名A', displayName: 'LINE名A' } as { id: string; name: string; displayName?: string } | null, loading: false, error: null as string | null },
  detail: vi.fn(), create: vi.fn(), update: vi.fn(), seen: [] as Array<{ id: string | null; name: string }>,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('id=var-1') }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => state.account }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/components/shared/line-preview', () => ({
  default: ({ accountName, children }: { accountName: string; children: React.ReactNode }) => {
    state.seen.push({ id: state.account.selectedAccountId, name: accountName })
    return <section data-testid="preview"><strong data-testid="preview-name">{accountName}</strong>{children}</section>
  },
  LinePreviewMessage: ({ accountName, children }: { accountName: string; children: React.ReactNode }) => <article><strong data-testid="message-name">{accountName}</strong>{children}</article>,
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    commonVars: { ...actual.api.commonVars, detail: state.detail, create: state.create, update: state.update,
      schedules: async () => ({ success: true, data: [] }), deleteImpact: async () => ({ success: true, data: { variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 0, blockingTotal: 0, historicalTotal: 0, unscopedFormTotal: 0, canDelete: true, byKind: {}, items: [], unavailableReferences: [], checkedAt: '2026-11-01T00:00:00Z', recommendedAction: 'delete' } }) },
  } }
})
import NewCommonVar from './new'
import EditCommonVar from './edit'

const detail = (accountId: string | null = 'a') => ({ success: true, data: {
  id: 'var-1', lineAccountId: accountId, name: '営業時間', varKey: 'hours', type: 'text', value: '10時', memo: '', status: 'active', validFrom: null, validUntil: null, expiryBehavior: 'stop', fallbackValue: null,
  version: 1, usages: [], history: [], usageCount: 0, usagePage: { total: 0, shown: 0 },
} })
const names = () => screen.queryAllByTestId('preview-name').map(node => node.textContent)
const ready = async () => waitFor(() => expect(names()).toContain('LINE名A'))
const account = (id: string) => { state.account.selectedAccountId = id; state.account.selectedAccount = { id, name: `管理名${id}`, displayName: id === 'a' ? 'LINE名A' : 'LINE名B' } }
beforeEach(() => {
  state.account = { selectedAccountId: 'a', selectedAccount: { id: 'a', name: '管理名A', displayName: 'LINE名A' }, loading: false, error: null }
  state.seen = []
  state.detail.mockReset().mockImplementation(async (_id: string, accountId: string) => detail(accountId))
  state.create.mockReset(); state.update.mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('共通情報の読込が失敗応答なら削除済みと誤認せず、再読み込みできる', async () => {
  state.detail.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce(detail('a'))
  render(<EditCommonVar />)
  expect(await screen.findByText('共通情報を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('この共通情報は見つかりません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('heading', { name: '営業時間' })).toBeTruthy()
})
