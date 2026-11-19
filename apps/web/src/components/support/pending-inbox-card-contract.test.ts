/*
 * 対応が必要な受信で、**読めなかったのか 0件なのか**を分ける。
 *
 * 取れていないのに「返信を待っている問い合わせはありません。」と出すと、
 * 通信障害・500 のときに未対応があるのか無いのか区別できず、
 * 返信漏れにつながる。取れていないときは読み直しを出す。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CARD = readFileSync(join(HERE, 'pending-inbox-card.tsx'), 'utf8')

/** 説明の文だけで通ってしまわないよう、判定の前にコメントを落とす。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('対応が必要な受信の読込失敗', () => {
  it('失敗を別の状態として持ち、「なし」と言い切らない', () => {
    const body = code(CARD)
    // DASH-24/A01-06: 失敗・権限なし・読込中・0件を別々の状態として持つ。
    expect(body).toContain('const [loadFailure, setLoadFailure]')
    expect(body).toContain("setLoadFailure('error')")
    expect(body).toContain('setLoadFailure(null)')
    // 「なし」の文の前に、失敗の枝があること。
    const empty = body.indexOf('返信を待っている問い合わせはありません')
    expect(empty).toBeGreaterThan(-1)
    const before = body.slice(0, empty)
    expect(before.lastIndexOf('loadFailure')).toBeGreaterThan(-1)
  })

  it('読込中と権限なしを 0件・失敗 と区別する（A01-06）', () => {
    const body = code(CARD)
    expect(body).toContain('loading && !summary')
    expect(body).toContain("loadFailure === 'forbidden'")
    expect(body).toContain('STATE_TEXT.forbiddenView')
  })

  it('成功後の更新失敗は古い値のまま読み直しを出す（DASH-24）', () => {
    const body = code(CARD)
    expect(body).toContain('loadFailure && summary')
    expect(body).toContain('最終更新')
  })

  it('遅れた古い応答が最新を上書きしない（DASH-23）', () => {
    const body = code(CARD)
    expect(body).toContain('loadSeq.current')
    expect(body).toContain('seq !== loadSeq.current')
  })

  it('取れていないときは読み直しを出し、再試行は既存の読込を呼ぶだけ', () => {
    const body = code(CARD)
    // N-008: 「取得できませんでした」は禁止文言。共通の読み込み失敗文言に揃える。
    expect(body).toContain('データを{STATE_TEXT.error}。')
    expect(body).toContain('もう一度読み込む')
    expect(body).toContain('onClick={() => void load()}')
  })

})
