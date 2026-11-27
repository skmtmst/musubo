import { describe, expect, test } from 'vitest'
import { describeVersionChanges, versionChangeSummary } from './version-diff'
import type { CommonActionStep } from '@/lib/api'

const wait = (id: string, minutes: number, onFailure: CommonActionStep['onFailure'] = 'stop'): CommonActionStep => ({
  id, type: 'wait', params: { durationMinutes: minutes }, onFailure,
})
const tag = (id: string, tagId = 'tag-1'): CommonActionStep => ({
  id, type: 'add_tag', params: { tagId }, onFailure: 'stop',
})

/*
 * 監査 R468: 切替確認で待ち時間・失敗時の動きの前後が分からない。
 * 「1個の処理」「待つ」だけの比較表示にしない。
 */
describe('describeVersionChanges（監査 R468）', () => {
  test('待機1分→60分・停止→続行を前後で書く', () => {
    const lines = describeVersionChanges([wait('w', 1)], [wait('w', 60, 'continue')])
    expect(lines).toContain('「待つ」を1分から60分にした')
    expect(lines).toContain('「待つ」の失敗時を「止める」から「次へ進む」にした')
  })

  test('処理の追加・削除・順序変更を区別する', () => {
    expect(describeVersionChanges([tag('a')], [tag('a'), wait('w', 5)]))
      .toContain('「待つ」を追加した')
    expect(describeVersionChanges([tag('a'), wait('w', 5)], [tag('a')]))
      .toContain('「待つ」を外した')
    expect(describeVersionChanges([tag('a'), wait('w', 5)], [wait('w', 5), tag('a')]))
      .toContain('処理の順番を変えた')
  })

  test('変わりがなければその旨を1行にする', () => {
    expect(describeVersionChanges([wait('w', 5)], [wait('w', 5)]))
      .toEqual(['内容の変更はありません'])
  })

  test('履歴の1行は初版・件数・先頭の変更を出す', () => {
    const v1 = { versionNumber: 1, actions: [wait('w', 1)] }
    expect(versionChangeSummary(v1, [v1])).toBe('はじめて公開した')
    const v2 = { versionNumber: 2, actions: [wait('w', 60)] }
    expect(versionChangeSummary(v2, [v1, v2])).toBe('「待つ」を1分から60分にした')
    const v3 = { versionNumber: 3, actions: [wait('w', 60), tag('a')] }
    expect(versionChangeSummary(v3, [v1, v2, v3])).toBe('処理を1 個から2 個にした')
  })
})

test('翌日の時刻と待ち方の変更も、変更前後を履歴に残す', () => {
  const next = (time: string): CommonActionStep => ({ id: 'w', type: 'wait', params: { mode: 'next_day', sendAtTime: time }, onFailure: 'stop' })
  expect(describeVersionChanges([next('10:00')], [next('11:30')])).toEqual(['「きっかけの翌日 10:00 まで待つ」から「きっかけの翌日 11:30 まで待つ」にした'])
  expect(describeVersionChanges([wait('w', 30)], [next('10:00')])).toEqual(['「30 分待つ」から「きっかけの翌日 10:00 まで待つ」にした'])
})


test.each(['constructor', 'toString', '__proto__', 'future'])('未知の処理や失敗時の動作 %s を確認できる文にする', (unknown) => {
  const step = { id: 'x', type: unknown, params: {}, onFailure: unknown } as unknown as CommonActionStep
  expect(describeVersionChanges([], [step])).toEqual(['「処理」を追加した'])
  expect(describeVersionChanges([tag('x')], [{ ...tag('x'), onFailure: unknown } as unknown as CommonActionStep]))
    .toEqual(['「タグを付ける」の失敗時を「止める」から「動作を確認できません」にした'])
})
