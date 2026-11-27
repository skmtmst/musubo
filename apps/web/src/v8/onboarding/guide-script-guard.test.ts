import { describe, expect, it } from 'vitest'
import { receptionGuideCopy } from './guide-script'

describe('onboarding/guide-script の席数入力ガード', () => {
  it('Infinity・小数・指数表記・上限超過などの非正整数では案内文を作らない', () => {
    for (const invalid of ['Infinity', '1.5', '1e5', '0', '-2', '99999999999999999999', '   ', null]) {
      expect(receptionGuideCopy(null, invalid)).toBeNull()
    }
  })

  it('正の整数文字列のときだけ席数を整形して案内文を返す', () => {
    expect(receptionGuideCopy(null, '4')).toEqual({
      title: '配分を保存する',
      body: '保存すると、営業日の全時間帯に4席ずつ適用します。今後の営業日にも自動で適用します。',
    })
    expect(receptionGuideCopy(null, ' 08 ')).toEqual({
      title: '配分を保存する',
      body: '保存すると、営業日の全時間帯に8席ずつ適用します。今後の営業日にも自動で適用します。',
    })
  })
})
