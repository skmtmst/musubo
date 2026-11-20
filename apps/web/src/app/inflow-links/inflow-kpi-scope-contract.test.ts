import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(__dirname, '../../v8/inflow-links/list.tsx'), 'utf8')
const NEW = fs.readFileSync(path.join(__dirname, '../../v8/inflow-links/new/create.tsx'), 'utf8')

/**
 * 検証環境（`3a21ef5e`）で、フォルダ列が
 * テスト`0`／SNS`2`／代理店`0`／未分類`1`＝合計3本と出ている横で、
 * 帯は **「流入元 0件」** だった。選択中が「テスト」だったため。
 *
 * 帯は画面全体の要約なので、**フォルダを選び替えたり検索欄に文字を打つだけで
 * 総数が変わってはいけない。** フォルダ内の件数は
 * 「選択中のフォルダ … 0 リンク」で別に出ている。
 *
 * `sortedRows` はフォルダで絞ったうえ検索文字でも絞った配列。
 * フォルダ列の件数は `accountRows` から数えており、
 * **同じ画面の中で数え方が2通りあった。**
 */
describe('流入と計測の帯は、選択中のフォルダだけを数えない', () => {
  it('受付中・停止中も同じ数え方にそろえる（R273）', () => {
    expect(PAGE).toContain('const accountRouteCount = summary?.routeTotal ?? accountRows.length')
    // 停止中は行の札で言い分け、測った数に入れない。未登録の外部REFを
    // 「計測済」には数えない（行の routeStatus が見る）。
    expect(ROWS).toContain("if (row.isActive === false) return 'stopped'")
    expect(ROWS).toContain("if (row.source === 'orphan') return 'unregistered'")
  })

  it('作成確認も公開オフなら停止中だと分かる（R273）', () => {
    // 公開オフで作った直後に「すぐに使えます」と出すと停止中と矛盾する。
    expect(NEW).toContain('公開オフのまま発行すると、URLを開いても友だち追加できません')
  })

  it('フォルダ列の件数は元のままで、意味が重ならない', () => {
    expect(PAGE).toContain("accountRows.filter((row) => row.genre === genre.name).length")
  })
})

const ROWS = fs.readFileSync(path.join(__dirname, '../../v8/inflow-links/rows.ts'), 'utf8')
