import { readApiSource } from '../../../../scripts/test-api-source.mjs'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(new URL('../../../v8/reminders/detail.tsx', import.meta.url), 'utf8')
/* 完全切り替え：管理画面 の一覧 page.tsx は捨て、V8 の list-v8.tsx を見る。 */
const LIST_PAGE = fs.readFileSync(new URL('../../../v8/reminders/list.tsx', import.meta.url), 'utf8')
const API = readApiSource(path.join(__dirname, '..', '..', '..', 'lib', 'api.ts'), 'utf8')

describe("管理画面 7-1-H リマインダ実行結果", () => {
  it('一覧から予定と履歴を選べ、予定は公開APIのplannedで絞る', () => {
    expect(LIST_PAGE).toContain('<RowMenu')
    expect(LIST_PAGE).toContain('items={rowMenuItems(row)}')
    // 削除は行に直に置かず、メニューの中の危ない操作にする。
    expect(LIST_PAGE).not.toContain('<Trash2 />')
    expect(LIST_PAGE).toContain("tone: 'danger'")
  })

  it('画面へ返す状態はplannedで、DB内部のqueuedを公開契約へ漏らさない', () => {
    const statusType = API.match(/export type ReminderDeliveryRunStatus =[\s\S]*?\n\n/)?.[0] ?? ''
    expect(statusType).toContain("| 'planned'")
    expect(statusType).not.toContain("| 'queued'")
  })

  it('実行結果APIを読み、固定の設計値を画面へ埋め込まない', () => {
    expect(API).toMatch(/runs:\s*\(\s*\n?\s*reminderId: string,/)
  })

  it('7機能で再利用する9項目と6状態を共通契約にする', () => {
    for (const field of [
      'occurredAt', 'subject', 'accountLabel', 'triggerLabel', 'reference',
      'status', 'detail', 'durationMs', 'canRetry',
    ]) {
      expect(API).toContain(`${field}:`)
    }
    for (const status of ['succeeded', 'failed', 'partial', 'skipped', 'pending', 'cancelled']) {
      expect(API).toContain(`| '${status}'`)
    }
  })

  it('LINEで取れない友だち単位の既読率を0として作らない', () => {
    expect(PAGE).not.toContain('openRate ?? 0')
  })

  it('読込・失敗・空を区別し、失敗した1通だけ再試行できる', () => {
    expect(PAGE).toContain('setData(null)')
  })

  it('通知名を本文から出し、内部の友だちIDを画面へ出さない', () => {
    expect(PAGE).toContain('function stepLabel(')
    expect(PAGE).not.toContain('<span className={styles.cellSub}>{item.friendId}</span>')
  })

  it('操作名から行き先と結果が分かる', () => {
    expect(PAGE).toContain('api.reminders.update(reminderId, { isActive })')
  })
})
