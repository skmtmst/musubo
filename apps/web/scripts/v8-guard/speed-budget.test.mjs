import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { measureMedian, judge, median, stubApi, targetExceedances, ONE_FRAME_MS } from './speed-budget.mjs'
import { speedPolicy } from './speed-policy.mjs'
import { assertStressTargets } from './stress-targets.mjs'
import { speedReport } from './speed-report.mjs'

const base = { showMs: 1000, lcpMs: 300, pressMs: 67, longTaskMs: 50, jsBytes: 10000 }
const sample = { name: 'inbox', ...base }
const stress = { name: 'friends-2000', rows: 2000, renderedRows: 25, showMs: 540, longTaskMs: 63 }

for (const path of ['/api/dashboard/style', '/api/dashboard/style/warnings', '/api/dashboard/style/starter-items']) {
  test(`local API fixture supports an empty HTTP request stream: ${path}`, async () => {
    const { mockFetch } = await import('./mock-local.mjs')
    const response = await mockFetch('GET', `${path}?account_id=visual-qa-account`)
    assert.equal(response.status, 200, response.body)
    const body = JSON.parse(response.body)
    assert.equal(body.success, true)
    assert.ok(body.data)
    if (path !== '/api/dashboard/style') assert.ok(Array.isArray(body.data.items))
    else assert.equal(typeof body.data.styleSelected, 'boolean')
  })
}

test('5回を順に測り、2回の外れ値を除いた中央値と全測定値を保存する', async () => {
  const values = [67, 900, 66, 800, 68]
  let calls = 0
  const result = await measureMedian(async () => ({ ...sample, pressMs: values[calls++] }))
  assert.equal(calls, 5)
  assert.equal(result.pressMs, 68)
  assert.deepEqual(result.samples.map(s => s.pressMs), values)
  assert.equal(median([NaN, Infinity, null]), null)
})

test('失敗した回を再試行で隠さず、過半数の欠測も失敗にする', async () => {
  let calls = 0
  await assert.rejects(measureMedian(async () => {
    if (++calls === 2) throw new Error('読込失敗')
    return sample
  }), /読込失敗/)
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(measureMedian(async () => ({ ...sample, showMs: ++calls > 2 ? null : 1000 })), /5回のうち2回/)
})

test('CI実測84ms・63msは補正後に通るが、2倍は全時間指標で落ちる', () => {
  const ci = speedPolicy('ci')
  assert.equal(ci.timeFactor, 1.3)
  assert.equal(ci.sampleCount, 5)
  assert.deepEqual(judge([{ ...sample, pressMs: 84 }], { inbox: base }, ci), [])
  assert.ok(judge([{ ...sample, pressMs: 85 }], { inbox: base }, speedPolicy('local')).length)
  assert.equal(assertStressTargets({ complete: true, measured: [stress] }, ci), stress)
  assert.throws(() => assertStressTargets({ complete: true, measured: [stress] }), /上限\s*50ms/)
  for (const metric of ['showMs', 'lcpMs', 'pressMs', 'longTaskMs']) {
    assert.equal(judge([{ ...sample, [metric]: base[metric] * 2 }], { inbox: base }, ci).length, 1, metric)
  }
  for (const change of [{ showMs: 2000 }, { longTaskMs: 100 }]) {
    assert.throws(() => assertStressTargets({ complete: true, measured: [{ ...stress, ...change }] }, ci), /上限/)
  }
})

test('補正の境界を守り、JS量とlongtaskの検出境界を時間倍率と混同しない', () => {
  const ci = speedPolicy('ci')
  assert.deepEqual(judge([{ ...sample, pressMs: 109 }], { inbox: base }, ci), [])
  assert.equal(judge([{ ...sample, pressMs: 110 }], { inbox: base }, ci).length, 1)
  assert.equal(judge([{ ...sample, jsBytes: base.jsBytes + 1025 }], { inbox: base }, ci).length, 1)
  assert.deepEqual(judge([{ ...sample, longTaskMs: 63 }], { inbox: { ...base, longTaskMs: 0 } }, ci), [])
  assert.equal(judge([{ ...sample, longTaskMs: 100 }], { inbox: { ...base, longTaskMs: 0 } }, ci).length, 1)
  assert.throws(() => speedPolicy('unlimited'), /未知/)
})

