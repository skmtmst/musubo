// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  loadStaffIdentity: vi.fn(),
  list: vi.fn(),
  getConfig: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/file-scan',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '見本アカウント' },
    accounts: [{ id: 'acc-1', name: '見本アカウント' }],
    loading: false,
  }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('../sb-frame/settings-screen', () => ({
  SbSettingsScreen: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}))
vi.mock('@/lib/staff-role', async (original) => {
  const actual = await original<typeof import('@/lib/staff-role')>()
  return {
    ...actual,
    useStaffRole: () => 'owner',
    loadStaffIdentity: mocks.loadStaffIdentity,
  }
})
vi.mock('@/lib/staff-identity-state', async (original) => {
  const actual = await original<typeof import('@/lib/staff-identity-state')>()
  return {
    ...actual,
    readStaffIdentity: () => ({ id: 'staff-1', name: '見本 オーナー', role: 'owner' }),
  }
})
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      fileScan: {
        ...actual.api.fileScan,
        list: mocks.list,
        getConfig: mocks.getConfig,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import FileScanScreen from './screen'

const emptyConfig = {
  success: true as const,
  data: {
    config: {
      externalProvider: null,
      externalEndpointUrl: null,
      externalSecretRef: null,
      externalEnabled: false,
      confirmationRevision: 1,
    },
  },
}

const sampleItem = {
  id: 'scan-1',
  filename: 'suspect.pdf',
  status: 'quarantined' as const,
  lineAccountId: 'acc-1',
  uploaderLabel: '山田 太郎',
  reasonCode: 'malware',
  reasonLabel: '危険な内容が見つかりました',
  releasedAt: null,
  confirmationRevision: 1,
}

describe('FileScanScreen 読み込み失敗の分類と再読み込み復旧', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/settings/file-scan')
    mocks.loadStaffIdentity.mockResolvedValue({ success: true, data: { role: 'owner' } })
    mocks.getConfig.mockResolvedValue(emptyConfig)
  })

  afterEach(() => {
    cleanup()
  })

  it('429 応答の待ち秒数を案内し、もう一度読み込むで一覧へ復旧できる', async () => {
    mocks.list.mockRejectedValueOnce(new ApiError(429, 'Too many requests', undefined, undefined, undefined, 45))
    mocks.list.mockResolvedValue({ success: true, data: { items: [sampleItem], total: 1 } })

    render(<FileScanScreen />)

    expect(await screen.findByText('混み合っています')).toBeTruthy()
    expect(screen.getByText('45秒ほど待ってから、もう一度読み込んでください。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect(screen.getByText('suspect.pdf')).toBeTruthy()
    })
  })

  it('403 応答では通信エラーに丸めず権限の案内を表示する', async () => {
    mocks.list.mockRejectedValueOnce(new ApiError(403, 'forbidden'))

    render(<FileScanScreen />)

    expect(await screen.findByText('この画面を見る権限がありません')).toBeTruthy()
    expect(screen.getByText('この操作の権限がありません。オーナーか管理者に頼んでください。')).toBeTruthy()
  })
})
