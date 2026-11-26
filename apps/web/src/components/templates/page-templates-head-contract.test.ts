import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(HERE, 'page-templates.module.css'), 'utf8')
/* 変数の定義場所は app/globals.css の :root（module の pure 検査に当たらない層）。 */
const globals = readFileSync(join(HERE, '..', '..', 'app', 'globals.css'), 'utf8')

/*
 * 型の見出しの既定は379板の絵どおり。
 * 題 22px/700/行32・間 4px・説明 13px/行19・上の余白 20。
 * 小さい「部品どおり」（EnlYo）は compact の変わり形に残す。
 * regular と未指定は既定（22/32）と同じにする。
 * 管理画面 には効かない（すべて data-theme v8 限定）。
 */
describe('型の見出し（379板の絵）', () => {
  it('寸法は先頭の変数に1か所まとめ・値は絵どおり', () => {
    const vars = globals.match(/:root \{[^}]*--tpl-head-pad-top[^}]*\}/s)
    expect(vars, '変数の一覧がありません').toBeTruthy()
    for (const [name, value] of [
      ['--tpl-head-pad-top', '16px'], ['--tpl-head-pad-side', 'var(--polish-space-section)'], ['--tpl-head-pad-bottom', '8px'],
      ['--tpl-title-size', 'var(--polish-text-page-title)'], ['--tpl-title-weight', '600'], ['--tpl-title-lh', '40px'],
      ['--tpl-head-gap', 'var(--polish-space-row)'], ['--tpl-desc-size', 'var(--polish-text-body)'], ['--tpl-desc-lh', '19px'],
      ['--tpl-toolbar-pad-block', '14px'], ['--tpl-toolbar-pad-side', '24px'], ['--tpl-toolbar-gap', '8px'],
      ['--tpl-folder-width', '200px'],
      ['--tpl-page-pad-block', '10px'], ['--tpl-page-pad-side', '24px'],
      // 数の帯の寸法はcontrol-feedbackの実ブラウザで、適用された値と操作を検証する。
      ['--tpl-create-head-pad-top', 'var(--tpl-head-pad-top)'], ['--tpl-create-head-pad-side', '24px'], ['--tpl-create-head-pad-bottom', 'var(--tpl-head-pad-bottom)'],
      ['--tpl-create-head-gap', '8px'],
      ['--tpl-detail-head-pad-top', 'var(--tpl-head-pad-top)'], ['--tpl-detail-head-pad-side', '24px'], ['--tpl-detail-head-pad-bottom', 'var(--tpl-head-pad-bottom)'],
      ['--tpl-detail-head-gap', '12px'], ['--tpl-detail-actions-gap', '6px'], ['--tpl-detail-tabs-pad-bottom', '12px'],
      ['--tpl-create-content-pad-block', 'var(--polish-space-section)'], ['--tpl-create-content-pad-side', 'var(--polish-space-section)'], ['--tpl-create-content-gap', 'var(--polish-space-card)'],
      ['--tpl-section-pad', 'var(--polish-space-section)'], ['--tpl-section-gap', 'var(--polish-space-field)'],
      ['--tpl-preview-pad', '24px'], ['--tpl-preview-narrow-width', '280px'],
      ['--tpl-detail-content-gap', '20px'],
      ['--tpl-footer-pad-block', '12px'], ['--tpl-footer-pad-side', '24px'], ['--tpl-footer-gap', '8px'],
      ['--tpl-settings-nav-width', '208px'], ['--tpl-settings-nav-pad-block', '16px'], ['--tpl-settings-nav-pad-side', '12px'],
      ['--tpl-settings-content-pad-block', '24px'], ['--tpl-settings-content-pad-side', '24px'], ['--tpl-settings-content-gap', '16px'],
      ['--tpl-settings-gap', '16px'],
      ['--tpl-inbox-list-width', '372px'], ['--tpl-inbox-summary-width', '320px'],
      ['--tpl-inbox-summary-pad', '20px'], ['--tpl-inbox-summary-gap', '16px'],
      ['--tpl-conv-head-pad-block', '12px'], ['--tpl-conv-head-pad-side', '20px'], ['--tpl-conv-head-gap', '8px'],
      ['--tpl-conv-messages-pad-block', '20px'], ['--tpl-conv-messages-pad-side', '24px'], ['--tpl-conv-messages-gap', '12px'],
      ['--tpl-composer-pad-top', '12px'], ['--tpl-composer-pad-side', '20px'], ['--tpl-composer-pad-bottom', '16px'],
      ['--tpl-composer-gap', '8px'],
    ] as const) {
      expect(vars![0]).toMatch(new RegExp(`${name}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    }
  })

  it('既定は変数だけを使う（題・間・説明・上余白）', () => {
    expect(css).toMatch(/\.title \{[^}]*font-size:\s*var\(--tpl-title-size\)/s)
    expect(css).toMatch(/\.title \{[^}]*font-weight:\s*var\(--tpl-title-weight\)/s)
    expect(css).toMatch(/\.title \{[^}]*line-height:\s*var\(--tpl-title-lh\)/s)
    expect(css).toMatch(/\.headingText \{[^}]*gap:\s*var\(--tpl-head-gap\)/s)
    expect(css).toMatch(/\.description \{[^}]*font-size:\s*var\(--tpl-desc-size\)/s)
    expect(css).toMatch(/\.description \{[^}]*line-height:\s*var\(--tpl-desc-lh\)/s)
    expect(css).toMatch(/\.heading \{[^}]*padding:\s*var\(--tpl-head-pad-top\) var\(--tpl-head-pad-side\) var\(--tpl-head-pad-bottom\)/s)
    expect(css).not.toMatch(/> \.heading \{[^}]*padding-bottom/s)
  })

  it('compact は部品どおり（題20/27・間2・説明13/20）', () => {
    expect(css).toMatch(/heading-size='compact'.*?\.title \{[^}]*font-size:\s*var\(--tpl-compact-title-size\)/s)
    expect(css).toMatch(/heading-size='compact'.*?\.title \{[^}]*line-height:\s*var\(--tpl-compact-title-lh\)/s)
    expect(css).toMatch(/heading-size='compact'.*?\.headingText \{[^}]*gap:\s*var\(--tpl-compact-gap\)/s)
    expect(css).toMatch(/heading-size='compact'.*?\.description \{[^}]*line-height:\s*var\(--tpl-compact-desc-lh\)/s)
  })

  it('regular は既定と同じ（小さい題20pxの指定を持たない）', () => {
    expect(css).not.toMatch(/heading-size='regular'\] \.title \{[^}]*font-size:\s*20px/s)
    expect(css).not.toMatch(/heading-size='regular'\] \.headingText \{[^}]*gap:\s*2px/s)
  })

  it('一覧の頭は下余白12・帯は頭の直下（頭の高さ87）', () => {
    expect(css).toMatch(/\.heading \{[^}]*padding:\s*var\(--tpl-head-pad-top\) var\(--tpl-head-pad-side\) var\(--tpl-head-pad-bottom\)/s)
    expect(css).toMatch(/\.stats \{[^}]*border:\s*0/s)
    const stats = css.match(/\.stats \{[^}]*\}/)
    expect(stats, '一覧の帯の枠がありません').toBeTruthy()
    expect(stats![0]).not.toMatch(/margin|padding-top/)
  })

  it('行の高さは現在のV8の1.5に固定し、旧値を残さない', () => {
    for (const name of ['--text-caption--line-height', '--text-label--line-height', '--text-body--line-height']) {
      const block = globals.match(new RegExp(`:root \\{[^}]*${name}:\\s*1\\.5`, 's'))
      expect(block, `${name} が v8 にありません`).toBeTruthy()
    }
    expect(globals).not.toMatch(/--text-caption--line-height:\s*1\.6/)
    expect(globals).not.toMatch(/--text-body--line-height:\s*1\.7/)
  })

  it('作る型の頭は20/24/16・間8・手順は題と説明の下の行（置き場所は1つ・q1xNMz）', () => {
    expect(css).toMatch(/\[data-page-template='create'\] \.heading \{[^}]*padding:\s*var\(--tpl-create-head-pad-top\) var\(--tpl-create-head-pad-side\) var\(--tpl-create-head-pad-bottom\)/s)
    expect(css).toMatch(/\[data-page-template='create'\] \.heading \{[^}]*gap:\s*var\(--tpl-create-head-gap\)/s)
    expect(css).toMatch(/\[data-page-template='create'\] \.heading > \.steps \{[^}]*flex-basis:\s*100%/s)
    expect(css).not.toMatch(/data-steps-placement/)
    expect(css).not.toMatch(/\[data-page-template='create'\] \.heading \{[^}]*padding-block:\s*16px/s)
  })

  /*
   * 承認済み ★BG-B `qIp42`：来た道の案内（`HLq5w` y=100・`Y5UR7`）と操作のボタン（`e3LG3u` y=99）が
   * 同じ行で、題（y=24）と説明（y=57）はその上の行。crumbs を渡した一覧の頭だけ2段にする。
   */
  it('一覧の頭に来た道の案内を渡したときだけ、題を全幅にして案内と操作を下の行へ並べる', () => {
    expect(css).toMatch(/\.heading\[data-has-crumbs\] > \.headingText \{[^}]*flex-basis:\s*100%/s)
    expect(css).toMatch(/\.heading > \.crumbs \{[^}]*order:\s*2/s)
    expect(css).toMatch(/\.heading\[data-has-crumbs\] > \.actions \{[^}]*order:\s*3/s)
    expect(css).toMatch(/\.heading\[data-has-crumbs\] > \.actions \{[^}]*margin-left:\s*auto/s)
  })

  it('詳細の頭は20/24/16・間12・操作の間6・タブは下の行', () => {
    expect(css).toMatch(/\[data-page-template='detail'\] \.heading \{[^}]*padding:\s*var\(--tpl-detail-head-pad-top\) var\(--tpl-detail-head-pad-side\) var\(--tpl-detail-head-pad-bottom\)/s)
    expect(css).toMatch(/\[data-page-template='detail'\] \.actions \{[^}]*gap:\s*var\(--tpl-detail-actions-gap\)/s)
    expect(css).toMatch(/\[data-page-template='detail'\] \.tabs \{[^}]*padding-bottom:\s*var\(--tpl-detail-tabs-pad-bottom\)/s)
    expect(css).toMatch(/\.detailContent \{[^}]*gap:\s*var\(--tpl-detail-content-gap\)/s)
  })

  it('作る・詳細の中身と右の列は変数だけ（左24/28・間16・右24・900の板は280）', () => {
    expect(css).toMatch(/\.createContent \{[^}]*padding:\s*var\(--tpl-create-content-pad-block\) var\(--tpl-create-content-pad-side\)/s)
    expect(css).toMatch(/\.createContent \{[^}]*gap:\s*var\(--tpl-create-content-gap\)/s)
    expect(css).toMatch(/\.section \{[^}]*padding:\s*var\(--tpl-section-pad\)/s)
    expect(css).toMatch(/\.section \{[^}]*gap:\s*var\(--tpl-section-gap\)/s)
    expect(css).toMatch(/\.preview \{[^}]*padding:\s*var\(--tpl-preview-pad\)/s)
    expect(css).toMatch(/\.preview \{[^}]*width:\s*var\(--tpl-preview-narrow-width\)/s)
  })

  it('保存の帯は採用 A-1 の浮いた帯（下から12・左右12の余白＝絵の下の帯 left 12。オーナー 2026-10-04 採用。sticky-bar-contract が形を固定）', () => {
    const footer = css.match(/\.footer \{[^}]*\}/s)
    expect(footer, '型の保存の帯がありません').toBeTruthy()
    expect(footer![0]).toMatch(/bottom:\s*12px/)
    expect(footer![0]).toMatch(/margin:\s*12px var\(--tpl-fx4-footer-inset\)/)
    expect(globals).toMatch(/--tpl-fx4-footer-inset: 12px;/)
  })

  it('設定はメニュー208・内側16/12・中身24/28・間16', () => {
    expect(css).toMatch(/\.settingsNav \{[^}]*width:\s*var\(--tpl-settings-nav-width\)/s)
    expect(css).toMatch(/\.settingsNav \{[^}]*padding:\s*var\(--tpl-settings-nav-pad-block\) var\(--tpl-settings-nav-pad-side\)/s)
    expect(css).toMatch(/\.settingsContent \{[^}]*padding:\s*var\(--tpl-settings-content-pad-block\) var\(--tpl-settings-content-pad-side\)/s)
    expect(css).toMatch(/\.settingsContent \{[^}]*gap:\s*var\(--tpl-settings-content-gap\)/s)
    expect(css).toMatch(/\.settings \{[^}]*gap:\s*var\(--tpl-settings-gap\)/s)
  })

  it('受信箱は列372・会話・要点260・会話の頭と書く欄は変数', () => {
    expect(css).toMatch(/\.inboxList \{[^}]*width:\s*var\(--tpl-inbox-list-width\)/s)
    expect(css).toMatch(/\.inboxSummary \{[^}]*width:\s*var\(--tpl-inbox-summary-width\)/s)
    expect(css).toMatch(/\.inboxSummary \{[^}]*padding:\s*var\(--tpl-inbox-summary-pad\)/s)
    expect(css).toMatch(/\.inboxSummary \{[^}]*gap:\s*var\(--tpl-inbox-summary-gap\)/s)
    expect(css).toMatch(/\.conversationHeader \{[^}]*padding:\s*var\(--tpl-conv-head-pad-block\) var\(--tpl-conv-head-pad-side\)/s)
    expect(css).toMatch(/\.messages \{[^}]*padding:\s*var\(--tpl-conv-messages-pad-block\) var\(--tpl-conv-messages-pad-side\)/s)
    expect(css).toMatch(/\.messages \{[^}]*gap:\s*var\(--tpl-conv-messages-gap\)/s)
    expect(css).toMatch(/\.composer \{[^}]*padding:\s*var\(--tpl-composer-pad-top\) var\(--tpl-composer-pad-side\) var\(--tpl-composer-pad-bottom\)/s)
  })

  it('large の説明に絵に無い 12/18 を使わない', () => {
    const large = css.match(/heading-size='large'\] \.description \{[^}]*\}/)
    expect(large, 'large の説明がありません').toBeTruthy()
    expect(large![0]).toMatch(/font-size:\s*var\(--tpl-desc-size\)/)
    expect(large![0]).toMatch(/line-height:\s*var\(--tpl-desc-lh\)/)
  })
})
