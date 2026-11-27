import { readApiSource } from '../../../../scripts/test-api-source.mjs'
/*
 * IDEA-07: イベントの予約ごとの通知予定を、予約そのもののそばで見せる。
 *
 * 開催回の移動・予約の取消で止まった分も「停止済み」として出すので、
 * 古い通知が残っていないか・二重になっていないかをこの一覧で確かめられる。
 * 変更に連動しない別管理の通知一覧は作らない（指示の除外範囲）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, '../../../v8/events/booking-records.tsx'), 'utf8')
const API = readApiSource(join(HERE, '..', '..', '..', 'lib', 'api.ts'), 'utf8')
// 取得範囲・1回の取得・応答内容はWorker events.test.tsの実HTTP試験で確認する。

/** 説明の文だけで通ってしまわないよう、判定の前にコメントを落とす。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('IDEA-07 イベント予約の通知予定', () => {
  it('一覧APIが予約ごとの通知予定を同じ応答で返す', () => {
    // 応答の動作はWorker側で確認し、ここでは画面の型を保つ。
    expect(code(API)).toContain('reminders?:')
    expect(code(API)).toContain("'pending' | 'sent' | 'failed' | 'failed_permanent' | 'cancelled'")
  })

  it('変更に連動しない別管理の通知一覧は増やさない', () => {
    const page = code(PAGE)
    // 通知予定は予約の行の中だけ。独立した一覧口は呼ばない。
    expect(page).not.toContain('notifications/pending')
    expect(page).not.toContain('/api/reminders')
  })
})
