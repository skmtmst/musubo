import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(new URL('../../v8/broadcasts/list.tsx', import.meta.url), 'utf8')

/**
 * R173: 絞り込み0件をデータ未作成の状態として案内しない。
 *
 * 下書きだけがある状態で「予約中のみ」を押すと、APIは空を返す。
 * 「まだ配信がありません」と出すと保存済みが消えたように見える。
 * 絞りが効いているときの0件は共通 ListState の `filtered`
 * （「条件に合うものがありません」）と「条件を外す」ボタンにする。
 */
describe('R173 一斉配信の0件の出し分け', () => {
  it('絞り込み0件では作る口を出さない', () => {
    // 「絞り込みを変えるか、新しく作成してください。」は作る口への誘導だった。
    expect(PAGE).not.toContain('条件に該当する配信はありません')
    expect(PAGE).not.toContain('絞り込みを変えるか、新しく作成してください。')
  })

})
