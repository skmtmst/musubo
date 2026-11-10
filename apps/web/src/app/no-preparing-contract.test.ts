import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = path.join(__dirname, '..')

/**
 * 「準備中」を画面から無くすための、全画面ぶんの見張り。
 *
 * `docs/v8-design-rules.md` §5 は **「`準備中` のボタンが1つも無い（出す＝使える）」**
 * を完了の条件にしている。§2-2 は「使えないプルダウンを完成画面に置かない」、
 * §5-5 は「隠すのではなく、そもそも描かない」。
 *
 * これまでは画面ごとに `expect(PAGE).not.toContain('マニュアルは準備中です')` を
 * 書き足していた。**書いた画面しか見張れず、新しい画面には効かない。**
 * ここで 130 ページと共通部品を一度に見る形へ一般化する。
 *
 * ## 何を禁じるか
 *
 * 禁じるのは**言い訳の言い回し**（`準備中です` / `準備中）` / `準備中)`）。
 * 「まだ動きません」を吹き出しや注記で言い添えて、押せない操作を
 * 置いたままにする書き方がこれにあたる。
 *
 * **裸の `準備中` は禁じない。** 2026-09-28（U）より前は、イベントの状態
 * （まだ公開していない）を設計そのものが `準備中` と呼んでいて、
 * `src/lib/design-structure.json` の `/events` にもその言葉が入っていた。
 * U で状態名を「下書き」に変えたので、今はどちらの言葉も設計にある状態名
 * として扱う。ただし例外は `DESIGN_WORDS` に書いた場所だけで、
 * 数も固定する（言い回しを変えて言い訳を逃がさないため）。
 */

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
 * 注釈を落とす。見張りたいのは**画面に出る言葉**だけ。
 *
 * 「なぜ準備中をやめたか」を書いた注釈が自分の見張りに当たると、
 * 直したのに落ちるという嘘の失敗になる。
 */
function visible(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const FILES = sources(SRC).map((p) => ({
  p: path.relative(SRC, p).split(path.sep).join('/'),
  s: visible(fs.readFileSync(p, 'utf8')),
}))

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

/** 「まだ動きません」の言い訳。これを画面に置かない。 */
const EXCUSE = /準備中(?:です|[）)])/g

/** 「準備中」という言葉そのもの。 */
const ANY = /準備中/g

/**
 * 設計そのものにある状態名。**言い訳ではないので直さない。**
 *
 * 2026-09-28（U）より前は、イベントの `is_published !== 1`（まだ公開して
 * いない）を設計が `準備中` と呼んでいた。U で状態名を「下書き」に変えた
 * ので、この表は空になった（0 になったら行ごと消す決まり）。
 */
const DESIGN_WORDS: Record<string, number> = {}

/**
 * （2026-10-16 オーナー）：口（API）がまだ無い機能は、入口・ボタンを絵どおり置き、押すと
 * 「現在準備中です」の窓（★V8 `fuQxi`）・お客さまの画面（`K9HMJp`）で伝えてよい。言い訳の飾りボタンではなく、
 * 決まった1つの共通部品で出す。言葉はこの部品の中の1か所（`PREPARING_WORD`）にだけ置き、画面はそれを使う。
 * ここに無いファイルで「準備中」を書いたら、今までどおり落ちる。
 */
const PREPARING_COMPONENTS: Record<string, number> = {
  'components/shared/preparing-dialog.tsx': 1,
}

/**
 * まだ残っている言い訳。**担当（S1〜S3）が機能ごとに消す。**
 *
 * ここは減る一方の表。
 * - 数を**増やせない**（新しい「準備中」を足せない）
 * - 0 になったら**行ごと消す**（消し忘れるとこの試験が落ちる）
 *
 * 共通部品（`components/shared`）はこの表に載せない。載せない＝0 件。
 *
 * 2026-09-03 時点で 33 ファイル・73 件。
 * 2026-09-04: 自動応答（`app/auto-replies/page.tsx`）の 2 件を外して 0 になったので行を消した。
 *   絞り込みの「30日以上の絞り込みは準備中」と、行き先の決まっていない「マニュアル」。
 */
