// @vitest-environment happy-dom
import type { DependencyList, EffectCallback } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelectCreateContext } from './select-types'

// 二重の守りを個別に検証する。通常経路はselect-permission.test.tsxが実物で守る。
// UI側だけ迂回するとFieldのhandlerが単独で残る。
// 閉じるeffectだけ保留すると、実在する窓の確定handlerが単独で残る。
const fault = vi.hoisted(() => ({ bypassTipHandlers: false, holdEffects: false }))
vi.mock('react', async load => {
  const actual = await load<typeof import('react')>()
  return { ...actual, useEffect: (effect: EffectCallback, deps?: DependencyList) => actual.useEffect(fault.holdEffects ? () => {} : effect, deps) }
})
vi.mock('./permission-lock-tip', async load => {
  const actual = await load<typeof import('./permission-lock-tip')>()
  return { ...actual, usePermissionLockTip: <T extends HTMLElement,>(reason: string | null | undefined, description?: string) => {
    const lock = actual.usePermissionLockTip<T>(reason, description)
    return fault.bypassTipHandlers ? { ...lock, handlers: undefined } : lock
  } }
})
import Select from './select'
import { EntityPickerField, EntityPickerSummary } from './entity-picker'

const reason = '閲覧のみのため変更できません'
const items = [{ id: 'a', name: '現在の物' }, { id: 'b', name: '別の物' }]
const options = items.map(item => ({ value: item.id, label: item.name }))
beforeEach(() => { fault.bypassTipHandlers = false; fault.holdEffects = false })
afterEach(() => { cleanup(); fault.bypassTipHandlers = false; fault.holdEffects = false })
function holdClosing(update: () => void) {
  fault.holdEffects = true
  try { update() } finally { fault.holdEffects = false }
}

