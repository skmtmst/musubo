// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Select from './select'
import EntitySelect from './entity-select'
import { EntityPickerField, EntityPickerSummary } from './entity-picker'
import type { SelectCreateContext } from './select-types'

const reason = '閲覧のみのため変更できません'
const options = [{ value: 'a', label: '移行元' }, { value: 'b', label: '移行先' }]
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function expectLocked(button: HTMLElement) {
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('data-permission-locked')).toBe(true)
  expect(button.tabIndex).toBe(0)
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
}

describe('選ぶ欄の権限理由', () => {
  it('Selectは選べる時の操作を保ち、拒否時は候補を開かず理由へ届く', () => {
    const change = vi.fn()
    const view = render(<Select aria-label="引き継ぎ方" value="a" options={options} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: '引き継ぎ方' }))
    fireEvent.click(within(screen.getByRole('option', { name: '移行先' })).getByRole('button'))
    expect(change).toHaveBeenCalledWith('b')
    view.rerender(<Select aria-label="引き継ぎ方" value="a" options={options} onChange={change} disabled lockedReason={reason} />)
    const trigger = screen.getByRole('button', { name: '引き継ぎ方' })
    expectLocked(trigger)
    fireEvent.click(trigger); fireEvent.keyDown(trigger, { key: 'ArrowDown' }); fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('Selectで開いてから権限が変わると閉じ、保持された作成完了でも値を変えない', () => {
    let context: SelectCreateContext | undefined
    const change = vi.fn()
    const createAction = { label: '新しく作る', render: (value: SelectCreateContext) => { context = value; return <span>作成欄</span> } }
    const view = render(<Select aria-label="選ぶ物" value="a" options={options} onChange={change} createAction={createAction} />)
    fireEvent.click(screen.getByRole('button', { name: '選ぶ物' }))
    fireEvent.click(screen.getByText('新しく作る'))
    expect(context).toBeDefined()
    view.rerender(<Select aria-label="選ぶ物" value="a" options={options} onChange={change} createAction={createAction} lockedReason={reason} />)
    context!.finish('created')
    expect(screen.queryByText('作成欄')).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })

  it('EntitySelectは新しい口を渡し、選ぶ・消すを拒む。解除後は通常通りに消せる', () => {
    const change = vi.fn()
    const view = render(<EntitySelect aria-label="アカウント" value="a" options={options} onChange={change} clearable lockedReason={reason} />)
    const trigger = screen.getByRole('button', { name: 'アカウント' })
    expectLocked(trigger)
    fireEvent.click(trigger)
    const clear = screen.getByRole('button', { name: 'アカウントを外す' })
    fireEvent.blur(trigger)
    expectLocked(clear)
    expect(clear.closest('[data-disabled]')).toBeTruthy()
    fireEvent.click(clear)
    expect(change).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<EntitySelect aria-label="アカウント" value="a" options={options} onChange={change} clearable />)
    fireEvent.click(screen.getByRole('button', { name: 'アカウントを外す' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('')
  })

  it('EntitySelectで開いた窓は権限の変更で閉じ、確定しない', async () => {
    const change = vi.fn()
    const view = render(<EntitySelect aria-label="アカウント" value="a" options={options} onChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'アカウント' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: '移行先' }))
    const confirm = within(dialog).getByRole('button', { name: '選択する' })
    view.rerender(<EntitySelect aria-label="アカウント" value="a" options={options} onChange={change} lockedReason={reason} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(confirm)
    expect(change).not.toHaveBeenCalled()
  })

  it('理由の追加でも既存の説明とbuttonRefを保つ', () => {
    const ref = createRef<HTMLButtonElement>(), open = vi.fn()
    render(<><span id="help">元の説明</span><EntityPickerSummary label="物" noun="物" name="選択済み" onOpen={open} buttonRef={ref} describedBy="help" lockedReason={reason} /></>)
    const trigger = screen.getByRole('button', { name: '物：変更する' })
    expect(ref.current).toBe(trigger)
    expect(trigger.getAttribute('aria-describedby')!.split(' ')).toContain('help')
    expectLocked(trigger)
    fireEvent.click(trigger)
    expect(open).not.toHaveBeenCalled()
  })

  it('readOnlyの見る窓は権限理由で止めず、書込の確定は残さない', async () => {
    const change = vi.fn(), open = vi.fn(), preview = vi.fn()
    render(<EntityPickerField label="物" noun="物" value="a" items={[{ id: 'a', name: '現在の物' }, { id: 'b', name: '別の物' }]} readOnly onOpen={open} onSelect={preview} onChange={change} lockedReason={reason} />)
    fireEvent.click(screen.getByRole('button', { name: '物：見る' }))
    const dialog = await screen.findByRole('dialog')
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('radio', { name: '別の物' }))
    expect(preview).toHaveBeenCalledExactlyOnceWith('b')
    expect(within(dialog).queryByRole('button', { name: '選択する' })).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })

  it('複数選択の札の×も残して理由で拒否し、解除後の削除は1回に保つ', () => {
    const change = vi.fn()
    const props = { label: '物', noun: '物', items: [{ id: 'a', name: '現在の物' }], value: ['a'], multiple: true as const, onChange: change }
    const view = render(<EntityPickerField {...props} disabled lockedReason={reason} />)
    const remove = screen.getByRole('button', { name: '現在の物を外す' })
    expectLocked(remove)
    fireEvent.click(remove)
    expect(change).not.toHaveBeenCalled()
    view.rerender(<EntityPickerField {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '現在の物を外す' }))
    expect(change).toHaveBeenCalledExactlyOnceWith([])
  })

  it('readOnlyの窓は、開いた後に権限理由が付いても残り、読取の候補切替は続けられる', async () => {
    const change = vi.fn(), preview = vi.fn()
    const props = { label: '物', noun: '物', value: 'a', items: [{ id: 'a', name: '現在の物' }, { id: 'b', name: '別の物' }], readOnly: true, onChange: change, onSelect: preview }
    const view = render(<EntityPickerField {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '物：見る' }))
    const dialog = await screen.findByRole('dialog')
    view.rerender(<EntityPickerField {...props} lockedReason={reason} />)
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(dialog.isConnected).toBe(true)
    fireEvent.click(within(dialog).getByRole('radio', { name: '別の物' }))
    expect(preview).toHaveBeenCalledExactlyOnceWith('b')
    expect(change).not.toHaveBeenCalled()
  })

  it('印だけのSelectも同じ理由で焦点へ届き、候補を開かない', () => {
    const change = vi.fn()
    render(<Select aria-label="並び方" value="a" options={options} iconOnly lockedReason={reason} onChange={change} />)
    const trigger = screen.getByRole('button', { name: '並び方' })
    expectLocked(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })

  it('状態disabledに権限印を足さず、選択・クリアは普通disabledのまま', () => {
    const { container } = render(<EntitySelect aria-label="アカウント" value="a" options={options} onChange={vi.fn()} clearable disabled />)
    expect(screen.getByRole('button', { name: 'アカウント' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'アカウントを外す' }).hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('[data-permission-locked]')).toBeNull()
  })
})
