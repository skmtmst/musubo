// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ account: 'a', fields: vi.fn(), folders: vi.fn(), create: vi.fn(), push: vi.fn(), toast: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: f.push }), useSearchParams: () => new URLSearchParams(''), usePathname: () => '/tags/fields/new' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: f.account }) }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: f.toast }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, friendFields: { ...actual.api.friendFields, list: f.fields, create: f.create }, folders: { ...actual.api.folders, list: f.folders } } } })
vi.mock('./field-editor', () => ({ default: (props: { siblings: { name: string }[]; siblingsReady: boolean; folders: { name: string }[]; error: string; onSubmit: (values: unknown, key: string) => void }) => <div>
  <span>{props.siblings.map(row => row.name).join(',')}</span><span>{props.folders.map(row => row.name).join(',')}</span><span>{props.siblingsReady ? '確認済み' : '確認中'}</span><span>{props.error}</span>
  <button onClick={() => props.onSubmit({ name: '新しい項目', fieldKey: 'test', type: 'text', folderId: '', options: [], defaultValue: '', isPersonal: false, isStarred: false, ecIsMaster: false, ecFieldPath: null }, 'key')}>保存する</button>
</div> }))
import FieldNew from './field-new'
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => { f.account = 'a'; f.fields.mockReset(); f.folders.mockReset(); f.create.mockReset(); f.push.mockReset(); f.toast.mockReset(); f.fields.mockImplementation(async (id: string) => ({ success: true, data: [{ id, name: id }] })); f.folders.mockResolvedValue({ success: true, data: [] }) })
afterEach(cleanup)

it('アカウントを往復した後に前の重複確認とフォルダを混ぜない', async () => {
  const oldFields = deferred<unknown>(), oldFolders = deferred<unknown>()
  f.fields.mockReturnValueOnce(oldFields.promise).mockResolvedValueOnce({ success: true, data: [{ id: 'b', name: 'Bの項目' }] }).mockResolvedValueOnce({ success: true, data: [{ id: 'a', name: '新しいAの項目' }] })
  f.folders.mockReturnValueOnce(oldFolders.promise).mockResolvedValueOnce({ success: true, data: [] }).mockResolvedValueOnce({ success: true, data: [{ id: 'new', name: '新しいAのフォルダ' }] })
  const view = render(<FieldNew />)
  f.account = 'b'; view.rerender(<FieldNew />); await screen.findByText('Bの項目')
  f.account = 'a'; view.rerender(<FieldNew />); await screen.findByText('新しいAの項目')
  await act(async () => { oldFields.resolve({ success: true, data: [{ id: 'old', name: '古いAの項目' }] }); oldFolders.resolve({ success: true, data: [{ id: 'old', name: '古いAのフォルダ' }] }) })
  expect(screen.queryByText('古いAの項目')).toBeNull(); expect(screen.queryByText('古いAのフォルダ')).toBeNull()
  expect(screen.getByText('新しいAの項目')).toBeTruthy(); expect(screen.getByText('新しいAのフォルダ')).toBeTruthy()
})

it('切替先の重複確認中は保存せず、前の保存結果で移動しない', async () => {
  const oldSave = deferred<unknown>(), newFields = deferred<unknown>()
  f.create.mockReturnValueOnce(oldSave.promise)
  f.fields.mockResolvedValueOnce({ success: true, data: [{ id: 'a', name: 'Aの項目' }] }).mockReturnValueOnce(newFields.promise)
  const view = render(<FieldNew />); await screen.findByText('確認済み')
  fireEvent.click(screen.getByRole('button', { name: '保存する' })); expect(f.create).toHaveBeenCalledTimes(1)
  f.account = 'b'; view.rerender(<FieldNew />)
  expect(screen.getByText('確認中')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '保存する' })); expect(f.create).toHaveBeenCalledTimes(1)
  await act(async () => { oldSave.resolve({ success: true, data: { id: 'old' } }); newFields.resolve({ success: true, data: [] }) })
  expect(f.push).not.toHaveBeenCalled()
  expect(f.toast).toHaveBeenCalledWith('前のアカウントで「新しい項目」を作りました')
})
