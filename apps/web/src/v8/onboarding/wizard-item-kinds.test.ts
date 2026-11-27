import { describe, expect, it } from 'vitest'
import { setupItemKind } from './wizard-item-kinds'

describe('初期設定で追加したものの種類', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s はリンク先不明として扱う', kind => {
    expect(setupItemKind(kind)).toBeNull()
  })
  it('既知の種類には元の名前とリンクを使う', () => {
    expect(setupItemKind('template')?.label).toBe('テンプレート')
    expect(setupItemKind('template')?.href('restaurant')).toBe('/templates')
  })
})
