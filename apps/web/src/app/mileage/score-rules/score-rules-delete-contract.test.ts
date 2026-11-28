import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

/*
 * 監査 m22j ついで: ほかの一覧と同じく、行の赤いゴミ箱ではなく
 * 「…」の中の「削除する」（確認つき）にそろえる（LAY-18）。
 */
describe('スコアのルールの削除（m22j）', () => {
  it('行の配置は変えない（名前・点数・頻度・操作の並び）', () => {
    // U047 の幅の約束は保つ。操作の場所だけ「…」に入れ替える。
    expect(PAGE).toContain('col-span-1 justify-self-end')
  })
})
