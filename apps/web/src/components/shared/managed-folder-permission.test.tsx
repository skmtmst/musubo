// @vitest-environment happy-dom
import React, { createRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'
import { api } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import ManagedFolderPanel, { type ManagedFolderControl, useManagedFolders } from './managed-folder-panel'
import { useFolderRowActions } from './folder-row-actions'
import FolderPanel from './folder-panel'

const captures = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL ||= 'http://worker.test'
  return {
    probe: undefined as (() => void) | undefined,
    editor: undefined as ComponentProps<typeof import('./folder-add-dialog').default> | undefined,
    confirm: undefined as ComponentProps<typeof import('./confirm-dialog').default> | undefined,
    row: undefined as ReturnType<ReturnType<typeof useFolderRowActions>['rowActions']> | undefined,
  }
})
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('./folder-add-dialog', async original => {
  const mod = await original<typeof import('./folder-add-dialog')>()
  return { ...mod, default: (props: ComponentProps<typeof mod.default>) => {
    captures.editor = props
    return <mod.default {...props} />
  } }
})
vi.mock('./confirm-dialog', async original => {
  const mod = await original<typeof import('./confirm-dialog')>()
  return { ...mod, default: (props: ComponentProps<typeof mod.default>) => {
    if (props.open) captures.confirm = props
    return <mod.default {...props} />
  } }
})

const folders: Folder[] = ['a', 'b'].map((id, index) => ({
  id, kind: 'scenario', name: `フォルダ${id}`, parentId: null, color: null,
  displayOrder: index, createdAt: '', updatedAt: '', itemCount: 2, accountId: 'account-a', revision: 1,
}))
const reason = '閲覧のみのため、フォルダは変えられません。'
const onChanged = vi.fn(), onDeleted = vi.fn(), onSelect = vi.fn()
const control = createRef<ManagedFolderControl>()
type Permission = { canWriteNow?: () => boolean; enabled?: boolean; accountId?: string; kind?: string; lockedReason?: string | null }
function LayoutProbe() {
  React.useLayoutEffect(() => { const probe = captures.probe; captures.probe = undefined; probe?.() })
  return null
}
function Panel({ canWriteNow, enabled = true, accountId = 'account-a', kind = 'scenario', lockedReason }: Permission) {
  return <><ManagedFolderPanel kind={kind} accountId={accountId} folders={folders}
    onChanged={onChanged} canManage={enabled} canWriteNow={canWriteNow} lockedReason={lockedReason}
    activeId="all" onSelect={onSelect} allCount={4} itemLabel="シナリオ" controlRef={control} /><LayoutProbe /></>
}
function Rows({ canWriteNow, enabled = true, accountId = 'account-a', kind = 'scenario', lockedReason }: Permission) {
  const scopedFolders = folders.map(folder => ({ ...folder, accountId }))
  const actions = useFolderRowActions({ kind, folders: scopedFolders, accountId, enabled, canWriteNow,
    lockedReason, itemLabel: 'シナリオ', onChanged, onDeleted })
  captures.row = actions.rowActions(scopedFolders[0], 0)
  return <><FolderPanel rows={scopedFolders.map((folder, index) => ({ ...actions.rowActions(folder, index),
    id: folder.id, label: folder.name, kind: 'folder' as const }))} activeId="all" onSelect={onSelect} />{actions.dialogs}<LayoutProbe /></>
}
function ReadPanel() {
  const state = useManagedFolders('scenario', 'account-a')
  return <ManagedFolderPanel kind="scenario" accountId="account-a" folders={state.folders}
    onChanged={state.reload} canManage canWriteNow={() => true}
    activeId="all" onSelect={onSelect} allCount={4} itemLabel="シナリオ" />
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const click = async (element: Element) => { await act(async () => { fireEvent.click(element) }) }
async function menu(action: string) {
  await click(screen.getByRole('button', { name: 'フォルダ「フォルダa」の操作' }))
  await click(await screen.findByRole('menuitem', { name: action }))
}

beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  document.documentElement.dataset.theme = 'v8'
  captures.probe = undefined; captures.editor = undefined; captures.confirm = undefined; captures.row = undefined
  onChanged.mockReset(); onDeleted.mockReset(); onSelect.mockReset()
  vi.spyOn(api.folders, 'create').mockResolvedValue({ success: true, data: folders[0] })
  vi.spyOn(api.folders, 'update').mockResolvedValue({ success: true, data: folders[0] })
  vi.spyOn(api.folders, 'delete').mockResolvedValue({ success: true, data: null })
  vi.spyOn(api.folders, 'swapOrder').mockResolvedValue({ success: true, data: { swapped: ['a', 'b'] } })
  vi.spyOn(api.folders, 'list').mockResolvedValue({ success: true, data: folders })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme })

