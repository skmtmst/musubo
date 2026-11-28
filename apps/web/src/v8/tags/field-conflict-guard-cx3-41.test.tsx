// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ account: 'a', id: 'field-1', fields: vi.fn(), folders: vi.fn(), createFolder: vi.fn(), update: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams({ id: fixture.id }), usePathname: () => '/tags/fields/edit' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: { id: fixture.account, name: fixture.account } }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, friendFields: { ...actual.api.friendFields, list: fixture.fields, update: fixture.update }, folders: { ...actual.api.folders, list: fixture.folders, create: fixture.createFolder } } }
})
vi.mock('./field-editor', () => ({ default: (props: { field: { name: string }; folders: { name: string }[]; foldersState: string; error: string; notices: React.ReactNode; onRetryFolders: () => void; onCreateFolder: (name: string, color: string | null) => Promise<unknown>; onSubmit: (values: unknown) => void }) => <div>
  <span>{props.field.name}</span>{props.notices}<span>{props.folders.map(item => item.name).join(',')}</span><span>{props.foldersState}</span><span>{props.error}</span>
  <button onClick={props.onRetryFolders}>フォルダを読み直す</button><button onClick={() => void props.onCreateFolder('新しいフォルダ', null)}>フォルダを作る</button>
  <button onClick={() => props.onSubmit({ name: '変更', folderId: '', options: null, defaultValue: null, isPersonal: false, isStarred: false, ecIsMaster: false, ecFieldPath: null })}>保存する</button>
</div> }))
import FieldEdit from './field-edit'
const field = (name: string) => ({ id: 'field-1', name, fieldKey: 'visit', type: 'text', folderId: null, options: null, defaultValue: null, isPersonal: false, isStarred: false, ecIsMaster: false, ecFieldPath: null, version: 1 })
beforeEach(() => {
  fixture.account = 'a'; fixture.id = 'field-1'
  fixture.fields.mockReset()
  fixture.folders.mockReset().mockResolvedValue({ success: true, data: [] })
  fixture.update.mockReset()
})
afterEach(cleanup)

it.each(['options', 'defaultValue'])('最新の%sが欠けたら保存済みと断定せず入力を残す', async missing => {
  const { ApiError } = await import('@/lib/api')
  const latest: Record<string, unknown> = { ...field('変更') }
  delete latest[missing]
  fixture.fields.mockResolvedValueOnce({ success: true, data: [field('もとの名前')] }).mockResolvedValueOnce({ success: true, data: [latest] })
  fixture.update.mockRejectedValueOnce(new ApiError(409, '競合', 'VERSION_CONFLICT'))
  render(<FieldEdit />)
  await screen.findByText('もとの名前')
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText(/最新の内容を確認できませんでした/)).toBeTruthy()
  expect(screen.getByText('もとの名前')).toBeTruthy()
})
