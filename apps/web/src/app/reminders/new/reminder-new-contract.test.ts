import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const BASICS = fs.readFileSync(path.join(__dirname, '../../../v8/reminders/basics-form.tsx'), 'utf8')

describe('V8 リマインダ作成の契約', () => {
  it('フォルダの読み込み失敗は選び直せる表示にし、準備中に戻さない', () => {
    expect(BASICS).toContain('フォルダを読み込めませんでした')
    expect(BASICS).toContain('もう一度読み込む')
    expect(BASICS).toContain('setFoldersReloadToken((current) => current + 1)')
    expect(BASICS).not.toContain('フォルダ分けは準備中です')
    expect(BASICS).not.toMatch(/<select disabled[^>]*>[\s\S]*?<option>未分類<\/option>/)
  })
})
