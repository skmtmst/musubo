import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'top-bar.tsx'), 'utf8')
const css = readFileSync(join(here, 'top-bar.module.css'), 'utf8')
const appTopBar = readFileSync(join(here, '..', 'shell', 'app-top-bar.tsx'), 'utf8')

describe("管理画面共通トップバー", () => {
  it('押せる要素のキーボードフォーカスを消さない', () => {
    expect(css).toContain(':focus-visible')
    expect(css).not.toMatch(/outline:\s*(?:0|none)/)
  })

  it('統括の画面にもLINEアカウント切替を出す（殻合わせ・絵 V8-B/JKjsE）', () => {
    // 殻合わせ前は統括で札を隠していた（showAccountSwitcher={!isHq}）。
    // 絵どおり統括もふだんの画面も同じ殻にするため、常に付ける。
    expect(source).toContain('showAccountSwitcher = true')
    expect(source).toContain('showAccountSwitcher ? <>')
    expect(appTopBar).toContain('showAccountSwitcher')
    expect(appTopBar).not.toContain('showAccountSwitcher={!isHq}')
  })

  it('V8 の 1152 の帯：札は潰さない・パンくずと自分の名前が縮む', () => {
    expect(css).toMatch(/:root \.accountPill \{[^}]*flex-shrink:\s*0/s)
    expect(css).toMatch(/:root \.crumbCurrent/s)
    expect(css).toMatch(/min-width:\s*0/)
    // 札の縮みを止める指定は共通の器で持つ。
    expect(css).not.toMatch(/^\.accountPill \{[^}]*flex-shrink/m)
  })
})

/*
 * V8 殻合わせ。統括もふだんの画面も同じ帯：
 * ホーム › 画面名・切替札（役割＋名前）・鈴・名前と役割・ログアウト。
 * 役割と名前の配置は共通の帯で持つ。
 */
describe('V8 の帯は絵どおり（殻合わせ）', () => {
  it('パンくずの手前はホーム（格子印＋リンク。統括の画面は統括のホームへ）', () => {
    expect(source).toContain("homeHref = '/'")
    expect(appTopBar).toContain("homeHref={hqShell ? '/hq' : '/'}")
    expect(source).toContain('ホーム')
    expect(source).toContain('crumbHome')
    expect(source).toContain('HomeGridIcon')
  })

  it("切替の札に役割と名前を縦に添える", () => {
    expect(source).toContain('pillText')
    expect(source).toContain('pillRole')
    expect(css).toMatch(/:root \.pillText \{[^}]*flex-direction:\s*column/s)
    expect(css).toMatch(/:root \.pillText \{[^}]*display:\s*flex/s)
  })

  it('自分の名前と役割は現在のV8の縦の並びに固定する', () => {
    expect(source).toContain('identityText')
    expect(css).toMatch(/:root \.identityText \{[^}]*flex-direction:\s*column/s)
    expect(css).toMatch(/:root \.identityText \{[^}]*display:\s*flex/s)
  })

  it('パンくずは「ホーム › 画面名」1回だけ（先頭のホームは重ねない）', () => {
    expect(source).not.toContain('crumbs == null && current')
  })

  it('切替の札は箱の中に小さい字＋名前（外の見出しは畳む）', () => {
    expect(source).toContain('>LINEアカウント<')
    expect(css).toMatch(/:root \.accountField > span:first-child \{[^}]*display:\s*none/s)
    expect(css).toMatch(/:root \.accountPill \{[^}]*height:\s*36px/s)
  })

  it('『前の見た目に戻す』は帯に無い（オーナー指示で廃止）', () => {
    expect(source).not.toContain('前の見た目に戻す')
    expect(source).not.toContain('onRevertTheme')
    expect(css).not.toContain('.revert')
    expect(appTopBar).not.toContain('onRevertTheme')
    expect(appTopBar).not.toContain("applyAdminTheme('v7')")
  })
})
