// @vitest-environment happy-dom

import React from 'react'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockState = vi.hoisted(() => ({
  marks: vi.fn(), scenarios: vi.fn(), fields: vi.fn(), create: vi.fn(), push: vi.fn(),
  role: 'owner' as string | null,
  revision: 5,
  previewRevisions: [] as Array<number | undefined>,
}))

const baseDetail = () => ({
  id: 's1',
  name: 'テスト検索',
  scope: 'friends' as const,
  conditions: { all: [{ kind: 'mark', op: 'includes', value: '' }, { kind: 'scenario', op: 'includes', value: '' }, { kind: 'field', op: 'eq', key: '', value: '' }], any: [] },
  createdBy: 'staff-1',
  lineAccountId: 'a1',
  isShared: false,
  displayOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  revision: mockState.revision,
  matchCount: 0,
  usedIn: [],
  canDelete: true,
  accountScope: { type: 'line_account' as const, id: 'a1' },
  owner: { id: 'staff-1', isCurrentUser: true },
  match: {
    total: 0,
    byChannel: { line: 0, mail: 0 },
    calculatedAt: '2026-09-27T00:00:00.000Z',
  },
})

vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => mockState.role }))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    staff: { me: async () => ({ success: true, data: { role: 'owner' } }) },
    savedSearches: {
      detail: () => Promise.resolve({ success: true, data: baseDetail() }),
      list: () => Promise.resolve({
        success: true,
        items: [],
        summary: { total: 1, usedInBroadcasts: 0, zeroMatches: 1, callsThisMonth: 0 },
      }),
      update: () => {
        mockState.revision = 6
        return Promise.resolve({ success: true, data: baseDetail() })
      },
      preview: (_account: string, data: { revision?: number }) => {
        mockState.previewRevisions.push(data.revision)
        // 版が古ければサーバーは409相当の失敗を返す。
        if (data.revision !== 6) {
          return Promise.resolve({ success: false, error: 'ほかの担当者が先に変更しました' })
        }
        return Promise.resolve({
          success: true,
          data: { match: { total: 0, byChannel: { line: 0, mail: 0 }, calculatedAt: '2026-09-27T01:00:00.000Z' } },
        })
      },
      create: mockState.create,
      delete: () => Promise.resolve({ success: true, data: null }),
    },
    tags: { list: () => Promise.resolve({ success: true, data: [] }) },
    supportMarks: { list: mockState.marks },
    scenarios: { list: mockState.scenarios },
    friendFields: { list: mockState.fields },
    forms: { list: () => Promise.resolve({ success: true, data: [] }) },
    operators: { list: () => Promise.resolve({ success: true, data: [] }) },
    featureSettings: {
      visibility: () => Promise.resolve({ success: true, data: { features: {} } }),
    },
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockState.push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('id=s1'),
  usePathname: () => '/tags/searches/edit',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a1', selectedAccount: { id: 'a1', name: '店舗A' } }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready', features: { saved_searches: true }, enabled: () => true }),
}))

beforeEach(() => {
  mockState.marks.mockReset().mockResolvedValue({ success: true, data: [] })
  mockState.scenarios.mockReset().mockResolvedValue({ success: true, data: [] })
  mockState.fields.mockReset().mockResolvedValue({ success: true, data: [] })
  mockState.create.mockReset().mockResolvedValue({ success: false, error: '複製できませんでした' })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('候補の取得失敗と0件をそれぞれ画面で区別する', async () => {
  mockState.marks.mockRejectedValueOnce(new Error('offline'))
  mockState.scenarios.mockRejectedValueOnce(new Error('offline'))
  mockState.fields.mockRejectedValueOnce(new Error('offline'))
  const { default: Page } = await import('./page')
  const view = render(<Page />)
  await screen.findByRole('button', { name: '保存する' })
  await waitFor(() => expect(view.container.textContent).toContain('対応マークを読み込めませんでした'))
  expect(view.container.textContent).toContain('友だち情報を読み込めませんでした')
  expect(view.container.textContent).toContain('シナリオを読み込めませんでした')
  view.unmount()
  const empty = render(<Page />)
  await screen.findByRole('button', { name: '保存する' })
  await waitFor(() => expect(empty.container.textContent).toContain('対応マークがありません'))
  expect(empty.container.textContent).toContain('友だち情報がありません')
  expect(empty.container.textContent).toContain('シナリオがありません')
})

test('同じアカウントから候補を読み、名前で選べる', async () => {
  mockState.marks.mockResolvedValue({ success: true, data: [{ id: 'mark-1', name: '要連絡' }] })
  mockState.scenarios.mockResolvedValue({ success: true, data: [{ id: 'scenario-1', name: '来店後' }] })
  mockState.fields.mockResolvedValue({ success: true, data: [{ fieldKey: 'pet_name', name: 'ペット名' }] })
  const { default: Page } = await import('./page')
  render(<Page />)
  await screen.findByRole('button', { name: '保存する' })
  expect(mockState.marks).toHaveBeenCalledWith('a1', { suppressFeatureDisabledEvent: true })
  expect(mockState.scenarios).toHaveBeenCalledWith({ accountId: 'a1' })
  expect(mockState.fields).toHaveBeenCalledWith('a1', undefined, { suppressFeatureDisabledEvent: true })
  fireEvent.click(screen.getByLabelText('対応マーク'))
  fireEvent.click(await screen.findByText('要連絡'))
  expect(screen.getByText('要連絡')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('友だち情報の項目'))
  fireEvent.click(await screen.findByText('ペット名'))
  expect(screen.getByText('ペット名')).toBeTruthy()
  await pickEntity('シナリオ', '来店後')
  expect(screen.getByText('来店後')).toBeTruthy()
})
