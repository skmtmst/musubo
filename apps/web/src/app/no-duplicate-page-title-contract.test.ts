import fs from 'node:fs'
import path from 'node:path'

import { describe,expect,it } from 'vitest'

const SRC = path.join(__dirname, '..')

/**
 * **画面名を、本文とトップバーで2回出さない。**
 *
 * 以前の画面で「シナリオ配信」が
 * 出るのは 2 回だけ——サイドメニューと、トップバー。**本文には 0 回**で、
 * 設計の本文は注意帯から始まる。
 *
 * 実装は本文にも題を出していたので、同じ言葉が画面に 2 回見えていた。
 * `PageHeader` を使う 9 画面すべてと、`<h1>` を直に書いた画面が該当する。
 *
 * ただし**一律に隠すのではない。** 詳細画面（`bV5Vs` シナリオ編集）は、
 * トップバーがその記録の名前「新規登録7日間フォロー」を出し、本文でも
 * パンくずの下に同じ名前を出す——**設計そのものが2回出している。**
 * 重なるのは「トップバーと本文が同じ言葉のとき」だけなので、`PageHeader`
 * はトップバーが何を出しているかを見て、同じときだけ隠す。
 *
 * ## 2回出す道は2つしかない
 *
 * 1. `page.tsx` が `<h1>` を直接書く
 * 2. `PageHeader` に `titleDisplay="always"` を渡す
 *
 * **両方を塞げば、二重表示は 0 になる。** ここはその2つを見張る。
 *
 * `<h1>` そのものを禁じているわけではない。`PageHeader` は `sr-only` で
 * 持っている——消すと読み上げで「この画面は何か」を辿れなくなり、
 * 見出しの階層も h2 から始まってしまう。
 */

/** 画面のコードを、`.test.` を除いて集める。 */
function pages(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) pages(p, out)
    else if (e.name === 'page.tsx') out.push(p)
  }
  return out
}

/** 注釈を落とす。**「なぜ h1 をやめたか」を書いた注釈が自分の見張りに当たらないように。** */
function visible(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PAGES = pages(path.join(SRC, 'app')).map((p) => ({
  p: path.relative(SRC, p).split(path.sep).join('/'),
  s: visible(fs.readFileSync(p, 'utf8')),
}))

/**
 * **本文に `<h1>` を持ってよい画面。理由を書く。**
 *
 * どれも「トップバーが出す画面名と同じ言葉を、本文でもう一度出す」形では
 * ない。増やすときは、その画面のトップバーに何が出ているかを見てから。
 */
const ALLOWED_H1: Record<string, string> = {
  // トップバーが無い。`<h1>` がその画面の唯一の見出し。
  // ログイン（0-1）と会員登録・再設定は `components/auth/auth-card.tsx` が h1 を出す（page.tsx には無い）。
  'app/login/two-factor/page.tsx': 'ログインはトップバーの外',
  'app/login/two-factor/setup/page.tsx': 'ログインはトップバーの外',
  // 出しているのはテナント名（「株式会社 然」）で、画面名ではない。
  // 画面名の「統括コンソール」は、その上に小さく出る別の行。
  'app/hq/open/page.tsx': '出しているのはテナント名',
  // 消す予定の画面（2026-09 のオーナー決定「/updates を /emergency へ
  // 一本化」「V2/V3 の検証島を消す」）。触らない。
  'app/updates/page.tsx': '消す予定（/emergency へ一本化）',
}

describe('画面名を本文とトップバーで2回出さない', () => {
  it('全ページを読めている', () => {
    expect(PAGES.length).toBe(227)  // 2026-10-29 に友だち引継ぎの再開（/accounts/new/handover）と運営の申込（/ops/applications・/ops/applications/detail）の3画面を追加。2026-10-16 に AI の操作の記録（/webhooks/ai-log）を追加。2026-10-12 に設定のデリバリー連携（/settings/delivery、承認案 DL-1 `dF4Ov`）を追加。2026-10-11 に開発枝のお客様の見え方（/settings/customer-look）を取り込み。2026-10-10 に開発枝の編集画面3枚（/conversions/edit・/inflow-links/edit・/staff/edit）を取り込み。2026-10-09 に飲食店向けテストのデリバリー受注（/restaurant-test/delivery）を追加。2026-10-08 に V2〜管理画面 の見本 6 画面（visual-qa/friend-attributes・-v2・-v3・管理画面-combobox・管理画面-progress-filedrop・管理画面-target-missing）を撤去。2026-10-07 に提案 E-7 の来店スタンプ（/visit-stamps）、提案 E-4 予約サイト・グルメ媒体（/settings/booking-media）と E-9 統括の一括配信（/hq/broadcasts・new・detail）を追加。同日に提案 E の枠を閉じる知らせ（/restaurant-test/close-tasks）と SNS 連携（/settings/sns）を追加。情報欄の編集画面と運営専用ナレッジ（37-11）、★管理画面見本（管理画面-progress-filedrop・管理画面-combobox・管理画面-target-missing）、設定の中のファイルの検査を含む実測値。2026-09-25 に比較用 /tags-v2・/tags-v3 の2画面を撤去。2026-09-28 にイベントの変更の確認・お客様表示の確認の2画面を追加（U）。同日に付与ルールの下書き編集画面を追加（R296）。2026-10-01 に ★V8 新部品の見本画面（visual-qa/v8-parts）を追加。2026-10-03 に /scenarios/new の転送画面を追加。2026-10-04 に予約からの売上（/booking/sales）を追加。
  })

  // PageHeader が共通の見出しで頭を出すことは page-header-heading.test.tsx が描いて守る。
  it('既存の PageHeader は頭を二重に手書きしない', () => {
    const header = fs.readFileSync(path.join(SRC, 'components', 'shared', 'page-header.tsx'), 'utf8')
    expect(visible(header)).not.toMatch(/<h[12][\s>]/)
  })
})
