import { readUiSource } from '../../../scripts/test-ui-source.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildTemplatePreview } from '../../components/templates/template-preview-model'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readUiSource(join(HERE, '../../v8/templates/list.tsx'), 'utf8')
/* 種類の呼び方は `./template-message-type` に一本化した（#497 軽2）。 */
const MESSAGE_TYPE = readFileSync(join(HERE, '../../v8/templates/words.ts'), 'utf8')
const EDIT_PAGE = readFileSync(join(HERE, '../../v8/template-edit/message.tsx'), 'utf8')
const MESSAGE_EDITOR = readFileSync(join(HERE, '../../components/templates/message-template-editor.tsx'), 'utf8')
  + readFileSync(join(HERE, '../../components/templates/template-preview-model.ts'), 'utf8')

/**
 * テンプレート一覧（設計 `W7LBc` 11-1）に、内部の値を出さない。
 *
 * #10 の撮影で、種類の欄に `text`、種類の札に `Flex` `Carousel` が出て
 * いた。**LINE の作りの名前は運用する人には通じない。**
 *
 * 種類の呼び方・絞り込みの札・使われている数の書き分けは templates-list-behavior.test.tsx、
 * 作る画面の URL・差し込みの見え方は v8/template-edit/edit.test.tsx、カルーセルの上限は
 * carousel/page-save-retry.test.tsx、素材の保存は template-asset-save.test.tsx・edit.test.tsx で、
 * 画面を開いて確かめる。ここに残すのは、戻してはいけない書き方の見張りと、別の束で見直す確かめ。
 */
describe('種類の呼び方', () => {
  it('LINEの作りの名前をそのまま出さない', () => {
    expect(MESSAGE_TYPE, '内部の名前が残っている').not.toMatch(/flex: 'Flex'|carousel: 'Carousel'/)
  })

  it('絞り込みの札にも内部の名前を出さない', () => {
    expect(PAGE, '失敗の文に内部の語が出ている').not.toContain('Flex JSON parse 失敗')
  })

  it('知らない種類でも内部の値を出さない', () => {
    /*
     * `?? t.messageType` だと、`sticker` や `video` のひな形が並んだとき
     * **画面に英語の値がそのまま出る**。
     */
    expect(PAGE).not.toContain('?? t.messageType}')
    expect(PAGE).not.toContain('?? drawerData.messageType}')
  })

  it('`category` を画面へ流さない', () => {
    /* `text` `general` は内部の値。分け方はフォルダが受け持つ。 */
    expect(PAGE, 'category を出している').not.toMatch(/\{t\.category \|\| '未分類'\}/)
  })
})

describe('V8の作成画面', () => {
  it('本文のURLと差し込み後のLINE表示を確認できる', () => {
    // 統括の作る画面が使う共通の編集部品（components/templates）は別の束で描画の試験へ移す。
    expect(MESSAGE_EDITOR).toContain('本文に入れたURLの扱い')
    // : 題「LINEプレビュー」は共通部品が出す。画面側は使うだけ。
    expect(MESSAGE_EDITOR).toContain('<LinePreview')
    expect(buildTemplatePreview('{{name}}', { friendFields: [], commonVars: [] }).content).toBe('見本 141')
    expect(MESSAGE_EDITOR).toContain('preview.unresolved.length > 0')
    expect(EDIT_PAGE).not.toContain('内容 / JSON')
  })
})
