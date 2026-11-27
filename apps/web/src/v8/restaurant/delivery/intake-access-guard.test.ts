import { describe, expect, it } from 'vitest'
import type { DeliveryServiceState } from '@/lib/restaurant-delivery-api'
import { intakeActionReason, intakeOperationReason, type IntakeAccess } from './intake-access'

function makeState(patch: Partial<DeliveryServiceState> = {}): DeliveryServiceState {
  return {
    service: 'demaecan',
    label: '出前館',
    connectionStatus: 'connected',
    intakeStatus: 'open',
    stopUntil: null,
    todayCount: 0,
    todayAmount: 0,
    ...patch,
  }
}

describe('intake-access 未知状態・再開時未選択・配列欠損の防御', () => {
  it('未知や欠損の connectionStatus を未接続と断定せず確認不能として拒否する', () => {
    const unknownConn = makeState({ connectionStatus: 'maintenance' as DeliveryServiceState['connectionStatus'] })
    const missingConn = makeState({ connectionStatus: undefined as unknown as DeliveryServiceState['connectionStatus'] })
    expect(intakeActionReason(unknownConn, 'stop')).toBe('接続の状態を確認できません。読み直してから操作してください。')
    expect(intakeActionReason(missingConn, 'resume')).toBe('接続の状態を確認できません。読み直してから操作してください。')
    expect(intakeActionReason(makeState({ connectionStatus: 'disconnected' }), 'stop')).toBe('未接続のため操作できません。')
    expect(intakeActionReason(makeState({ connectionStatus: 'error' }), 'stop')).toBe('接続の異常を解消してください。')
  })

  it('未知や欠損の intakeStatus を停止済み/再開済みと断定せず確認不能として拒否する', () => {
    const unknownIntake = makeState({ intakeStatus: 'paused' as DeliveryServiceState['intakeStatus'] })
    const missingIntake = makeState({ intakeStatus: undefined as unknown as DeliveryServiceState['intakeStatus'] })
    expect(intakeActionReason(unknownIntake, 'stop')).toBe('受付の状態を確認できません。読み直してから操作してください。')
    expect(intakeActionReason(missingIntake, 'resume')).toBe('受付の状態を確認できません。読み直してから操作してください。')
    expect(intakeActionReason(makeState({ intakeStatus: 'stopped' }), 'stop')).toBe('すでに受付が停止しています。')
    expect(intakeActionReason(makeState({ intakeStatus: 'open' }), 'resume')).toBe('すでに受付を再開しています。')
  })

  it('未選択時の案内が停止と再開で食い違わず、services が非配列でも落ちない', () => {
    const scope = {}
    const access: IntakeAccess = {
      scope,
      accountId: 'acc-1',
      canManage: true,
      roleKnown: true,
      ready: true,
      services: [makeState()],
    }
    expect(intakeOperationReason(access, scope, [], 'stop')).toBe('接続済みで受付中のサービスを選んでください。')
    expect(intakeOperationReason(access, scope, [], 'resume')).toBe('接続済みで停止中のサービスを選んでください。')
    const malformedAccess: IntakeAccess = {
      ...access,
      services: null as unknown as DeliveryServiceState[],
    }
    expect(intakeOperationReason(malformedAccess, scope, ['demaecan'], 'stop')).toBe(
      'サービスの状態を読み直してから操作してください。',
    )
  })
})
