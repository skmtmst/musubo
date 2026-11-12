import { getPageAction, findPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HqAttributes from './attributes'
import AttributeDistribution from './attribute-distribution'
import { fieldDefinition, fieldOf } from './attribute-model'
import type { HqFriendAttributeDetail } from '@line-crm/shared'
const mocks = vi.hoisted(() => ({ role: 'owner', list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), folders: vi.fn(), createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(), stats: vi.fn(), accounts: vi.fn(), received: vi.fn(), preflight: vi.fn(), distribute: vi.fn(), result: vi.fn(), context: vi.fn() }))
vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => ['owner', 'admin'].includes(mocks.role), useStaffRole: () => mocks.role, useStaffIdentity: () => ({ id: 'hq-owner' }), canManageRole: (role: string) => ['owner', 'admin'].includes(role) }))
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
afterEach(cleanup)
describe('統括の情報欄・対応マーク', () => {
  it('一覧取得中は使っているマークを0種類と誤表示しない', async () => {
    let resolve!: (rows: unknown[]) => void
    mocks.list.mockReturnValue(new Promise((done) => { resolve = done }))
    render(<HqAttributes type="mark" tab="marks" onTab={vi.fn()} />)
    expect(document.body.textContent).not.toContain('使っている 0')
    expect(document.body.textContent).not.toContain('まだ対応マークはありません')
    mocks.get.mockResolvedValue(mark)
    await act(async () => { resolve([{ ...mark.template, friend_count: 3 }]) })
    expect(document.body.textContent).toContain('使っている 1')
  })
  it('情報欄の操作説明を題から開閉し、単独の質問印を置かない', async () => {
    window.localStorage.clear()
    render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
    await screen.findByText('愛犬のお名前')
    const toggle = screen.getByRole('button', { name: 'この画面の説明' })
    expect(toggle.closest('[data-template-region="heading"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '一覧の操作の説明' })).toBeNull()
    fireEvent.click(toggle)
    expect(document.getElementById(toggle.getAttribute('aria-describedby') ?? '')?.textContent).toContain('情報欄のひな形を各アカウントへ配れます。')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('対応マークの説明は題から開閉し、数の帯と道具の間に一度だけ出す', async () => {
    window.localStorage.clear()
    mocks.list.mockResolvedValue([mark.template]); mocks.get.mockResolvedValue(mark)
    render(<HqAttributes type="mark" tab="marks" onTab={vi.fn()} />)
    await screen.findByText('未対応')
    const toggle = screen.getByRole('button', { name: 'この画面の説明' })
    expect(toggle.closest('[data-template-region="heading"]')).toBeTruthy()
    expect(screen.queryAllByText(/対応マークは、受信箱で/)).toHaveLength(0)
    fireEvent.click(toggle)
    expect(document.getElementById(toggle.getAttribute('aria-describedby') ?? '')?.textContent).toContain('新しいメッセージが来たら自動で変える')
    expect(screen.getAllByText(/対応マークは、受信箱で/)).toHaveLength(1)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: '対応マーク「未対応」の操作' })).toBeTruthy()
  })
  it('店の情報欄一覧を使い、API未取得の使用先は—、閲覧のみは変更操作を隠す', async () => {
    mocks.role = 'staff'; render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
    await screen.findByText('愛犬のお名前'); expect(screen.queryByRole('button', { name: '項目を作る' })).toBeNull(); expect(screen.queryByRole('button', { name: '愛犬のお名前を配る' })).toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0); expect(screen.queryByText('友だち詳細・テンプレート差し込み')).toBeNull()
    expect([...document.querySelectorAll('[title]')].some((element) => element.getAttribute('title')?.includes('友だち詳細'))).toBe(false)
  })
  it('対応マークも閲覧のみは編集リンク・配布・削除を隠し、使用先を補わない', async () => {
    mocks.role = 'staff'; mocks.list.mockResolvedValue([mark.template]); mocks.get.mockResolvedValue(mark)
    render(<HqAttributes type="mark" tab="marks" onTab={vi.fn()} />)
    await screen.findByText('未対応')
    expect(screen.queryByRole('link', { name: '未対応' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'マークを作る' })).toBeNull()
    expect(screen.queryByRole('button', { name: '未対応を配る' })).toBeNull()
    expect(screen.queryByRole('button', { name: '対応マーク「未対応」の操作' })).toBeNull()
    expect([...document.querySelectorAll('[title]')].some((element) => element.getAttribute('title')?.includes('友だち詳細'))).toBe(false)
  })
  it('情報欄の入力不足は欄で止め、作成APIを呼ばない', async () => {
    render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />); await screen.findByText('愛犬のお名前'); fireEvent.click(screen.getAllByRole('button', { name: '項目を作る' })[0]); fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect(screen.getByRole('textbox', { name: /項目名/ }).getAttribute('aria-invalid')).toBe('true'); expect(mocks.create).not.toHaveBeenCalled()
  })
  it('情報欄編集は読んだ版を送り、成功してから配る窓を開く', async () => {
    render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />); await screen.findByText('愛犬のお名前'); fireEvent.click(screen.getByRole('link', { name: '愛犬のお名前' })); await screen.findByRole('button', { name: '保存する' }); fireEvent.change(screen.getByRole('textbox', { name: /項目名/ }), { target: { value: 'ペット名' } }); fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('field-one', expect.objectContaining({ expectedRevision: 3, name: 'ペット名', type: 'friend_field' })))
    await screen.findByText('保存しました。アカウントに配りますか？'); expect(mocks.distribute).not.toHaveBeenCalled()
  })
  it('版の衝突では入力を残し、保存後の窓を開かない', async () => {
    mocks.update.mockRejectedValue(Object.assign(new Error('先に変更されました'), { status: 409 })); render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />); await screen.findByText('愛犬のお名前'); fireEvent.click(screen.getByRole('link', { name: '愛犬のお名前' })); await screen.findByRole('button', { name: '保存する' }); fireEvent.change(screen.getByRole('textbox', { name: /項目名/ }), { target: { value: '入力を残す' } }); fireEvent.click(screen.getByRole('button', { name: '保存する' })); await screen.findByText('先に変更されました'); expect(screen.queryByText('保存しました。アカウントに配りますか？')).toBeNull(); expect((screen.getByRole('textbox', { name: /項目名/ }) as HTMLInputElement).value).toBe('入力を残す')
  })
  it('対応マークの下書き保存は配布せず、削除は確認後に版付きで送る', async () => {
    mocks.list.mockResolvedValue([{ ...mark.template, friend_count: 2 }]); mocks.get.mockResolvedValue(mark); mocks.update.mockResolvedValue(mark); mocks.remove.mockResolvedValue({ archived: true })
    render(<HqAttributes type="mark" tab="marks" onTab={vi.fn()} />); await screen.findByText('未対応'); fireEvent.click(await screen.findByRole('link', { name: '未対応' })); await findPageAction({ name: '下書きを保存' }); fireEvent.click(getPageAction({ name: '下書きを保存' })); await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('mark-one', expect.objectContaining({ expectedRevision: 4 }))); await screen.findByRole('button', { name: '対応マーク「未対応」の操作' }); expect(screen.queryByText('保存しました。アカウントに配りますか？')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '対応マーク「未対応」の操作' })); fireEvent.click(screen.getByRole('menuitem', { name: '削除する' })); expect(mocks.remove).not.toHaveBeenCalled(); expect(screen.getByRole('alertdialog').textContent).toContain('環境'); fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })); await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('mark-one', 4))
  })
  it('並び替えは既存PATCHで順序と読んだ版を保存する', async () => {
    const second = { ...field, template: { ...field.template, id: 'field-two', name: '2つ目', revision: 5 }, definition: { ...field.definition, field: { ...field.definition.field, name: '2つ目', fieldKey: 'second', displayOrder: 1 } } } as typeof field
    mocks.list.mockResolvedValue([{ ...field.template, friend_count: 0 }, { ...second.template, friend_count: 0 }]); mocks.get.mockImplementation(async (id) => id === 'field-two' ? second : field)
    render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />); await screen.findByText('2つ目'); fireEvent.keyDown(screen.getByRole('button', { name: /愛犬のお名前.*並/ }), { key: 'ArrowDown' })
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('field-two', expect.objectContaining({ expectedRevision: 5, definition: expect.objectContaining({ field: expect.objectContaining({ displayOrder: 0 }) }) })))
  })
  it('作成の応答不明は同じ依頼を再確認し、入力を変えて二重作成しない', async () => {
    mocks.create.mockRejectedValueOnce(new Error('通信が切れました')).mockResolvedValue(field)
    render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
    await screen.findByText('愛犬のお名前'); fireEvent.click(screen.getAllByRole('button', { name: '項目を作る' })[0])
    fireEvent.change(screen.getByRole('textbox', { name: /項目名/ }), { target: { value: '新しい項目' } })
    fireEvent.change(screen.getByRole('textbox', { name: /差し込みの名前/ }), { target: { value: 'new_field' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByText('通信が切れました')
    expect((screen.getByRole('textbox', { name: /項目名/ }) as HTMLInputElement).disabled).toBe(true)
    const first = mocks.create.mock.calls[0]
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByText('保存しました。アカウントに配りますか？')
    expect(mocks.create.mock.calls[1]).toEqual(first)
    expect(window.sessionStorage.length).toBe(0)
  })
  it('マーク編集のキャンセルは未保存の変更を確認し、断ると入力を残す', async () => {
    mocks.list.mockResolvedValue([mark.template]); mocks.get.mockResolvedValue(mark)
    render(<HqAttributes type="mark" tab="marks" onTab={vi.fn()} />)
    await screen.findByText('未対応'); fireEvent.click(await screen.findByRole('link', { name: '未対応' }))
    const name = await screen.findByRole('textbox', { name: /マーク名/ })
    fireEvent.change(name, { target: { value: '名前を変更' } }); fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('保存')
    fireEvent.click(within(dialog).getByRole('button', { name: '編集を続ける' }))
    expect((name as HTMLInputElement).value).toBe('名前を変更'); expect(mocks.update).not.toHaveBeenCalled()
  })
})
it('選択肢のID・削除した選択肢・既定値を往復で保つ', () => {
  const definition = { schemaVersion: 1 as const, field: { name: '種類', fieldKey: 'kind', type: 'select' as const, options: [{ id: 'dog', label: '犬' }, { id: 'cat', label: '猫' }], defaultValue: 'dog' }, folders: [] }
  const values = { name: '種類', fieldKey: 'kind', type: 'select' as const, folderId: '', options: ['犬'], defaultValue: '犬', isPersonal: false, isStarred: false, ecIsMaster: false, ecFieldPath: '' }
  const next = fieldDefinition(values, definition, [], true)
  expect(next.field.defaultValue).toBe('dog'); expect(next.field.options).toContainEqual(expect.objectContaining({ id: 'cat', status: 'archived' })); expect(fieldOf({ ...field, definition: next }).optionDefinitions).toContainEqual(expect.objectContaining({ id: 'dog', label: '犬' }))
  const renamed = fieldDefinition({ ...values, options: ['いぬ'], optionIds: ['dog'], defaultValue: 'いぬ' }, definition, [], true)
  expect(renamed.field.defaultValue).toBe('dog'); expect(renamed.field.options).toContainEqual(expect.objectContaining({ id: 'dog', label: 'いぬ', status: 'active' }))
})
it('配布の応答不明は結果GETで復元し、POSTを繰り返さない', async () => {
  mocks.preflight.mockResolvedValue({ preflightId: 'run', expiresAt: '2099-01-01', stores: [{ accountId: 'a', accountName: '本店', items: [{ sourceId: 'field-one', name: '項目', duplicate: false, allowedModes: ['create'] }] }] }); mocks.distribute.mockRejectedValue(new Error('network')); mocks.result.mockResolvedValue({ runId: 'run', status: 'completed', stores: [{ accountId: 'a', status: 'succeeded', reason: null, counts: { created: 1, overwritten: 0, aliased: 0 } }] })
  render(<AttributeDistribution detail={field} onClose={vi.fn()} />); await screen.findByRole('checkbox', { name: '本店' }); fireEvent.click(screen.getByRole('checkbox', { name: '本店' })); fireEvent.click(screen.getByRole('button', { name: '選んだアカウントを確かめる' })); await screen.findByRole('button', { name: 'この内容で1アカウントへ配る' }); fireEvent.click(screen.getByRole('button', { name: 'この内容で1アカウントへ配る' })); await screen.findByText('成功'); fireEvent.click(screen.getByRole('button', { name: '結果を再確認' })); await waitFor(() => expect(mocks.result).toHaveBeenCalledTimes(2)); expect(mocks.distribute).toHaveBeenCalledTimes(1)
})

it('統括の情報欄のフォルダも保存色を読み、色の保存に失敗しても窓と入力を保つ', async () => {
  mocks.folders.mockResolvedValue([{ id: 'f1', name: '基本情報', revision: 2, color: '#8b5cf6' }])
  mocks.updateFolder.mockRejectedValueOnce(new Error('保存できませんでした')).mockResolvedValueOnce({ id: 'f1', name: '基本情報', revision: 3, color: '#ec4899' })
  render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「基本情報」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '色を変える' }))
  const dialog = within(screen.getByRole('dialog', { name: 'フォルダを編集する' }))
  fireEvent.click(dialog.getByRole('button', { name: 'フォルダの色：紫' }))
  fireEvent.click(screen.getByRole('radio', { name: 'ピンク' }))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(dialog.getByRole('alert').textContent).toContain('保存できませんでした'))
  expect(dialog.getByRole('button', { name: 'フォルダの色：ピンク' })).toBeTruthy()
  expect(screen.queryByText('保存できませんでした', { selector: '[data-notice]' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(mocks.updateFolder).toHaveBeenLastCalledWith('f1', '基本情報', 2, '#ec4899'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})


it('情報欄のフォルダをその場で作ると、選んだ色を統括のAPIと閉じた欄へ渡す', async () => {
  document.documentElement.dataset.theme = 'v8'
  const folder = { id: 'f-new', name: '新しい分類', color: '#ef4444', revision: 1 }
  mocks.createFolder.mockResolvedValue(folder)
  render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
  await screen.findByText('愛犬のお名前')
  fireEvent.click(screen.getAllByRole('button', { name: '項目を作る' })[0])
  const trigger = screen.getByRole('button', { name: '友だち情報欄のフォルダ' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: folder.name } })
  fireEvent.click(screen.getByRole('button', { name: 'フォルダの色：青' }))
  fireEvent.click(screen.getByRole('radio', { name: '赤' }))
  fireEvent.click(screen.getByRole('button', { name: '作って選ぶ' }))
  await waitFor(() => expect(mocks.createFolder).toHaveBeenCalledWith(folder.name, folder.color))
  await waitFor(() => expect(trigger.textContent).toBe(folder.name))
  const expected = document.createElement('span')
  expected.style.backgroundColor = folder.color
  expect(trigger.querySelector<HTMLElement>('[data-folder-dot]')!.style.backgroundColor).toBe(expected.style.backgroundColor)
  delete document.documentElement.dataset.theme
})
it('情報欄のフォルダ名を編集中は移動前に確認する', async () => {
  render(<><HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} /><a href="/events">イベントへ</a></>)
  await screen.findByText('愛犬のお名前')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '分類' } })
  fireEvent.click(screen.getByRole('link', { name: 'イベントへ' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('統括の情報欄フォルダ削除窓に対象と環境を出す', async () => {
  mocks.folders.mockResolvedValue([{ id: 'f1', name: '基本情報', revision: 2, color: '#8b5cf6' }])
  render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「基本情報」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog.textContent).toContain('統括のフォルダ')
  expect(dialog.textContent).toContain('環境')
})

it('統括情報欄フォルダは閉じた確認から削除しない', async () => {
  mocks.deleteFolder.mockClear().mockResolvedValue(undefined)
  mocks.folders.mockResolvedValue([{ id: 'f1', name: '基本情報', revision: 2, color: '#8b5cf6' }])
  render(<HqAttributes type="friend_field" tab="fields" onTab={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'フォルダ「基本情報」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '消す' }))
  const previous = heldFolder.confirm!
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await previous() })
  expect(mocks.deleteFolder).not.toHaveBeenCalled()
})
