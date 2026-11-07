import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { connectGuardBrowser } from './browser-session.mjs'
import { assess, assessAgainstBase, DEFECT_ROUTES, measurePage } from './layout-defects.mjs'
const shell = body => '<style>*{box-sizing:border-box}body{margin:0;font:16px/20px sans-serif}main{width:1000px}</style><main>'+body+'</main>'

const cases = {
  'control-overlap': '<div data-list-row style="display:flex"><button style="width:100px;height:36px">コピー</button><button style="width:36px;height:36px;margin-left:-30px">…</button></div>',
  'control-blocked': '<div data-list-row style="position:relative"><button style="width:80px;height:36px">…</button><span style="position:absolute;left:20px;top:0;width:36px;height:36px;background:#fff"></span></div>',
  wrap: '<span data-list-name style="display:block;width:50px">短い名前の折り返し</span>',
  squash: '<button style="width:24px;word-break:break-all">20件表示</button>',
  clip: '<div style="overflow:hidden;width:100px"><span style="white-space:nowrap">横にはみ出した短い文字列です</span></div>',
  overlap: '<div style="position:relative"><span style="display:inline-block;width:120px">隣と重なる文字</span><span style="margin-left:-90px">重なった隣の文字</span></div>',
}
const repairs = {
  'control-overlap': cases['control-overlap'].replace('margin-left:-30px', 'margin-left:16px'),
  'control-blocked': cases['control-blocked'].replace('left:20px', 'left:120px'),
  wrap: cases.wrap.replace('width:50px','width:300px;white-space:nowrap'),
  squash: cases.squash.replace('width:24px;word-break:break-all','width:100px;white-space:nowrap'),
  clip: cases.clip.replace('overflow:hidden;width:100px','overflow:visible;width:500px'),
  overlap: cases.overlap.replace('margin-left:-90px','margin-left:16px'),
}
test('実物の表CSS：窓内のコンテナ幅を壊すと取消が押せず、修復後は押せる', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    const css = readFileSync(new URL('../../src/components/shared/data-table.module.css', import.meta.url), 'utf8')
    const html = style => `<html data-theme="v8"><style>${style}</style><body><div style="display:flex;flex-direction:column;align-items:flex-start;width:560px"><div class="frame" data-shared-part="list-table"><table class="table"><tbody><tr><td><button>取り消す</button></td></tr></tbody></table></div></div></body></html>`
    const hit = () => page.locator('button').evaluate(el => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    await page.setContent(html(css.replace('width: 100%; min-width: 0; container-type: inline-size;', 'container-type: inline-size;')))
    assert.equal(await hit(), false, '幅の指定を外すと子の操作が隠れる')
    await page.setContent(html(css))
    assert.equal(await page.locator('.frame').evaluate(el => el.getBoundingClientRect().width), 560)
    assert.equal(await hit(), true, '実物CSSで取消の中央を押せる')
  } finally { await browser.close() }
})
test('追従バーの裏の文字と、実際に見える重なりを区別する', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1152, height: 900 } })
    const covered = '<div style="height:200px;overflow:auto"><div style="height:300px">本文の文字</div><footer style="position:sticky;bottom:0;background:white;height:40px;z-index:2">保存の操作</footer></div>'
    // 追従した帯と本文を同じ位置へ置く。
    const fixture = covered.replace('height:300px', 'height:180px;padding-top:160px')
    await page.setContent(shell(fixture))
    assert.equal((await measurePage(page)).some(f => f.kind === 'overlap'), false)
    await page.locator('footer').evaluate(el => el.style.background = 'transparent')
    assert.ok((await measurePage(page)).some(f => f.kind === 'overlap'), '透明な帯では両方の文字が見える')
    await page.setContent(shell(fixture.replace('保存の操作', cases.overlap)))
    assert.ok((await measurePage(page)).some(f => f.kind === 'overlap'), '不透明な帯の中の重なりは検出する')
  } finally { await browser.close() }
})
test('種類ごとに実物を壊し、検出・終了コード1・修復後0を確認する', async () => {
  const browser = await connectGuardBrowser()
  const dir = mkdtempSync(join(tmpdir(),'v8-defects-'))
  try {
    const page = await browser.newPage({viewport:{width:1152,height:900}})
    for (const [kind, body] of Object.entries(cases)) {
      await page.setContent(shell(body))
      const findings = await measurePage(page)
      assert.ok(findings.some(f=>f.kind===kind),kind+' を検出する')
      assert.ok(assess(findings,'/fixture',1152,[]).failures.some(f=>f.kind===kind))
      await page.setContent(shell(repairs[kind]))
      assert.deepEqual(assess(await measurePage(page),'/fixture',1152,[]).failures,[],kind+'の修復')
    }
    await page.close()
  } finally { await browser.close() }
  try {
    // CLI 自身も種類別に止まる。起動は壊れた9枚で1回、修復9枚で1回。
    const fixture = join(dir,'test.html'), manifest = join(dir,'cases.json')
    writeFileSync(manifest,JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k,v])=>[k,shell(v)]))))
    const run = spawnSync(process.execPath,['apps/web/scripts/v8-guard/layout-defects.mjs','--fixtures',manifest],{encoding:'utf8',timeout:60000})
    assert.equal(run.status,1,run.stdout+run.stderr)
    for (const kind of Object.keys(cases)) {
      assert.match(run.stdout,new RegExp('崩れ 1152 /fixture/'+kind+': 新規[1-9]'))
      assert.match(run.stdout,new RegExp('  '+kind+' '))
    }
    writeFileSync(manifest,JSON.stringify(Object.fromEntries(Object.entries(repairs).map(([k,v])=>[k,shell(v)]))))
    const fixed = spawnSync(process.execPath,['apps/web/scripts/v8-guard/layout-defects.mjs','--fixtures',manifest],{encoding:'utf8',timeout:60000})
    assert.equal(fixed.status,0,fixed.stdout+fixed.stderr)
    for (const kind of Object.keys(cases)) assert.match(fixed.stdout,new RegExp('崩れ 1152 /fixture/'+kind+': 新規0'))
    writeFileSync(fixture,shell('<p>正常な一行</p>'))
    const good = spawnSync(process.execPath,['apps/web/scripts/v8-guard/layout-defects.mjs','--fixture',fixture],{encoding:'utf8',timeout:60000})
    assert.equal(good.status,0,good.stdout+good.stderr)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
