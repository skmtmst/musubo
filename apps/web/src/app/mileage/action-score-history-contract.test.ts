import { readApiSource } from '../../../scripts/test-api-source.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readImplementationSource } from '../../../../worker/src/test-utils/implementation-source'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = readApiSource(join(HERE, '..', '..', 'lib', 'api.ts'), 'utf8')
const SCORING_ROUTE = readImplementationSource(
  join(HERE, '..', '..', '..', '..', 'worker', 'src', 'routes', 'scoring.ts'),
)
const DB_SCORING = readFileSync(
  join(HERE, '..', '..', '..', '..', '..', 'packages', 'db', 'src', 'scoring.ts'),
  'utf8',
)
const EVENT_BUS = readFileSync(
  join(HERE, '..', '..', '..', '..', 'worker', 'src', 'services', 'event-bus.ts'),
  'utf8',
)

/*
 * IDEA-17（A 優先実施）の画面・口の約束だけを見る。
 * 台帳の冪等性そのものは worker/db の直接試験が見ている。
 */

describe('IDEA-17：スコアの計算理由を明細からたどれる', () => {


  it('口は前後の点数・発生日時・動かした方法まで返す', () => {
    expect(API).toContain('currentScore: number')
    expect(API).toContain('scoreBefore: number | null')
    expect(API).toContain('scoreAfter: number | null')
    expect(API).toContain("mode: 'manual' | 'automatic'")
    expect(SCORING_ROUTE).toContain('occurredAt: h.occurred_at ?? h.created_at')
    expect(SCORING_ROUTE).toContain('scoreBefore: h.score_before')
    expect(SCORING_ROUTE).toContain('executedByStaffName: h.executed_by_staff_name')
    expect(DB_SCORING).toContain('score_before')
    expect(DB_SCORING).toContain('executed_by_staff_name')
  })
})

describe('IDEA-17：同じイベントを再実行してもスコアが二重にならない', () => {
  it('旧ルールの適用にも発生元の不変IDを渡す', () => {
    expect(EVENT_BUS).toContain('execution?.sourceEventId ?? payload.sourceEventId')
    expect(EVENT_BUS).toContain('applyScoring(db, payload.friendId, eventType, scoreSourceEventId)')
  })
})
