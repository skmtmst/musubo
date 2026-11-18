import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * 押した瞬間に変える切り替え（触り心地 5 回目）：マイルのたまる決めごと・使い道、アフィリエイトの公開。
 * 送る前に画面の状態を変え、失敗したら元に戻してトーストで知らせる。成功しても一覧を丸ごと読み直さない
 * （読み直すと「読み込み中」に戻ってちらつく）。受け口（成果地点）は list.test.tsx で実際に動かして確かめる。
 */
const SRC = dirname(fileURLToPath(import.meta.url))

const CASES = [
  { file: 'mileage/rewards.tsx', fn: 'changeState', optimistic: 'setStatus(next)', revert: 'setStatus(before)', call: 'api.mileage.stopReward(' },
  { file: 'affiliates/offers.tsx', fn: 'togglePublish', optimistic: 'setActive(next)', revert: 'setActive(offer.isActive)', call: 'api.affiliateOffers.update(' },
]

function body(source: string, fn: string): string {
  const start = source.indexOf(`const ${fn} = async`)
  expect(start, `${fn} が見つからない`).toBeGreaterThan(-1)
  const next = source.indexOf('\n  const ', start + 10)
  return source.slice(start, next < 0 ? undefined : next)
}

describe('押した瞬間に変える切り替え', () => {
  it.each(CASES)('$file の $fn', ({ file, fn, optimistic, revert, call }) => {
    const code = body(readFileSync(join(SRC, file), 'utf8'), fn)
    const set = code.indexOf(optimistic)
    const send = code.indexOf(call)
    const back = code.indexOf(revert, send)
    expect(set, '先に画面を変えていない').toBeGreaterThan(-1)
    expect(set).toBeLessThan(send)
    expect(back, '失敗したときに元に戻していない').toBeGreaterThan(send)
    expect(code.slice(back)).toMatch(/notifyToast\([\s\S]*tone: 'error'/)
    // 成功したときに一覧を丸ごと読み直さない（下書きの公開は別の道）
    const toggled = code.slice(0, code.indexOf('} finally {'))
    expect(toggled).not.toMatch(/await load(Offers)?\(\)/)
  })
})
