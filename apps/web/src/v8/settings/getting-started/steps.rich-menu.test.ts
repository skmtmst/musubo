import { describe, expect, it } from 'vitest'
import { buildSteps, stepsForStyle, type StyleSetupProgress } from './steps'

const base = () => buildSteps({
  accounts: [], featureSet: null, tagCount: 0, friendFieldCount: 0, friendAdd: null,
  friendAddDraft: null, scenarios: [], role: 'owner' as const,
})

const restaurant = (steps: StyleSetupProgress['steps'] = {}) => stepsForStyle(base(), 'restaurant', { style: 'restaurant', steps })

describe('飲食の初期設定9項目', () => {
  it('③にリッチメニューを選ぶを置き、9項目の並びを保つ', () => {
    const result = restaurant()
    expect(result.map(step => step.key)).toEqual(['accounts', 'featureSet', 'richMenu', 'attributes', 'hours', 'friendAdd', 'scenario', 'followup', 'firstMessage'])
    expect(result.map(step => step.ordinal)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    const step = result[2]
    expect(step.title).toBe('リッチメニューを選ぶ')
    expect(step.action).toEqual({ label: 'リッチメニューを選ぶ', href: '/getting-started/rich-menu' })
    expect(step.condition).toContain('下書き')
  })

  it('下書きが1つでもあれば済み、無ければまだ、読めなければ未確認にする', () => {
    expect(restaurant({ richMenu: { complete: true } })[2].state).toBe('done')
    const todo = restaurant({ richMenu: { complete: false, reason: '最初のリッチメニューを選び、下書きを作ってください' } })[2]
    expect(todo.state).toBe('todo')
    expect(todo.next).toContain('下書き')
    const unknown = restaurant({ richMenu: { complete: null, reason: 'リッチメニューの状態を確認できませんでした' } })[2]
    expect(unknown.state).toBe('unknown')
    expect(unknown.next).toBe('リッチメニューの状態を確認できませんでした')
  })

  it('権限が無い人には操作させず、済みにもしない', () => {
    const steps = base().map(step => step.key === 'attributes' ? { ...step, state: 'forbidden' as const } : step)
    const step = stepsForStyle(steps, 'restaurant', { style: 'restaurant', steps: { richMenu: { complete: true } } }).find(item => item.key === 'richMenu')
    expect(step).toMatchObject({ state: 'forbidden', action: null, blockedReason: '管理者に頼んでください' })
  })
})
