import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sidebar = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8')

describe('サイドバーの運用警告は要約1回だけ (#630)', () => {
  // 現在のV8メニューには表示先が無く、実画面から値の計算と世代の守りを確かめられない。
  it('警告数と危険数の合計を保つ', () => {
    expect(sidebar).toContain('warningCount + summary.value.data.dangerCount')
  })
  it('古い応答を反映しない世代の守りを保つ', () => {
    expect(sidebar).toContain('mySeq !== seq')
  })
})
