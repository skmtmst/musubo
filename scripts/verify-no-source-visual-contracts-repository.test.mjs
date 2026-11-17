import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSourceTests, newSourceAssertions, checkRepository, splitModuleMoves } from './verify-no-source-visual-contracts.mjs'

const entry = 'apps/web/src/example.test.tsx'
const analyze = (body, extras = new Map(), file = entry) => analyzeSourceTests(new Map([
  [file, `import {readFileSync as read} from 'node:fs'; import {it,expect} from 'vitest';
    const src=read('apps/web/src/example.tsx','utf8'); it('case',()=>{${body}});`],
  ...extras,
]), [file])

test('repository git rename detection preserves a moved test but fails a deliberately added source assertion', () => {
  const root = mkdtempSync(join(tmpdir(), 'source-contract-rename-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    mkdirSync(join(root, 'apps/web/src'), { recursive: true })
    const source = `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const src=readFileSync('view.tsx');it('case',()=>{expect(src).toContain('styles.row')})`
    writeFileSync(join(root, entry), source)
    git('add', '.'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD'), moved = 'apps/web/src/renamed.test.tsx'
    git('mv', entry, moved)
    assert.equal(checkRepository(root, base).findings.length, 0)
    writeFileSync(join(root, moved), source.replace("expect(src).toContain('styles.row')", "expect(src).toContain('styles.row');expect(src).toContain('styles.deliberateRegression')"))
    const broken = checkRepository(root, base)
    assert.equal(broken.findings.length, 1)
    assert.match(broken.findings[0].expression, /deliberateRegression/)
    writeFileSync(join(root, moved), source)
    writeFileSync(join(root, entry), source)
    assert.equal(checkRepository(root, base).findings.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('renaming the read source keeps an unchanged assertion while unrelated read roots stay new', () => {
  const run = path => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const src=readFileSync('${path}');it('case',()=>expect(src).toContain('styles.row'))`]]))
  const moves = new Map([['apps/web/src/view.tsx', 'apps/web/src/moved/view.tsx']])
  for (const [from, to] of [['apps/web/src/view.tsx', 'apps/web/src/moved/view.tsx'], ['src/view.tsx', 'src/moved/view.tsx'], ['view.tsx', 'moved/view.tsx']]) {
    assert.equal(newSourceAssertions(run(from), run(to), moves).length, 0)
    assert.equal(newSourceAssertions(run(from), run('unrelated.tsx'), moves).length, 1)
    assert.equal(newSourceAssertions(run(from), [...run(to), ...run(to)], moves).length, 1)
  }
})

test('a named default implementation retains lineage when split; ambiguous or unrelated defaults do not', () => regressionCase(() => {
  const old = 'apps/web/src/old.tsx', next = 'apps/web/src/feature/main.tsx'
  const before = new Map([[old, 'export default function Orders(){ return <Old/> }']])
  const after = new Map([[next, "import { Body } from './body';export default function Orders(){return <Body/>}"]])
  const moves = splitModuleMoves(before, after)
  assert.equal(moves.get(old), next)
  assert.equal(splitModuleMoves(before, new Map([...after, ['apps/web/src/another.tsx', after.get(next)]])).has(old), false)
  assert.equal(splitModuleMoves(before, new Map([[next, 'export default function Other(){return null}']])).has(old), false)
  assert.equal(splitModuleMoves(new Map([[old, 'export default () => null']]), after).has(old), false)
  const run = path => analyzeSourceTests(new Map([[entry, `import {readFileSync}from'node:fs';import{it,expect}from'vitest';it('case',()=>expect(readFileSync('${path}')).toContain('label'))`]]))
  assert.equal(newSourceAssertions(run(old), run(next), moves).length, 0)
  assert.equal(newSourceAssertions(run(old), [...run(next), ...run(next)], moves).length, 1)
  assert.equal(newSourceAssertions(run(old), run('unrelated.tsx'), moves).length, 1)
}))

test('aliased path functions and array reads retain separate roots, and a new root or copied assertion fails', () => {
  const run = (parts, file = entry) => analyzeSourceTests(new Map([[file, `import{readFileSync}from'node:fs';import{join as sourceJoin}from'node:path';import{it,expect}from'vitest';const text=${JSON.stringify(parts)}.map(name=>readFileSync(sourceJoin(__dirname,name))).join('');it('case',()=>expect(text).toContain('label'))`]]))
  const old = run(['view.tsx', 'model.ts'])
  assert.deepEqual(old[0].reads, ['apps/web/src/model.ts', 'apps/web/src/view.tsx'])
  const moved = 'apps/web/src/moved.test.tsx', moves = new Map([[entry, moved]])
  assert.equal(newSourceAssertions(old, run(['view.tsx', 'model.ts'], moved), moves).length, 0)
  assert.equal(newSourceAssertions(old, run(['view.tsx', 'new.tsx'], moved), moves).length, 1)
  assert.equal(newSourceAssertions(old, [...run(['view.tsx', 'model.ts'], moved), ...run(['view.tsx', 'model.ts'], moved)], moves).length, 1)
})

test('a renamed opaque reader keeps its identity without approving a changed read root', () => {
  const run = (file, path) => analyzeSourceTests(new Map([[file, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const text=readFileSync(sourceJoin(__dirname,'${path}'));it('case',()=>expect(text).toContain('label'))`]]))
  const moved = 'apps/web/src/moved.test.tsx', moves = new Map([[entry, moved]])
  assert.equal(newSourceAssertions(run(entry, 'view.tsx'), run(moved, 'view.tsx'), moves).length, 0)
  assert.equal(newSourceAssertions(run(entry, 'view.tsx'), run(moved, 'other.tsx'), moves).length, 1)
})

test('AST node predicates inspect syntax, while raw root text and getFullText remain source assertions', () => {
  const run = body => analyzeSourceTests(new Map([[entry, `import ts from 'typescript';import{readFileSync}from'node:fs';import{it,expect}from'vitest';it('case',()=>{const ast=ts.createSourceFile('view.tsx',readFileSync('view.tsx'));${body}})`]]))
  assert.deepEqual(run('expect(ts.isFunctionDeclaration(ast.statements[0])).toBe(true)'), [])
  assert.ok(run("expect(ast.text).toContain('className')").length)
  assert.ok(run("expect(ast.getFullText()).toContain('className')").length)
})

test('temporary fixture results are executable test data; copying product source there retains its origin', () => {
  const run = content => analyzeSourceTests(new Map([[entry, `import{mkdtempSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{it,expect}from'vitest';it('case',()=>{const root=mkdtempSync('/tmp/fixture-');const path=join(root,'view.tsx');writeFileSync(path,${content});expect(readFileSync(path)).toContain('className')})`]]))
  assert.deepEqual(run(`'<div className="fixture"/>'`), [])
  assert.ok(run(`readFileSync('apps/web/src/example.tsx')`).length)
})

test('an extracted dependency can accompany its retained read root; unrelated roots, new strings and copies fail', () => {
  const source = 'apps/web/src/view.tsx', extracted = 'apps/web/src/model.ts', other = 'apps/web/src/other.ts'
  const modules = new Map([[source, "import { model } from './model'; export default model"], [extracted, 'export const model = 1'], [other, 'export const other = 1']])
  const run = (roots, text = 'label') => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const value=${JSON.stringify(roots)}.map(path=>readFileSync(path)).join('');it('case',()=>expect(value).toContain('${text}'))`]]))
  const before = run([source]), after = run([source, extracted])
  assert.equal(newSourceAssertions(before, after, new Map(), modules).length, 0)
  assert.equal(newSourceAssertions(before, run([source, other]), new Map(), modules).length, 1)
  assert.equal(newSourceAssertions(before, run([source, extracted], 'new-label'), new Map(), modules).length, 1)
  assert.equal(newSourceAssertions(before, [...after, ...after], new Map(), modules).length, 1)
  assert.equal(newSourceAssertions(before, run([other]), new Map(), modules).length, 1)
})

test('changing a reader argument from segments to one path preserves the assertion but not a changed target', () => {
  const run = args => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{join}from'node:path';import{it,expect}from'vitest';function read(...parts){return readFileSync(join(__dirname,...parts))}it('case',()=>expect(read(${args})).toContain('label'))`]]))
  assert.equal(newSourceAssertions(run("'feature','view.tsx'"), run("'feature/view.tsx'")).length, 0)
  assert.equal(newSourceAssertions(run("'feature','view.tsx'"), run("'other/view.tsx'")).length, 1)
})

