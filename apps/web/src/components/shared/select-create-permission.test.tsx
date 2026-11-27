// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SelectCreateContext } from './select-types'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
const held = vi.hoisted(() => ({ start: undefined as undefined | (() => void) }))
// Render the real row; also keep the parent's callback to simulate an already queued event.
vi.mock('./select-menu', async original => {
  const actual = await original<typeof import('./select-menu')>()
  return { ...actual, SelectMenuAction: (props: React.ComponentProps<typeof actual.SelectMenuAction>) => {
    held.start = props.onSelect
    return <actual.SelectMenuAction {...props} />
  } }
})
import FolderSelect from './folder-select'
import Select from './select'
import { SelectMenuAction } from './select-menu'
const reason = 'フォルダを作る操作はオーナーか管理者に頼んでください。'
const folders = [{ value: 'a', label: '現在の分類' }, { value: 'b', label: '別の分類' }]
const options = folders
const create = () => screen.getByRole('button', { name: '新しいフォルダを作る' }) as HTMLButtonElement
const open = () => fireEvent.click(screen.getByRole('button', { name: '分類' }))
afterEach(cleanup)

it('作成口未指定と明示undefinedはDOM/Tab/候補選択/作成を変えない', async () => {
  const change = vi.fn(), onCreate = vi.fn(async () => ({ value: 'new', label: '追加した分類' }))
  const props = { folders, value: 'a', onChange: change, onCreate, 'aria-label': '分類' }
  const view = render(<FolderSelect {...props} />)
  const closed = view.container.innerHTML
  view.rerender(<FolderSelect {...props} createDisabled={undefined} createLockedReason={undefined} />)
  expect(view.container.innerHTML).toBe(closed)
  open()
  const row = create(), html = row.outerHTML
  expect(row.tabIndex).toBe(0); expect(row.disabled).toBe(false)
  view.rerender(<FolderSelect {...props} />)
  expect(create().outerHTML).toBe(html)
  expect(create().hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(create())
  fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '追加' } })
  fireEvent.click(screen.getByRole('button', { name: '作って選択する' }))
  await act(async () => { await Promise.resolve() })
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(change).toHaveBeenCalledExactlyOnceWith('new')
})

it('＋行だけが灰色/Tab可/理由1つになり、既存の候補は選べる', () => {
  const change = vi.fn(), onCreate = vi.fn()
  render(<FolderSelect folders={folders} value="a" onChange={change} onCreate={onCreate} aria-label="分類" createLockedReason={reason} />)
  const trigger = screen.getByRole('button', { name: '分類' }) as HTMLButtonElement
  expect(trigger.disabled).toBe(false); expect(trigger.hasAttribute('data-permission-locked')).toBe(false)
  open()
  const row = create()
  expect(row.disabled).toBe(false); expect(row.tabIndex).toBe(0)
  expect(row.getAttribute('aria-disabled')).toBe('true')
  expect(row.hasAttribute('data-permission-locked')).toBe(true)
  fireEvent.focus(row)
  expect(screen.getAllByRole('tooltip')).toHaveLength(1)
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.click(row); fireEvent.keyDown(row, { key: 'Enter' }); fireEvent.keyDown(row, { key: ' ' })
  expect(screen.queryByRole('textbox', { name: '新しいフォルダの名前' })).toBeNull()
  expect(onCreate).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('option', { name: '別の分類' })).getByRole('button'))
  expect(change).toHaveBeenCalledExactlyOnceWith('b')
})

