import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReminderValidationResult } from '@line-crm/shared'
import { reminderAudienceCounts } from '../../v8/reminders/edit'

const FLOW = readFileSync(join(process.cwd(), 'src/v8/reminders/edit.tsx'), 'utf8')
const ISSUE_469 = readFileSync(join(process.cwd(), 'src/v8/reminders/edit.tsx'), 'utf8')
/* 完全切り替え：管理画面 page は捨て、V8 の list-v8 を見る。 */
const LIST_PAGE = readFileSync(join(process.cwd(), 'src/v8/reminders/list.tsx'), 'utf8')

describe('リマインダ公開フローの実データ表示', () => {
  it('TargetStage は validate 応答の対象人数を表示へ渡す', () => {
    const validation: ReminderValidationResult = {
      valid: true,
      checks: [],
      audience: { matched: 17, excluded: 3 },
    }
    expect(reminderAudienceCounts(validation)).toEqual({ matched: 17, excluded: 3, total: 20 })

    expect(FLOW).toContain('reminderAudienceCounts(validation)')
    expect(FLOW).toContain("countLabel(total, '人')")
    expect(FLOW).toContain("countLabel(matched, '人')")
    expect(FLOW).toContain("countLabel(excluded, '人')")
    expect(FLOW).not.toContain('426人')
  })

  it('口にない値は実際の取得元を示し、作りかけの固定例を出さない', () => {
    for (const source of [FLOW, ISSUE_469]) {
      expect(source).toContain('テストで使う値')
      expect(source).toContain('reminderPlaceholders')
      expect(source).not.toContain('8/23 01:30')
      expect(source).not.toContain('Demo Person')
      // 実装に無い差し込み名・架空の例値を「取得元」付きで並べない
      expect(source).toContain('placeholder.testValue')
      expect(source).toContain('placeholder.source')
    }
  })

  it('一覧は共通のサーバー一覧とページ送りを使い、取得後に切り出さない', () => {
    expect(LIST_PAGE).toContain('useOffsetServerList')
    expect(LIST_PAGE).toContain("query.set('q', deferredNameQuery)")
    expect(LIST_PAGE).toContain('page={reminderList.page}')
    expect(LIST_PAGE).not.toContain('filtered.slice(')
  })
})
