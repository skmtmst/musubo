import { describe, expect, it } from 'vitest'
import type { FriendAddEventRoutingStatus } from '@line-crm/shared'
import { routingAction, routingLabel } from './status'

describe('友だち追加の実行状態', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の %s は不明として表示する', value => {
    const status = value as FriendAddEventRoutingStatus
    expect(routingLabel(status, null)).toEqual({ label: '不明', tone: 'neutral' })
    expect(routingAction(status, null)).toBe('状態を確認中')
    expect(routingAction(status, 'delivery_unknown')).toBe('送達不明・要確認（自動では送り直しません）')
  })
  it('既知の結果は従来の言葉で表示する', () => {
    expect(routingLabel('completed', null)).toEqual({ label: '成功', tone: 'success' })
    expect(routingAction('failed', null)).toBe('配信・処理に失敗')
  })
})