it.each([Panel, Rows])('%sの未指定と許可callbackではDOMとTab順が同一', Component => {
  const { container, rerender } = render(<Component />)
  const before = container.innerHTML
  const tabOrder = () => [...container.querySelectorAll('button,a,input,select')].map(el => [el.tagName, el.getAttribute('tabindex'), el.textContent, el.getAttribute('disabled')])
  const beforeTabs = tabOrder()
  rerender(<Component canWriteNow={() => true} />)
  expect(container.innerHTML).toBe(before)
  expect(tabOrder()).toEqual(beforeTabs)
})

it.each(['add', 'edit', 'delete'] as const)('開いた%s窓は閲覧者への切替後も残り、確定とEnterと保持した操作は書込0', async mode => {
  const dialogRole = mode === 'delete' ? 'alertdialog' : 'dialog'
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  if (mode === 'add') {
    await act(async () => control.current!.startAdd())
    fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '新しいフォルダ' } })
  } else await menu(mode === 'edit' ? '名前を変える' : '消す')
  expect(screen.getByRole(dialogRole)).toBeTruthy()
  if (mode !== 'delete') expect(captures.editor!.canSaveNow).toBeTypeOf('function')
  const held = mode === 'delete' ? captures.confirm!.onConfirm! : captures.editor!.canSaveNow!
  const heldConfirm = mode === 'delete' ? captures.confirm!.onConfirm! : undefined
  verifiedStaffRole('viewer')
  rerender(<Panel canWriteNow={() => false} enabled={false} lockedReason={reason} />)
  expect(screen.getByRole(dialogRole)).toBeTruthy()
  const button = screen.getByRole('button', { name: mode === 'delete' ? '削除する' : mode === 'edit' ? '保存する' : '追加する' }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.tabIndex).toBe(0)
  await click(button)
  fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' })
  await act(async () => button.focus())
  expect(screen.getByRole('tooltip').textContent).toContain(reason)
  const form = button.closest('[role="dialog"],[role="alertdialog"]')?.querySelector('form')
  if (form) fireEvent.submit(form)
  if (heldConfirm) await act(async () => heldConfirm())
  else expect(held()).toBe(false)
  expect(api.folders.create).not.toHaveBeenCalled()
  expect(api.folders.update).not.toHaveBeenCalled()
  expect(api.folders.delete).not.toHaveBeenCalled()
  expect(api.folders.swapOrder).not.toHaveBeenCalled()
  expect(screen.getByRole(dialogRole)).toBeTruthy()
  await click(screen.getByRole('button', { name: 'キャンセル' }))
  if (mode === 'add') {
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    await click(screen.getByRole('button', { name: '破棄する' }))
  }
  expect(screen.queryByRole(dialogRole)).toBeNull()
})

it('開いた追加窓は本人未確定でも残り、拒否理由なしの普通のdisabledとなる', async () => {
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  await act(async () => control.current!.startAdd())
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '入力は残す' } })
  verifiedStaffRole(null)
  rerender(<Panel canWriteNow={() => false} enabled={false} lockedReason={null} />)
  const save = screen.getByRole('button', { name: '追加する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(save.hasAttribute('data-permission-locked')).toBe(false)
  expect(screen.getByRole('textbox', { name: 'フォルダ名' }).getAttribute('value')).toBe('入力は残す')
  expect(screen.queryByRole('tooltip')).toBeNull()
  await click(save)
  expect(api.folders.create).not.toHaveBeenCalled()
})

it.each([false, true])('保持した削除は描画ごとに異なる最新callback=%sを読む', async allowed => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  await menu('消す')
  rerender(<Rows canWriteNow={() => !allowed} />)
  const held = captures.confirm!.onConfirm!
  rerender(<Rows canWriteNow={() => allowed} />)
  await act(async () => held())
  expect(api.folders.delete).toHaveBeenCalledTimes(allowed ? 1 : 0)
  if (allowed) expect(api.folders.delete).toHaveBeenCalledWith('a', 'account-a', 1)
})

