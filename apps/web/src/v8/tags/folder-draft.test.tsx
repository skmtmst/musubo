// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'
const fx = vi.hoisted(() => ({ create: vi.fn(), createFolder: vi.fn(), push: vi.fn(), save: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fx.push, replace: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/tags/new' }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<object>(), useStaffRole: () => 'admin', canManageRole: () => true }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }), retroactivePreview: async () => ({ success: true, data: { selfTargets: 4, referralTargets: 1, selfMiles: 400, referralMiles: 0, selfExcluded: 1, referralExcluded: 0, previewToken: 'pt-1' } }), createDefinition: fx.create }, tagGroups: { ...actual.api.tagGroups, list: async () => ({ success: true, data: [] }), create: fx.createFolder } } } })
import TagCreate from './create'
import { TagEditForm } from '@/v8/tag-edit/edit-form'
afterEach(() => { cleanup(); vi.clearAllMocks() })
function startFolder() {
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '編集中フォルダ' } })
  fireEvent.pointerDown(document.body)
}
function edit() {
  render(<TagEditForm tag={{ id: 't1', name: '架空タグ', status: 'active' } as Tag} groups={[]} onCreateGroup={fx.createFolder} dependencies={null} accountId="acc" readOnly={false} conflict={false} compareBusy={false} onCompare={vi.fn()} onReloadLatest={vi.fn()} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={fx.push} onSave={fx.save} onDelete={vi.fn()} />)
}
it.each(['タグを作る', '保存して続けて作る'])('新規 %s の前に作成途中のフォルダを確認する', async label => {
  render(<TagCreate />)
  fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '架空タグ' } })
  startFolder()
  if (label === '保存して続けて作る') {
    fireEvent.click(screen.getByRole('button', { name: '作成・編集のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
  } else fireEvent.click(screen.getByRole('button', { name: label, exact: true }))
  expect(await screen.findByRole('button', { name: 'フォルダを破棄して保存' })).toBeTruthy()
  expect(fx.create).not.toHaveBeenCalled()
})
it('タグ編集の保存前に作成途中のフォルダを確認する', async () => {
  edit(); startFolder()
  fireEvent.click(screen.getByRole('button', { name: 'タグを保存する' }))
  expect(await screen.findByRole('button', { name: 'フォルダを破棄して保存' })).toBeTruthy()
  expect(fx.save).not.toHaveBeenCalled()
})
it('タグ編集のキャンセルは作成途中のフォルダを確認する', async () => {
  edit(); startFolder()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(fx.push).not.toHaveBeenCalled()
})
it('新規のキャンセルはタグとフォルダの両方の変更を確認する', async () => {
  render(<TagCreate />)
  fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '架空タグ' } })
  startFolder()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(await screen.findAllByRole('dialog', { name: '保存していない変更があります' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect((screen.getByLabelText('タグ名') as HTMLInputElement).value).toBe('架空タグ')
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  expect((screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement).value).toBe('編集中フォルダ')
  expect(fx.push).not.toHaveBeenCalled()
})
it('タグ編集で削除へ進む前にも作成途中のフォルダを確認する', async () => {
  const remove = vi.fn()
  render(<TagEditForm tag={{ id: 't1', name: '架空タグ', status: 'active' } as Tag} groups={[]} onCreateGroup={vi.fn()} dependencies={null} accountId="acc" readOnly={false} conflict={false} compareBusy={false} onCompare={vi.fn()} onReloadLatest={vi.fn()} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={fx.push} onSave={fx.save} onDelete={remove} />)
  startFolder()
  fireEvent.click(screen.getByRole('button', { name: 'タグを削除する' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(remove).not.toHaveBeenCalled()
})
it('タグ編集の読み直しは作成途中のフォルダを確認し、破棄を選んだ時だけ実行する', async () => {
  const reload = vi.fn()
  render(<TagEditForm tag={{ id: 't1', name: '架空タグ', status: 'active' } as Tag} groups={[]} onCreateGroup={vi.fn()} dependencies={null} accountId="acc" readOnly={false} conflict compareBusy={false} onCompare={vi.fn()} onReloadLatest={reload} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={fx.push} onSave={fx.save} onDelete={vi.fn()} />)
  startFolder()
  fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  expect(reload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(reload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  expect((screen.getByRole('textbox', { name: '新しいフォルダの名前' }) as HTMLInputElement).value).toBe('編集中フォルダ')
  fireEvent.pointerDown(document.body)
  fireEvent.click(screen.getByRole('button', { name: '最新を読み込んで続ける' }))
  fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
  expect(reload).toHaveBeenCalledOnce()
})
it.each(['タグを作る', '保存して続けて作る'])('新規 %s は破棄の確定後だけ保存する', async label => {
  fx.create.mockResolvedValue({ success: true, data: { tag: { id: 'tag-created' } } })
  render(<TagCreate />)
  fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '架空タグ' } })
  startFolder()
  if (label === '保存して続けて作る') {
    fireEvent.click(screen.getByRole('button', { name: '作成・編集のその他の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
  } else fireEvent.click(screen.getByRole('button', { name: label, exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダを破棄して保存' }))
  await waitFor(() => expect(fx.create).toHaveBeenCalledOnce())
  expect(fx.create).toHaveBeenCalledWith('acc', expect.objectContaining({ name: '架空タグ', groupId: null }))
  await waitFor(() => expect(fx.push).toHaveBeenCalledWith(expect.stringContaining(label === 'タグを作る' ? '/tags?highlight=' : '/tags/new?')))
})
it('フォルダ破棄を確かめた後も遡及反映の確認を省かない', async () => {
  render(<TagEditForm tag={{ id: 't1', name: '架空タグ', status: 'active', linkedEnabled: true, mileageReward: 100, friendCount: 5 } as Tag} groups={[]} onCreateGroup={vi.fn()} dependencies={null} accountId="acc" readOnly={false} conflict={false} compareBusy={false} onCompare={vi.fn()} onReloadLatest={vi.fn()} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={fx.push} onSave={fx.save} onDelete={vi.fn()} />)
  fireEvent.click(within(screen.getByRole('region', { name: 'マイル' })).getByRole('button', { name: '開く' }))
  fireEvent.click(screen.getByRole('switch', { name: 'さかのぼって反映' }))
  startFolder()
  fireEvent.click(screen.getByRole('button', { name: 'タグを保存する' }))
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダを破棄して保存' }))
  expect(await screen.findByText('5人にさかのぼってマイルを積みますか？')).toBeTruthy()
  expect(fx.save).not.toHaveBeenCalled()
})


it.each(['新規', '編集'])('%s：フォルダ作成の通信中は親の保存に処理中を表示する', async mode => {
  fx.createFolder.mockImplementation(() => new Promise(() => {}))
  if (mode === '新規') {
    render(<TagCreate />)
    fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '架空タグ' } })
  } else edit()
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '処理中' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  const busy = await screen.findAllByRole('button', { name: 'フォルダ作成中' })
  expect(busy).toHaveLength(1)
  expect(busy.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  if (mode === '新規') {
    fireEvent.click(screen.getByRole('button', { name: '作成・編集のその他の操作' }))
    expect(screen.getByRole('menuitem', { name: 'フォルダ作成中' }).getAttribute('disabled')).not.toBeNull()
  }
  expect(screen.getAllByText('フォルダを作成中です。')).toHaveLength(mode === '編集' ? 2 : 1)
  expect((screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).disabled).toBe(true)
  if (mode === '編集') expect((screen.getByRole('button', { name: 'タグを削除する' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fx.create).not.toHaveBeenCalled()
  expect(fx.save).not.toHaveBeenCalled()
})


it.each(['成功', '失敗'])('フォルダ作成の%s後は親の保存の処理中表示を解除する', async outcome => {
  let resolve!: (value: { value: string; label: string }) => void
  let reject!: (reason: Error) => void
  fx.createFolder.mockImplementation(() => new Promise((ok, fail) => { resolve = ok; reject = fail }))
  edit()
  fireEvent.click(screen.getByRole('button', { name: '所属フォルダ' }))
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '新規分類' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  expect(await screen.findByRole('button', { name: 'フォルダ作成中' })).toBeTruthy()
  await act(async () => { if (outcome === '成功') resolve({ value: 'group-1', label: '新規分類' }); else reject(new Error('作成失敗')) })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'フォルダ作成中' })).toBeNull())
  expect((screen.getByRole('button', { name: 'タグを保存する' }) as HTMLButtonElement).disabled).toBe(false)
})
