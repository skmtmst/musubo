import { describe, expect, it } from 'vitest'
import type { AccountStyle, LineAccount } from '@line-crm/shared'
import { buildSteps, stepsForStyle, stoppedReasons, type StepResult, type StyleSetupProgress } from './steps'

const keys = ['attributes', 'friendAdd', 'scenario'] as const
const styles: AccountStyle[] = ['restaurant', 'lesson', 'salon', 'consult', 'ec']

it('LINEアカウントを登録済みなら接続状態に関係なく段1を完了にする', () => {
  const input = {
    accounts: [{ id: 'account-1', isActive: false, channelSecretConfigured: false, webhook: { status: 'unknown' } } as LineAccount],
    featureSet: null, tagCount: 0, friendFieldCount: 0, friendAdd: null,
    friendAddDraft: null, scenarios: [], role: 'owner' as const,
  }
  expect(buildSteps(input)[0].state).toBe('done')
  expect(buildSteps({ ...input, accounts: [] })[0].state).toBe('todo')
})
const oldDone = (): StepResult[] => keys.map((key, index) => ({
  key, ordinal: String(index + 3), title: '旧配信の設定', sub: 'タグと配信', state: 'done',
  condition: '旧配信の到達条件', next: 'タグを増やす', action: { label: '旧配信へ', href: '/tags' }, blockedReason: null,
}))

describe('業種に合う初期設定の実測', () => {
  it.each(styles)('%sでは旧タグや配信が済みでも、実物を読めなければ済みにしない', style => {
    const input = oldDone()
    const output = stepsForStyle(input, style).filter(step => keys.includes(step.key as typeof keys[number]))
    expect(output.map(step => step.state)).toEqual(['unknown', 'unknown', 'unknown'])
    for (const step of output) {
      expect(step.next).toContain('確認できません')
      expect(step.condition).not.toMatch(/タグ|シナリオ|公開したルール/)
    }
    expect(stoppedReasons(output)).toHaveLength(3)
    expect(input).toEqual(oldDone())
  })

  it.each(styles)('%sは実際に確認できた段だけを済みにし、未設定と読込失敗を分ける', style => {
    for (const key of keys) {
      const progress: StyleSetupProgress = { style, steps: { [key]: { complete: true } } }
      const result = stepsForStyle(oldDone(), style, progress)
      expect(result.filter(step => step.state === 'done').map(step => step.key)).toEqual([key])
      expect(result.find(step => step.key === key)?.next).toContain('終わっています')
    }
    const result = stepsForStyle(oldDone(), style, { style, steps: {
      attributes: { complete: false }, friendAdd: { complete: null, reason: '設定の読み込みに失敗しました' },
    } }).filter(step => keys.includes(step.key as typeof keys[number]))
    expect(result.map(step => step.state)).toEqual(['todo', 'unknown', 'unknown'])
    expect(result[0].next).not.toMatch(/タグ|シナリオ/)
    expect(result[1].next).toBe('設定の読み込みに失敗しました')
    expect(result[1].blockedReason).toBeNull()
    expect(result[1].action).not.toBeNull()
  })

  it('別の業種の結果を流用せず、権限不足では済みにも操作可能にもしない', () => {
    const progress: StyleSetupProgress = { style: 'ec', steps: { attributes: { complete: true } } }
    expect(stepsForStyle(oldDone(), 'restaurant', progress).every(step => step.state === 'unknown')).toBe(true)
    const input = oldDone()
    input[0] = { ...input[0], state: 'forbidden', next: '管理者に頼んでください', blockedReason: '操作する権限がありません', action: null }
    expect(stepsForStyle(input, 'ec', progress)[0]).toMatchObject({ state: 'forbidden', action: null, next: input[0].next, blockedReason: input[0].blockedReason })
  })

  it('標準にもGoogle営業時間を追加し、スタイル未確定では既存の状態を保つ', () => {
    const steps = buildSteps({ accounts: [], featureSet: null, tagCount: 1, friendFieldCount: 0, friendAdd: null, friendAddDraft: null, scenarios: [], role: null })
    expect(stepsForStyle(steps, 'standard').find(step => step.key === 'hours')).toMatchObject({ state: 'unknown', action: { href: '/settings/google-hours' } })
    expect(stepsForStyle(steps, null)).toEqual(steps)
    expect(steps.find(step => step.key === 'attributes')?.state).toBe('done')
    expect(steps.find(step => step.key === 'attributes')?.condition).toContain('タグか友だち情報欄')
    const progress: StyleSetupProgress = { style: 'ec', steps: { attributes: { complete: false } } }
    expect(stepsForStyle(steps, 'standard', progress).find(step => step.key === 'hours')?.state).toBe('unknown')
    expect(stepsForStyle(steps, null, progress)).toEqual(steps)
  })

  it('未完了からでも実測で済みにでき、空白の失敗理由や欠けた段を安全に扱う', () => {
    for (const state of ['todo', 'stalled', 'unknown'] as const) {
      const input = oldDone().map(step => ({ ...step, state }))
      const copy = structuredClone(input)
      const output = stepsForStyle(input, 'restaurant', { style: 'restaurant', steps: { attributes: { complete: true }, friendAdd: { complete: null, reason: '   ' } } }).filter(step => keys.includes(step.key as typeof keys[number]))
      expect(output.map(step => step.state)).toEqual(['done', 'unknown', 'unknown'])
      expect(output[1].next).toContain('予約で受け付ける内容')
      expect(output[0].action?.href).toBe('/restaurant-test/tables')
      expect(input).toEqual(copy)
    }
    expect(stepsForStyle([], 'ec', { style: 'ec', steps: { attributes: { complete: true } } })).toEqual([])
  })
})
