import { describe, expect, it } from 'vitest'
import { operationHistoryCsv } from './history-details'

describe('緊急停止の履歴 CSV', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を確認できない対象と表示する', capability => {
    const rows = [{ createdAt: '2026-11-26T03:00:00Z', actorId: 'staff', capabilities: [capability, 'broadcast_dispatch'], lineAccountId: null, reason: '', resolvedAt: null }] as Parameters<typeof operationHistoryCsv>[0]
    const csv = operationHistoryCsv(rows)
    expect(csv).toContain('対象を確認できません・予約中の一斉配信')
    expect(csv).not.toContain('[object Object]')
  })
})
