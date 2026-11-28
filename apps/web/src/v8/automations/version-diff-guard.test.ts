import { describe, expect, it } from 'vitest'
import type { CommonActionStep } from '@/lib/api'
import { describeVersionChanges, versionChangeLines } from './version-diff'

describe('version-diff ガード', () => {
  it('params のキー順違いを誤って変更扱いせず、params 欠損や不正配列でも落ちずに安全に扱う', () => {
    const prevStep = {
      id: 's1',
      type: 'send_message',
      onFailure: 'continue',
      params: { text: 'こんにちは', delay: 1 },
    } as unknown as CommonActionStep
    const sameOrderDiff = {
      id: 's1',
      type: 'send_message',
      onFailure: 'continue',
      params: { delay: 1, text: 'こんにちは' },
    } as unknown as CommonActionStep

    expect(describeVersionChanges([prevStep], [sameOrderDiff])).toEqual(['内容の変更はありません'])

    // params が null でもクラッシュしない
    const nullParams = { id: 's1', type: 'branch', onFailure: 'continue', params: null } as unknown as CommonActionStep
    const nextBranch = {
      id: 's1',
      type: 'branch',
      onFailure: 'continue',
      params: { condition: { operator: 'AND', rules: [{ field: 'tag' }] } },
    } as unknown as CommonActionStep
    expect(describeVersionChanges([nullParams], [nextBranch])).toContain('条件分岐の条件の中身を変えた')

    // actions が配列でない破損データは fail-closed で「変更内容を読み取れません」を返す
    expect(
      versionChangeLines(
        { versionNumber: 2, actions: null as unknown as CommonActionStep[] },
        [{ versionNumber: 1, actions: [prevStep] }],
      ),
    ).toEqual(['変更内容を読み取れません'])
  })

  it('ID にカンマが含まれていても順序変更の判定を誤らず、負の待ち時間や循環参照でも壊れない', () => {
    const a = { id: 'a,b', type: 'add_tag', onFailure: 'continue', params: {} } as unknown as CommonActionStep
    const b = { id: 'c', type: 'add_tag', onFailure: 'continue', params: {} } as unknown as CommonActionStep
    const a2 = { id: 'a', type: 'add_tag', onFailure: 'continue', params: {} } as unknown as CommonActionStep
    const b2 = { id: 'b,c', type: 'add_tag', onFailure: 'continue', params: {} } as unknown as CommonActionStep
    expect(describeVersionChanges([a, b], [b, a])).toContain('処理の順番を変えた')
    expect(describeVersionChanges([a, b], [a2, b2])).not.toContain('処理の順番を変えた')

    const negWait = { id: 'w1', type: 'wait', onFailure: 'continue', params: { durationMinutes: -5 } } as unknown as CommonActionStep
    const okWait = { id: 'w1', type: 'wait', onFailure: 'continue', params: { durationMinutes: 10 } } as unknown as CommonActionStep
    const waitLines = describeVersionChanges([negWait], [okWait])
    expect(waitLines.join('')).not.toContain('-5分')
    expect(waitLines).toContain('「待つ」の内容を変えた')
  })

  it('旧形式 { minutes: 30 } と新形式 { durationMinutes: 30 } の同じ待機時間は変更なしとして扱う', () => {
    const legacyWait = { id: 'w1', type: 'wait', onFailure: 'continue', params: { minutes: 30 } } as unknown as CommonActionStep
    const modernWait = { id: 'w1', type: 'wait', onFailure: 'continue', params: { durationMinutes: 30 } } as unknown as CommonActionStep
    expect(describeVersionChanges([legacyWait], [modernWait])).toEqual(['内容の変更はありません'])
  })

  it('初版で actions が不正なときも、件数違いで不正要素を含むときも「変更内容を読み取れません」を返す', () => {
    const validStep = { id: 's1', type: 'add_tag', onFailure: 'continue', params: {} } as unknown as CommonActionStep

    // 初版で actions が null や [null] の場合は「はじめて公開した」と偽らない
    expect(
      versionChangeLines(
        { versionNumber: 1, actions: null as unknown as CommonActionStep[] },
        [],
      ),
    ).toEqual(['変更内容を読み取れません'])
    expect(
      versionChangeLines(
        { versionNumber: 1, actions: [null] as unknown as CommonActionStep[] },
        [],
      ),
    ).toEqual(['変更内容を読み取れません'])

    // 件数違いでも不正要素を含めば「1個から2個にした」ではなく「変更内容を読み取れません」
    expect(
      versionChangeLines(
        { versionNumber: 2, actions: [validStep, null] as unknown as CommonActionStep[] },
        [{ versionNumber: 1, actions: [validStep] }],
      ),
    ).toEqual(['変更内容を読み取れません'])
    expect(
      versionChangeLines(
        { versionNumber: 2, actions: [validStep] },
        [{ versionNumber: 1, actions: [validStep, null] as unknown as CommonActionStep[] }],
      ),
    ).toEqual(['変更内容を読み取れません'])
  })
})
