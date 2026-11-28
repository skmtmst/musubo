// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => Object.fromEntries(['context', 'list', 'listByKind', 'kindCounts', 'accounts', 'get', 'create', 'update', 'remove', 'duplicate', 'preflight', 'distribute', 'result', 'messageReferences', 'folderList', 'listStats', 'versions', 'receivedVersions'].map((key) => [key, vi.fn()])))
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), TEMPLATE_TYPES: ['tag', 'template', 'rich_menu', 'form', 'scenario'], hqTemplatesApi: { ...calls, folders: { list: calls.folderList } } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/hq/templates' }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, selectedAccount: null, setSelectedAccountId: vi.fn(), loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], scenarios: [], templates: [], forms: [], reminders: [], richMenus: [] }) }))
import HqTemplatesV8 from './console'

afterEach(() => { cleanup(); vi.clearAllMocks() })
async function show(count: unknown) {
  const row = { id: 'f1', name: '来店アンケート', description: null, template_type: 'form', folder_id: null, revision: 3, updated_at: '2026-08-21T09:02:00Z', content_summary: '質問 1', distributed_account_count: count, distributed_account_names: [], distributed_account_more: 0 }
  const definition = { schemaVersion: 1, form: { name: '来店アンケート', description: null, fields: [], layout: { version: 2, header: [], sections: [], options: {} }, on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }
  calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
  calls.list.mockResolvedValue([row]); calls.folderList.mockResolvedValue([]); calls.accounts.mockResolvedValue([])
  calls.listStats.mockResolvedValue({ thisMonthSentCount: 0, outdatedTemplateCount: 0 }); calls.versions.mockResolvedValue([]); calls.receivedVersions.mockResolvedValue([]); calls.messageReferences.mockResolvedValue([])
  calls.get.mockResolvedValue({ template: row, definition })
  render(<HqTemplatesV8 type="form" />)
  fireEvent.click((await screen.findByRole('link', { name: '来店アンケート' })).closest('tr')!)
  await screen.findByRole('heading', { name: '配った先' })
}

it('配布件数が未取得なら、まだ配っていないと表示しない', async () => {
  await show(null)
  expect(screen.getAllByText(/配布状況を確認できません/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/まだどのアカウントにも配っていません/)).toBeNull()
})

it('不正な配布件数なら、保存済み状態を未配布と決めつけない', async () => {
  await show('不明')
  expect(screen.getAllByText(/配布状況を確認できません/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/下書き・まだ配っていません/)).toBeNull()
})

it('配布件数が0なら従来どおり未配布と表示する', async () => {
  await show(0)
  expect(screen.getByText(/まだどのアカウントにも配っていません/)).toBeTruthy()
  expect(screen.queryByText(/配布状況を確認できません/)).toBeNull()
})

it('既存フォームの配布件数が省略された場合も未配布と決めつけない', async () => {
  await show(undefined)
  expect(screen.getAllByText(/配布状況を確認できません/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/まだどのアカウントにも配っていません/)).toBeNull()
})
