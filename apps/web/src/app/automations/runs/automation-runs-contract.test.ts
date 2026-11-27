import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { AUTOMATION_RUNS } from '../../../../../../scripts/visual-qa/fixtures.mjs'

const PAGE = readFileSync(new URL('../../../v8/automations/runs.tsx', import.meta.url), 'utf8')
/**
 * 実口のソース。**画面と同じ形を返しているか**を突き合わせるために読む(#735)。
 *
 * ここを `toContain` で片側だけ見ていたころは、実口のキー名や状態の写像を
 * 変えても**この試験は緑のままだった**(#735 の証拠節)。片側に文字列がある
 * ことではなく、**両側が同じ形であること**を見る。
 */
const ROUTE = readFileSync(
  new URL('../../../../../worker/src/routes/automations.ts', import.meta.url),
  'utf8',
)

/** `type X = { ... }` / `const X: Record<..> = { ... }` の直下のキーを拾う。 */
function keysOfBlock(source: string, opener: string): string[] {
  const start = source.indexOf(opener)
  if (start < 0) throw new Error(`見つからない: ${opener}`)
  let depth = 0
  let end = -1
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error(`閉じ括弧が見つからない: ${opener}`)
  const body = source.slice(source.indexOf('{', start) + 1, end)
  // 入れ子の中身は数えない(直下のキーだけ)。
  const flat = body.replace(/\{[^{}]*\}/g, '')
  return [...flat.matchAll(/^\s*'?\"?([\w.]+)'?\"?\s*:/gm)].map((m) => m[1])
}

describe('V8 オートメーションが動いた記録', () => {
  it('実行記録画面の設計ノードを持つ', () => {
    expect(PAGE).toContain('boardId="g98F9"')
  })

  it('実行記録の読み込み状態を定義する', () => {
    expect(PAGE).toContain("'loading' | 'ready' | 'error'")
  })

  it('詳細を開き、失敗した処理だけを安全な再実行口へ接続する', () => {
    expect(PAGE).toContain('もう一度やる')
    expect(PAGE).toContain('/api/automation-runs/${encodeURIComponent(run.id)}/retry')
    expect(PAGE).toContain('失敗した処理だけを、成功済みの処理と重ならないようにもう一度実行できます。')
    expect(PAGE).toContain('失敗した処理をもう一度やる')
    expect(PAGE).toContain('setSelectedRun(run)')
    expect(PAGE).toContain('実行記録の中身')
    expect(PAGE).toContain('成功済みの処理を二重に動かさないため')
  })

  it('CSV書き出しと実行の取りやめを実口へ接続する (#942 N-353)', () => {
    // #1053: 直リンクは Bearer 補完経路で401になるため、認証付き取得へ。
    expect(PAGE).toContain('downloadApiFile(api.automations.runsCsvUrl')
    expect(PAGE).toContain('api.automations.cancelRun')
    expect(PAGE).toContain('この実行を取りやめる')
    // R492: 取りやめの確認には操作対象の店名を出す。
    expect(PAGE).toContain('の実行を取りやめますか？記録は残りますが、実行は戻せません。')
    expect(PAGE).toContain('実行を取りやめました。記録は残っています。')
  })

  it('見るだけの権限では操作を出さず、テスト実行の切替と版の区別を持つ (#1043)', () => {
    // 権限不足 view: 再試行・取り消し・CSVを出さない（管理画面 §9）。
    expect(PAGE).toContain('useAutomationRunManage')
    expect(PAGE).toContain('permissions.canOperate')
    expect(PAGE).toContain('permissions.canExport')
    // 既定は本番だけ、切替でテスト実行を含める。
    // 現在の版と実行版を区別する。
    expect(PAGE).toContain('isCurrentVersion')
    expect(PAGE).toContain('currentVersionNumber')
    // 運用停止・機能無効で動けない実行の理由。
    expect(PAGE).toContain('holdReason')
    expect(PAGE).toContain('止まっている理由')
  })

  it('詳細に版番号・テスト印・処理ごとの結果を出す (#942 N-354)', () => {
    expect(PAGE).toContain('api.automations.getRun')
    expect(PAGE).toContain('versionNumber')
    expect(PAGE).toContain('isTest')
    expect(PAGE).toContain('処理ごとの結果')
    expect(PAGE).toContain('attemptNumber')
  })

  it('壊れた応答を描画せず取得失敗へ倒す', () => {
    expect(PAGE).toContain('!response.data.summary')
    expect(PAGE).toContain('!Array.isArray(response.data.items)')
    expect(PAGE).toContain('実行記録の応答形式が正しくありません')
  })

  it('検索の連打で古い応答が新しい表示を上書きしない (#580)', () => {
    expect(PAGE).toContain('loadGeneration.current')
    expect(PAGE).toContain('generation !== loadGeneration.current')
    expect(PAGE).toContain('setTimeout(() => void load(), 400)')
  })

  it('変えられない表示条件は選択肢に見せない (#580)', () => {
    expect(PAGE).toContain('<PageSizeSelect value={pageSize} onChange={setPageSize}')
    expect(PAGE).not.toContain('onChange={() => undefined}')
  })
})

/*
 * ここから下は**形の突合**(#735)。
 *
 * 上の表明は「画面のコードにこの文字列があるか」を見るもので、**実口が別の形を
 * 返し始めても気づけない**。実際、サーバーの状態写像を取り違える逆変異
 * (`COMMON_STATUS_TO_DOMAIN.succeeded` を `['failed']` にする)も、応答のキー名を
 * 取り違える逆変異(`mostRunName` → `mostRunLabel`)も、**この試験は緑のまま**だった。
 *
 * 上の表明は消していない。あちらは画面側にしか無いもの(設計ノード・文言・連打
 * 対策・再実行の注意書き)を見張っていて、突合では代わりにならない。
 */
describe('#735 実行記録の形が、画面・実口・見本で揃っている', () => {
  it('集計のキーが、画面の型と実口の応答と見本で一致する', () => {
    const screen = keysOfBlock(PAGE, 'type RunsResponse = {').filter((k) => k !== 'summary')
    const screenSummary = keysOfBlock(PAGE.slice(PAGE.indexOf('type RunsResponse')), 'summary: {')
    const routeSummary = keysOfBlock(ROUTE.slice(ROUTE.indexOf('const body: AutomationExecutionRunsResponse')), 'summary: {')
    const fixtureSummary = Object.keys((AUTOMATION_RUNS as { summary: Record<string, unknown> }).summary)
    expect(screenSummary.length).toBeGreaterThan(0)
    expect([...routeSummary].sort()).toEqual([...screenSummary].sort())
    expect([...fixtureSummary].sort()).toEqual([...screenSummary].sort())
    // 画面の型の直下(items / pagination)も落ちていないこと。
    expect(screen).toEqual(expect.arrayContaining(['items', 'pagination']))
  })

  it('画面が知っている状態だけを実口が返す', () => {
    const screenStatuses = keysOfBlock(PAGE, 'const STATUS_LABEL: Record<RunStatus, string>')
    const routeCommon = keysOfBlock(ROUTE, 'const COMMON_STATUS_TO_DOMAIN')
    const routeToCommonValues = [...ROUTE.slice(ROUTE.indexOf('const DOMAIN_STATUS_TO_COMMON'))
      .slice(0, ROUTE.slice(ROUTE.indexOf('const DOMAIN_STATUS_TO_COMMON')).indexOf('};'))
      .matchAll(/:\s*'([\w_]+)'/g)].map((m) => m[1])
    expect([...routeCommon].sort()).toEqual([...screenStatuses].sort())
    // 実口が画面の知らない状態を返さないこと。
    expect([...new Set(routeToCommonValues)].filter((s) => !screenStatuses.includes(s))).toEqual([])
  })

  it('状態の写像が往復して元に戻る', () => {
    const toDomain = Object.fromEntries(
      [...ROUTE.slice(ROUTE.indexOf('const COMMON_STATUS_TO_DOMAIN'))
        .slice(0, ROUTE.slice(ROUTE.indexOf('const COMMON_STATUS_TO_DOMAIN')).indexOf('};'))
        .matchAll(/^\s*([\w_]+):\s*\[([^\]]+)\]/gm)]
        .map((m) => [m[1], m[2].split(',').map((s) => s.trim().replace(/'/g, ''))]),
    ) as Record<string, string[]>
    const toCommon = Object.fromEntries(
      [...ROUTE.slice(ROUTE.indexOf('const DOMAIN_STATUS_TO_COMMON'))
        .slice(0, ROUTE.slice(ROUTE.indexOf('const DOMAIN_STATUS_TO_COMMON')).indexOf('};'))
        .matchAll(/^\s*([\w_]+):\s*'([\w_]+)'/gm)]
        .map((m) => [m[1], m[2]]),
    ) as Record<string, string>
    expect(Object.keys(toDomain).length).toBeGreaterThan(0)
    /*
     * 「動いたもので絞ったのに、失敗したものが出る」を止める。
     * 絞り込み(common→domain)で選んだ domain を、表示(domain→common)へ
     * 通したら、元の common に戻らなければならない。
     */
    const broken = Object.entries(toDomain).flatMap(([common, domains]) =>
      domains.filter((domain) => toCommon[domain] !== common).map((domain) => `${common}→${domain}→${toCommon[domain]}`))
    /*
     * #1043: domain `waiting` は待機(wait)と失敗の再試行待ちを兼ねる1つの
     * 状態で、表示側は行の中身（待機stepの retry_at の有無）で
     * `waiting` / `retry_wait` に分ける。`retry_wait` で絞ると同じ domain の
     * 待機中も返るため、この組み合わせだけ往復しない意図的な近似。
     */
    const knownSharedDomain = new Set(['retry_wait→waiting→waiting'])
    expect(broken.filter((entry) => !knownSharedDomain.has(entry))).toEqual([])
  })

  it('見本の実行記録が、画面の型どおりの形を持つ', () => {
    const screenRun = keysOfBlock(PAGE, 'type AutomationRunRow = {')
    const fixtureRun = Object.keys((AUTOMATION_RUNS as { items: Record<string, unknown>[] }).items[0])
    expect(screenRun.length).toBeGreaterThan(0)
    // 画面が読むキーは、見本にすべて入っていること(見本が足りないと空欄で撮れてしまう)。
    expect(screenRun.filter((k) => !fixtureRun.includes(k))).toEqual([])
  })
})
