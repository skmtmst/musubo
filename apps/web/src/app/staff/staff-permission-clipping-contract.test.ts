import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/*
 * #983 追加監査 LAY-07〜10: ログインユーザーの権限詳細（EOTS4）が
 * 狭い幅で潰れ・説明が固定文・保存バーが画面外だった問題の契約。
 *
 * - LAY-07: `minmax(0,1fr) 390px` と `repeat(3, 140px)` の全幅固定をやめ、
 *   狭い幅は1列・各機能カード化。PCは設定欄に十分な幅がある時だけ2列。
 * - LAY-08: 保存バーの左端を `var(--sidebar-width)` 固定からやめ、
 *   ビュー幅に追従（狭い幅は全幅、PCはメニュー実在幅だけ左余白）。
 * - LAY-09: 右欄の説明は選択中の権限データから生成し、人数は実データ接続。
 * - LAY-10: 「つながる先」は見た目だけの p ではなく実リンク。
 */

const directory = dirname(fileURLToPath(import.meta.url))
const staffSource = readFileSync(join(directory, 'page.tsx'), 'utf8')

describe('LAY-07: 権限詳細の設定欄が狭い幅で潰れない', () => {
  it('設定と説明の2列は全幅固定ではなく、十分な幅の時だけにする', () => {
    expect(staffSource).not.toContain("gridTemplateColumns: 'minmax(0, 1fr) 390px'")
    expect(staffSource).toContain('styles.scopeGrid')
  })

  it('選択列の `repeat(3, 140px)` 固定をやめ、機能ごとのカードにする', () => {
    expect(staffSource).not.toContain('repeat(3, 140px)')
    expect(staffSource).not.toContain('1.45fr repeat(3, 140px) 1.2fr')
    // 各選択肢は触れる高さ（44px以上）を持つ
    expect(staffSource).toContain('min-h-11')
  })
})

describe('LAY-08: 保存バーが画面外へ逃げない', () => {
  it('画面ごとの固定座標を置かず、共通の追従帯へ配置を委ねる', () => {
    expect(staffSource).not.toContain('var(--sidebar-width')
    expect(staffSource).not.toContain('fixed inset-x-0 bottom-0')
  })

  it('バーの高さを固定せず、下部はキャンセルと保存に絞る', () => {
    expect(staffSource).not.toContain('height: 72')
    expect(staffSource).toContain('見せる範囲を保存する')
    expect(staffSource).toContain('キャンセル')
  })
})

describe('LAY-09: 権限の説明が現在の設定と連動する', () => {
  it('固定の項目数・固定の人数を置かず、選択中の権限データから生成する', () => {
    expect(staffSource).not.toContain('サイドメニューに出るのは4項目')
    expect(staffSource).not.toContain("'2人', 'すべての設定と操作'")
    expect(staffSource).not.toContain("'4人', '配信と日々の運用'")
    expect(staffSource).toContain('visibleItems.length')
    expect(staffSource).toContain('hiddenItems.length')
    expect(staffSource).toContain('roleCounts[value]')
  })

  it('取れない項目は「未確認」と出し、未保存の変更は「変更後の予定」と分かる', () => {
    expect(staffSource).toContain('未確認')
    expect(staffSource).toContain('変更後の予定')
  })
})

describe('LAY-10: 「つながる先」は実リンクにする', () => {
  it('リンク外見の p 要素をやめ、href を持つ Link にする', () => {
    expect(staffSource).not.toContain('<p className="font-bold text-action">→')
    for (const href of ['/settings', '/staff?tab=audit', '/emergency', '/booking/menus']) {
      expect(staffSource).toContain(`href="${href}"`)
    }
  })
})
