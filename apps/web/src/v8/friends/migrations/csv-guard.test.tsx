// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  hookState: null as Record<string, unknown> | null,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/friends/migrations',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('../shared/head', () => ({
  FriendsSectionHead: ({ action }: { action?: React.ReactNode }) => <div>{action}</div>,
}))
vi.mock('./use-friend-migrations', () => ({
  JOB_STATUS_LABELS: { completed: '反映ずみ', previewed: '確認まで', expired: '期限切れ' },
  formatImportBytes: (n: number) => `${n}B`,
  useFriendMigrations: () => fx.hookState,
}))

import CsvMigrationsV8 from './csv'

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    manageLocked: false,
    busy: false,
    downloadId: null,
    accounts: [{ id: 'acc-1', name: '本店' }],
    accountId: 'acc-1',
    setAccountId: vi.fn(),
    columns: ['basic'],
    toggleColumn: vi.fn(),
    exportResult: null,
    downloadExport: vi.fn(),
    createExport: vi.fn(),
    file: { name: 'friends.csv', size: 120 },
    rows: [{}],
    onPickFile: vi.fn(),
    previewImport: vi.fn(),
    message: '',
    summary: { add: 3, update: 1, unchanged: 0, conflict: Number.NaN, error: 0 },
    importId: 'imp-1',
    cancelImport: vi.fn(),
    executeImport: vi.fn(),
    jobs: [
      {
        id: 'job-invalid-exp',
        kind: 'export',
        status: 'completed',
        line_account_id: 'acc-1',
        row_count: -5,
        total_count: null,
        created_at: '2026-11-20T00:00:00Z',
        created_by_name: '担当A',
        expires_at: 'invalid-date',
      },
      {
        id: 'job-valid-exp',
        kind: 'export',
        status: 'completed',
        line_account_id: 'acc-1',
        row_count: 10,
        total_count: null,
        created_at: '2026-11-20T00:00:00Z',
        created_by_name: '担当B',
        expires_at: '2099-01-01T00:00:00Z',
      },
    ],
    load: vi.fn(),
    ...overrides,
  }
}

describe('CsvMigrationsV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.hookState = baseState()
  })

  afterEach(() => {
    cleanup()
  })

  it('確認結果の競合件数が NaN のときは反映ボタンを fail-closed で無効化し、不正な期限日時の書き出しはダウンロード不可にする', () => {
    render(<CsvMigrationsV8 />)

    const applyButton = screen.getByRole('button', { name: '件数を確認できないため反映できません' }) as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)

    // 履歴の有効期限が不正な行にはダウンロードボタンを出さず、未来期限の行だけ1件出す
    const downloadButtons = screen.getAllByRole('button', { name: 'CSVで書き出す' })
    expect(downloadButtons).toHaveLength(1)
    expect(screen.queryByText('-5')).toBeNull()
  })
})
