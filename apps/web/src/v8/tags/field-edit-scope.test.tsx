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
  <button onClick={() => props.onSubmit({ name: '変更', folderId: '', options: [], defaultValue: '', isPersonal: false, isStarred: false, ecIsMaster: false, ecFieldPath: null })}>保存する</button>
</div> }))
import FieldEdit from './field-edit'
const field = (name: string, id = 'field-1') => ({ id, name, fieldKey: 'visit', type: 'text', options: [], version: 1 })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
beforeEach(() => { fixture.account = 'a'; fixture.id = 'field-1'; fixture.fields.mockReset().mockImplementation(async (account: string) => ({ success: true, data: [field(account, fixture.id)] })); fixture.folders.mockReset().mockResolvedValue({ success: true, data: [] }); fixture.createFolder.mockReset(); fixture.update.mockReset() })
afterEach(cleanup)

it('フォルダの再取得中にアカウントを往復したら古い候補を出さない', async () => {
  const old = deferred<unknown>()
  fixture.folders.mockResolvedValueOnce({ success: false }).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ success: true, data: [{ id: 'b', name: 'Bのフォルダ' }] })
    .mockResolvedValueOnce({ success: true, data: [{ id: 'new', name: '新しいAのフォルダ' }] })
  const view = render(<FieldEdit />)
  await screen.findByText('error')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを読み直す' }))
  fixture.account = 'b'; view.rerender(<FieldEdit />); await screen.findByText('Bのフォルダ')
  fixture.account = 'a'; view.rerender(<FieldEdit />); await screen.findByText('新しいAのフォルダ')
  await act(async () => old.resolve({ success: true, data: [{ id: 'old', name: '古いAのフォルダ' }] }))
  expect(screen.queryByText('古いAのフォルダ')).toBeNull()
  expect(screen.getByText('新しいAのフォルダ')).toBeTruthy()
})

it('保存中にアカウントを替えたら前の保存結果を反映しない', async () => {
  const old = deferred<unknown>()
  fixture.update.mockReturnValueOnce(old.promise)
  const view = render(<FieldEdit />); await screen.findByText('a')
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(fixture.update).toHaveBeenCalledTimes(1)
  fixture.account = 'b'; view.rerender(<FieldEdit />); await screen.findByText('b')
  await act(async () => old.resolve({ success: true, data: field('古い保存') }))
  expect(screen.queryByText('古い保存')).toBeNull()
  expect(screen.getByText('b')).toBeTruthy()
})

it.each(['success', 'failure'])('409の最新確認%s中にアカウントを往復しても古い結果を表示しない', async outcome => {
  const { ApiError } = await import('@/lib/api')
  const old = deferred<unknown>()
  fixture.fields.mockResolvedValueOnce({ success: true, data: [field('a')] }).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ success: true, data: [field('b')] })
    .mockResolvedValueOnce({ success: true, data: [field('新しいa')] })
  fixture.update.mockRejectedValueOnce(new ApiError(409, '競合', 'VERSION_CONFLICT'))
  const view = render(<FieldEdit />); await screen.findByText('a')
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await vi.waitFor(() => expect(fixture.fields).toHaveBeenCalledTimes(2))
  fixture.account = 'b'; view.rerender(<FieldEdit />); await screen.findByText('b')
  fixture.account = 'a'; view.rerender(<FieldEdit />); await screen.findByText('新しいa')
  await act(async () => { if (outcome === 'failure') old.reject(new Error('network')); else old.resolve({ success: true, data: [field('古い競合')] }) })
  expect(screen.queryByText(/古い競合/)).toBeNull()
  expect(screen.queryByText(/最新の内容を確認できませんでした/)).toBeNull()
  expect(screen.getByText('新しいa')).toBeTruthy()
})

it('別の項目に切り替えた後は前のフォルダ作成結果を反映しない', async () => {
  const old = deferred<unknown>()
  fixture.createFolder.mockReturnValueOnce(old.promise)
  const view = render(<FieldEdit />); await screen.findByText('a')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを作る' }))
  fixture.id = 'field-2'; view.rerender(<FieldEdit />)
  await vi.waitFor(() => expect(fixture.fields).toHaveBeenCalledTimes(2))
  await screen.findByText('a')
  await act(async () => old.resolve({ success: true, data: { id: 'old', name: '前の項目のフォルダ' } }))
  expect(screen.queryByText('前の項目のフォルダ')).toBeNull()
})
