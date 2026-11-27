// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import HqAttributes from './attributes'
import type { HqFriendAttributeDetail } from '@line-crm/shared'
const mocks = vi.hoisted(() => ({ role: 'owner', list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), folders: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(), stats: vi.fn(), accounts: vi.fn(), received: vi.fn(), preflight: vi.fn(), distribute: vi.fn(), result: vi.fn(), context: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => ['owner', 'admin'].includes(mocks.role), useStaffRole: () => mocks.role, useStaffIdentity: () => ({ id: 'hq-owner' }), canManageRole: (role: string) => ['owner', 'admin'].includes(role) }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: (allowed: boolean) => allowed ? undefined : '統括の管理権限が必要です' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/hq/friend-attributes' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn(), usePageCrumbs: vi.fn() }))
vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { context: mocks.context } }))
vi.mock('@/lib/hq-friend-attributes-api', () => ({ hqFriendAttributesApi: { list: mocks.list, get: mocks.get, create: mocks.create, update: mocks.update, remove: mocks.remove, listStats: mocks.stats, folders: { list: mocks.folders, create: mocks.createFolder, update: mocks.updateFolder, remove: mocks.deleteFolder }, accounts: mocks.accounts, receivedVersions: mocks.received, preflight: mocks.preflight, distribute: mocks.distribute, result: mocks.result } }))
vi.mock('./distribution-accounts', () => ({ ALL_ACCOUNTS: 'all', useDistributionFolders: () => ({ folders: [], membership: new Map(), failed: false }), distributionFolderRows: () => [], accountsInFolder: (rows: unknown[]) => rows, DistributionFolderPanel: () => null }))
const heldFolder = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.title === 'フォルダを削除' && props.onConfirm) heldFolder.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})
const field: HqFriendAttributeDetail = { template: { id: 'field-one', name: '愛犬のお名前', description: null, template_type: 'friend_field', folder_id: null, revision: 3, updated_at: '2026-10-08' }, definition: { schemaVersion: 1, field: { name: '愛犬のお名前', fieldKey: 'dog_name', type: 'text', displayOrder: 0 }, folders: [] } }
const mark: HqFriendAttributeDetail = { template: { id: 'mark-one', name: '未対応', description: null, template_type: 'mark', revision: 4, updated_at: '2026-10-08' }, definition: { schemaVersion: 1, mark: { name: '未対応', color: '#EF4B55', isDefault: true, displayOrder: 0 } } }
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'owner'; window.sessionStorage.clear(); window.history.replaceState(null, '', '/hq/friend-attributes?tab=fields')
  HTMLElement.prototype.scrollIntoView = vi.fn()
  mocks.context.mockResolvedValue({ actorId: 'owner', tenantId: 'tenant' }); mocks.folders.mockResolvedValue([]); mocks.stats.mockResolvedValue({ totalTemplates: 1 }); mocks.accounts.mockResolvedValue([{ id: 'a', name: '本店' }]); mocks.received.mockResolvedValue([])
  mocks.list.mockResolvedValue([{ ...field.template, friend_count: 7 }]); mocks.get.mockResolvedValue(field); mocks.update.mockResolvedValue(field); mocks.create.mockResolvedValue(field)
})
afterEach(() => { cleanup(); clearToastsForTest() })

it('ひな形のフォルダ作成の完了を知らせる', async () => {
  mocks.createFolder.mockResolvedValueOnce({ id: 'new-folder', name: '見本', revision: 1 })
  render(<><HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} /><ToastHost /></>)
  await screen.findByText('愛犬のお名前')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '見本' } })
  fireEvent.click(screen.getByRole('button', { name: '追加する' }))
  expect(await screen.findByText('フォルダを作りました。')).toBeTruthy()
  expect(mocks.createFolder).toHaveBeenCalledOnce()
})

it('作成に失敗したら完了を知らせず入力を保つ', async () => {
  mocks.createFolder.mockRejectedValueOnce(new Error('保存できませんでした'))
  render(<><HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} /><ToastHost /></>)
  await screen.findByText('愛犬のお名前')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '見本' } })
  fireEvent.click(screen.getByRole('button', { name: '追加する' }))
  expect(await screen.findByText('保存できませんでした')).toBeTruthy()
  expect(screen.queryByText('フォルダを作りました。')).toBeNull()
  expect(screen.getByDisplayValue('見本')).toBeTruthy()
})

it('ひな形のフォルダ変更の完了を知らせる', async () => {
  mocks.folders.mockResolvedValue([{ id: 'f1', name: '基本情報', revision: 2, color: '#8b5cf6' }])
  mocks.updateFolder.mockResolvedValueOnce({ id: 'f1', name: '基本情報', revision: 3, color: '#ec4899' })
  render(<><HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「基本情報」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '色を変更する' }))
  const dialog = within(screen.getByRole('dialog', { name: 'フォルダを編集する' }))
  fireEvent.click(dialog.getByRole('button', { name: 'フォルダの色：紫' }))
  fireEvent.click(screen.getByRole('radio', { name: 'ピンク' }))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText('フォルダを保存しました。')).toBeTruthy()
})