test('時間は20%か書き換え1回分（17ms）の大きい方まで許し、本当の悪化とほかの予算は落とす', () => {
  const local = speedPolicy('local')
  assert.equal(ONE_FRAME_MS, 17)
  /* ① 基準67msに書き換え1回分の揺れが乗った83msは通る。 */
  assert.deepEqual(judge([{ ...sample, pressMs: 83 }], { inbox: base }, local), [])
  /* ② 基準の1.6倍を超える本当の悪化110msは落ちる。 */
  assert.equal(judge([{ ...sample, pressMs: 110 }], { inbox: base }, local).length, 1)
  /* ③ 時間でない予算は今までどおり。JSは1KBを超えたら落ちる。 */
  assert.equal(judge([{ ...sample, jsBytes: base.jsBytes + 1025 }], { inbox: base }, local).length, 1)
  assert.deepEqual(judge([{ ...sample, jsBytes: base.jsBytes + 1024 }], { inbox: base }, local), [])
  /* 元の固定目標（反応100ms）の判定は変えない。 */
  assert.equal(targetExceedances([{ ...sample, pressMs: 83 }], { pressMs: 100 }).length, 0)
  assert.equal(targetExceedances([{ ...sample, pressMs: 110 }], { pressMs: 100 }).length, 1)
})

test('途中結果に速い2,000人があっても、未完了・エラー・欠測は合格にならない', () => {
  for (const extra of [{}, { complete: false }, { complete: true, error: 'settings: timeout' }]) {
    assert.throws(() => assertStressTargets({ measured: [{ ...stress, longTaskMs: 0 }], ...extra }), /未完了/)
    const report = speedReport({ measured: [stress], ...extra }, { budget: 'success', stress: 'success' })
    assert.equal(report.warning, true)
    assert.match(report.text, /測定未完了/)
  }
  for (const change of [{ longTaskMs: null }, { showMs: NaN }, { rows: 20 }, { renderedRows: 0 }]) {
    assert.throws(() => assertStressTargets({ complete: true, measured: [{ ...stress, ...change }] }, speedPolicy('ci')))
  }
  assert.match(speedReport({ complete: true }, { budget: 'failure', stress: 'success' }).text, /超過または判定失敗/)
})

