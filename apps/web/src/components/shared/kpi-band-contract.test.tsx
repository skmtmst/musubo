// @vitest-environment happy-dom

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import KpiBand from './kpi-band'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string) => readFileSync(join(HERE, name), 'utf8')
const readFriends = (name: string) =>
  readFileSync(join(HERE, '..', 'friends', name), 'utf8')

/*
 * 数の帯（Pp3nS・全画面共通）。マス3〜4個を1本の帯にまとめ、
 * マスどうしは隙間0・1px の縦線で区切る。角丸は帯の外側だけ。
 */
describe('数の帯（Pp3nS）', () => {
  it('ListKpis と FriendKpis は包み（KpiBand）で帯として出す', () => {
    expect(read('list-kpis.tsx')).toContain('<KpiBand')
    expect(readFriends('friend-kpis.tsx')).toContain('<KpiBand')
    expect(readFriends('friend-kpis.tsx')).toContain('presentation="band"')
  })

  it('v8 の帯は隙間0・縦線・外側だけ角0・数22', () => {
    const css = read('kpi-card.module.css')
    const strip = css.match(
      /:root \.strip\[data-kpi-presentation='band'\] \{[^}]*\}/s,
    )
    expect(strip, 'v8 の帯の指定がありません').toBeTruthy()
    expect(strip![0]).toMatch(/gap:\s*var\(--tpl-band-gap\)/)
    expect(strip![0]).toMatch(/border-block:\s*1px solid var\(--tpl-band-line\)/)
    expect(strip![0]).toMatch(/border-radius:\s*var\(--radius-none\)/)
    expect(css).toMatch(
      /:root \.strip\[data-kpi-presentation='band'\] > \*:not\(:last-child\) \{[^}]*border-right:\s*1px solid var\(--tpl-band-line\)/s,
    )
    expect(css).toMatch(
      /:root \.strip\[data-kpi-presentation='band'\] \.number \{[^}]*font-size:\s*var\(--tpl-band-number-size\)/s,
    )
  })

  it('数のマスは角0・影なし', () => {
    const css = read('kpi-card.module.css')
    expect(css).toMatch(/:root \.strip\[data-kpi-presentation='band'\] \.card \{[^}]*border-radius:\s*var\(--radius-none\)/s)
  })

  it('v8 の単位（件・通）は 12px', () => {
    const css = read('kpi-card.module.css')
    expect(css).toMatch(/:root \.unit \{[^}]*font-size:\s*12px/s)
  })

  it('包み（KpiBand）は帯の印を持ち、並べ方は呼び出し側のまま', () => {
    const html = renderToStaticMarkup(<KpiBand gridClassName="custom-grid"><span>数</span></KpiBand>)
    expect(html).toContain('data-kpi-strip')
    expect(html).toContain('data-kpi-presentation="band"')
    expect(html).toContain('custom-grid')
  })

  it('隣に線が無い所はカードの枠を指定できる', () => {
    const html = renderToStaticMarkup(<KpiBand frame="card"><span>数</span></KpiBand>)
    expect(html).toContain('data-kpi-frame="card"')
  })

  it('帯の指定は層の外にある（ユーティリティ層の gap 等に勝つ）', () => {
    const css = read('kpi-card.module.css')
    const marker = 'どの層より強い'
    expect(css).toContain(marker)
    const unlayered = css.split(marker)[1] ?? ''
    expect(unlayered).toContain(":root .strip[data-kpi-presentation='band']")
    expect(unlayered).not.toContain('@layer')
  })

  it('折りたたみ（KpiCollapse）も帯として出す', () => {
    const collapse = readFileSync(join(HERE, '..', 'ui', 'kpi-collapse.tsx'), 'utf8')
    expect(collapse).toContain('data-kpi-presentation="band"')
  })

  it('印なしの帯（data-kpi-strip）もv8では横一列・隙間0', () => {
    const css = read('kpi-band-v8.css')
    const bare = css.match(/:root \[data-kpi-strip\] \{[^}]*\}/s)
    expect(bare, 'data-kpi-strip の横並びがありません').toBeTruthy()
    expect(bare![0]).toMatch(/display:\s*grid/)
    expect(bare![0]).toMatch(/grid-auto-flow:\s*column/)
    expect(bare![0]).toMatch(/grid-auto-columns:\s*minmax\(0,\s*1fr\)/)
    expect(bare![0]).toMatch(/gap:\s*var\(--tpl-band-gap\)/)
    expect(bare![0]).not.toMatch(/grid-template-columns/)
  })
})
