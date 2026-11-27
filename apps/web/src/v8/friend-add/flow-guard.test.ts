import { describe, expect, it } from 'vitest'
import type { FriendAddRuleDefinition } from '@/lib/api'
import { friendAddFlowSteps, friendAddReaddLines, timeWindowsSummary } from './flow'

function makeDefinition(overrides: Partial<FriendAddRuleDefinition> = {}): FriendAddRuleDefinition {
  return {
    messageType: 'text',
    messageText: 'ようこそ！',
    timing: 'immediate',
    scenarioId: null,
    actions: [],
    returningMode: 'other',
    startPosition: 'beginning',
    resendSuppressionHours: 24,
    ...overrides,
  } as unknown as FriendAddRuleDefinition
}

describe('friend-add/flow 不正再送時間・未知モード・欠損配列の防御', () => {
  it('resendSuppressionHours が NaN や負数のとき「再送は制限しません」と断定せず確認不能を返す', () => {
    const nanLines = friendAddReaddLines({
      friendKind: 'first_time',
      status: 'active',
      definition: makeDefinition({ resendSuppressionHours: Number.NaN }),
    })
    expect(nanLines).toContain('同じ人への再送制限を確認できません。')
    expect(nanLines).not.toContain('同じ人への再送は制限しません。')

    const negativeLines = friendAddReaddLines({
      friendKind: 'first_time',
      status: 'active',
      definition: makeDefinition({ resendSuppressionHours: -1 }),
    })
    expect(negativeLines).toContain('同じ人への再送制限を確認できません。')
    expect(negativeLines).not.toContain('同じ人への再送は制限しません。')

    const zeroLines = friendAddReaddLines({
      friendKind: 'first_time',
      status: 'active',
      definition: makeDefinition({ resendSuppressionHours: 0 }),
    })
    expect(zeroLines).toContain('同じ人への再送は制限しません。')
  })

  it('未知の returningMode をシナリオ配信と断定せず確認不能にし、actions や messageText 欠損でも落ちない', () => {
    const lines = friendAddReaddLines({
      friendKind: 'returning',
      status: 'active',
      definition: makeDefinition({
        returningMode: 'future_mode' as FriendAddRuleDefinition['returningMode'],
        actions: null as unknown as FriendAddRuleDefinition['actions'],
      }),
    })
    expect(lines).toContain('再追加時の配信設定を確認できません。')

    const steps = friendAddFlowSteps({
      isFallback: false,
      routeNames: ['店頭QR'],
      missingRouteCount: Number.NaN,
      friendKind: 'first_time',
      definition: makeDefinition({
        messageText: null as unknown as string,
        actions: undefined as unknown as FriendAddRuleDefinition['actions'],
      }),
      scenarioName: null,
    })
    expect(steps.find((s) => s.key === 'firstMessage')?.detail).toContain('文面は未設定です。')
    expect(steps.find((s) => s.key === 'attributes')?.detail).toBe('タグの追加・解除はありません。')
    expect(timeWindowsSummary('invalid' as unknown as undefined)).toBe('いつでも')
  })
})