it.each([false, true])('保持した並べ替えは最新callback=%sを読む', async allowed => {
  const { rerender } = render(<Rows canWriteNow={() => !allowed} />)
  const held = captures.row!.onMoveDown!
  rerender(<Rows canWriteNow={() => allowed} />)
  await act(async () => held())
  expect(api.folders.swapOrder).toHaveBeenCalledTimes(allowed ? 1 : 0)
})

it('callbackが許可でも、保持した操作は最新enabled=falseで拒否する', async () => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  await menu('消す')
  const held = captures.confirm!.onConfirm!
  rerender(<Rows canWriteNow={() => true} enabled={false} lockedReason={null} />)
  await act(async () => held())
  expect(api.folders.delete).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toBeTruthy()
})

it.each(['add', 'edit'] as const)('保持した%sの保存確認は最新のcallbackを読む', async mode => {
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  await act(async () => mode === 'add' ? control.current!.startAdd() : control.current!.startEdit(folders[0]))
  const held = captures.editor!.canSaveNow!
  rerender(<Panel canWriteNow={() => false} />)
  expect(held()).toBe(false)
  rerender(<Panel canWriteNow={() => true} />)
  expect(held()).toBe(true)
})

it.each(['auto_reply', 'common_action', 'mileage_reward'])('%sの追加・編集は未保存の入力を確認してから閉じる', async kind => {
  render(<Panel kind={kind} canWriteNow={() => true} />)
  for (const mode of ['add', 'edit'] as const) {
    await act(async () => mode === 'add' ? control.current!.startAdd() : control.current!.startEdit(folders[0]))
    const input = screen.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '編集中の名前' } })
    await click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
    await click(screen.getByRole('button', { name: '編集を続ける' }))
    expect(input.value).toBe('編集中の名前')
    await click(screen.getByRole('button', { name: 'キャンセル' }))
    await click(screen.getByRole('button', { name: '破棄する' }))
    expect(screen.queryByRole('textbox', { name: 'フォルダ名' })).toBeNull()
  }
  expect(api.folders.create).not.toHaveBeenCalled()
  expect(api.folders.update).not.toHaveBeenCalled()
})

it.each(['auto_reply', 'common_action', 'mileage_reward'])('%sの行メニューからの編集も未保存の入力を守る', async kind => {
  render(<Rows kind={kind} canWriteNow={() => true} />)
  await menu('名前を変える')
  const input = screen.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: '変更した名前' } })
  await click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
  await click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(input.value).toBe('変更した名前')
  expect(api.folders.update).not.toHaveBeenCalled()
})

it('権限復帰だけでは書かず、明示的な再確認で削除は1回', async () => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  await menu('消す')
  rerender(<Rows canWriteNow={() => false} />)
  rerender(<Rows canWriteNow={() => true} />)
  expect(api.folders.delete).not.toHaveBeenCalled()
  await click(screen.getByRole('button', { name: '削除する' }))
  expect(api.folders.delete).toHaveBeenCalledExactlyOnceWith('a', 'account-a', 1)
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith('a')
  expect(onChanged).toHaveBeenCalledOnce()
})

