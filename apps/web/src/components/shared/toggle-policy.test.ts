import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

test('シナリオのオン・オフは5秒待たずに保存し、停止だけ確認する', () => {
  const source = readFileSync(resolve('src/v8/scenarios/list.tsx'), 'utf8')
  const body = source.slice(source.indexOf('const runBulkToggle'), source.indexOf('/* ===== フォルダ移動'))
  expect(body).toContain('runOptimistic(')
  expect(body).not.toContain('runUndoable(')
})

/*
 * 選ぶ＝チェックボックス、オン・オフ（表示する・使う・送る）＝スイッチ。
 * オン・オフの意味の欄をチェックボックスへ戻さない。
 */
function screens(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(dir, entry.name)
    return entry.isDirectory() ? screens(file) : file.endsWith('.tsx') && !file.includes('.test.') ? [file] : []
  })
}
const ON_OFF_SCREENS = screens(resolve('src/v8'))

test('全画面のオン・オフを設定用のチェックボックスへ戻さない', () => {
  const found = ON_OFF_SCREENS.filter(file => /(?:import[^;]*\bSettingCheckbox\b|<SettingCheckbox\b)/.test(readFileSync(file, 'utf8')))
  expect(found).toEqual([])
})
