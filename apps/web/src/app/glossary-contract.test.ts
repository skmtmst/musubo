import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { terms, termsAvoid } from '@/lib/terms'

const SRC = path.join(__dirname, '..')

/** 画面のコードを、`.test.` を除いて集める。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/**
 * 注釈と、機械が読む値を落とす。
 *
 * 見張りたいのは**画面に出る言葉**だけ。
 * 「なぜ『対応済』をやめたか」を書いた注釈が自分の見張りに当たると、
 * 直したのに落ちるという嘘の失敗になる。
 * `resolved` のような API の値も画面には出ないので対象外。
 */
function visible(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const FILES = sources(SRC).map((p) => ({ p: path.relative(SRC, p), s: visible(fs.readFileSync(p, 'utf8')) }))

/** `docs/管理画面-requirements/管理画面-00-glossary.md` の1〜2節。使うほうを左に書く。 */
const BANNED: Array<{ use: string; avoid: RegExp; why: string }> = [
  { use: 'すべて', avoid: /全て/, why: '要件書が93対5で「すべて」' },
  { use: '対応済み', avoid: /対応済(?!み)/, why: '未対応・対応中・保留と語尾をそろえる' },
  { use: '友だち', avoid: /友達/, why: '要件書467か所すべて「友だち」' },
  { use: '絞り込み', avoid: /絞込/, why: '名詞を圧縮しない' },
  { use: '未割り当て', avoid: /未割当(?!て)/, why: '同上' },
  { use: 'アカウント', avoid: /アカ(?![ウ])/, why: '省略語を開く' },
]

describe("用語表（管理画面 §7 48番の表記ゆれ潰し）", () => {
  for (const { use, avoid, why } of BANNED) {
    it(`画面には「${use}」を出す（${why}）`, () => {
      const hits = FILES.filter((f) => avoid.test(f.s)).map((f) => f.p)
      expect(hits, `「${use}」に直す: ${hits.join(', ')}`).toEqual([])
    })
  }

  /**
   * **固定の4状態と、自由分類のマークは別物。**
   *
   * 要件書 `管理画面-02-inbox-requirements-draft.md:77`
   *   「管理画面画面の『対応マーク』は、実装時に『対応状況』へ変更する。
   *     タグの対応マークは右パネル内の別項目として表示する。」
   *
   * 見分け方は API の形。`chatStatus` / `status` が
   * unread・in_progress・on_hold・resolved を取るものは**対応状況**。
   * `support_mark` / `markId` を扱うものが**対応マーク**。
   */
  it('固定4状態を「対応マーク」と呼ばない', () => {
    const FIXED_STATE = [
      'app/chats/page.tsx',
      'app/friends/detail/page.tsx',
      'components/chats/inbox-dropdown.tsx',
      'components/chats/inbox-filter-panel.tsx',
      'components/chats/friend-info-sidebar.tsx',
      'components/friends/single-friend-actions.tsx',
      'components/friends/advanced-search-dialog.tsx',
      'components/dashboard/side-cards.tsx',
      'v8/dashboard/dashboard-editor.tsx',
    ]
    for (const rel of FIXED_STATE) {
      const f = FILES.find((x) => x.p === rel)
      expect(f, `${rel} が見つからない`).toBeDefined()
      // side-cards は一覧名、詳細検索は自由分類の support mark 軸なので、その箇所だけ許す。
      const body = rel === 'components/dashboard/side-cards.tsx'
        ? f!.s.replace(/対応マーク一覧/g, '')
        : rel === 'components/friends/advanced-search-dialog.tsx'
          ? f!.s.replace("{ label: '対応マーク',", '')
          : f!.s
      expect(body.includes('対応マーク'), `${rel}: 固定4状態は「対応状況」と呼ぶ`).toBe(false)
    }
  })

  /**
   * **期間の言い方を1つにする。**
   *
   * 同じ30日を「直近30日」「過去30日」「この30日」の3通りで書いていた。
   * 2026-10-09 オーナー決定（ の 5・ の ⑦）で「過去30日」に1つ
   * （用語表 `docs/管理画面-requirements/管理画面-00-glossary.md` §3-3）。前の「この30日に寄せる」と
   * Webhook・マイルの「直近30日」（WEB-025・WEB-073）はこの決定で置き換え。
   *
   * 2026-10-09 時点で古い言い方が残っているファイルは、下の「直す途中」に入れてある。
   * 直したら一覧から外す。一覧に無いファイルが古い言い方を足すと落ちる。
   */
  it('30日の窓は「過去30日」と書く', () => {
    /* 直す途中（2026-10-09 時点で「この30日」「直近30日」が画面に残るファイル）。 */
    const migrating = new Set([
    'app/booking/menus/page.tsx',
    'app/common-actions/versions/page.tsx',
    'app/emergency/page.tsx',


    'app/line-notifications/page.tsx',
    'app/mileage/page.tsx',
    'v8/nen-campaigns/list.tsx',
    'app/nen-members/photo-review-v8.tsx',
    'v8/restaurant/google/reviews.tsx',
    'app/visual-qa/v8-parts/page.tsx',
    'components/broadcasts/segment-preset-controls.tsx',
    'components/staff/login-audit.tsx',
    'v8/auto-replies/runs.tsx',
    'v8/automations/list.tsx',
    'v8/automations/runs.tsx',
    'v8/automations/templates.tsx',
    'v8/conversions/create.tsx',
    'v8/conversions/dialogs.tsx',
    'v8/conversions/list.tsx',
    'v8/inflow-links/ad-connections.tsx',
    'v8/inflow-links/ads.tsx',
    'v8/inflow-links/site-script.tsx',
    'v8/mileage/balances.tsx',
    'v8/mileage/earning-rule-new/create.tsx',
    'v8/mileage/earning-rules.tsx',
    'v8/mileage/history.tsx',
    'v8/nen-health/summary.tsx',
    'v8/restaurant/google/reviews.tsx',
    'v8/settings/ec-commerce/connector.tsx',
    'v8/settings/emergency/health.tsx',
    'v8/settings/emergency/history.tsx',
    'v8/settings/line-notifications/customer-kpis.ts',
    'v8/settings/line-notifications/screen.tsx',
    'v8/webhooks/interactions.tsx',
    'v8/webhooks/outgoing.tsx',
    'v8/webhooks/shell.tsx',
    ])
    const hits = FILES.filter((f) => !migrating.has(f.p) && /この30日|直近30日/.test(f.s)).map((f) => f.p)
    expect(hits, '「過去30日」に寄せる').toEqual([])
  })

  /**
   * **LINEの見た目を確かめる面の札を1つにする。**
   *
   * 実装は5通りに割れていた——LINEプレビュー／LINEカードプレビュー／
   * LINE配信プレビュー／配信プレビュー／〜のプレビュー。
   * 設計は30枚すべて「LINEプレビュー」。
   *
   * `プレビューを隠す` `プレビューのみ` のような、面そのものを指さない語は
   * 対象外なので、`LINE` か `配信` が付いた形だけを見る。
   */
  it('LINEの見た目を出す面は「LINEプレビュー」と呼ぶ', () => {
    const hits = FILES.filter((f) => /LINEカードプレビュー|LINE配信プレビュー|配信プレビュー/.test(f.s)).map((f) => f.p)
    expect(hits, '「LINEプレビュー」に寄せる').toEqual([])
  })

  it('同じものを「対応状態」とも呼ばない', () => {
    const hits = FILES.filter((f) => f.s.includes('対応状態')).map((f) => f.p)
    expect(hits, '「対応状況」に寄せる').toEqual([])
  })

  /**
   * **言葉の表（docs/v8-requirements/terms.md）の「使わない」を画面に出さない。**
   *
   * 表の写し（lib/terms.ts の termsAvoid）をそのまま使う。表に行を足せば見張りも増える。
   * 表そのもの（lib/terms.ts）と、法務の文（content/ の利用規約）は対象外。
   */
  for (const { id, avoid } of termsAvoid) {
    it(`言葉の表 TM-${id}：「${terms[id]}」と書く`, () => {
      const hits = FILES.filter((f) => f.p !== 'lib/terms.ts' && !f.p.startsWith('content/') && avoid.test(f.s)).map((f) => f.p)
      expect(hits, `「${terms[id]}」に直す`).toEqual([])
    })
  }
})
