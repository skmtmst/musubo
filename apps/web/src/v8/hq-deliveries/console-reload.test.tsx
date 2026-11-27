// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.hoisted(() => { process.env.NEXT_PUBLIC_API_URL = 'http://worker.test' })
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  preflight: vi.fn(),
  distribute: vi.fn(),
  accounts: vi.fn(),
  folders: vi.fn(),
}))

vi.mock('@/components/shared/hq-account-picker', () => ({
  useHqAccountFolders: () => ({ folders: [], membership: new Map(), failed: false }),
}))
vi.mock('@/lib/api/helpers/hq-deliveries', () => ({ hqDeliveriesApi: calls }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { accounts: calls.accounts, folders: { list: calls.folders } } }))
vi.mock('@/lib/api/helpers/hq-resource-search', () => ({ searchHqTemplateResources: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'owner',
  canManageRole: (value: string) => value === 'owner' || value === 'admin',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

import HqDeliveryConsole from './console'

const sampleRow = {
  id: 'delivery-1',
  name: '予約の確認返信',
  description: null,
  template_type: 'auto_reply' as const,
  revision: 1,
  distributed_account_count: 1,
  content_summary: '自動応答の本文',
  distributed_account_names: ['本店'],
  distributed_account_more: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  calls.list.mockResolvedValue([sampleRow])
  calls.accounts.mockResolvedValue([{ id: 'account-1', name: '本店' }])
  calls.folders.mockResolvedValue([])
})
afterEach(cleanup)

it('一覧の取得に失敗したときは空一覧を出さず、その場でもう一度読み込んで一覧へ復帰できる', async () => {
  calls.list
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([sampleRow])

  render(<HqDeliveryConsole type="auto_reply" />)
  expect(await screen.findByText('ひな形を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('まだ自動応答のひな形がありません')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('button', { name: '予約の確認返信', exact: true })).toBeTruthy()
  expect(screen.queryByText('ひな形を読み込めませんでした')).toBeNull()
})

it('配布先やフォルダの取得に失敗したときも、その場でもう一度読み込める', async () => {
  calls.accounts
    .mockRejectedValueOnce(new Error('accounts offline'))
    .mockResolvedValueOnce([{ id: 'account-1', name: '本店' }])
  calls.folders
    .mockRejectedValueOnce(new Error('folders offline'))
    .mockResolvedValueOnce([{ id: 'folder-1', name: '重要フォルダ', color: '#087A3E' }])

  render(<HqDeliveryConsole type="auto_reply" />)
  expect(await screen.findByText('フォルダを読み込めませんでした。')).toBeTruthy()
  expect(await screen.findByText('配布先を読み込めませんでした。')).toBeTruthy()

  const retryButtons = screen.getAllByRole('button', { name: 'もう一度読み込む' })
  expect(retryButtons).toHaveLength(2)
  fireEvent.click(retryButtons[0])
  fireEvent.click(retryButtons[1])

  expect(await screen.findByRole('button', { name: /重要フォルダ/ })).toBeTruthy()
  expect(screen.queryByText('フォルダを読み込めませんでした。')).toBeNull()
  expect(screen.queryByText('配布先を読み込めませんでした。')).toBeNull()
})
