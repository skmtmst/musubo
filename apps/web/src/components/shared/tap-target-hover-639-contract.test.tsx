import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import FilterChip from './filter-chip'
import Pagination from './pagination'
import { RowActions } from './row-actions'
import { Tabs } from './tabs'

/*
 * #639 タップ高さ・ホバーの契約。
 *
 * 監査5の指摘: ピル/フィルタ/補助リンクが 20〜32px でタップ推奨 44px を
 * 下回り、16画面で主要ボタンのホバー前後が不変だった。
 *
 * 規則（共通部品レベルで固定・段階適用の土台）:
 *   - 主要操作の最小高さは 32px、推奨 36px 以上は部品側で持つ
 *     （共通 Button 40px・ページネーション 38px・行内アイコン 32px・
 *     タブ 44px）。素のボタンはベースCSSの `min-height: 32px` で拾う。
 *   - タッチ端末（`pointer: coarse`）は 44px を確保する。
 *   - ホバー演出は `@media (hover: hover) and (pointer: fine)` の中に
 *     だけ書く（タップ後にホバーが残らないように）。
 *
 * 対象外の明示: スイッチ（`role="switch"`）は 20px の軌道とつまみの
 * 比率が決まっているため、高さだけ伸ばさない。ページネーションの
 * 表記統一は #667、フィルターバーの構成統一は #668 の範囲。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')
const readShared = (name: string) => readFileSync(join(HERE, name), 'utf8')
const readApp = (name: string) => readFileSync(join(SRC, 'app', name), 'utf8')
const GLOBALS = readShared('../../app/globals.css')
/** 注釈を落としたベースCSS。宣言だけを見る。 */
const GLOBALS_CODE = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '')

describe('#639 主要操作の最小高さ 32px', () => {
  it('素のボタンはベース層で 32px を下回らない（高い部品はそのまま）', () => {
    expect(GLOBALS_CODE).toMatch(/button:not\(\[role="switch"\]\),\s*\[role="button"\]\s*\{\s*min-height:\s*32px;/)
  })

  it('行内ボタン・チップ・ページネーションは 32px 以上を部品側で持つ', () => {
    // 行内アイコン操作 32px（Pencil K65Uhe・Ls12y・H0V8EK の寸法）。
    expect(readShared('row-actions.module.css')).toMatch(/\.action\s*\{[^}]*height:\s*32px/s)
    // 札の高さ・折り返しとタッチ44pxは shared-surface-layout の実描画で確かめる。
    // ページネーションは推奨 36px 以上（38px）。
    expect(readShared('pagination.module.css')).toMatch(/\.item\s*\{[^}]*height:\s*32px/s)
    // タブは 44px。
    expect(readShared('tabs.module.css')).toMatch(/:root \.list \.tab\.tab\s*\{[^}]*height:\s*var\(--tpl-tabs-h\)/s)
    // 共通ボタンの標準は 40px。
    expect(readShared('button.module.css')).toMatch(/:root \.standard,\s*:root \.field\s*\{[^}]*height:\s*var\(--tpl-button-h\)/s)
  })

  it('画像タイルのお気に入り星は現役の板の24pxを使う', () => {
    const list = readFileSync(join(SRC, 'v8', 'hq-banners', 'list.tsx'), 'utf8')
    const css = readFileSync(join(SRC, 'v8', 'hq-banners', 'list.module.css'), 'utf8')
    expect(list).toContain("aria-label={image.isFavorite ? 'お気に入りから外す' : 'お気に入りにする'}")
    expect(list).toContain('<IconButton size="small" variant="plain"')
    expect(readShared('icon-button.module.css')).toContain("[data-size='small']")
    expect(GLOBALS_CODE).toMatch(/--tpl-hb-star:\s*24px/)

  })
})

describe('#639 タッチ端末は 44px', () => {
  it('ベース層で素のボタンを 44px にする（スイッチは除く）', () => {
    expect(GLOBALS_CODE).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*button:not\(\[role="switch"\]\),\s*\[role="button"\]\s*\{\s*min-height:\s*44px;/,
    )
  })

  it('行内操作・チップ・ページネーション・汎用アイコンは部品側で 44px', () => {
    expect(readShared('row-actions.module.css')).toMatch(
      /@media \(pointer: coarse\)\s*\{[^}]*\.action\s*\{[^}]*height:\s*44px/s,
    )
    expect(readShared('filter-chip.css')).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.v6-filter-chip\s*\{\s*min-height:\s*44px;/,
    )
    expect(readShared('pagination.module.css')).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.item\s*\{\s*min-height:\s*44px;/,
    )
    expect(readShared('icon-button.module.css')).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.button\s*\{[^}]*height:\s*44px/s,
    )
  })
})

