import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (relative: string) => readFileSync(join(HERE, relative), 'utf8')

/*
 * V8-B オートメーション3板（ 一覧・ 下書きを仕上げる・
 *  見本12件）。F-14〜F-16 の口が入ったので、絵どおりに作り直した
 * 現役V8の外枠と操作を確認する。
 */
describe('V8 オートメーション3板の印', () => {

  it('一覧の行の操作に「1人で試す」を置く（F-14 担当へ知らせるの動作確認口）', () => {
    const list = read('../../v8/automations/list.tsx')
    expect(list, '1人で試すが無い').toContain('1人で試す')
  })

  it('下書き仕上げに「1人で試す」を置く（F-15）', () => {
    const draft = read('../../v8/automations/create/create.tsx')
    expect(draft, 'F-15 の試しが無い').toContain('1人で試す')
  })

})