const REMAINING: Record<string, number> = {
  /* #670 17 で押せない「保存した条件」(準備中です)を撤去し、
     page.tsx は 0 件になったので行を消した。 */
  /* 監査7 #810 で「画像を選ぶ」（準備中です）の飾りボタンを撤去し 0 件になったので行を消した。 */
  /* 2026-09-08 #605 で「同じ設定で作り直す」を実動作へ接続し 0 件になったので行を消した。 */
  /* ★V7 C6 で押せない「マニュアル」（準備中です）を撤去し 0 件になったので行を消した。 */
  /* 2026-09-24 V7残り一覧の手直しで飾りボタン2件と接続見出しの言い回しを消し 0 件になったので行を消した。 */
  /* 監査7 #810 で carousel の「下書き保存」と edit の「テスト送信」他の飾りボタンを撤去し 0 件になったので行を消した。 */
  /* 監査8 で残り11件を消化し表が空になった。stores/new の押せないマニュアル札は
     描かない形へ、broadcast-form は未対応の種別を「準備中」ではなく事実表記
     （未対応）へ、event-wizard の押せないプルダウンとチェック、friend-timeline の
     押せない「★のみ」を撤去した。 */
}

describe('画面に「準備中」を置かない', () => {
  it('全画面を読めている（数え漏れの見張り）', () => {
    // 数え漏れ（読む場所を間違えて 0 件になる）だけを見張る。
    // ちょうどの枚数は画面が増えるたびに動くので、下限をゆるく取る。
    expect(FILES.length).toBeGreaterThan(300)
    expect(FILES.filter((f) => /^app\/.*\/page\.tsx$/.test(f.p) || f.p === 'app/page.tsx')).toHaveLength(227)
  })

  it('共通部品に「準備中」が1つも無い', () => {
    for (const f of FILES.filter((f) => f.p.startsWith('components/shared/') && !(f.p in PREPARING_COMPONENTS))) {
      expect(count(f.s, ANY), `${f.p} に「準備中」がある`).toBe(0)
    }
  })

  it('表に無いファイルは「準備中」を1つも持たない', () => {
    for (const f of FILES) {
      if (f.p in REMAINING || f.p in DESIGN_WORDS || f.p in PREPARING_COMPONENTS) continue
      expect(count(f.s, ANY), `${f.p} に新しい「準備中」が入った`).toBe(0)
    }
  })

  it('残りの表より「準備中」を増やさない', () => {
    for (const f of FILES) {
      const allowed = REMAINING[f.p]
      if (allowed === undefined) continue
      expect(count(f.s, EXCUSE), `${f.p} の「準備中」が ${allowed} 件から増えた`).toBeLessThanOrEqual(allowed)
    }
  })

  it('0 件になったファイルは表から消す', () => {
    for (const p of Object.keys(REMAINING)) {
      const f = FILES.find((x) => x.p === p)
      expect(f, `${p} が無い。表から消す`).toBeDefined()
      expect(count(f!.s, EXCUSE), `${p} は 0 件になった。表から行を消す`).toBeGreaterThan(0)
    }
  })

  it('言い回しを変えて言い訳を逃がさない', () => {
    for (const f of FILES) {
      if (f.p in PREPARING_COMPONENTS) continue
      const design = DESIGN_WORDS[f.p] ?? 0
      expect(count(f.s, ANY), `${f.p} に、言い訳でも設計の状態名でもない「準備中」がある`).toBe(
        count(f.s, EXCUSE) + design,
      )
    }
  })

  it("共通部品の準備中は共通部品の1か所だけ（数を増やさない）", () => {
    for (const [p, allowed] of Object.entries(PREPARING_COMPONENTS)) {
      const f = FILES.find((x) => x.p === p)
      expect(f, `${p} が無い。表から消す`).toBeDefined()
      expect(count(f!.s, ANY), `${p} の「準備中」が ${allowed} 件と違う`).toBe(allowed)
    }
  })

  it('設計にある状態名だけは残す（イベントの下書き）', () => {
    const events = FILES.find((f) => f.p === 'app/events/page.tsx')!
    // U で状態名を「下書き」に変えたので、「準備中」は0件のはず。
    expect(count(events.s, ANY)).toBe(0)
    // 現役の一覧が状態を「下書き」と出すことは v8/events/list.test.tsx が描いて守る。
  })
})
