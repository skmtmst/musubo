import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ActionMenu from './action-menu'
import { RowActions } from './row-actions'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => readFileSync(join(HERE, name), 'utf8')

/**
 * #985 LAY-18: 一覧の操作をアプリ全体で同じルールにする。
 *
 * - 「詳細」は操作欄の先頭の補助ボタン。文字は1行。
 * - 編集・複製・停止・アーカイブなどは「⋯」メニューへ集約する。
 * - 削除など元に戻せない操作は区切りの後・赤で必ず最後。
 * - 押せない操作は無効状態と具体的な理由を示す。
 * - タッチ端末では操作領域44px以上を確保する。
 */
describe('RowActions 一覧の操作の共通ルール（#985 LAY-18）', () => {
  it('詳細と「…」を出し、編集は閉じた行に出さない', () => {
    const html = renderToStaticMarkup(
      <RowActions
        subjectName="来店お礼"
        detail={{ href: '/templates/detail?id=t1' }}
        edit={{ onClick: vi.fn() }}
        menuItems={[{ id: 'copy', label: '複製する', onSelect: vi.fn() }]}
      />,
    )
    expect(html).toContain('詳細')
    expect(html).not.toContain('編集')
    expect(html).toContain('来店お礼のその他操作')
    // 「⋯」は閉じた状態で aria-expanded="false" を持つ。
    expect(html).toContain('aria-expanded="false"')
  })

  it('権限で許可されない編集は出さず、全行にその他操作の入口を残す', () => {
    const html = renderToStaticMarkup(
      <RowActions subjectName="閲覧のみ" detail={{ href: '/x' }} />,
    )
    expect(html).toContain('詳細')
    expect(html).not.toContain('編集')
    expect(html).toContain('その他操作')
  })

  it('行き先が役割と違うときはラベルを明記できる', () => {
    const html = renderToStaticMarkup(
      <RowActions detail={{ label: '飼い主', href: '/friends/detail?id=f1' }} />,
    )
    expect(html).toContain('飼い主')
    expect(html).toContain('href="/friends/detail?id=f1"')
  })

  it('ソースは共有部品（Button / MoreAction / ActionMenu）だけで組み立てる', () => {
    const src = read('row-actions.tsx')
    expect(src).toContain("'use client'")
    expect(src).toContain("import Button from './button'")
    expect(src).toContain("import ActionMenu, { orderActionMenuItems, type ActionMenuItem } from './action-menu'")
    // 「⋯」は既存の MoreAction トリガーを使い回す。
    expect(src).toContain('<MoreAction')
    // 機能ごとの裸の button 装飾や文字リンクを新たに作らない。
    expect(src).not.toMatch(/text-accent|text-danger[^s]/)
  })

  it('破壊的操作は区切りの後・赤で必ず最後に置く', () => {
    const src = read('row-actions.tsx')
    expect(src).toContain("tone: 'danger'")
    // 並べ替えと区切りは「…」の部品（RowMenu の orderRowMenuItems）が持つ。動きは row-menu.react.test.tsx。
    expect(src).toContain('items={orderRowMenuItems(items)}')
    // destructiveItem を menuItems の後ろへ連結する（途中に挟まない）。
    expect(src).toContain('[...normalItems, { ...destructiveItem')
  })

  it('押せない操作は無効状態と具体的な理由をメニューに出す', () => {
    const html = renderToStaticMarkup(
      <ActionMenu
        open
        inline
        onClose={vi.fn()}
        items={[
          { id: 'del', label: '削除する', tone: 'danger', disabled: true, disabledReason: '公開中のため先に停止してください', onSelect: vi.fn() },
        ]}
      />,
    )
    expect(html).toContain('削除する')
    expect(html).toContain('公開中のため先に停止してください')
    expect(html).toContain('disabled=""')
  })

  it('タッチ端末では「⋯」を含む操作領域を44pxにする', () => {
    const css = read('row-actions.module.css')
    expect(css).toMatch(/@media \(pointer: coarse\)\s*{[^}]*\.action\s*{[^}]*width:\s*44px/s)
    expect(css).toMatch(/@media \(pointer: coarse\)\s*{[^}]*\.action\s*{[^}]*height:\s*44px/s)
  })

  it('操作の並びは縮めず折り返さない', () => {
    const css = read('row-actions.module.css')
    expect(css).toMatch(/\.rowActions\s*{[^}]*white-space:\s*nowrap/s)
    expect(css).toMatch(/\.rowActions\s*{[^}]*position:\s*relative/s)
  })

  it("項目がない行も同じその他操作の入口を持つ", () => {
    const without = renderToStaticMarkup(<RowActions subjectName="送信済み" detail={{ href: '/broadcasts/detail?id=s1' }} />)
    const withMenu = renderToStaticMarkup(<RowActions detail={{ href: '/broadcasts/detail?id=d1' }} menuItems={[{ id: 'copy', label: '複製する', onSelect: vi.fn() }]} />)
    for (const html of [without, withMenu]) {
      expect(html).toContain('data-row-menu')
      expect(html).not.toContain('data-more-placeholder')
    }
  })
})
