import { describe, expect, it } from 'vitest'
import { conditionSummary, usageSummary } from './searches-tab'

describe('保存した検索の行の文（絵 IWnYX）', () => {
  it('条件は「かつ」「または」でつなぐ', () => {
    expect(conditionSummary({ all: ['タグ「VIP」を含む', 'タグ「未契約」を含む'], any: [], note: null })).toBe('タグ「VIP」を含む かつ タグ「未契約」を含む')
    expect(conditionSummary({ all: [], any: ['タグ「購入」を含む', '予約が 1 件以上'], note: null })).toBe('タグ「購入」を含む または 予約が 1 件以上')
    expect(conditionSummary({ all: [], any: [], note: null })).toBe('未設定')
  })

  it('使っている所は1件なら名前、複数なら種類ごとの数、なしは「なし」', () => {
    expect(usageSummary([{ kind: 'broadcast', id: 'b1', name: '秋の案内' }] as never)).toBe('一斉配信「秋の案内」')
    expect(usageSummary([
      { kind: 'broadcast', id: 'b1', name: 'a' },
      { kind: 'broadcast', id: 'b2', name: 'b' },
      { kind: 'automation', id: 'a1', name: 'c' },
    ] as never)).toBe('一斉配信 2・自動処理 1')
    expect(usageSummary([])).toBe('なし')
    expect(usageSummary(undefined)).toBe('—')
  })
})


it.each(['constructor', 'toString', '__proto__', 'future'])('知らない検索の使用先 %s はそのほかとして数える', kind => {
  expect(usageSummary([{ kind, id: 'a', name: '確認用' }] as never)).toBe('そのほか「確認用」')
  expect(usageSummary([{ kind, id: 'a', name: '確認用' }, { kind: 'broadcast', id: 'b', name: '配信' }] as never)).toBe('そのほか 1・一斉配信 1')
})