test('CLIの測定不能は終了1・complete=false。報告は明示した警告と概要を残す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-controls-'))
  try {
    const result = join(dir, 'speed.json'), summary = join(dir, 'summary.md')
    const run = spawnSync(process.execPath, ['apps/web/scripts/v8-guard/speed-budget.mjs', 'http://127.0.0.1:1', result], { encoding: 'utf8', timeout: 30000, env: { ...process.env, V8_SPEED_PROFILE: 'ci' } })
    assert.equal(run.status, 1, run.stdout + run.stderr)
    const recorded = JSON.parse(readFileSync(result, 'utf8'))
    assert.equal(recorded.complete, false)
    assert.ok(recorded.error)
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary, SPEED_BUDGET_OUTCOME: 'failure', STRESS_SPEED_OUTCOME: 'failure' }
    const report = spawnSync(process.execPath, ['apps/web/scripts/v8-guard/speed-report.mjs', result], { encoding: 'utf8', env })
    assert.equal(report.status, 1)
    assert.match(report.stdout, /::warning::速度検査: 測定未完了/)
    assert.match(readFileSync(summary, 'utf8'), /測定未完了/)
    writeFileSync(result, '{broken')
    const broken = spawnSync(process.execPath, ['apps/web/scripts/v8-guard/speed-report.mjs', result], { encoding: 'utf8', env })
    assert.match(broken.stdout, /::warning::.*結果を読めません/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('速度と動作は必須の動作ジョブに残し、見た目の崩れは報告ジョブで止めずに測る', () => {
  const require = createRequire(new URL('../../../../apps/docs/package.json', import.meta.url))
  const { parse } = require('yaml')
  const workflow = parse(readFileSync(new URL('../../../../.github/workflows/required-pr-gate.yml', import.meta.url), 'utf8'))
  const guard = workflow.jobs['v8-behavior-guard']
  const screen = workflow.jobs['v8-screen-guard']
  assert.ok(!guard['continue-on-error'])
  assert.ok(!screen['continue-on-error'])
  assert.equal(guard.env.V8_SPEED_ENFORCEMENT, '${{ vars.V8_SPEED_ENFORCEMENT }}')
  assert.ok(workflow.jobs['required-pr-gate'].needs.includes('v8-behavior-guard'))
  for (const script of ['layout-overflow.mjs', 'layout-defects.mjs']) {
    const step = screen.steps.find(s => s.run?.includes(script))
    assert.ok(step, script)
    assert.ok(!step['continue-on-error'], script)
  }
  const table = guard.steps.find(s => s.run?.includes('friends-table.browser.mjs'))
  assert.ok(table)
  assert.ok(!table['continue-on-error'])
  for (const id of ['speed_budget', 'stress_speed']) {
    const step = guard.steps.find(s => s.id === id)
    assert.ok(!step['continue-on-error'])
    assert.equal(step.env.V8_SPEED_PROFILE, 'ci')
  }
  assert.ok(!guard.steps.find(s => s.run?.includes('stgfix17-targets.mjs'))['continue-on-error'])
  assert.ok(!guard.steps.find(s => s.id === 'speed_budget').run.includes('ALLOW_JS_BASELINE_UPDATE'))
  const report = guard.steps.find(s => s.run?.includes('speed-report.mjs'))
  assert.match(guard.steps.find(s => s.id === 'speed_budget').if, /!cancelled\(\)/, '動作の失敗で速度測定まで消さない')
  assert.match(guard.steps.find(s => s.run?.includes('speed-budget.test.mjs')).if, /!cancelled\(\)/)
  assert.match(report.if, /!cancelled\(\)/)
  assert.match(report.env.SPEED_BUDGET_OUTCOME, /speed_budget.outcome/)
  assert.match(report.env.STRESS_SPEED_OUTCOME, /stress_speed.outcome/)
  const perf3 = guard.steps.find(s => s.id === 'perf3_targets')
  assert.ok(!perf3['continue-on-error'])
  assert.match(perf3.run, /perf3-targets.mjs/)
  assert.match(report.env.PERF3_TARGETS_OUTCOME, /perf3_targets.outcome/)
  for (const [job, name] of [[guard, 'Upload V8 behavior guard results'], [screen, 'Upload V8 screen guard results']]) {
    const upload = job.steps.find(s => s.name === name)
    assert.match(upload.if, /always\(\)/)
    assert.match(upload.with.path, /\/tmp\/v8-guard\//)
  }
})


test('local-stubはAPI外のバージョン確認もCIと同じ固定応答にし、外部通信を残さない', async () => {
  const routes = new Map()
  const page = { route: async (pattern, answer) => routes.set(pattern, answer) }
  const paths = []
  await stubApi(page, async (method, path) => { paths.push([method, path]); return { status: 200, body: '{"version":"2.6.4"}' } })
  let fulfilled
  await routes.get('**/admin/**')({ request: () => ({ url: () => 'https://example.test/admin/version', method: () => 'GET', headers: () => ({ origin: 'http://127.0.0.1:4393' }) }), fulfill: async value => { fulfilled = value } })
  assert.deepEqual(paths, [['GET', '/admin/version']])
  assert.equal(fulfilled.status, 200)
  assert.equal(JSON.parse(fulfilled.body).version, '2.6.4')
  assert.equal(fulfilled.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:4393')
})

test('超過を数値の表へ残して終了0、enforceへ戻すと終了1。欠測はどちらも終了1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'speed-enforcement-'))
  try {
    const fixture = join(dir, 'fixture.json'), summary = join(dir, 'summary.md')
    const script = join(dir, 'check.mjs')
    const budgetUrl = new URL('./speed-budget.mjs', import.meta.url).href
    const outcomeUrl = new URL('./speed-outcome.mjs', import.meta.url).href
    writeFileSync(script, `import {readFileSync} from 'node:fs'; import {budgetExceedances} from ${JSON.stringify(budgetUrl)}; import {finishSpeedCheck} from ${JSON.stringify(outcomeUrl)};
      const result=JSON.parse(readFileSync(process.argv[2],'utf8'));
      if(!result.complete || result.error || !Number.isFinite(result.measured[0].showMs)) throw new Error('測定が未完了');
      process.exitCode=finishSpeedCheck(budgetExceedances(result.measured,result.baselines));`)
    const slow = { complete: true, measured: [{ name: 'dashboard', ...base, showMs: 2000, jsBytes: base.jsBytes + 1025 }], baselines: { dashboard: base } }
    const run = mode => spawnSync(process.execPath, [script, fixture], { encoding: 'utf8', env: { ...process.env, V8_SPEED_ENFORCEMENT: mode, GITHUB_STEP_SUMMARY: summary } })
    writeFileSync(fixture, JSON.stringify(slow))
    assert.equal(run('report').status, 0)
    const table = readFileSync(summary, 'utf8')
    assert.match(table, /速さの上限を超えた物/)
    assert.match(table, /dashboard \| showMs \| 2000ms \| 1200ms \| \+800ms/)
    assert.match(table, /dashboard \| jsBytes \| 11025B \| 11024B \| \+1B/)
    assert.equal(run('enforce').status, 1)
    for (const corrupt of [{ ...slow, complete: false }, { ...slow, error: '画面が開かない' }, { ...slow, measured: [{ name: 'dashboard', showMs: null }] }]) {
      writeFileSync(fixture, JSON.stringify(corrupt))
      for (const mode of ['report', 'enforce']) assert.equal(run(mode).status, 1)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
