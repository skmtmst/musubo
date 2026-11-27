// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActionList, { ActionRow, ActionAddButton, type ActionChoice } from './action-list'

type Item = { id: string; text: string }
const choices: ActionChoice<Item>[] = [
  { id: 'text', label: 'テキストを送る', make: () => ({ id: 'text', text: '' }) },
  { id: 'tag', label: 'タグを付ける', make: () => ({ id: 'tag', text: '' }), picker: {
    title: 'タグを選ぶ', multiple: true, items: [{ id: 't1', name: '予約' }, { id: 't2', name: '来店' }], apply: (item, ids) => ({ ...item, text: ids.join(',') }),
  } },
]
function Harness({ readOnly = false, initial = [], quickAddChoiceId }: { readOnly?: boolean; initial?: Item[]; quickAddChoiceId?: string }) {
  const [value, setValue] = useState(initial)
  return <><output data-testid="value">{JSON.stringify(value)}</output><ActionList value={value} onChange={setValue} choices={choices} readOnly={readOnly} quickAddChoiceId={quickAddChoiceId} idOf={item => item.id}
    titleOf={item => item.text || '未設定'} renderEditor={(item, update) => <input aria-label="本文" value={item.text} onChange={event => update({ ...item, text: event.target.value })} />} /></>
}
afterEach(cleanup)
const data = () => JSON.parse(screen.getByTestId('value').textContent!) as Item[]
const addMenu = () => fireEvent.click(screen.getByRole('button', { name: '行うことを足す' }))
describe('行うことの共通部品', () => {
  it('直接選ぶ入口も取消では追加せず、選択を確定してから追加する', () => {
    render(<Harness quickAddChoiceId="tag" />)
    fireEvent.click(screen.getByRole('button', { name: '共通アクションから選ぶ' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    expect(data()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '共通アクションから選ぶ' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '予約', exact: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
    expect(data()).toEqual([{ id: 'tag', text: 't1' }])
  })
  it('対象を確定するまで追加せず、取消でも入力を変えない', () => {
    render(<Harness />)
    addMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'タグを付ける' }))
    expect(data()).toEqual([])
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(data()).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('複数のタグを確定してから1つの行へ追加する', () => {
    render(<Harness />)
    addMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'タグを付ける' }))
    const dialog = screen.getByRole('dialog')
    const checks = within(dialog).getAllByRole('checkbox')
    fireEvent.click(checks.find(input => input.getAttribute('aria-label')?.includes('予約')) ?? checks[0])
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
    expect(data()).toHaveLength(1)
    expect(data()[0].text).toContain('t1')
  })
  it('選ぶ窓を開いたまま候補が切り替わっても、前の店舗の候補を残さない', () => {
    const onAdd = vi.fn()
    const choice = (id: string, name: string): ActionChoice<Item>[] => [{ id: 'tag', label: 'タグを付ける', make: () => ({ id: 'tag', text: '' }), picker: {
      title: 'タグを選ぶ', items: [{ id, name }], apply: (item, ids) => ({ ...item, text: ids[0] }),
    } }]
    const view = render(<ActionAddButton choices={choice('old', '前の店舗')} onAdd={onAdd} />)
    addMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'タグを付ける' }))
    expect(screen.getByRole('radio', { name: '前の店舗' })).toBeTruthy()
    view.rerender(<ActionAddButton choices={choice('new', '今の店舗')} onAdd={onAdd} />)
    expect(screen.queryByRole('radio', { name: '前の店舗' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '今の店舗' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '選択する' }))
    expect(onAdd).toHaveBeenCalledWith({ id: 'tag', text: 'new' })
  })
  it('テキストはその場で編集し、開く行は1つだけ', () => {
    render(<Harness initial={[{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    fireEvent.change(screen.getByRole('textbox', { name: '本文' }), { target: { value: 'A2' } })
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(screen.getAllByRole('textbox', { name: '本文' })).toHaveLength(1)
    expect(data()[0].text).toBe('A2')
  })
  it('上下キーとドラッグは同じ保存順にする', () => {
    for (const how of ['key', 'drag']) {
      cleanup()
      const { container } = render(<Harness initial={[{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]} />)
      const grip = screen.getByRole('button', { name: '1つ目の行うことを並べ替える' })
      if (how === 'key') fireEvent.keyDown(grip, { key: 'ArrowDown' })
      else { fireEvent.dragStart(grip); const row = container.querySelector('[data-reorder-id="b"]')!; fireEvent.dragEnter(row); fireEvent.dragOver(row); fireEvent.drop(row) }
      expect(data().map(item => item.id)).toEqual(['b', 'a'])
    }
  })
  it('削除は確かめてから行い、閲覧のみには操作を出さない', () => {
    const { rerender } = render(<Harness initial={[{ id: 'a', text: 'A' }]} />)
    fireEvent.click(screen.getByRole('button', { name: '1つ目の行うことのその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
    expect(data()).toHaveLength(1)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
    expect(data()).toHaveLength(1)
    rerender(<Harness readOnly initial={[{ id: 'a', text: 'A' }]} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('A')).toBeTruthy()
  })
})

it('Y1 名前と値は同じまとまりで読み、設定操作とメニューを両方保つ', () => {
 const toggle=vi.fn();const {container}=render(<ActionRow title="本人に知らせる" number={1} extra="成果1件ごとに" onToggle={toggle} onRemove={()=>{}} />);
 const name=container.querySelector('[data-action-name]')!,value=container.querySelector('[data-action-value]')!;
 expect(name.parentElement).toBe(value.parentElement);
 fireEvent.click(screen.getByRole('button',{name:'本人に知らせる'}));expect(toggle).toHaveBeenCalledTimes(1);
 expect(name.parentElement?.contains(screen.getByRole('button',{name:'1つ目の行うことのその他操作'}))).toBe(false);
 expect(value.textContent).toBe('成果1件ごとに');
});
