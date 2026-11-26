// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
const held = vi.hoisted(() => ({ menus: new Map<string, () => unknown>(), buttons: new Map<string, () => unknown>(), single: null as null | ((id: string) => void), multi: null as null | ((ids: string[]) => void), remove: null as null | (() => unknown), edit: new Map<string, () => void>() }))
vi.mock('./button', async original => {
  const { default: Actual } = await original<typeof import('./button')>()
  return { default: (p: ComponentProps<typeof Actual>) => { if (p.onClick) held.buttons.set(p['aria-label'] || [p.children].flat().filter(v => typeof v === 'string' || typeof v === 'number').join(''), p.onClick as () => unknown); return <Actual {...p} /> } }
})
vi.mock('./action-menu', async original => {
  const { default: Actual, ...rest } = await original<typeof import('./action-menu')>()
  return { ...rest, default: (p: ComponentProps<typeof Actual>) => { for (const item of p.items) if (item.onSelect) held.menus.set(item.id, item.onSelect as () => unknown); return <Actual {...p} /> } }
})
vi.mock('./entity-picker', async original => {
  const actual = await original<typeof import('./entity-picker')>()
  return { ...actual, EntityPickerDialog: (p: ComponentProps<typeof actual.EntityPickerDialog>) => { held.single = p.onConfirm; return <actual.EntityPickerDialog {...p} /> }, EntityMultiPickerDialog: (p: ComponentProps<typeof actual.EntityMultiPickerDialog>) => { held.multi = p.onConfirm; return <actual.EntityMultiPickerDialog {...p} /> } }
})
vi.mock('./confirm-dialog', async original => {
  const { default: Actual, ...rest } = await original<typeof import('./confirm-dialog')>()
  return { ...rest, default: (p: ComponentProps<typeof Actual>) => { if (p.open) held.remove = p.onConfirm as () => unknown; return <Actual {...p} /> } }
})
import ActionList, { ActionAddButton, type ActionChoice } from './action-list'
import Button from './button'
import { EntityPickerDialog } from './entity-picker'
const reason = '閲覧のみのため行うことを変えられません。'
type Item = { id: string; text: string }
const items = [{ id: 'a', name: '候補A' }, { id: 'b', name: '候補B' }]
function choice(multiple = false) {
  const make = vi.fn(() => ({ id: 'pick', text: '' })); const apply = vi.fn((item: Item, ids: string[]) => ({ ...item, text: ids.join(',') }))
  return { make, apply, choices: [{ id: 'pick', label: '対象を選ぶ', make, picker: { title: '対象', items, multiple, apply } }] satisfies ActionChoice<Item>[] }
}
function list(p: Partial<ComponentProps<typeof ActionList<Item>>> = {}) {
  const defaults = { value: [{ id: 'a', text: '本文A' }, { id: 'b', text: '本文B' }], onChange: vi.fn(), choices: [] as ActionChoice<Item>[], idOf: (item: Item) => item.id, titleOf: (item: Item) => item.text }
  const props = { ...defaults, ...p }
  return { change: props.onChange, ui: <ActionList {...props} renderEditor={(item, update) => { held.edit.set(item.id, () => update({ ...item, text: '変更後' })); return <Button disabled={props.disabled || (!props.lockedReason && props.canChangeNow?.() === false)} lockedReason={props.lockedReason} onClick={held.edit.get(item.id)}>本文を直す</Button> }} /> }
}
const button = (name: string) => screen.getByRole('button', { name, exact: true }) as HTMLButtonElement
function openEditor() { fireEvent.click(screen.getByRole('button', { name: /本文A/ })) }
beforeEach(() => { held.menus.clear(); held.buttons.clear(); held.single = null; held.multi = null; held.remove = null; held.edit.clear() })
afterEach(cleanup)

it.each([false,true])('任意leaseは開いた候補を理由付きで残し、保持した親confirmもAPI0 multiple=%s', multiple => {
  const c = choice(multiple); const onAdd = vi.fn(); const view = render(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
  fireEvent.click(button('行うことを足す')); fireEvent.click(screen.getByRole(multiple ? 'checkbox' : 'radio', { name: '候補A', exact: true }))
  const confirm = multiple ? () => held.multi!(['a']) : () => held.single!('a'); const old = multiple ? held.multi! : held.single!
  view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('dialog')).toBeTruthy(); const target = button(multiple ? '選択する（1件）' : '選択する')
  expect(target.disabled).toBe(false); expect(target.matches(':disabled')).toBe(false); expect(target.tabIndex).toBe(0)
  fireEvent.focus(target); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  act(() => { if (multiple) (old as (ids: string[]) => void)(['a']); else (old as (id: string) => void)('a'); confirm() })
  expect(c.make).not.toHaveBeenCalled(); expect(c.apply).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('searchbox')).toBeTruthy()
})

