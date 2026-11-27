import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node用の静的検査を、実際のソースと同じ入口で試す
import { sourceFiles, globalTokens, resolveValue, cssShapeCandidates, classShapeCandidates, sharedCardIssues, v8Sources } from '../../../scripts/card-shape-contract.mjs'

const SRC = resolve(__dirname, '../..')
const read = (file: string) => readFileSync(file, 'utf8')
const tokens = globalTokens(read(resolve(SRC, 'app/globals.css')))
type Candidate = { file: string; selector: string }
const key = ({ file, selector }: Candidate) => `${file} ${selector}`

// : ファイル全体・名前のパターンでは免除しない。該当する規則だけ。
// 新しい箱はここを足さず、共通の Card / content-card の形を使う。
const EXCEPTIONS: [file: string, selector: string, reason: string][] = [
  ["components/shared/combobox.module.css", ".popup", "開いた入力欄の選ぶ面。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/date-time-field.module.css", ".popover", "開いた入力欄の選ぶ面。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/multi-select.module.css", ".popup", "開いた入力欄の選ぶ面。浮く面の影を使い、カードの影を重ねない。"],
  ["app/mileage/earning-rules/new/v8-create-form.module.css", ".choice", "獲得方法を選ぶ入力。選択枠で区別する。"],
  ["app/reminders/wizard-v8.module.css", ".choice", "入力欄・補助操作・選択肢。中身のカードではない。"],
  ["app/reminders/wizard-v8.module.css", ".addStep", "入力欄・補助操作・選択肢。中身のカードではない。"],
  ["components/friend-fields/tag-csv-import-dialog.module.css", ".panel", "開いた窓・メニュー。浮く面の影を使い、カードの影を重ねない。"],
  ["components/friend-fields/tag-csv-import-dialog.module.css", ".tableFrame", "取り込み内容の表の枠。影を重ねない。"],
  ["components/hq/account-menu.module.css", ".menu", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/account-switch-menu.module.css", ".panel", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/data-table.module.css", ":root .frame[data-table-presentation='account-list'], :root .frame[data-table-presentation='account-handover']", "アカウント一覧と乗り換えの表の枠。影を重ねない。"],
  ["components/shared/file-drop.module.css", ".zone", "ファイルを落とす入力欄。内容のカードではない。"],
  ["components/shared/file-drop.module.css", ".row", "選んだファイルの入力行。外側の入力欄と影を重ねない。"],
  ["components/shared/line-preview.module.css", ".flat", "LINEに届く内容の見本。管理画面のカードの影は付けない。"],
  ["components/shared/media-slot.module.css", ".frame", "画像を入れる入力欄。内容のカードではない。"],
  ["components/shared/message-composer.module.css", ".bubble", "メッセージ本文の入力欄。内容のカードではない。"],
  ["components/shared/multi-select.module.css", ".overflow", "選びきれない札を表示する副ボタン。カードではない。"],
  ["components/shared/notification-panel.module.css", ".panel", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/radio-card.module.css", ":root .card", "一つを選ぶ入力欄。枠は選択状態を示す。"],
  ["components/shared/seat-tile.module.css", ".map", "席を選ぶ入力。枠は選択状態を示す。"],
  ["components/shared/select-menu.module.css", ".surface", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/source-picker-dialog.module.css", ".selectedRow", "選ぶ窓の中の仮選択行。入れ子に影を重ねない。"],
  ["components/shared/tap-area-editor.module.css", ".frame", "押したら行うことの入れ子の編集欄。影を重ねない。"],
  ["components/shared/time-field-v8.module.css", ".panel", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["components/shared/toast.module.css", ":root .toast", "一時的な知らせ。知らせ専用の影を保つ。"],
  ["v8/analytics/analytics.module.css", ".table", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/analytics/analytics.module.css", ".reportTable", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/analytics/analytics.module.css", ".waitBox", "警告・閲覧のみ・状態・待機の帯。線で区別する。"],
  ["v8/booking-menus/menu-form.module.css", ".subSection", "カード内の小箱・入れ子・階層の行。影を重ねない。"],
  ["v8/broadcast-detail/detail.module.css", ".linkList", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/broadcast-detail/detail.module.css", ".approval", "警告・閲覧のみ・状態・待機の帯。線で区別する。"],
  ["v8/form-edit/edit.module.css", ".blockOpenCard", "カード内の小箱・入れ子・階層の行。影を重ねない。"],
  ["v8/friends/list/list.module.css", ".columnsMenu", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["v8/hq-broadcasts/create.module.css", ".checkEmpty", "未選択の入力欄。破線は空の状態を示す。"],
  ["v8/hq-broadcasts/create.module.css", ".notYet", "入力が未設定の注意帯。カードではない。"],
  ["v8/hq-templates/console.module.css", ".tableBox", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/hq-templates/folder-distribution-dialog.module.css", ".list", "配る窓の中のアカウント一覧の枠。影を重ねない。"],
  ["v8/inbox-chat/inbox-chat.module.css", ".pop", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["v8/inbox-chat/inbox-chat.module.css", ".inputBox", "入力欄・補助操作・選択肢。中身のカードではない。"],
  ["v8/inbox-chat/inbox-chat.module.css", ".attachPop", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["v8/inflow-links/list.module.css", ".presetPanel", "開いたメニュー・選ぶ欄。浮く面の影を使い、カードの影を重ねない。"],
  ["v8/nen-posts/review.module.css", ".tableWrap", "投稿の公開記録を表示する表の枠。影を重ねない。"],
  ["v8/ops/auth.module.css", ".digit", "入力欄・補助操作・選択肢。中身のカードではない。"],
  ["v8/restaurant/closures/closures.module.css", ".grid", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/scenarios/results.module.css", ".table", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/settings/accounts/accounts.module.css", ".table", "表・一覧の行。外側のカードと影を重ねない。"],
  ["v8/settings/sns/sns.module.css", ".list", "カードの中の接続一覧の枠。内容は行で区切り、外側のカードと影を重ねない。"],
  ["v8/templates/question-new.module.css", ".choice", "入力欄・補助操作・選択肢。中身のカードではない。"],
  ["v8/emergency/send-path-coverage-panel.tsx", "className=\"border-hairline rounded-card border bg-canvas px-4 py-3 text-xs text-ink-faint\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/broadcasts/broadcast-approval.tsx", "className=\"bg-warning-bg rounded-card border-hairline border p-5\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/broadcasts/broadcast-form-model.tsx", "className=\"border-hairline mt-4 rounded-card border bg-canvas p-5\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["components/broadcasts/broadcast-form.tsx", "className=\"rounded-card border border-hairline bg-canvas p-8 text-center\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/broadcasts/broadcast-form.tsx", "className=\"bg-canvas rounded-card border-hairline text-ink-faint border p-8 text-center text-sm\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/broadcasts/broadcast-form.tsx", "className={`${styles.draftNotice} border-hairline bg-canvas-sunken text-ink-secondary mt-3 rounded-card border px-4 py-2 text-xs`}", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/broadcasts/segment-preset-controls.tsx", "className=\"divide-y divide-hairline rounded-card border border-hairline bg-canvas\"", "表・履歴・一覧の器。内容は行で区切り、影は重ねない。"],
  ["components/forms/block-editor.tsx", "className={`rounded-card border p-4 transition-colors ${ selected ? 'border-accent bg-canvas' : 'border-hairline bg-canvas' }`}", "絞り込み・段の切り替え・選択の枠。中身のカードではない。"],
  ["components/friends/single-friend-actions.tsx", "className=\"bg-canvas rounded-card border-hairline mt-2 border p-3\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["components/scenarios/action-editor.tsx", "className=\"text-ink-faint rounded-card border-hairline border border-dashed py-8 text-center text-sm\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/scenarios/carousel-picker.tsx", "className=\"border-hairline rounded-card border border-dashed px-4 py-6 text-center\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/scenarios/insert-toolbar.tsx", "className=\"border-hairline rounded-card bg-canvas max-h-64 w-64 overflow-y-auto border shadow-float\"", "開いた窓・メニュー。浮く面の影を使い、カードの影を重ねない。"],
  ["components/scenarios/insert-toolbar.tsx", "className=\"border-hairline rounded-card bg-canvas w-72 border p-3 shadow-float\"", "開いた窓・メニュー。浮く面の影を使い、カードの影を重ねない。"],
  ["components/scenarios/question-editor.tsx", "className=\"border-hairline rounded-card border\"", "絞り込み・段の切り替え・選択の枠。中身のカードではない。"],
  ["components/scenarios/step-preview.tsx", "className=\"border-hairline rounded-card text-ink-faint border border-dashed px-3 py-6 text-center text-micro\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["components/scenarios/trigger-editor.tsx", "className=\"border-hairline rounded-card flex flex-wrap items-center justify-between gap-2 border px-4 py-3\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["components/shared/condition-builder.tsx", "className=\"border-hairline bg-canvas rounded-card flex flex-wrap items-start gap-2 border p-3\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["components/shared/version-history.tsx", "className={ active ? 'rounded-card border border-accent bg-canvas' : 'rounded-card border border-hairline bg-canvas' }", "絞り込み・段の切り替え・選択の枠。中身のカードではない。"],
  ["components/staff/login-audit.tsx", "className=\"overflow-hidden rounded-card border border-hairline bg-canvas\"", "表・履歴・一覧の器。内容は行で区切り、影は重ねない。"],
  ["components/templates/message-template-editor.tsx", "className=\"border-hairline rounded-card border p-4\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/affiliates/attribution-view.tsx", "className=\"bg-canvas border-hairline mt-2 overflow-x-auto rounded-card border\"", "表・履歴・一覧の器。内容は行で区切り、影は重ねない。"],
  ["v8/automations/branch-editor.tsx", "className=\"border-hairline bg-canvas-sunken mt-3 rounded-card border p-4\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/contents/media-detail-dialog.tsx", "className=\"bg-canvas-sunken rounded-card flex min-h-96 items-center justify-center overflow-hidden border border-hairline\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/nen-posts/detail.tsx", "className=\"mt-4 rounded-card border border-hairline bg-canvas p-4\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
  ["v8/scenario-detail/scenario-step-form.tsx", "className={editingStepId ? '' : 'border-hairline rounded-card bg-canvas-sunken border p-4'}", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/scenario-detail/scenario-step-form.tsx", "className=\"border-hairline rounded-card border p-4\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/settings/staff/staff.tsx", "className=\"rounded-card border border-hairline bg-canvas p-4\"", "カード内の小箱・入力のまとまり・内容の見本。影を重ねない。"],
  ["v8/settings/staff/staff.tsx", "className=\"mt-2 divide-y divide-hairline overflow-hidden rounded-card border border-hairline\"", "表・履歴・一覧の器。内容は行で区切り、影は重ねない。"],
  ["v8/templates/staff-asset-list.tsx", "className=\"bg-canvas border-hairline text-ink-faint col-span-full rounded-card border border-dashed p-12 text-center text-sm\"", "未取得・未選択・空の状態・警告。線とメッセージで区別する。"],
]

function candidates(): Candidate[] {
  const files: string[] = sourceFiles(SRC)
  // *.module.css だけでなく通常のCSS・globals.cssの部品規則も読む。
  const css = files.filter(file => file.endsWith('.css')).flatMap(file =>
    cssShapeCandidates(read(file), tokens).map((selector: string) => ({ file: relative(SRC, file), selector })))
  const classes = (v8Sources(SRC, files) as string[]).flatMap(file =>
    classShapeCandidates(read(file), tokens).map((selector: string) => ({ file: relative(SRC, file), selector })))
  return [...css, ...classes]
}

const all = candidates()

describe("カードの角丸と枠に共通の影を欠かさない", () => {
  it('カードの角丸と枠を持つ規則には共通の影がある（理由つきの非カードだけ除外）', () => {
    const permitted = new Set(EXCEPTIONS.map(([file, selector]) => key({ file, selector })))
    const missing = all.filter(candidate => !permitted.has(key(candidate)))
    expect(missing, 'Card / content-card の共通の縁と影を使ってください').toEqual([])
  })

  it('例外にはファイル・規則・理由があり、不要になった例外を残さない', () => {
    const found = new Set(all.map(key))
    const keys = EXCEPTIONS.map(([file, selector]) => key({ file, selector }))
    expect(new Set(keys).size).toBe(keys.length)
    expect(EXCEPTIONS.every(([file, selector, reason]) => file && selector && reason.length > 10)).toBe(true)
    const stale = keys.filter(entry => !found.has(entry))
    expect(stale, `影を付けた規則や消した規則の例外は外してください: ${JSON.stringify(stale)}`).toEqual([])
  })

  it('globalsの変数の連鎖・V8の上書き・フォールバックを解く（循環では止まる）', () => {
    const vars = globalTokens(`@theme { --radius-card: 8px; --alias: var(--radius-card); }
      :root { --radius-card: 12px; }
      .component { --radius-card: 3px; }`)
    expect(resolveValue('var(--alias)', vars)).toBe('12px')
    expect(resolveValue('var(--missing, var(--alias))', vars)).toBe('12px')
    expect(resolveValue('var(--a)', new Map([['--a', 'var(--b)'], ['--b', 'var(--a)']]))).toBe('var(--a)')
  })

  it('共通Cardの輪郭線・outline・1pxの線影を見分ける（本物の値は実ブラウザの検査で見る）', () => {
    const clean = `:root { --card-shadow: 0 1px 2px rgba(0,0,0,.08); } .card { border: 0; box-shadow: var(--card-shadow); }`
    const brokenShadow = `:root { --card-shadow: 0 0 0 1px rgba(0,0,0,.1), 0 2px 4px rgba(0,0,0,.1); } .card { border: 0; box-shadow: var(--card-shadow); }`
    const brokenOutline = `:root { --card-shadow: 0 1px 2px rgba(0,0,0,.08); } .card { outline: 1px solid transparent; box-shadow: var(--card-shadow); }`
    const local = (css: string) => globalTokens(css)
    expect(sharedCardIssues(clean, local(clean))).toEqual([])
    expect(sharedCardIssues(brokenShadow, local(brokenShadow))).toContain('--card-shadow: 1px shadow edge')
    expect(sharedCardIssues(brokenOutline, local(brokenOutline))).toContain('.card: outline')
  })

  it.each(['12px', 'var(--radius-card)', 'var(--tpl-htn-radius-l)', 'var(--missing, var(--radius-card))'])('角丸 %s と枠だけの新しいカードを検出する', radius => {
    expect(cssShapeCandidates(`.newCard { border-radius: ${radius}; border: 1px solid var(--color-hairline); }`, tokens)).toEqual(['.newCard'])
  })

  it('ringのみ・none・別の薄い影・分割した影の取り消しも検出する', () => {
    for (const shadow of ['var(--tpl-fe-ring)', 'none', 'var(--control-shadow)', 'var(--shadow-card)']) {
      expect(cssShapeCandidates(`@media (min-width: 1000px) { .newCard { border-radius: var(--radius-card); border: 1px solid var(--color-hairline); box-shadow: ${shadow}; } }`, tokens)).toEqual(['.newCard'])
    }
    expect(cssShapeCandidates(`.newCard { border-radius: 12px; border: 1px solid var(--color-hairline); box-shadow: var(--card-shadow); } .newCard { box-shadow: none; }`, tokens)).toEqual(['.newCard'])
    expect(cssShapeCandidates('.ringCard { border-radius: var(--tpl-htn-radius-l); box-shadow: var(--tpl-htn-ring); }', tokens)).toEqual(['.ringCard'])
  })

  it('共通の影・その別名・カード以外の角丸・コメントは誤検知しない', () => {
    for (const shadow of ['var(--card-shadow)', 'var(--shadow-card-surface)', 'var(--tpl-fe-ring), var(--card-shadow)']) {
      expect(cssShapeCandidates(`.newCard { border-radius: 12px; border: 1px solid var(--card-edge); box-shadow: ${shadow}; }`, tokens)).toEqual([])
    }
    expect(cssShapeCandidates('/* .bad { border-radius:12px; border:1px solid var(--color-hairline); } */ .input { border-radius:8px; box-shadow:var(--tpl-fe-ring); }', tokens)).toEqual([])
    expect(cssShapeCandidates('.icon { border-radius:12px; }', tokens)).toEqual([])
  })

  it('Tailwindも同じ要素で判定し、条件分岐やクラスの合成で逃がさない', () => {
    const bad = [
      '<section className="rounded-card border border-hairline" />',
      '<section className="rounded-card border-hairline shadow-none" />',
      '<section className="rounded-card border-hairline shadow-field" />',
      '<section className="rounded-card border-hairline shadow-card" />',
      '<section className={cn("rounded-card", "border-hairline")} />',
      '<section className={`rounded-card border-hairline ${ok ? "shadow-card" : ""}`} />',
      'const shape = "rounded-card border-hairline"; const View = () => <section className={shape} />',
      '<section className="rounded-card border-hairline"><div className="shadow-card" /></section>',
    ]
    for (const source of bad) expect(classShapeCandidates(source, tokens), source).toHaveLength(1)
    for (const shadow of ['shadow-card-surface', 'content-card']) {
      expect(classShapeCandidates(`<section className="rounded-card border-hairline ${shadow}" />`, tokens)).toEqual([])
    }
    expect(classShapeCandidates('<div className="rounded-card"><div className="border-hairline" /></div>', tokens)).toEqual([])
    const named = new Map(tokens).set('--shadow-card-surface', 'var(--card-shadow)')
    expect(classShapeCandidates('<div className="rounded-card border-hairline shadow-card-surface" />', named)).toEqual([])
    named.set('--shadow-card-surface', 'none')
    expect(classShapeCandidates('<div className="rounded-card border-hairline shadow-card-surface" />', named)).toHaveLength(1)
  })
})