it('read代理は許可callbackでも書込を拒み、フォルダの読取と選択は保つ', async () => {
  act(() => rememberSessionSnapshot({ impersonation: { id: 'proxy', tenantId: 'tenant', mode: 'read', piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' }))
  render(<ReadPanel />)
  await screen.findByRole('button', { name: 'フォルダa 2' })
  const add = screen.getByRole('button', { name: 'フォルダを追加' })
  expect(add.getAttribute('aria-disabled')).toBe('true')
  await click(add)
  expect(screen.queryByRole('dialog')).toBeNull()
  await click(screen.getByRole('button', { name: 'フォルダa 2' }))
  expect(api.folders.list).toHaveBeenCalledExactlyOnceWith('scenario', 'account-a')
  expect(onSelect).toHaveBeenCalledWith('a')
  expect(api.folders.create).not.toHaveBeenCalled()
  expect(api.folders.delete).not.toHaveBeenCalled()
})

it('account A→B→Aで保持した削除/並べ替えは復活しない', async () => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  const heldMove = captures.row!.onMoveDown!
  await menu('消す')
  const heldRemove = captures.confirm!.onConfirm!
  rerender(<Rows canWriteNow={() => true} accountId="account-b" />)
  rerender(<Rows canWriteNow={() => true} />)
  await act(async () => { heldMove(); heldRemove() })
  expect(api.folders.delete).not.toHaveBeenCalled()
  expect(api.folders.swapOrder).not.toHaveBeenCalled()
})

it('同じフォルダの窓を開き直しても古い確定は新しい窓を使わない', async () => {
  render(<Rows canWriteNow={() => true} />)
  await menu('消す')
  const held = captures.confirm!.onConfirm!
  await click(screen.getByRole('button', { name: 'キャンセル' }))
  await menu('消す')
  await act(async () => held())
  expect(api.folders.delete).not.toHaveBeenCalled()
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  await click(screen.getByRole('button', { name: '削除する' }))
  expect(api.folders.delete).toHaveBeenCalledOnce()
})

it('古い削除の応答とfinallyは別アカウントの新しい削除窓を閉じずbusyも解かない', async () => {
  const old = deferred<{ success: true; data: null }>(), next = deferred<{ success: true; data: null }>()
  vi.mocked(api.folders.delete).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  await menu('消す'); await click(screen.getByRole('button', { name: '削除する' }))
  rerender(<Rows canWriteNow={() => true} accountId="account-b" />)
  await menu('消す'); await click(screen.getByRole('button', { name: '削除する' }))
  await act(async () => old.resolve({ success: true, data: null }))
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: '処理中…' }).getAttribute('aria-busy')).toBe('true')
  expect(onChanged).not.toHaveBeenCalled()
  expect(onDeleted).not.toHaveBeenCalled()
  await act(async () => next.resolve({ success: true, data: null }))
  expect(api.folders.delete).toHaveBeenCalledTimes(2)
  expect(onDeleted).toHaveBeenCalledExactlyOnceWith('a')
  expect(onChanged).toHaveBeenCalledOnce()
})


it('保持した追加/編集/削除の入口も最新callback=falseで窓を開かない', async () => {
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  const held = control.current!
  rerender(<Panel canWriteNow={() => false} />)
  await act(async () => { held.startAdd(); held.startEdit(folders[0]); held.startDelete(folders[0]) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(api.folders.create).not.toHaveBeenCalled()
  expect(api.folders.update).not.toHaveBeenCalled()
  expect(api.folders.delete).not.toHaveBeenCalled()
})

it('追加窓の保持した保存も、callback=trueでも現在canManage=falseなら拒否する', async () => {
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  await act(async () => control.current!.startAdd())
  const held = captures.editor!.canSaveNow!
  rerender(<Panel canWriteNow={() => true} enabled={false} lockedReason={null} />)
  expect(held()).toBe(false)
})

it('開いた削除窓も本人未知なら理由なしdisabledで、窓とキャンセルは残す', async () => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  await menu('消す')
  verifiedStaffRole(null)
  rerender(<Rows canWriteNow={() => false} enabled={false} lockedReason={null} />)
  const save = screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(save.hasAttribute('data-permission-locked')).toBe(false)
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  await click(save)
  expect(api.folders.delete).not.toHaveBeenCalled()
  await click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
})


it.each(['add', 'delete'] as const)('アカウント切替のlayout時点で古い%s窓は既に無く、旧内容を新accountへ送らない', async mode => {
  const { rerender } = render(<Panel canWriteNow={() => true} />)
  await act(async () => mode === 'add' ? control.current!.startAdd() : control.current!.startDelete(folders[0]))
  let sawOldWindow: boolean | undefined
  captures.probe = () => {
    sawOldWindow = Boolean(document.querySelector('[role="dialog"],[role="alertdialog"]'))
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === (mode === 'add' ? '追加する' : '削除する'))
    if (button) fireEvent.click(button)
  }
  rerender(<Panel canWriteNow={() => true} accountId="account-b" />)
  expect(sawOldWindow).toBe(false)
  expect(api.folders.create).not.toHaveBeenCalled()
  expect(api.folders.delete).not.toHaveBeenCalled()
})

it('kindを替えて元へ戻しても旧入口/並べ替え/確定は復活しない', async () => {
  const { rerender } = render(<Rows canWriteNow={() => true} />)
  const heldRow = captures.row!
  await menu('消す')
  const heldConfirm = captures.confirm!.onConfirm!
  rerender(<Rows canWriteNow={() => true} kind="reminder" />)
  rerender(<Rows canWriteNow={() => true} />)
  await act(async () => { heldRow.onMoveDown!(); heldRow.onEdit!(); heldRow.onDelete!(); heldConfirm() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(api.folders.swapOrder).not.toHaveBeenCalled()
  expect(api.folders.delete).not.toHaveBeenCalled()
})
