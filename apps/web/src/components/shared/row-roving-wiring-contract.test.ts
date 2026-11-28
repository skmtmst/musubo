import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/* 動きの点検（2026-10-07）20 番：主な一覧は 1 行に Tab が 1 回だけ止まる表の本体を使う。 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LISTS = [
  'v8/scenarios/list.tsx',
  'v8/reminders/list.tsx',
  'v8/auto-replies/list.tsx',
  'v8/tags/tags-tab.tsx',
  'v8/broadcasts/list.tsx',
  'v8/templates/list.tsx',
]

describe('主な一覧の行は RovingTbody に入っている', () => {
  it.each(LISTS)('%s', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8')
    expect(source).toContain("from '@/components/shared/row-roving'")
    expect(source).toMatch(/<RovingTbody[\s>][\s\S]*<\/RovingTbody>/)
  })
})