test('除外を実寸で確認し、表内の文字の重なりは見逃さない', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({viewport:{width:1152,height:900}})
    await page.setContent(shell('<aside data-template-region="folders">'+cases.wrap+'</aside><nav>'+cases.squash+'</nav><div data-line-preview-part="talk">'+cases.wrap+'</div><div style="display:flex;flex-direction:column"><div role="row" style="height:60px;border:1px solid">行1</div><div role="row" style="height:60px;border:1px solid">行2</div></div>'))
    assert.deepEqual(await measurePage(page),[])
    await page.setContent(shell('<div style="background:white;height:900px"><p style="margin:0">画面いっぱいの板</p></div>'))
    assert.deepEqual(await measurePage(page),[])
    await page.setContent(shell('<div role="row">'+cases.overlap+'</div>'))
    assert.ok((await measurePage(page)).some(f=>f.kind==='overlap'))
    await page.setContent(shell('<div style="width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="全文の名前">全文の名前が長い場合の省略</div>'))
    assert.equal((await measurePage(page)).some(f=>f.kind==='clip'),false)
    await page.setContent(shell('<div style="display:flex;gap:16px"><span style="width:80px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="長い名前の全文">長い名前が右の文字の裏まで続く省略</span><span>隣の名前</span></div>'))
    assert.equal((await measurePage(page)).some(f=>f.kind==='overlap'),false,'省略で隠れた文字は隣と重なっていない')
    await page.setContent(shell('<small style="display:block;width:120px">買うたびに数えます。売上を追うときに</small>'))
    assert.equal((await measurePage(page)).some(f=>f.kind==='wrap'),false,'説明文は短い名前の折り返しではない')
    await page.setContent(shell('<div style="overflow:hidden;width:100px"><span style="white-space:nowrap">省略なしで切れた長い名前を検出する</span></div>'))
    assert.ok((await measurePage(page)).some(f=>f.kind==='clip'),'隠れた重なりを除いても、省略なしの切れは検出する')
  } finally { await browser.close() }
})
test('comparison fails only new defects, including additional copies of an existing defect', () => {
  const defect = { kind: 'overlap', target: 'span', text: '本文', measure: { x: 10, y: 10 } }
  const newDefect = { ...defect, target: 'button' }
  const result = assessAgainstBase([defect, newDefect, defect], [defect])
  assert.deepEqual(result.failures, [newDefect, defect])
  assert.deepEqual(result.allowed, [])
  assert.deepEqual(result.existing, [defect])
  assert.deepEqual(result.baseFindings, [defect])
  assert.deepEqual(assessAgainstBase([defect], [defect]).failures, [])
  assert.deepEqual(assessAgainstBase(
    [{ ...defect, target: 'div:nth-of-type(2)', targetIdentity: 'div:unique' }],
    [{ ...defect, target: 'div:nth-of-type(1)', targetIdentity: 'div:unique' }],
  ).failures, [])
  assert.deepEqual(assess([defect]).failures, [defect])
  assert.deepEqual(assess([]).failures, [])
})

test('conversions guard measures the canonical points tab instead of the legacy redirect', () => {
  assert.equal(DEFECT_ROUTES.conversions, '/affiliates?tab=points')
})

test('short names fail when wrapped; paragraphs and message bodies can wrap without punctuation rules', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(shell('<p style="width:120px">再開すると、止めたところから続きを送ります</p><div style="width:120px;white-space:pre-wrap">さん、こんにちは。\n明日お待ちしています</div><span data-list-name style="display:block;width:40px">短い名前の折り返し</span>'))
    const wrapped = (await measurePage(page)).filter(f => f.kind === 'wrap')
    assert.equal(wrapped.length, 1)
    assert.match(wrapped[0].text, /短い名前/)
    await page.locator('[data-list-name]').evaluate(el => { el.style.width = '400px'; el.style.whiteSpace = 'nowrap' })
    assert.equal((await measurePage(page)).some(f => f.kind === 'wrap'), false)
  } finally { await browser.close() }
})