describe('#639 ホバーは hover:hover かつ pointer:fine の中にだけ書く', () => {
  it('素のボタンと文字リンクに代替の視覚反応がある', () => {
    expect(GLOBALS_CODE).toContain('@media (hover: hover) and (pointer: fine)')
    // 背景の無い素の文字ボタンだけが変わる。背景もホバーも持つ部品は
    // 層の順序でそちらが勝つ。
    expect(GLOBALS_CODE).toMatch(
      /button:not\(:disabled, \[role="switch"\]\):hover,[\s\S]*?background-color:\s*var\(--color-canvas-sunken\)/,
    )
    // 文字リンクは操作色で応答する（枠付きボタン状リンクに線を入れない）。
    expect(GLOBALS_CODE).toMatch(/a:hover\s*\{\s*color:\s*var\(--color-action-hover\);\s*\}/)
  })

  it('transition: all を使わない（#648の教訓）', () => {
    expect(GLOBALS_CODE).not.toMatch(/transition(?:-property)?\s*:\s*all\b/)
  })

  it('背景色付きの主要ボタンは自前のホバー変化を持つ', () => {
    // ★管理画面 1920px見直し: 予約スタッフの保存口は共通 Button primary へ寄せた。
    // 塗りのままなのでホバー変化は要るが、持ち主は共通 Button（brightness で沈む）。
    expect(readApp('booking/menus/staff/page.tsx')).toContain('variant="primary"')
    // V8 移行 ①: 緊急停止の操作は共通 Button へ。塗りとホバー（brightness）の
    // 持ち主は共通部品で、画面側は寸法の指定だけを持つ。
    expect(readApp('../v8/settings/emergency/health.tsx')).toContain('variant="secondary"')
    const buttonCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'button.module.css'), 'utf8')
    expect(buttonCss).toContain('.secondary:hover:not(:disabled)')
    expect(buttonCss).toContain('min-height:')
    // 流入経路モーダル・プールは brightness で沈む（生の色を増やさない）。
    // 2026-09-25: 白字 3.77:1 の bg-emerald-600 を bg-success（5.61:1）へ。
    // 見張りはホバー変化の有無（意図は変えない）。
    expect(readApp('../v8/inflow-links/genre-dialog.tsx')).toContain('onConfirm={() => save()}')
    // ★管理画面 C5: 流入リンク編集窓は共通 Dialog＋Button primary へ寄せた。ホバー変化は共通 Button が持つ。
    expect(readApp('../v8/inflow-links/edit-route-dialog.tsx')).toContain('variant="primary"')
    expect(readApp('../v8/settings/pools/pools.tsx')).toContain('variant="primary"')
    // 白地の枠付き口は沈み色へ、淡色ピルは brightness で応答する。
    // V8 移行 ①: 白地の枠付き口は共通 Button secondary へ。沈み色は部品が持つ。
    expect(readFileSync(join(HERE, '../../v8/tags/folder-page.tsx'), 'utf8')).toContain('<FolderEditorDialog')
    expect(readApp("booking/bookings/booking-calendar.tsx")).toContain('bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-deep hover:brightness-95')
  })
})

describe('#639 高さ規則は本物の操作部品に載る（実React描画）', () => {
  it('絞り込み札は押せるボタンとして描かれる', () => {
    const html = renderToStaticMarkup(
      <FilterChip selected={false} onChange={vi.fn()}>
        未対応
      </FilterChip>,
    )
    expect(html).toContain('<button')
    expect(html).toContain('v6-filter-chip')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('未対応')
  })

  it('ページ送りは nav の中に実ボタンを並べる', () => {
    const html = renderToStaticMarkup(<Pagination page={2} pageCount={5} onPageChange={vi.fn()} />)
    expect(html).toContain('<nav aria-label="ページ送り"')
    expect(html).toContain('aria-label="前のページ"')
    expect(html).toContain('aria-label="次のページ"')
    expect(html).toContain('aria-current="page"')
  })

  it('行内操作の編集は「…」へ入る', () => {
    const html = renderToStaticMarkup(
      <RowActions
        subjectName="来店お礼"
        detail={{ href: '/templates/detail?id=t1' }}
        edit={{ onClick: vi.fn() }}
      />,
    )
    expect(html).toContain('詳細')
    expect(html).not.toContain('編集')
    expect(html).toContain('来店お礼のその他操作')
    expect(html).toMatch(/<(button|a)\b/)
  })

  it('タブは行き先つきリンクと操作ボタンを描き分ける', () => {
    const html = renderToStaticMarkup(
      <Tabs
        items={[
          { label: 'すべて', href: '/friends', current: true },
          { label: '未対応', count: 3, onClick: vi.fn() },
        ]}
      />,
    )
    expect(html).toContain('<nav')
    expect(html).toContain('未対応')
    expect(html).toContain('<span')
    expect(html).toContain('3')
  })
})
