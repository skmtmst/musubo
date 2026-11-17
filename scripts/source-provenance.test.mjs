import { execFileSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSourceTests, newSourceAssertions, splitModuleMoves } from './verify-no-source-visual-contracts.mjs'
const entry = 'apps/web/src/example.test.tsx'
const analyze = body => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';const src=readFileSync('view.tsx');it('case',()=>{${body}})`]]))

function regressionCase(run) {
  const program = `import assert from 'node:assert/strict';
    import { analyzeSourceTests, newSourceAssertions, splitModuleMoves } from ${JSON.stringify(new URL('./verify-no-source-visual-contracts.mjs', import.meta.url).href)};
    const entry = ${JSON.stringify(entry)};
    const analyze = ${analyze.toString()};
    (${run.toString()})();`
  execFileSync(process.execPath, ['--input-type=module', '-e', program], { stdio: 'pipe' })
}

test('dynamic imports execute modules while raw imports still read source', () => {
  const run = raw => analyzeSourceTests(new Map([[entry, `import{it,expect}from'vitest';it('load',async()=>{const module=await import('./view.tsx${raw ? '?raw' : ''}');expect(module.answer()).toBe(42)})`]]))
  assert.deepEqual(run(false), [])
  assert.ok(analyzeSourceTests(new Map([[entry, `import source from './view.tsx?raw';import{it,expect}from'vitest';it('text',()=>expect(source).toContain('answer'))`]])).length)
})

test('compiler diagnostics are execution results and raw AST text stays source', () => {
  const code = `import ts from 'typescript';import{it,expect}from'vitest';it('compile',()=>{const program=ts.createProgram(['fixture.ts'],{});expect(program.getSemanticDiagnostics()).toEqual([])})`
  assert.deepEqual(analyzeSourceTests(new Map([[entry, code]])), [])
  assert.ok(analyze(`const ast=ts.createSourceFile('view.tsx',src);expect(ast.getFullText()).toContain('row')`).length)
})

test('a pure compatibility re-export retains a named implementation, without hiding copies or changed assertions', () => regressionCase(() => {
  const old = 'apps/web/src/Old.tsx', next = 'apps/web/src/old.tsx'
  const body = 'export default function View(){return null}'
  const before = new Map([[old, body]])
  const after = new Map([[old, "export {default} from './old'"], [next, body]])
  const moves = splitModuleMoves(before, after)
  assert.equal(moves.get(old), next)
  const run = (file, text = 'label') => analyzeSourceTests(new Map([[entry, `import{readFileSync}from'node:fs';import{it,expect}from'vitest';it('case',()=>expect(readFileSync('${file}')).toContain('${text}'))`]]))
  assert.equal(newSourceAssertions(run(old),run(next),moves).length,0)
  assert.equal(newSourceAssertions(run(old),run(next,'changed'),moves).length,1)
  assert.equal(newSourceAssertions(run(old),[...run(next),...run(next)],moves).length,1)
  after.set(old, "export {default as renamed} from './old'")
  assert.equal(splitModuleMoves(before,after).has(old),false)
  after.set(old, "sideEffect();export {default} from './old'")
  assert.equal(splitModuleMoves(before,after).has(old),false)
  after.set(old, "export {default} from './old'");after.set(next,'export default function Other(){return null}')
  assert.equal(splitModuleMoves(before,after).has(old),false)
}))

test('a reader collecting paths with Set and array spread keeps the requested roots', () => {
  const helper = 'apps/web/src/helper.mjs'
  const files = new Map([[entry,`import{readSource}from'./helper.mjs';import{it,expect}from'vitest';it('case',()=>expect(readSource('view.tsx')).toContain('label'))`],
    [helper,`import{readFileSync}from'node:fs';function paths(entry){const seen=new Set();seen.add(entry);return [...seen]}export function readSource(entry){return paths(entry).map(file=>readFileSync(file,'utf8')).join('\\n')}`]])
  const hits=analyzeSourceTests(files)
  assert.equal(hits.length,1)
  assert.deepEqual(hits[0].reads,['view.tsx'])
})

