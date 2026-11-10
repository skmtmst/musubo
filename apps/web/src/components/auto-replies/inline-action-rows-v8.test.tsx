// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => true }) }))
vi.mock('@/components/scenarios/action-editor', () => ({
  ACTION_KINDS: [{ type: 'tag', label: 'タグ操作', make: () => ({ op: 'add', tagIds: [] }) }],
  ActionConfigEditor: (props: {templates?: {name:string}[];reminders?: {name:string}[];events?: {name:string}[]}) => <p>中身の編集 {JSON.stringify([props.templates,props.reminders,props.events])}</p>,
}))

import InlineActionRowsV8, { actionRowTitle } from './inline-action-rows-v8'
import type { InlineAction } from './draft-fields'

afterEach(cleanup)

const opts = { tags: [{ id: 't1', name: '予約' }], fields: [], marks: [{ id: 'm1', name: '予約変更' }], scenarios: [], vars: [], notificationRules: [{ id: 'r1', name: 'Demo Person', version: 1 }] }
const a = (over: Partial<InlineAction>): InlineAction => ({ key: 'k1', actionType: 'support_mark', config: { markId: 'm1' }, onFailure: 'continue', ...over })

describe('返したあとに行うこと（V8 の行）', () => {
  it('何をするか「どれを」を1行で出す', () => {
    expect(actionRowTitle(a({}), opts)).toBe('対応マークを付ける「予約変更」')
    expect(actionRowTitle(a({ actionType: 'notify_staff', config: { notificationRuleId: 'r1' } }), opts)).toBe('担当者へ知らせる「Demo Person」')
    expect(actionRowTitle(a({ actionType: 'tag', config: { op: 'remove', tagIds: ['t1'] } }), opts)).toBe('タグを外す「予約」')
  })

  it('失敗したらの動きを変えると、その行だけが変わる', () => {
    const onChange = vi.fn()
    render(<InlineActionRowsV8 actions={[a({}), a({ key: 'k2' })]} onChange={onChange} {...opts} />)
    fireEvent.click(screen.getAllByRole('button', { name: '対応マークを付ける「予約変更」' })[0])
    // 選ぶ欄は共通の Select（ボタン＋一覧）。開いて「ここで止める」を押す。
    fireEvent.click(screen.getByRole('button', { name: '1つ目の失敗したときの動き' }))
    fireEvent.click(screen.getByRole('button', { name: 'ここで止める' }))
    expect(onChange).toHaveBeenCalled()
    const next = onChange.mock.calls.at(-1)?.[0] as InlineAction[]
    expect(next[0].onFailure).toBe('stop')
    expect(next[1].onFailure).toBe('continue')
  })

  it('何も無いときは足し方を出す', () => {
    render(<InlineActionRowsV8 actions={[]} onChange={() => {}} {...opts} />)
    expect(screen.getByText('行うことはまだありません。')).toBeTruthy()
    expect(screen.getByRole('button', { name: /行うことを足す/ })).toBeTruthy()
  })
})

it('WEB-019：つまみはマウスと上下キーで同じ順へ動かせる', () => {
  const onChange = vi.fn()
  const actions = [a({}), a({ key: 'k2' })]
  const { container } = render(<InlineActionRowsV8 actions={actions} onChange={onChange} {...opts} />)
  const handle = screen.getByRole('button', { name: '1つ目の行うことを並べ替える' })
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(onChange).toHaveBeenLastCalledWith([actions[1], actions[0]])
  onChange.mockClear()
  fireEvent.dragStart(handle)
  const target = container.querySelector('[data-reorder-id="k2"]')!
  fireEvent.dragEnter(target)
  fireEvent.dragOver(target)
  fireEvent.drop(target)
  expect(onChange).toHaveBeenLastCalledWith([actions[1], actions[0]])
})

it('編集を開くと送信・リマインダ・イベントの候補が入る', () => {
  render(<InlineActionRowsV8 actions={[a({})]} onChange={()=>{}} {...opts} templates={[{id:'t',name:'案内'}]} reminders={[{id:'r',name:'翌日'}]} events={[{id:'e',name:'相談会'}]} />)
  fireEvent.click(screen.getByRole('button',{name:'対応マークを付ける「予約変更」'}))
  expect(screen.getByText(/中身の編集/).textContent).toContain('案内')
  expect(screen.getByText(/中身の編集/).textContent).toContain('翌日')
  expect(screen.getByText(/中身の編集/).textContent).toContain('相談会')
})
