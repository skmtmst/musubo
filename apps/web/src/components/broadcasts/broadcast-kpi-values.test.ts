import { describe, expect, it } from 'vitest'

import { buildBroadcastKpiCards, countText } from './broadcast-kpi-values'
import type { BroadcastStats } from '@/lib/api'

/**
 * 一斉配信の帯（設計 `q76C35`）で、**未取得と実測 0 を取り違えない**こと。
 *
 * 「配信 0 件」と「配信の数が読めなかった」は、運用する人にとって
 * まったく違う。0 と出すと、登録したものが消えたように見える。
 */

const FULL: BroadcastStats = {
  thisMonth: 12,
  scheduled: 4,
  drafts: 3,
  delivered: 1842,
  failed: 3,
  openRate: 69.4,
}

describe('帯の4枚', () => {
  it('設計の順に並ぶ', () => {
    expect(buildBroadcastKpiCards(FULL).map((c) => c.title)).toEqual([
      '予約中',
      '下書き',
      '今月の配信',
      '平均開封率',
    ])
  })

  it('一覧の口が返す「下書き」を表示する', () => {
    const draft = buildBroadcastKpiCards(FULL).find((c) => c.title === '下書き')
    expect(draft?.value).toBe(3)
    expect(draft?.detail).toBe('編集途中')
  })

  it('旧 stats 契約では「下書き」を未取得のままにする', () => {
    const draft = buildBroadcastKpiCards({ ...FULL, drafts: undefined }).find((c) => c.title === '下書き')
    expect(draft?.value).toBeNull()
    expect(buildBroadcastKpiCards(FULL).find((c) => c.title === '予約中')?.detail).toBe('今日 —（未取得）')
    expect(draft?.detail).toBe('編集途中・未取得')
  })

  it('実測 0 は 0 のまま出す', () => {
    /* **取得できた 0 を `—` にしない。** 「今月は1件も配信していない」は事実。 */
    const cards = buildBroadcastKpiCards({ ...FULL, thisMonth: 0, scheduled: 0, delivered: 0 })
    expect(cards.find((c) => c.title === '今月の配信')?.value).toBe(0)
    expect(cards.find((c) => c.title === '予約中')?.value).toBe(0)
    expect(cards.find((c) => c.title === '今月の配信')?.detail).toBe('0人へ到達')
  })

  it('口が答えなかったときは、数を null にする', () => {
    for (const card of buildBroadcastKpiCards(null)) {
      expect(card.value, `${card.title} が数を持っている`).toBeNull()
    }
  })

  it('欠けた項目だけを未取得にし、揃っている項目は出す', () => {
    /* 一部が欠けても、読めたものまで捨てない。 */
    const cards = buildBroadcastKpiCards({ ...FULL, openRate: null })
    expect(cards.find((c) => c.title === '今月の配信')?.value).toBe(12)
    expect(cards.find((c) => c.title === '平均開封率')?.value).toBeNull()
  })

  it('数でないものが来ても、そのまま画面へ流さない', () => {
    /* 口が想定の形を返さないことがある。`'12'` や `{}` を数として扱わない。 */
    const broken = { thisMonth: '12', scheduled: {}, delivered: Number.NaN, failed: null, openRate: undefined }
    for (const card of buildBroadcastKpiCards(broken as unknown as BroadcastStats)) {
      expect(card.value, `${card.title} が数でないものを持っている`).toBeNull()
      expect(card.detail).not.toMatch(/undefined|NaN|\[object/)
    }
  })

  it('平均開封率の副題は、設計どおり「過去28日」だけ', () => {
    expect(buildBroadcastKpiCards(FULL).find((c) => c.title === '平均開封率')?.detail).toBe('過去28日')
  })
})

describe('副題に出す数', () => {
  it('数があれば桁区切りと単位を付ける', () => {
    expect(countText(1842, '人')).toBe('1,842人')
    expect(countText(0, '件')).toBe('0件')
  })

  it('数が無いときは — にして、単位を付けない', () => {
    /* `—件` は数に見える。 */
    for (const input of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '12', {}]) {
      expect(countText(input, '件')).toBe('—')
    }
  })
})