test('missing options use the declared default without reading a fabricated path', () => regressionCase(() => {
  const helper='scripts/scanner.mjs';
  const code=`import{readFileSync}from'node:fs';export function scan(options){const path=options.path===undefined?'fixture.json':options.path;return readFileSync(path,'utf8')}`;
  const run=options=>analyzeSourceTests(new Map([[entry,`import{it,expect}from'vitest';import{scan}from'../../../scripts/scanner.mjs';it('result',()=>expect(scan(${options})).toContain('value'))`],[helper,code]]));
  assert.deepEqual(run('{}'),[]);
  assert.ok(run(`{path:'view.tsx'}`).length);
}))

test('named re-exports retain reader provenance and changed roots still fail', () => regressionCase(() => {
  const helper='apps/web/src/helper.mjs',barrel='apps/web/src/index.mjs';
  const run=path=>analyzeSourceTests(new Map([[entry,`import{it,expect}from'vitest';import{readSource}from'./index.mjs';it('case',()=>expect(readSource()).toContain('label'))`],
    [barrel,`export{readSource}from'./helper.mjs'`],[helper,`import{readFileSync}from'node:fs';export function readSource(){return readFileSync('${path}')}`]]));
  assert.ok(run('first.tsx').length);
  assert.equal(newSourceAssertions(run('first.tsx'),run('second.tsx')).length,1);
}))

test('sorting source-derived values retains positive and forbidden comparisons', () => regressionCase(() => {
  assert.ok(analyze(`expect([src].sort()).toEqual(['fixed'])`).length);
  assert.deepEqual(analyze(`expect(src.match(/forbidden/g).sort()).toEqual([])`),[]);
  assert.ok(analyze(`const values=new Set();values.add(src);expect([...values]).toContain('fixed')`).length);
}))

test('mocked file readers execute fixture bodies while copied product text remains traced', () => regressionCase(() => {
  const run=body=>analyzeSourceTests(new Map([[entry,`import{readFileSync as read}from'node:fs';import{it,expect,vi}from'vitest';vi.mock('node:fs',()=>({readFileSync:path=>${body}}));it('value',()=>expect(read('view.tsx')).toContain('label'))`]]));
  assert.deepEqual(run(`'fixture data'`),[]);
  assert.ok(run(`read('product.tsx')`).length);
  const asyncReader=`import{readFile}from'node:fs';import{it,expect,vi}from'vitest';vi.mock('node:fs',async original=>({...await original(),readFileSync:path=>'fixture'}));it('value',async()=>expect(await readFile('product.tsx')).toContain('label'))`;
  assert.ok(analyzeSourceTests(new Map([[entry,asyncReader]])).length);
}))

test('removing an old read root retains identity without accepting new roots, copies or new expectations', () => regressionCase(() => {
  const run=(roots,text='label')=>analyzeSourceTests(new Map([[entry,`import{readFileSync}from'node:fs';import{it,expect}from'vitest';const source=${JSON.stringify(roots)}.map(path=>readFileSync(path)).join('');it('case',()=>expect(source).toContain('${text}'))`]]));
  const before=run(['first.tsx','second.tsx']),after=run(['first.tsx']);
  assert.equal(newSourceAssertions(before,after).length,0);
  assert.equal(newSourceAssertions(before,run(['other.tsx'])).length,1);
  assert.equal(newSourceAssertions(before,run(['first.tsx'],'changed')).length,1);
  assert.equal(newSourceAssertions(before,[...after,...after]).length,1);
}))

test('module loaders execute imports and keep file reader aliases traceable', () => regressionCase(() => {
  const code=`import{createRequire}from'node:module';import{it,expect}from'vitest';const load=createRequire(import.meta.url);const fs=load('node:fs');it('value',()=>expect(fs.readFileSync(dynamicPath)).toContain('label'))`;
  assert.ok(analyzeSourceTests(new Map([[entry,code]])).length);
  const source=`import{createRequire}from'node:module';import{readFileSync}from'node:fs';import{it,expect}from'vitest';const load=createRequire(import.meta.url);const src=readFileSync('product.tsx');it('value',()=>{load.externalAssert(src);expect(load.resolve(src)).toContain('label')})`;
  assert.equal(analyzeSourceTests(new Map([[entry,source]])).length,2);
}));
