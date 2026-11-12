import { describe, expect, it } from 'vitest'
import { withHonorific } from './honorific'

describe('敬称を付ける共通の 1 か所', () => {
  it('名前に敬称を付ける', () => {
    expect(withHonorific('マロン')).toBe('マロンさん')
    expect(withHonorific('マロン', 'さん', { space: true })).toBe('マロン さん')
    expect(withHonorific('見本 143', 'さま')).toBe('見本 143さま')
    expect(withHonorific('山田', '様', { space: true })).toBe('山田 様')
  })

  it('名前の末尾に「さん・様・さま」があれば重ねない', () => {
    for (const name of ['マロン さん', 'マロンさん', '山田様', '山田 様', '花子さま', 'マロン さん ']) {
      for (const honorific of ['さん', '様', 'さま'] as const) {
        const shown = withHonorific(name, honorific, { space: true })
        expect(shown).toBe(name.trim())
        expect(shown).not.toMatch(/(さん|様|さま)\s*(さん|様|さま)$/)
      }
    }
  })

  it('空の名前には敬称だけを出さない', () => {
    expect(withHonorific('')).toBe('')
    expect(withHonorific('  ')).toBe('')
  })
})