describe('UIの拒否だけを迂回したFieldの守り', () => {
  it('開くhandler自体が、権限のない選択窓を開かない', () => {
    fault.bypassTipHandlers = true
    render(<EntityPickerField label="物" noun="物" value="a" items={items} onChange={vi.fn()} lockedReason={reason} />)
    fireEvent.click(screen.getByRole('button', { name: '物：変更する' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('外すhandler自体が、値を消さない', () => {
    fault.bypassTipHandlers = true
    const change = vi.fn()
    render(<EntityPickerField label="物" noun="物" value="a" items={items} onChange={change} clearable lockedReason={reason} />)
    fireEvent.click(screen.getByRole('button', { name: '物を外す' }))
    expect(change).not.toHaveBeenCalled()
  })
  it('札の外すhandler自体が、値を消さない', () => {
    fault.bypassTipHandlers = true
    const change = vi.fn()
    render(<EntityPickerField label="物" noun="物" multiple value={['a']} items={items} onChange={change} lockedReason={reason} />)
    fireEvent.click(screen.getByRole('button', { name: '現在の物を外す' }))
    expect(change).not.toHaveBeenCalled()
  })
})

it('Summaryの開く・外すUIは、Fieldの守りがなくても理由付きで拒む', () => {
  const open = vi.fn(), clear = vi.fn()
  render(<EntityPickerSummary label="物" noun="物" name="現在の物" onOpen={open} onClear={clear} lockedReason={reason} />)
  fireEvent.click(screen.getByRole('button', { name: '物：変更する' }))
  fireEvent.click(screen.getByRole('button', { name: '物を外す' }))
  expect(open).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
})

describe('閉じるeffectを保留した実在する窓の守り', () => {
  it('Selectのchooseが候補の確定を止める', () => {
    const change = vi.fn()
    const view = render(<Select aria-label="物" value="a" options={options} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: '物' }))
    holdClosing(() => view.rerender(<Select aria-label="物" value="a" options={options} onChange={change} lockedReason={reason} />))
    const choice = within(screen.getByRole('option', { name: '別の物' })).getByRole('button')
    expect(choice.isConnected).toBe(true)
    fireEvent.click(choice)
    expect(change).not.toHaveBeenCalled()
  })
  it('SelectのstartCreateが作成画面のマウントを止める', () => {
    const createAction = { label: '新しく作る', render: () => <span>新しい作成画面</span> }
    const props = { 'aria-label': '物', value: 'a', options, onChange: vi.fn(), createAction }
    const view = render(<Select {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '物' }))
    holdClosing(() => view.rerender(<Select {...props} lockedReason={reason} />))
    fireEvent.click(screen.getByText('新しく作る'))
    expect(screen.queryByText('新しい作成画面')).toBeNull()
  })
  it('Selectのfinishはsessionが同じままでも作成完了を反映しない', () => {
    let context: SelectCreateContext | undefined
    const change = vi.fn()
    const createAction = { label: '新しく作る', render: (value: SelectCreateContext) => { context = value; return <span>作成画面</span> } }
    const props = { 'aria-label': '物', value: 'a', options, onChange: change, createAction }
    const view = render(<Select {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '物' }))
    fireEvent.click(screen.getByText('新しく作る'))
    holdClosing(() => view.rerender(<Select {...props} lockedReason={reason} />))
    expect(screen.getByText('作成画面').isConnected).toBe(true)
    act(() => context!.finish('created'))
    expect(change).not.toHaveBeenCalled()
  })
  it.each([false, true])('EntityPicker multiple=%sは実在する確定ボタンを押しても保存しない', async multiple => {
    const change = vi.fn()
    const Single = ({ lockedReason }: { lockedReason?: string }) => <EntityPickerField label="物" noun="物" value="a" items={items} onChange={change} lockedReason={lockedReason} />
    const Multi = ({ lockedReason }: { lockedReason?: string }) => <EntityPickerField label="物" noun="物" multiple value={['a']} items={items} onChange={change} lockedReason={lockedReason} />
    const Field = multiple ? Multi : Single
    const view = render(<Field />)
    fireEvent.click(screen.getByRole('button', { name: '物：変更する' }))
    const dialog = await screen.findByRole('dialog')
    holdClosing(() => view.rerender(<Field lockedReason={reason} />))
    expect(screen.getByRole('dialog')).toBe(dialog)
    const confirm = within(dialog).getByRole('button', { name: /^選択する/ }) as HTMLButtonElement
    expect(confirm.isConnected).toBe(true)
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(change).not.toHaveBeenCalled()
  })
  it('単一の作成handlerは、開いた窓からの作成を止める', async () => {
    const create = vi.fn()
    const props = { label: '物', noun: '物', value: 'a', items, onChange: vi.fn(), createAction: { label: () => 'この名前で作る', onCreate: create } }
    const view = render(<EntityPickerField {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '物：変更する' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '新しい物' } })
    await within(dialog).findByRole('button', { name: 'この名前で作る' })
    holdClosing(() => view.rerender(<EntityPickerField {...props} lockedReason={reason} />))
    fireEvent.click(within(dialog).getByRole('button', { name: 'この名前で作る' }))
    expect(create).not.toHaveBeenCalled()
  })
  it('複数の作成handlerも、開いた作成欄からの作成を止める', async () => {
    const create = vi.fn(async () => ({ id: 'created', name: '新しい物' }))
    const props = { label: '物', noun: '物', value: ['a'], items, onChange: vi.fn(), multiple: true as const, headerCreate: { label: '新しく作る', onCreate: create } }
    const view = render(<EntityPickerField {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '物：変更する' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '新しく作る' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '新しい名前' }), { target: { value: '新しい物' } })
    holdClosing(() => view.rerender(<EntityPickerField {...props} lockedReason={reason} />))
    const button = within(dialog).getByRole('button', { name: '作る' })
    expect(button.isConnected).toBe(true)
    await act(async () => fireEvent.click(button))
    expect(create).not.toHaveBeenCalled()
  })
})
