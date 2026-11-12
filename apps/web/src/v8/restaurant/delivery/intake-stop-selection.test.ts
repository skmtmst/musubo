import { describe, expect, it } from 'vitest'
import { intakeOperationReason } from './intake-access'
import { intakeStopSelection } from './intake-stop-selection'
import type { DeliveryServiceState } from '@/lib/restaurant-delivery-api'

const open = (service: DeliveryServiceState['service']): DeliveryServiceState => ({service,label:service,connectionStatus:'connected',intakeStatus:'open',stopUntil:null,todayCount:0,todayAmount:0})

describe('受付停止の現在の対象', () => {
  it('再取得で停止中になった対象を外し、提供前と接続の判定は共通の門に渡す', () => {
    const before = [open('demaecan'),open('rocketnow'),open('ubereats')]
    expect(intakeStopSelection(before, ['demaecan','rocketnow','ubereats'], '30m').services).toEqual(['demaecan','rocketnow','ubereats'])
    const after = before.map(state => state.service === 'demaecan' ? {...state,intakeStatus:'stopped' as const} : state)
    expect(intakeStopSelection(after, ['demaecan','rocketnow','ubereats'], '30m')).toEqual({services:['rocketnow','ubereats'],preset:'30m',problem:null})
    const scope = {}
    expect(intakeOperationReason({scope,accountId:'a',canManage:true,roleKnown:true,ready:true,services:after}, scope, intakeStopSelection(after, ['rocketnow','ubereats'], '30m').services, 'stop')).toBe('営業状態の連携は準備中')
    expect(intakeStopSelection(after, ['demaecan'], '30m').problem).toBe('停止するサービスを選んでください')
  })
  it('本人を確認中と読み込み失敗を区別し、どちらも操作を通さない', () => {
    const scope = {}
    const context = { scope, accountId: 'a', canManage: false, roleKnown: false, ready: true, services: [open('demaecan')] }
    expect(intakeOperationReason({ ...context, roleFailed: false }, scope, ['demaecan'], 'stop')).toBe('担当者の確認が終わるまでお待ちください。')
    expect(intakeOperationReason({ ...context, roleFailed: true }, scope, ['demaecan'], 'stop')).toBe('担当者を確認できませんでした。画面を読み直してください。')
  })
  it('対象と時間を選ぶまでは理由を返し、期間のAPI型へ空を補わない', () => {
    expect(intakeStopSelection([open('demaecan')], [], '').problem).toBe('停止するサービスを選んでください')
    expect(intakeStopSelection([open('demaecan')], ['demaecan'], '').problem).toBe('停止する時間を選んでください')
    expect(intakeStopSelection([open('demaecan')], ['demaecan'], 'today')).toEqual({services:['demaecan'],preset:'today',problem:null})
  })
})
