import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')
const SIDEBAR = readFileSync(join(HERE, 'sidebar.tsx'), 'utf8')
const SIDEBAR_CSS = readFileSync(join(HERE, 'sidebar.module.css'), 'utf8')
const APP_SHELL_CSS = readFileSync(join(SRC, 'components', 'app-shell.module.css'), 'utf8')
const TOP_BAR = readFileSync(join(SRC, 'components', 'shell', 'app-top-bar.tsx'), 'utf8')
const GLOBALS = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')

/*
 * #975 U037/U038: 1280px 未満では固定のハンバーガーヘッダーが
 * PC用の上部バー（画面名・アカウント切替）に重なり、画面名が
 * 読めなかった。さらに本文の上余白がヘッダー高さと別管理で、
 * 二重の空白ができていた。
 *
 * 直し方: 現在地をモバイルヘッダーへ統合し、1280px 未満では上部バーを
 * 畳む。ヘッダー高さと本文のオフセットは --mobile-header-height 1つで
 * 管理する。共通部品（components/shared/）はこの案件の所有外なので、
 * 畳む指定はシェル側の scoped style で行う。
 */
describe('モバイル固定ヘッダーと現在地（#975 U037/U038）', () => {
  it('モバイルヘッダーが現在地（画面名）を持つ', () => {
    expect(SIDEBAR).toContain('styles.mobileTitle')
    // 長いタイトルは省略し、全文は title で読める。
    expect(SIDEBAR_CSS).toContain('text-overflow: ellipsis')
  })

  it('1280px 未満では上部バーを畳み、2本のヘッダーを同時に占有させない', () => {
    // TopBar を無印の div で包んで畳む。部品側の display（CSS Module）に
    // utilities の hidden が負けないよう、TopBar 自身には乗せない。
    // v8-topbar-wrap は ★V8 で 1024px から帯を出すための印（globals.css）。
    expect(TOP_BAR).toContain('className="hidden xl:block v8-topbar-wrap"')
    expect(APP_SHELL_CSS).toContain('@media (max-width: 1279.98px)')
  })

  it('ヘッダー高さと本文のオフセットは1つのトークンで管理する', () => {
    expect(GLOBALS).toContain('--mobile-header-height')
    expect(SIDEBAR_CSS).toContain('height: var(--mobile-header-height)')
    expect(APP_SHELL_CSS).toContain('padding-top: var(--mobile-header-height)')
    // 旧来の固定値の二重計上（72px ベタ書き + content の上余白）は残さない。
    expect(APP_SHELL_CSS).not.toContain('padding-top: 72px')
  })

  it('モバイルでもアカウント一覧の失敗帯は畳まない', () => {
    // 畳むのは TopBar 本体だけ。失敗帯は畳む枠（`hidden xl:block`）の外に出す。
    expect(TOP_BAR).toContain('accountsLoadFailed')
    expect(TOP_BAR.indexOf('hidden xl:block')).toBeLessThan(TOP_BAR.indexOf('{accountsLoadFailed ?'))
    expect(TOP_BAR.indexOf('</div>')).toBeLessThan(TOP_BAR.indexOf('{accountsLoadFailed ?'))
  })
})
