import { describe, expect, it } from 'vitest'
import type { DeliveryServiceState } from '@/lib/restaurant-delivery-api'
import { intakeStopSelection } from './intake-stop-selection'

const open = (service: DeliveryServiceState['service']): DeliveryServiceState => ({
  service,
  label: service,
  connectionStatus: 'connected',
  intakeStatus: 'open',
  stopUntil: null,
  todayCount: 0,
  todayAmount: 0,
})

describe('restaurant/delivery/intake-stop-selection の対象絞り込みガード', () => {
  it('重複したサービスIDと現在の状態一覧に存在しないサービスを停止対象から外す', () => {
    const out = intakeStopSelection(
      [open('demaecan')],
      ['demaecan', 'demaecan', 'rocketnow'],
      '30m',
    )
    expect(out).toEqual({ services: ['demaecan'], preset: '30m', problem: null })

    const unknownOnly = intakeStopSelection([open('demaecan')], ['rocketnow'], '30m')
    expect(unknownOnly.services).toEqual([])
    expect(unknownOnly.problem).toBe('停止するサービスを選んでください')
  })
})