it.each([false,true])('理由なしfalseも候補を保ち、古い許可と拒否の両方を復活させない multiple=%s', multiple => {
  const c = choice(multiple); const onAdd = vi.fn(); const view = render(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
  fireEvent.click(button('行うことを足す')); fireEvent.click(screen.getByRole(multiple ? 'checkbox' : 'radio', { name: '候補A', exact: true }))
  const oldYes = multiple ? held.multi! : held.single!
  view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => false} />); const oldNo = multiple ? held.multi! : held.single!
  expect(button(multiple ? '選択する（1件）' : '選択する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => { if (multiple) (oldYes as (ids: string[]) => void)(['a']); else (oldYes as (id: string) => void)('a') }); expect(onAdd).not.toHaveBeenCalled()
  view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
  act(() => { if (multiple) (oldNo as (ids: string[]) => void)(['a']); else (oldNo as (id: string) => void)('a') }); expect(onAdd).not.toHaveBeenCalled()
  fireEvent.click(button(multiple ? '選択する（1件）' : '選択する')); expect(onAdd).toHaveBeenCalledExactlyOnceWith({ id: 'pick', text: 'a' })
})

it('開いた種類menuも理由付きで残し、保持した選択はmakeもaddも0', () => {
  const make = vi.fn(() => ({ id: 'new', text: '新規' })); const onAdd = vi.fn(); const choices = [{ id: 'new', label: 'テキストを足す', make }]
  const view = render(<ActionAddButton choices={choices} onAdd={onAdd} canChangeNow={() => true} />)
  fireEvent.click(button('行うことを足す')); const old = held.menus.get('new')!
  view.rerender(<ActionAddButton choices={choices} onAdd={onAdd} canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('menu')).toBeTruthy(); expect(screen.getByRole('menuitem', { name: 'テキストを足す' }).getAttribute('aria-disabled')).toBe('true')
  act(() => old()); expect(make).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled()
})

it('再描画の前に失効しても、開く・種類を足す・候補の確定の各入口で書込0', () => {
  let allowed = true; const c = choice(); const onAdd = vi.fn()
  render(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => allowed} />)
  allowed = false; fireEvent.click(button('行うことを足す')); expect(screen.queryByRole('dialog')).toBeNull()
  allowed = true; fireEvent.click(button('行うことを足す')); const confirm = held.single!; allowed = false
  act(() => confirm('a')); expect(c.make).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy()
})

