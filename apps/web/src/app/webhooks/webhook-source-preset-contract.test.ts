import { join } from 'node:path'
import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = readUiSource(path.join(__dirname, 'page.tsx'), 'utf8')
const OVERVIEWS = ['outgoing', 'incoming'].map(name => readUiSource(join(import.meta.dirname, '../../v8/webhooks', `${name}.tsx`), 'utf8')).join('\n')

/** 注釈を落とす。「なぜ直したか」を書いた文が、直したはずの字面に当たるのを避ける。 */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CODE = code(`${PAGE}\n${OVERVIEWS}`)

/**
 * 設計 `M0Gb7` は「予約サービス」「アンケートツール」のような**見本を選んで作る道**を持つ。
 * 実装は `sourceType` の自由入力だけで、置き文字の `line` しか手がかりが無かった。
 *
 * 保存する値は今までどおりの文字列なので、口も保存の形も変えていない。
 */
describe('外部連携の「どこから来るか」は、見本から選べる', () => {
  it('自由入力中は見本の説明を混ぜず、保存後は見本選択へ戻す', () => {
    expect(CODE).toContain('setCreateSource(SOURCE_PRESETS[0].value)')
    expect(CODE).toContain("setCreateSourceFree('')")
    expect(CODE).toContain('setShowCreate(false)')
  })

  it('内部の語を見出しに出さない', () => {
    expect(CODE, '「ソースタイプ」が残っている').not.toContain('ソースタイプ')
    expect(CODE).toContain('どこから来るか')
  })

  it('未設定を半角ハイフンで書かない', () => {
    expect(CODE, "'-' のまま出している").not.toContain("wh.sourceType || '-'")
    expect(CODE).toContain("?? (value || 'その他')")
  })
})
