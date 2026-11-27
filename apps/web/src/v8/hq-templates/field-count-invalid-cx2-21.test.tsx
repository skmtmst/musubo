// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HqFriendAttributeDetail } from '@line-crm/shared'
import HqAttributes from './attributes'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), folders: vi.fn(), stats: vi.fn(), accounts: vi.fn(), received: vi.fn(), context: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', useStaffIdentity: () => ({ id: 'owner' }), canManageRole: () => true }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: (allowed: boolean) => allowed ? undefined : '統括の管理権限が必要です' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/hq/friend-attributes' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { context: mocks.context } }))
vi.mock('@/lib/hq-friend-attributes-api', () => ({ hqFriendAttributesApi: { list: mocks.list, get: mocks.get, listStats: mocks.stats, folders: { list: mocks.folders }, accounts: mocks.accounts, receivedVersions: mocks.received } }))
vi.mock('./distribution-accounts', () => ({ ALL_ACCOUNTS: 'all', useDistributionFolders: () => ({ folders: [], membership: new Map(), failed: false }), distributionFolderRows: () => [], accountsInFolder: (rows: unknown[]) => rows, DistributionFolderPanel: () => null }))

const field: HqFriendAttributeDetail = { template: { id: 'field-one', name: '愛犬のお名前', description: null, template_type: 'friend_field', folder_id: null, revision: 3, updated_at: '2026-10-08' }, definition: { schemaVersion: 1, field: { name: '愛犬のお名前', fieldKey: 'dog_name', type: 'text', displayOrder: 0 }, folders: [] } }
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('小数の使用人数は確認できない人数とし、ほかの操作は使える', async () => {
  window.sessionStorage.clear(); window.history.replaceState(null, '', '/hq/friend-attributes?tab=fields')
  mocks.context.mockResolvedValue({ actorId: 'owner', tenantId: 'tenant' }); mocks.folders.mockResolvedValue([]); mocks.stats.mockResolvedValue({ totalTemplates: 1 }); mocks.accounts.mockResolvedValue([]); mocks.received.mockResolvedValue([])
  mocks.list.mockResolvedValue([{ ...field.template, friend_count: 1.5 }]); mocks.get.mockResolvedValue(field)
  render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
  const name = await screen.findByText('愛犬のお名前')
  const row = name.closest('tr')!
  expect(within(row).getAllByRole('cell')[3].textContent).toBe('—')
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  expect(await screen.findByRole('menu')).toBeTruthy()
})
