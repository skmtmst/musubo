
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import InlineActionList from './inline-action-list'
import type { InlineAction } from './draft-fields'
// @vitest-environment happy-dom
/**
 * 監査 R255：必須内容が空の後続処理を未完成と示さず保存できる。
 *
 * 行ごとに不足内容の札が出て、埋めたら消える。下書き保存は止めない。
 */

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ enabled: () => true }),
}))

afterEach(() => cleanup())

const EMPTY: Array<{ type: InlineAction['actionType']; config: unknown; reason: string }> = [
  { type: 'tag', config: { op: 'add', tagIds: [] }, reason: 'タグが選ばれていません' },
  { type: 'friend_field', config: { fieldId: '', op: 'set', value: '' }, reason: '友だち情報の項目が選ばれていません' },
  { type: 'scenario', config: { op: 'start', scenarioId: '', restart: 'from_start' }, reason: 'シナリオが選ばれていません' },
  { type: 'common_var', config: { varKey: '', op: 'add', value: '1' }, reason: '共通情報の項目が選ばれていません' },
  { type: 'send_message', config: { content: '' }, reason: '本文が空です' },
  { type: 'send_template', config: { templateId: '' }, reason: 'テンプレートが選ばれていません' },
  { type: 'reminder', config: { reminderId: '' }, reason: 'リマインダが選ばれていません' },
  { type: 'event_booking', config: { eventId: '' }, reason: 'イベントが選ばれていません' },
]

function toActions(): InlineAction[] {
  return EMPTY.map((item, index) => ({
    key: `action-${index + 1}`,
    actionType: item.type,
    config: item.config,
    onFailure: 'continue' as const,
  }))
}

const EMPTY_OPTIONS = { tags: [], fields: [], marks: [], scenarios: [], vars: [] }

describe('R255 空の後続処理に未完成の札が出る', () => {
  it('8種すべてに具体的な不足が出る', () => {
    render(<InlineActionList actions={toActions()} onChange={() => {}} {...EMPTY_OPTIONS} />)
    const badges = screen.getAllByText(/未完成 — /)
    expect(badges).toHaveLength(8)
    for (const item of EMPTY) {
      expect(screen.getByText(`未完成 — ${item.reason}`)).toBeTruthy()
    }
  })

  it('埋めた行の札は消え、空の行の札は残る', () => {
    const actions = toActions()
    actions[0] = { ...actions[0], config: { op: 'add', tagIds: ['tag-1'] } }
    actions[4] = { ...actions[4], config: { content: 'こんにちは' } }
    render(<InlineActionList actions={actions} onChange={() => {}} {...EMPTY_OPTIONS} />)
    expect(screen.getAllByText(/未完成 — /)).toHaveLength(6)
    expect(screen.queryByText('未完成 — タグが選ばれていません')).toBeNull()
    expect(screen.queryByText('未完成 — 本文が空です')).toBeNull()
    expect(screen.getByText('未完成 — テンプレートが選ばれていません')).toBeTruthy()
  })
})

it('担当者通知の通知先と本文を編集し、必要な版も保存する', async()=>{
 const changed=vi.fn();
 const {fireEvent}=await import('@testing-library/react');
 render(<InlineActionList actions={[{key:'notify',actionType:'notify_staff',config:{notificationRuleId:'',notificationRuleVersion:0,message:'確認してください'},onFailure:'stop'}]} onChange={changed} {...EMPTY_OPTIONS} notificationRules={[{id:'r',name:'担当者',version:2}]}/>);
 fireEvent.click(screen.getByRole('button',{name:'担当者へ知らせる'}));
 await pickEntity('通知先', '担当者');
 expect(changed).toHaveBeenCalledWith([expect.objectContaining({config:{notificationRuleId:'r',notificationRuleVersion:2,message:'確認してください'}})]);
 expect(screen.getByText(/通知先と本文が選ばれていません/)).toBeTruthy();
});

it.each([['send_template','テンプレート','案内'],['reminder','リマインダ','翌日'],['event_booking','イベント予約','相談会']] as const)('%sの候補を編集欄に渡す', (actionType,label,selected) => {
  render(<InlineActionList actions={[{key:'target',actionType,config:{templateId:'t',reminderId:'r',eventId:'e'},onFailure:'continue'}]} onChange={()=>{}} {...EMPTY_OPTIONS} templates={[{id:'t',name:'案内'}]} reminders={[{id:'r',name:'翌日'}]} events={[{id:'e',name:'相談会'}]} />)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(selected) }))
  expect(screen.getByText(selected)).toBeTruthy()
  expect(screen.getByRole('button',{name:label+'：変更する'})).toBeTruthy()
})

it('イベントの取り消しを選んでもイベントと指定回を保つ', async () => {
  const changed = vi.fn()
  const { fireEvent } = await import('@testing-library/react')
  render(<InlineActionList actions={[{ key: 'event', actionType: 'event_booking', config: { eventId: 'e', slotId: 'slot', op: 'register' }, onFailure: 'continue' }]} onChange={changed} {...EMPTY_OPTIONS} events={[{ id: 'e', name: '相談会' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'イベントに予約する「相談会」' }))
  fireEvent.click(screen.getByRole('button', { name: 'イベント予約の操作' }))
  fireEvent.click(screen.getByRole('button', { name: '申し込みを取り消す' }))
  expect(changed).toHaveBeenCalledWith([expect.objectContaining({ config: { eventId: 'e', slotId: 'slot', op: 'cancel' } })])
})
