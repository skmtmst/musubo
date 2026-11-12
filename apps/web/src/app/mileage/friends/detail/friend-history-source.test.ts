/*
 * 友だち別マイル明細の「元の記録」表示の試験(#816 / N-241残差)。
 *
 * 管理向け履歴API（GET /api/mileage/history）は元記録の出来事IDそのものを
 * 返さず、有無だけ（hasSourceEvent）を返す。監査時点の明細画面は
 * `sourceEventId: item.hasSourceEvent ? item.id : null` と、台帳行自身のIDを
 * 元記録IDへ偽装していた。元記録を指すIDではない値を置かないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { MileageAdminHistoryItem } from '@/lib/api'
import { friendHistoryItem, mileageSourceNoteText } from '../../mileage-display'

function adminItem(overrides: Partial<MileageAdminHistoryItem> = {}): MileageAdminHistoryItem {
  return {
    id: 'ledger-1',
    primaryFriendId: 'friend-1',
    displayName: '見本 167',
    pictureUrl: null,
    entryType: 'grant',
    status: 'available',
    amount: 100,
    reason: 'あいさつ',
    source: 'line',
    hasSourceEvent: true,
    sourceReferenceId: null,
    ruleName: 'あいさつでたまる',
    mode: 'automatic',
    executedByStaffName: null,
    lineAccountName: '公式A',
    balanceAfter: 100,
    occurredAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('友だち別マイル明細の元記録マッピング', () => {
  it('元記録の出来事IDを台帳行自身のIDで偽装しない', () => {
    const mapped = friendHistoryItem(adminItem({ id: 'ledger-1', hasSourceEvent: true }))
    expect(mapped.sourceEventId).toBeNull()
    expect(mapped.sourceEventId).not.toBe('ledger-1')
  })

  it('元記録の有無は hasSourceEvent として直通し、「元の記録あり」と出す', () => {
    const mapped = friendHistoryItem(adminItem({ hasSourceEvent: true }))
    expect(mapped.hasSourceEvent).toBe(true)
    expect(mileageSourceNoteText({
      sourceReferenceId: mapped.sourceReferenceId,
      hasSourceEvent: mapped.hasSourceEvent ?? mapped.sourceEventId != null,
    })).toBe('元の記録あり')
  })

  it('元記録が無い行は「元の記録なし」と出す', () => {
    const mapped = friendHistoryItem(adminItem({ hasSourceEvent: false }))
    expect(mapped.hasSourceEvent).toBe(false)
    expect(mileageSourceNoteText({
      sourceReferenceId: mapped.sourceReferenceId,
      hasSourceEvent: mapped.hasSourceEvent ?? mapped.sourceEventId != null,
    })).toBe('元の記録なし')
  })

  it('参照番号だけ残っている行も「元の記録あり」と出す', () => {
    const mapped = friendHistoryItem(adminItem({ hasSourceEvent: false, sourceReferenceId: 'INQ-20260915-001' }))
    expect(mileageSourceNoteText({
      sourceReferenceId: mapped.sourceReferenceId,
      hasSourceEvent: mapped.hasSourceEvent ?? mapped.sourceEventId != null,
    })).toBe('元の記録あり')
  })
})
