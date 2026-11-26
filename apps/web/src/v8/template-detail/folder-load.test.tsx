// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ folders: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('id=t-2'), usePathname: () => '/templates/detail' }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [{ id: 'acc-1', name: '確認用' }], selectedAccountId: 'acc-1', loading: false }) }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, templates: { ...actual.api.templates, get: vi.fn(async () => ({ success: true, data: { id: 't-2', name: '流れの型', messageType: 'text', messageContent: '本文', accountId: 'acc-1', folderId: 'f-1', category: '別の名前', publishedVersion: 1, draftRevision: 2, usedBy: null, hasDraft: true } })), versions: vi.fn(async () => ({ success: true, data: [] })), list: vi.fn(async () => ({ success: true, data: [] })) }, folders: { ...actual.api.folders, list: mocks.folders } } } })
import TemplateDetail from './detail'
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('フォルダの取得失敗を知らせ、読み直して実際の名前を表示する', async () => {
  mocks.folders.mockRejectedValue(new Error('offline'))
  render(<TemplateDetail />)
  await screen.findByText('流れの型')
  const row = (await screen.findByText('フォルダ')).parentElement!
  expect(within(row).getByText('フォルダを確認できません')).toBeTruthy()
  mocks.folders.mockResolvedValue({ success: true, data: [{ id: 'f-1', name: '本当のフォルダ' }] })
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを読み直す' }))
  expect(await within(row).findByText('本当のフォルダ')).toBeTruthy()
})
