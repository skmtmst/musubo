import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, '..', '..', 'v8', 'events', 'create.tsx'), 'utf8')
const EDIT = readFileSync(join(HERE, '..', '..', 'v8', 'events', 'edit-form.tsx'), 'utf8')

describe('イベント作成の最初の予約枠', () => {
  it('イベント作成後のIDを使って最初の枠も保存する', () => {
    const createEvent = SOURCE.indexOf('eventsApi.createEvent(selectedAccountId, payload)')
    // #1000: 初回枠には固定の再送防止キーを付け、作成済みの枠ID
    // (firstSlotId)だけを更新対象にする。slots[0] の位置では識別しない。
    const createSlot = SOURCE.indexOf('await saveInitialSlot({')
    expect(createEvent).toBeGreaterThanOrEqual(0)
    expect(createSlot).toBeGreaterThan(createEvent)
    expect(SOURCE).toContain('createdRef.current = { accountId: selectedAccountId, event: saved!, payload: JSON.stringify(payload) }')
    const slots = readFileSync(new URL('../../v8/events/save-initial-slot.ts', import.meta.url), 'utf8')
    expect(slots).toContain('api.createSlots(accountId, eventId, [input])')
    expect(SOURCE).toContain('client_key: `first-slot:${eventId}`')
    expect(EDIT).toContain('slot.id, body, slot.version ?? 1')
  })

  it('一括の作りすぎは下見の前に500件で止める(点検#520の中9)', () => {
    // #1000: 上限値は bulk-slot-generator の BULK_SLOT_LIMIT が正本。
    // 下見・送信・生成の3か所で同じ制限を使う。
    expect(EDIT).toContain('generated.length > BULK_SLOT_LIMIT')
    expect(EDIT).toContain('500件を超える一括作成はできません')
  })
})