it.each(['inline','numbered'] as const)('読むeditorを残しfieldsetで理由を無効にせず、保持updateは0 appearance=%s', appearance => {
  const first = list({ appearance, canChangeNow: () => true }); const view = render(first.ui); openEditor(); const old = held.edit.get('a')!
  const denied = list({ appearance, onChange: first.change, canChangeNow: () => false, lockedReason: reason }); view.rerender(denied.ui)
  const edit = button('本文を直す'); expect(edit.closest('fieldset')).toBeNull(); expect(edit.matches(':disabled')).toBe(false); expect(edit.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(edit); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  act(() => old()); expect(first.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
})

it('unknown editorも閉じず、読む開閉を残して古い拒否の更新は通さない', () => {
  const p = list({ canChangeNow: () => true }); const view = render(p.ui); openEditor(); const oldYes = held.edit.get('a')!
  view.rerender(list({ onChange: p.change, canChangeNow: () => false }).ui); const oldNo = held.edit.get('a')!
  expect(button('本文を直す').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull(); act(() => oldYes()); expect(p.change).not.toHaveBeenCalled()
  view.rerender(list({ onChange: p.change, canChangeNow: () => true }).ui); act(() => oldNo()); expect(p.change).not.toHaveBeenCalled()
  fireEvent.click(button('本文を直す')); expect(p.change).toHaveBeenCalledOnce()
})

it('並べ替えの直前に失効しても保存0と読むeditorを保つ', () => {
  let allowed = true; const p = list({ canChangeNow: () => allowed }); render(p.ui); openEditor(); allowed = false
  fireEvent.keyDown(button('1つ目の行うことを並べ替える'), { key: 'ArrowDown' })
  expect(p.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
})

it('複製の保持handlerもtransformする前で拒み、読むeditorを残す', () => {
  let allowed = true; const duplicate = vi.fn((item: Item) => ({ ...item, id: 'copy' })); const p = list({ value: [{ id: 'a', text: '本文A' }], duplicateOf: duplicate, canChangeNow: () => allowed }); render(p.ui); openEditor(); const old = held.menus.get('duplicate')!
  allowed = false; act(() => old()); expect(duplicate).not.toHaveBeenCalled(); expect(p.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
})

it.each(['inline','numbered'] as const)('削除確認の保持handlerはcaller leaseも見て、保存0/読むeditor維持 appearance=%s', appearance => {
  let allowed = true; const p = list({ appearance, value: [{ id: 'a', text: '本文A' }], canChangeNow: () => allowed }); render(p.ui); openEditor()
  if (appearance === 'inline') { fireEvent.click(button('1つ目の行うことのその他操作')); fireEvent.click(screen.getByRole('menuitem', { name: '削除する' })) }
  else fireEvent.click(button('1つ目の処理を削除する'))
  expect(screen.getByRole('dialog')).toBeTruthy(); const confirm = held.remove!; allowed = false; act(() => confirm())
  expect(p.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
})

it.each(['up','down'] as const)('番号の上下操作も直前に失効するとeditorと保存値を保つ direction=%s', direction => {
  let allowed = true; const p = list({ appearance: 'numbered', canChangeNow: () => allowed }); render(p.ui); openEditor(); allowed = false
  fireEvent.click(button(direction === 'down' ? '1つ目の処理を下へ' : '2つ目の処理を上へ'))
  expect(p.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
})

it('custom pickerにも理由/未知/leaseの任意contextを渡し、GET/プレビューを残せる', () => {
  const c = choice(); const onAdd = vi.fn(); const cancel = vi.fn()
  const choices: ActionChoice<Item>[] = [{ ...c.choices[0], picker: { ...c.choices[0].picker!, render: ({ onConfirm, onCancel, permission }) => <EntityPickerDialog title="custom対象" items={items} initialId="a" onConfirm={id => onConfirm([id])} onCancel={() => { cancel(); onCancel() }} confirmDisabled={permission?.disabled} confirmLockedReason={permission?.lockedReason} canChangeNow={permission?.canChangeNow} preview={item => <p>読む：{item?.name}</p>} /> } }]
  const view = render(<ActionAddButton direct choices={choices} onAdd={onAdd} canChangeNow={() => true} />); fireEvent.click(button('行うことを足す')); const old = held.single!
  view.rerender(<ActionAddButton direct choices={choices} onAdd={onAdd} canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(button('選択する').getAttribute('aria-disabled')).toBe('true'); fireEvent.click(screen.getByRole('radio', { name: '候補B', exact: true })); expect(screen.getByText('読む：候補B')).toBeTruthy()
  act(() => old('a')); expect(onAdd).not.toHaveBeenCalled(); fireEvent.click(button('キャンセル')); expect(cancel).toHaveBeenCalledOnce()
})

it('種類menuの保持handlerは描画前の失効でも作る前に拒み、読むmenuを残す', () => {
  let allowed = true; const make = vi.fn(() => ({ id: 'new', text: '新規' })); const onAdd = vi.fn()
  render(<ActionAddButton choices={[{ id: 'new', label: 'テキストを足す', make }]} onAdd={onAdd} canChangeNow={() => allowed} />)
  fireEvent.click(button('行うことを足す')); const old = held.menus.get('new')!; allowed = false
  act(() => old()); expect(make).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.getByRole('menu')).toBeTruthy()
})

it('許可された最新の直接追加と本文更新は各1回', () => {
  const make = vi.fn(() => ({ id: 'new', text: '新規' })); const onAdd = vi.fn()
  const view = render(<ActionAddButton direct choices={[{ id: 'new', label: 'テキスト', make }]} onAdd={onAdd} canChangeNow={() => true} />)
  fireEvent.click(button('行うことを足す')); expect(make).toHaveBeenCalledOnce(); expect(onAdd).toHaveBeenCalledExactlyOnceWith({ id: 'new', text: '新規' }); view.unmount()
  const p = list({ canChangeNow: () => true }); render(p.ui); openEditor(); fireEvent.click(button('本文を直す'))
  expect(p.change).toHaveBeenCalledExactlyOnceWith([{ id: 'a', text: '変更後' }, { id: 'b', text: '本文B' }])
})

it.each(['inline','numbered'] as const)('初めから拒否でも読むeditorの開閉は保つ appearance=%s', appearance => {
  const p = list({ appearance, canChangeNow: () => false, lockedReason: reason }); render(p.ui)
  openEditor(); expect(button('本文を直す').getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button('本文を直す')); expect(p.change).not.toHaveBeenCalled()
  openEditor(); expect(screen.queryByRole('button', { name: '本文を直す' })).toBeNull()
})

it.each(['add', 'editor'] as const)('新しいcallbackが描画後に失効したら、前の描画のhandlerも0 surface=%s', surface => {
  let latestAllowed = true
  if (surface === 'add') {
    const c = choice(); const onAdd = vi.fn(); const view = render(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
    fireEvent.click(button('行うことを足す')); fireEvent.click(screen.getByRole('radio', { name: '候補A', exact: true })); const old = held.single!
    view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => latestAllowed} />); latestAllowed = false
    act(() => old('a')); expect(c.make).not.toHaveBeenCalled(); expect(c.apply).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy()
  } else {
    const p = list({ canChangeNow: () => true }); const view = render(p.ui); openEditor(); const old = held.edit.get('a')!
    view.rerender(list({ onChange: p.change, canChangeNow: () => latestAllowed }).ui); latestAllowed = false
    act(() => old()); expect(p.change).not.toHaveBeenCalled(); expect(button('本文を直す')).toBeTruthy()
  }
})

it.each(['add', 'editor'] as const)('理由付きの描画で保持したhandlerは、理由が外れても復活しない surface=%s', surface => {
  if (surface === 'add') {
    const c = choice(); const onAdd = vi.fn(); const view = render(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
    fireEvent.click(button('行うことを足す')); fireEvent.click(screen.getByRole('radio', { name: '候補A', exact: true }))
    view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} lockedReason={reason} />); const old = held.single!
    view.rerender(<ActionAddButton direct choices={c.choices} onAdd={onAdd} canChangeNow={() => true} />)
    act(() => old('a')); expect(c.make).not.toHaveBeenCalled(); expect(c.apply).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(button('選択する')); expect(onAdd).toHaveBeenCalledOnce()
  } else {
    const p = list({ canChangeNow: () => true, lockedReason: reason }); const view = render(p.ui); openEditor(); const old = held.edit.get('a')!
    view.rerender(list({ onChange: p.change, canChangeNow: () => true }).ui)
    act(() => old()); expect(p.change).not.toHaveBeenCalled(); fireEvent.click(button('本文を直す')); expect(p.change).toHaveBeenCalledOnce()
  }
})

it('未知になった種類menuは開いたまま普通のdisabled、permission印と理由なし、書込0', () => {
  const make = vi.fn(() => ({ id: 'new', text: '新規' })); const onAdd = vi.fn(); const choices = [{ id: 'new', label: 'テキストを足す', make }]
  const view = render(<ActionAddButton choices={choices} onAdd={onAdd} canChangeNow={() => true} />); fireEvent.click(button('行うことを足す'))
  view.rerender(<ActionAddButton choices={choices} onAdd={onAdd} canChangeNow={() => false} />)
  const item = screen.getByRole('menuitem', { name: 'テキストを足す' }) as HTMLButtonElement
  expect(item.disabled).toBe(true); expect(item.matches(':disabled')).toBe(true); expect(item.hasAttribute('data-permission-locked')).toBe(false); expect(item.hasAttribute('aria-describedby')).toBe(false)
  fireEvent.click(item); act(() => held.menus.get('new')!()); expect(make).not.toHaveBeenCalled(); expect(onAdd).not.toHaveBeenCalled(); expect(screen.queryByRole('tooltip')).toBeNull(); expect(screen.getByRole('menu')).toBeTruthy()
})
