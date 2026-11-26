import { expect, it } from 'vitest'
import { friendAddFlowSteps, MESSAGE_TYPE_LABEL } from './flow'
import type { FriendAddRuleDefinition } from '@/lib/api'

it.each(['constructor', 'toString', '__proto__', 'future'])('未知の案内種類 %s を他の画面でも安全に扱う', messageType => {
  expect((MESSAGE_TYPE_LABEL as Record<string, string>)[messageType]).toBeUndefined()
  const definition = { messageType, messageText: '', timing: 'immediate', actions: [] } as unknown as FriendAddRuleDefinition
  const steps = friendAddFlowSteps({ isFallback: true, routeNames: [], missingRouteCount: 0, friendKind: 'first_time', definition, scenarioName: null })
  expect(steps.find(step => step.key === 'firstMessage')?.title).toBe('初回案内（種類を確認できません）')
})
it('既知の案内種類は従来どおり', () => {
  expect(MESSAGE_TYPE_LABEL.text).toBe('テキスト')
})
