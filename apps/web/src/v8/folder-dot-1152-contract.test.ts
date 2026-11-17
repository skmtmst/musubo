import { readUiSource as readFileSync } from '../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * 1152 の残る一覧：名前の前のフォルダの丸を守る。
 * どの幅でも丸を出す（狭い幅で丸を消さない）。2行目の字下げは絵のとおり（リマインダだけ 1152 でも下げる）。
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCREENS = [
  'v8/mileage/earning-rules.tsx',
]

describe('1152 の一覧でも名前の前にフォルダの丸を出す', () => {
  it.each(SCREENS)('%s', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8')
    expect(source).toMatch(/(?:<FolderDotName folder=\{[^}]+\}>|<NameCell[\s\S]*?folder=\{)/)
    expect(source).not.toMatch(/<FolderDotName[^>]*dot=\{/)
  })
})
