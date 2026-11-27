import { describe, expect, it } from 'vitest'
import type { FriendAddRoutingValidation } from '@line-crm/shared'
import type { FriendAddRule } from '@/lib/api'
import { actionSummaryText, blockedReason, canPublish, firstSendText, idempotencyKeyFor } from './flow'

const validation = (patch: Partial<FriendAddRoutingValidation> = {}): FriendAddRoutingValidation => ({
  canPublish: true,
  estimatedAudienceCount: null,
  checks: [],
  conflicts: [],
  lastTestStatus: 'succeeded',
  ...patch,
})

const rule = (definition: Partial<FriendAddRule['definition']> = {}, patch: Partial<FriendAddRule> = {}) => ({
  friendKind: 'first_time',
  definition: {
    routeIds: [], scenarioId: null, messageType: 'text', messageText: 'こんにちは', timing: 'immediate',
    actions: [], friendCondition: '', activeFrom: null, activeUntil: null, ...definition,
  },
  ...patch,
}) as FriendAddRule

describe('友だち追加時の配信の確認（V8）の決まり', () => {
  it('有効にできるのは、サーバの確認が通り・最後のテストが成功しているときだけ', () => {
    expect(canPublish({ validation: validation(), busy: false })).toBe(true)
    expect(canPublish({ validation: validation(), busy: true })).toBe(false)
    expect(canPublish({ validation: validation({ lastTestStatus: null }), busy: false })).toBe(false)
    expect(canPublish({ validation: validation({ lastTestStatus: 'failed' }), busy: false })).toBe(false)
    expect(canPublish({ validation: validation({ canPublish: false }), busy: false })).toBe(false)
    expect(canPublish({ validation: null, busy: false })).toBe(false)
  })

  it('押せない理由を言葉で返す（テストがまだ・確認の失敗）', () => {
    expect(blockedReason(validation())).toBeNull()
    expect(blockedReason(validation({ lastTestStatus: null }))).toContain('テストで判定が通るまで')
    expect(blockedReason(validation({
      canPublish: false,
      checks: [{ key: 'scenario', label: '送るシナリオ', status: 'failed', detail: '' }],
    }))).toBe('送るシナリオを直してください。')
  })

  it('二重公開を防ぐ鍵は 管理画面 と同じ作り（アカウントと版）', () => {
    expect(idempotencyKeyFor({ accountId: 'acc', versionId: 'v1' })).toBe('friend-add-publish-acc-v1')
  })

  it('最初に送るもの・あわせて行うことの要約', () => {
    expect(firstSendText(rule())).toBe('テキスト 5字・追加してすぐ')
    expect(firstSendText(rule({ returningMode: 'none' }, { friendKind: 'returning' }))).toBe('配信なし（あわせて行うことだけ）')
    expect(actionSummaryText(rule({ scenarioId: 's1', actions: [{ type: 'add_tag', label: 'タグ' }] }))).toBe('タグ・シナリオの2つ')
    expect(actionSummaryText(rule())).toBe('なし')
  })
})


it.each(['constructor', 'toString', '__proto__', 'future'])('知らない初回案内の種類 %s は確認できないと表示する', messageType => {
  expect(firstSendText(rule({ messageType: messageType as FriendAddRule['definition']['messageType'] }))).toBe('種類を確認できません・追加してすぐ')
})
