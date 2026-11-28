// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const foldersList = vi.hoisted(() => vi.fn())
const scenario = vi.hoisted(() => ({
  id: 'sc-1',
  name: '新規登録7日間フォロー',
  description: '',
  triggerType: 'friend_add',
  isActive: true,
  contentRevision: 1,
  allowConcurrent: true,
  folderId: 'folder-1',
  deliveryMode: 'absolute_time',
  onCompleteMode: 'pause',
  lineAccountId: 'account-a',
  audienceCondition: null,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-10-01T05:02:00.000Z',
  steps: [
    {
      id: 'step-1', stepOrder: 1, delayMinutes: 0, offsetDays: 0, offsetMinutes: null, deliveryTime: '10:00',
      templateId: null, onReachTagId: null, afterSend: 'continue', messageType: 'text',
      messageContent: 'ご登録ありがとうございます。', targetCondition: null, question: null, isDraft: false,
    },
  ],
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ status: 'ready', enabled: () => true }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: {
    scenarios: {
      create: vi.fn(),
      get: vi.fn(async () => ({ success: true, data: scenario })),
      update: vi.fn(),
      confirmation: vi.fn(async () => ({ success: true, data: { contentRevision: 1, activeCount: 10, rowIdSum: 0, rowIdSquareSum: 0, totalCount: 10, totalRowIdSum: 0, totalRowIdSquareSum: 0, referrers: [] } })),
      simulate: vi.fn(async () => ({ success: true, data: { audience: { newStartPlanned: 10 }, steps: [] } })),
      runs: vi.fn(async () => ({ success: true, data: { steps: [], subscriptions: [], testSends: [], quota: { remaining: null, state: 'unlimited' } } })),
      triggers: { list: vi.fn(async () => ({ success: true, data: [{ id: 't1', kind: 'friend_add', tagId: null }] })) },
      actions: { list: vi.fn(async () => ({ success: true, data: [] })) },
      preview: vi.fn(async () => ({ success: true, data: { steps: [] } })),
    },
    folders: { list: foldersList },
    staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
  },
}))
vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    scenario: vi.fn(async () => ({ success: true, data: scenario })),
    stats: vi.fn(async () => ({ success: true, data: { enrolledTotal: 10, activeNow: 5, completed: 5, paused: 0, steps: [] } })),
    templates: vi.fn(async () => ({ success: true, data: [] })),
    tags: vi.fn(async () => ({ success: true, data: [] })),
    friendFields: vi.fn(async () => ({ success: true, data: [] })),
    supportMarks: vi.fn(async () => ({ success: true, data: [] })),
    scenarios: vi.fn(async () => ({ success: true, data: [] })),
    commonVars: vi.fn(async () => ({ success: true, data: [] })),
    reminders: vi.fn(async () => ({ success: true, data: [] })),
    events: vi.fn(async () => ({ success: true, data: [] })),
    invalidateScenario: vi.fn(),
  },
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/scenarios/detail',
  useSearchParams: () => new URLSearchParams('id=sc-1'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: '本店' },
    accounts: [{ id: 'account-a', name: '本店' }],
  }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'owner',
  useFeatureAccess: () => true,
  canManageRole: () => true,
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
}))

import ScenarioDetailV8 from './detail'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  foldersList.mockReset()
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('不正なフォルダ一覧', () => {
  it('失敗として表示し、再読み込みで正しいフォルダを表示する', async () => {
    foldersList.mockResolvedValueOnce({ success: true, data: null }).mockResolvedValueOnce({ success: true, data: [{ id: 'folder-1', name: '初回フォロー', color: '#22c55e', kind: 'scenario', accountId: 'account-a', sortOrder: 0 }] })
    render(<ScenarioDetailV8 id="sc-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '名前・説明・置き場を変更する' }))
    const dialog = await screen.findByRole('dialog', { name: '名前・説明・置き場を変える' })
    await within(dialog).findByText(/フォルダ一覧を読み込めませんでした/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度読み込む' }))
    expect(await within(dialog).findByText('初回フォロー')).toBeTruthy()
  })
})
