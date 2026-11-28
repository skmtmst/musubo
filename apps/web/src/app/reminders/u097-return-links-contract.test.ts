import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

const TAGS_MIGRATE = read('app/tags/fields/migrate/page.tsx')

/*
 * #975 U097: 「一覧へ戻ってください」「一覧から選び直してください」と
 * 書くだけで、実際の操作がなかった画面へ、該当の一覧へ戻れる
 * 操作を足す。
 */
describe('一覧へ戻る操作を置く（#975 U097）', () => {
  it('タグの移行は、アカウント未選択と対象なしの両方で一覧へ戻れる', () => {
    expect(TAGS_MIGRATE).toContain('href="/tags?tab=fields"')
    expect(TAGS_MIGRATE).toContain('友だち情報欄の一覧へ戻る')
    expect(TAGS_MIGRATE).toContain('移行元の項目が見つかりません')
  })

})
