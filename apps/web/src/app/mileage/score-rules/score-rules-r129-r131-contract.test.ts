import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'page.tsx'), 'utf8')

/*
 * R129〜R131（行動スコアの共同編集・反映・試算）の約束だけを見る。
 * 口の振る舞いは `packages/db` の同時保存試験と worker の試験が見ている。
 */
describe('R129：編集窓の入力は「設定を反映」まで一覧に残さない', () => {
  it('「設定を反映」でだけ親へ渡し、閉じる・Escapeは仮状態を捨てる', () => {
    expect(PAGE).toContain('applyEditor')
    expect(PAGE).toContain('closeEditor')
    expect(PAGE).toContain('onCancel={() => closeEditor()}')
    expect(PAGE).toContain('onClick={() => applyEditor()}')
  })
})

describe('R130：試算の入力ミスは窓の中・欄の下で直せる', () => {
  it('422の検証文を一般エラーに化けさせない', () => {
    expect(PAGE).toMatch(/error\.status === 400 \|\| error\.status === 422/)
  })
})

describe('R131：古い下書きでの保存は競合になり先の変更が残る', () => {
  it('保存時に読んだ版を送り、競合は読み直しを促す', () => {
    expect(PAGE).toContain('expectedDraftVersionId')
    expect(PAGE).toContain('ほかの人が先に保存しています')
  })
})