test('renaming a case title preserves its assertion; a new case copying it still increases the count', () => {
  const run = (title, text = 'label', path = 'view.tsx') => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const source=readFileSync('${path}');it('${title}',()=>expect(source).toContain('${text}'))`]]))
  const before = run('historical title'), after = run('describes behavior')
  assert.equal(newSourceAssertions(before, after).length, 0)
  assert.equal(newSourceAssertions(before, [...before, ...after]).length, 1)
  assert.equal(newSourceAssertions(before, run('describes behavior', 'new-label')).length, 1)
  assert.equal(newSourceAssertions(before, run('describes behavior', 'label', 'other.tsx')).length, 1)
})

// 回帰用の小さなプログラムを実行し、解析器の返す値と終了値を検証する。
function regressionCase(run) {
  const program = `import assert from 'node:assert/strict';
    import { analyzeSourceTests, newSourceAssertions, checkRepository, splitModuleMoves } from ${JSON.stringify(new URL('./verify-no-source-visual-contracts.mjs', import.meta.url).href)};
    const entry = ${JSON.stringify(entry)};
    const analyze = ${analyze.toString()};
    (${run.toString()})();`
  execFileSync(process.execPath, ['--input-type=module', '-e', program], { stdio: 'pipe' })
}

test('Worker, LIFF and scripts source assertions use the same diff guard as Web', () => regressionCase(() => {
  for (const file of ['apps/worker/src/routes/example.test.ts', 'apps/liff/src/example.test.tsx', 'scripts/example.test.mjs']) {
    const before = analyzeSourceTests(new Map([[file, `import{it,expect}from'vitest';it('runs',()=>expect(1+1).toBe(2))`]]))
    const after = analyzeSourceTests(new Map([[file, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const source=readFileSync('example.ts');it('shape',()=>expect(source).toContain('return true'))`]]))
    assert.equal(before.length, 0)
    assert.equal(newSourceAssertions(before, after).length, 1)
    assert.deepEqual(newSourceAssertions(after, after), [])
  }
}))

