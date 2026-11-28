/*
 * 監査 WEB233：Google スプレッドシートの同期が HTTP 200 のまま失敗を返したとき、理由を出す。
 */
import { describe, expect, it } from 'vitest'
import { syncResultProblem } from './sheets'
import { groupRuns, runKindLabel, runStatusLabel } from './sheets-runs'
import { sheetsCallbackNotice, sheetsLastSyncText } from './use-sheets'
import type { GoogleSheetsSyncRun } from '@/lib/api'

it.each(['constructor', 'toString', '__proto__', 'future'])('未知の同期記録 %s は安全な案内にする', (value) => {
  expect(runKindLabel(value)).toBe('種類を確認できません')
  expect(runStatusLabel(value)).toBe('状態を確認できません')
  expect(sheetsCallbackNotice(value)).toBeNull()
  const run = { id: 'one', kind: value, dataType: value, status: value, rowsWritten: 1, error: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: null } as GoogleSheetsSyncRun
  expect(groupRuns([run])[0].parts).toEqual(['内容を確認できません 1'])
})
it('既知の同期の種類・状態・接続結果は従来の案内を保つ', () => {
  expect(runKindLabel('manual')).toBe('手動')
  expect(runStatusLabel('ok')).toBe('完了')
  expect(sheetsCallbackNotice('connected')?.text).toContain('接続しました')
  expect(sheetsCallbackNotice('error:future')?.tone).toBe('danger')
})
it('最後の同期は状態が未取得・未知なら完了と言わない', () => {
  const at = '2026-10-26T01:00:00Z'
  expect(sheetsLastSyncText(at, null, 'manual')).toContain('手動・状態を確認できません')
  expect(sheetsLastSyncText(at, '__proto__', null)).toContain('状態を確認できません')
  expect(sheetsLastSyncText(at, 'ok', 'manual')).toContain('手動・完了')
  expect(sheetsLastSyncText(null, 'ok', null)).toBe('—')
})

describe('同期の結果（WEB233）', () => {
  it('失敗・一部・実行中は理由を返す', () => {
    expect(syncResultProblem({ status: 'error', results: [{ status: 'error', error: '権限がありません' }] })).toBe('同期できませんでした（権限がありません）')
    expect(syncResultProblem({ status: 'partial', results: [] })).toContain('一部だけ')
    expect(syncResultProblem({ status: 'already_running', results: [] })).toContain('いま同期しています')
  })
  it('うまくいったら何も出さない（対照）', () => {
    expect(syncResultProblem({ status: 'ok', results: [] })).toBeNull()
  })
})