it('＋行の理由をhover/touchでも共通の吹き出し1つで伝える', () => {
  render(<FolderSelect folders={folders} value="a" onChange={vi.fn()} onCreate={vi.fn()} aria-label="分類" createLockedReason={reason} />)
  open(); const row = create()
  fireEvent.pointerEnter(row, { pointerType: 'mouse' })
  expect(screen.getAllByRole('tooltip')).toHaveLength(1)
  fireEvent.pointerLeave(row, { pointerType: 'mouse' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.pointerDown(row, { pointerType: 'touch' })
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
})

it('本人未知の＋行は理由なしnative disabled。候補の選択は維持する', () => {
  const change = vi.fn()
  render(<FolderSelect folders={folders} value="a" onChange={change} onCreate={vi.fn()} aria-label="分類" createDisabled />)
  open(); const row = create()
  expect(row.disabled).toBe(true)
  expect(row.hasAttribute('data-permission-locked')).toBe(false)
  expect(row.hasAttribute('aria-describedby')).toBe(false)
  fireEvent.click(row)
  expect(screen.queryByRole('textbox', { name: '新しいフォルダの名前' })).toBeNull()
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(within(screen.getByRole('option', { name: '別の分類' })).getByRole('button'))
  expect(change).toHaveBeenCalledExactlyOnceWith('b')
})

it.each(['Enter', ' '])('欄の矢印から＋行を%sしても作成せず、行に焦点と理由を出す', key => {
  render(<FolderSelect folders={folders} unfiled={null} value="b" onChange={vi.fn()} onCreate={vi.fn()} aria-label="分類" createLockedReason={reason} />)
  const trigger = screen.getByRole('button', { name: '分類' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key })
  expect(document.activeElement).toBe(create())
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  expect(screen.queryByRole('textbox', { name: '新しいフォルダの名前' })).toBeNull()
})

it.each(['reason', 'disabled'] as const)('保持startは新しい%sを参照し、作成画面をマウントしない', kind => {
  const action = { label: '新しく作る', render: () => <span>作成画面</span> }
  const props = { 'aria-label': '分類', value: 'a', options, onChange: vi.fn() }
  const view = render(<Select {...props} createAction={action} />)
  open(); const old = held.start
  expect(old).toBeTypeOf('function')
  view.rerender(<Select {...props} createAction={{ ...action, ...(kind === 'reason' ? { lockedReason: reason } : { disabled: true }) }} />)
  act(() => old!())
  expect(screen.queryByText('作成画面')).toBeNull()
  expect(screen.getByRole('listbox')).toBeTruthy()
})

it.each(['reason', 'disabled'] as const)('開いていた作成窓は%s後も残り、古いfinishは許可復帰後も使えない', kind => {
  let context: SelectCreateContext | undefined
  const change = vi.fn()
  const action = { label: '新しく作る', render: (value: SelectCreateContext) => { context = value; return <span>作成画面</span> } }
  const props = { 'aria-label': '分類', value: 'a', options, onChange: change }
  const view = render(<Select {...props} createAction={action} />)
  open(); fireEvent.click(screen.getByRole('button', { name: '新しく作る' }))
  const old = context!
  view.rerender(<Select {...props} createAction={{ ...action, ...(kind === 'reason' ? { lockedReason: reason } : { disabled: true }) }} />)
  expect(screen.getByText('作成画面')).toBeTruthy()
  act(() => { old.finish('new'); context!.finish('new') })
  expect(change).not.toHaveBeenCalled()
  view.rerender(<Select {...props} createAction={action} />)
  act(() => old.finish('old'))
  expect(change).not.toHaveBeenCalled()
  act(() => context!.finish('explicit-new'))
  expect(change).toHaveBeenCalledExactlyOnceWith('explicit-new')
})

it('理由なし/禁止なしの行は従来のマウス操作とhoverを維持する', () => {
  const select = vi.fn(), hover = vi.fn()
  const view = render(<SelectMenuAction label="新しく作る" onSelect={select} onHover={hover} />)
  const row = screen.getByRole('button', { name: '新しく作る' })
  const original = row.outerHTML
  expect(row.getAttributeNames().sort()).toEqual(['class', 'data-select-menu-action', 'type'])
  view.rerender(<SelectMenuAction label="新しく作る" onSelect={select} onHover={hover} disabled={undefined} lockedReason={undefined} />)
  expect(row.outerHTML).toBe(original)
  fireEvent.mouseEnter(row); fireEvent.click(row)
  expect(hover).toHaveBeenCalledTimes(1)
  expect(select).toHaveBeenCalledTimes(1)
})

it('＋行の単独buttonもclick/Enter/Spaceで実行せず、理由は状態disabledより優先する', () => {
  const select = vi.fn()
  render(<SelectMenuAction label="新しく作る" onSelect={select} disabled lockedReason={reason} />)
  const row = screen.getByRole('button', { name: '新しく作る' }) as HTMLButtonElement
  expect(row.disabled).toBe(false)
  expect(row.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(row)
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.click(row)
  expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(false)
  expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false)
  expect(select).not.toHaveBeenCalled()
})


it('欄の次に別の欄があっても、＋行の理由がある時だけTabで行へ渡す', () => {
  const props = { folders, value: 'a', onChange: vi.fn(), onCreate: vi.fn(), 'aria-label': '分類' }
  const view = render(<><FolderSelect {...props} /><button>次の欄</button></>)
  const trigger = screen.getByRole('button', { name: '分類' })
  open()
  expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  view.rerender(<><FolderSelect {...props} createLockedReason={reason} /><button>次の欄</button></>)
  expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
  expect(document.activeElement).toBe(create())
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  expect(fireEvent.keyDown(create(), { key: 'Tab' })).toBe(true)
  expect(fireEvent.keyDown(create(), { key: 'Tab', shiftKey: true })).toBe(true)
  expect(fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true })).toBe(true)
})