test('removing literal table cases preserves old pairs while additions, replacements and copies remain new', () => regressionCase(() => {
  const run = (rows, expression = 'expect(readFileSync(path)).toMatch(gate)') => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const SCREENS=[${rows}];it.each(SCREENS)('screen %s',(path,gate)=>${expression})`]]))
  const first = "['first.tsx',/first/]", second = "['second.tsx',/second/]", third = "['third.tsx',/third/]"
  const before = run([first, second, third].join(','))
  const after = run(first)
  assert.equal(newSourceAssertions(before, run([first, second].join(','))).length, 0)
  assert.equal(newSourceAssertions(before, after).length, 0)
  assert.equal(newSourceAssertions(before, [...after, ...after]).length, 1)
  for (const rows of [
    [first, "['new.tsx',/new/]"].join(','),
    "['first.tsx',/changed/]",
    "['replaced.tsx',/first/]",
    "['second.tsx',/first/]",
    "['first.tsx',/second/]",
    [first, first].join(','),
  ]) assert.equal(newSourceAssertions(before, run(rows)).length, 1, rows)
  assert.equal(newSourceAssertions(before, run(first, 'expect(readFileSync(path)).toContain(gate)')).length, 1)
}))

test('independent entries each retain the same analysis budget and one oversized entry still fails closed', () => regressionCase(() => {
  const body = `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const src=readFileSync('source.ts');it('case',()=>expect(src).toContain('return true'))`
  const files = new Map(Array.from({length: 12}, (_, i) => [`apps/worker/src/example-${i}.test.ts`, body]))
  assert.equal(analyzeSourceTests(files, [...files.keys()], 4).length, 12)
  assert.throws(() => analyzeSourceTests(new Map([[entry, body + ';const extra=0']]), [entry], 4), /exceeded its bound/)
  assert.throws(() => analyzeSourceTests(files, [...files.keys()], 500001), /Invalid AST statement budget/)
}))

test('subprocess test results are executable behavior; subprocess source reads retain their provenance', () => regressionCase(() => {
  const run = (command, args, property) => analyzeSourceTests(new Map([[entry, `import{spawnSync}from'node:child_process';import{it,expect}from'vitest';it('result',()=>expect(spawnSync('${command}',${JSON.stringify(args)}).${property}).toBe(0))`]]))
  assert.deepEqual(run('node', ['script.mjs'], 'status'), [])
  assert.ok(run('cat', ['view.tsx'], 'stdout').length)
}))

test('hashing and JSON encoding are pure transformations; comparing transformed product source still fails', () => regressionCase(() => {
  const run = input => analyzeSourceTests(new Map([[entry, `import{createHash as hash}from'node:crypto';import{readFileSync}from'node:fs';import{it,expect}from'vitest';it('value',()=>expect(JSON.stringify(hash('sha256').update(${input}).digest('hex'))).toBe('expected'))`]]))
  assert.deepEqual(run("'view.tsx'"), [])
  assert.ok(run("readFileSync('view.tsx')").length)
  assert.ok(analyze(`expect(JSON.stringify({source:src})).toContain('className')`).length)
}))

test('resolving a temporary fixture path preserves fixture provenance and copied product source stays tainted', () => regressionCase(() => {
  const run = content => analyzeSourceTests(new Map([[entry, `import{mkdtempSync,realpathSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{it,expect}from'vitest';it('fixture',()=>{const root=realpathSync(mkdtempSync('/tmp/fixture-'));const path=join(root,'view.tsx');writeFileSync(path,${content});expect(readFileSync(path)).toContain('className')})`]]))
  assert.deepEqual(run(`'<div className="fixture"/>'`), [])
  assert.ok(run(`readFileSync('apps/web/src/example.tsx')`).length)
}))





test('git reads from temporary fixtures are data; copied product source keeps its origin', () => regressionCase(() => {
  const run=content=>analyzeSourceTests(new Map([[entry,`import{execFileSync}from'node:child_process';import{mkdtempSync,writeFileSync,readFileSync}from'node:fs';import{join}from'node:path';import{it,expect}from'vitest';it('fixture',()=>{const root=mkdtempSync('/tmp/repo-');writeFileSync(join(root,'view.tsx'),${content});expect(execFileSync('git',['show','HEAD:view.tsx'],{cwd:root})).toContain('className')})`]]))
  assert.deepEqual(run(`'<div className="fixture"/>'`),[])
  assert.ok(run(`readFileSync('apps/web/src/example.tsx')`).length)
}))
