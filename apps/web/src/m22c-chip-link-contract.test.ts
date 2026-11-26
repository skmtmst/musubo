import { readUiSource } from '../scripts/test-ui-source.mjs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/*
 * m22c：札の折り返し・行き先リンクの見た目そろえ。見た目の自動点検
 * （design-lint k=5 札の折り返し・k=10 行き先リンクの見た目）で残って
 * いた崩れの戻し検知。直しを戻すと赤くなる。
 */
function read(rel: string): string {
  return readUiSource(path.join(__dirname, rel), 'utf8')
}

describe('m22c 札・ボタンの折り返し', () => {
  it('受信箱の札と保存した検索は共通部品を使う', () => {
    const source = read('app/chats/page.tsx')
    // の36px。画面の旧いTailwind指定ではなく、札の持ち主を確かめる。
    expect(source).toContain('<FilterChip')
    expect(source).toContain('保存した検索')
    expect(source).not.toContain('<Button href="/tags?tab=marks" className="h-10 shrink-0">')
  })

  it('条件の足し口は15札を並べない（共通部品で検索式に）', () => {
    const source = read('components/shared/condition-builder.tsx')
    expect(source).toContain('aria-label="追加する条件を選択する"')
    expect(source).toContain('<KindPicker')
    // 種類ごとの札ボタンに戻っていたら赤。
    expect(source).not.toContain('{kind.label}')
  })
})

describe('m22c 行き先リンクの見た目', () => {
  it('分類案内の行き先リンクは共通の緑の文字リンク（TextLink）', () => {
    const source = read('components/friend-fields/attribute-kind-guide.tsx')
    expect(source).toContain('<TextLink')
    expect(source).not.toContain('text-status-info')
  })

  // 管理画面の本文の戻るリンクは廃止。V8の経路はbreadcrumb-r177で守る。
})
