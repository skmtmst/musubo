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

const positive = [
  `expect(src).toContain('className={styles.row}')`,
  `expect(src).toMatch(/<Field[^>]*label="名前"/)`,
  `expect(src).toContain('保存する')`,
  `expect(src).toContain('data-design-node="old"')`,
  `expect(src.includes('styles.row')).toBe(true)`,
  `expect(!src.includes('styles.row')).toBe(false)`,
  `expect(src.indexOf('<SearchField')).toBeLessThan(src.indexOf('<Select'))`,
  `const name='class'+'Name={styles.'+'row'+'}';expect(src).toContain(name)`,
  `const parts=['row','menu'];for(const part of parts)expect(src).toContain('styles.'+part)`,
  `const part=src.slice(src.indexOf('<Field'));expect(part).toContain('label="名前"')`,
  `const check=(text)=>expect(text).toContain('styles.row');check(src)`,
  `const verify=(text)=>{if(!text.includes('styles.row'))throw Error('missing')};verify(src)`,
  `unknownAssertion(src)`,
]
positive.forEach((body,i)=>test(`reject positive source path ${i+1}`,()=>assert.ok(analyze(body).length,body)))
test('source match counts cannot hide a positive assertion behind length', () => {
  assert.ok(analyze(`expect(src.match(/styles.row/g).length).toBe(1)`).length)
  assert.ok(analyze(`expect(src.split('className').length).not.toBe(0)`).length)
})
test('zero forbidden match counts remain prohibition checks', () => {
  assert.deepEqual(analyze(`expect(src.match(/window.confirm/g).length).toBe(0)`), [])
  assert.deepEqual(analyze(`expect(src.match(/window.confirm/g).length).toBeLessThanOrEqual(0)`), [])
})
test('built-in collections and path classifiers do not read fixture files', () => {
  assert.deepEqual(analyze(`const paths=new Set(['view.tsx']);expect(paths.has('view.tsx')).toBe(true);const limits=new Map([['view.tsx',400]]);expect(limits.get('view.tsx')).toBe(400);expect(Math.min(400,401)).toBe(400)`), [])
})
test('putting actual source in a Map retains its origin', () => {
  assert.ok(analyze(`const sources=new Map([['view.tsx',src]]);expect(sources.get('view.tsx')).toContain('styles.row')`).length)
})

const negative = [
  `expect(src).not.toContain('window.confirm(')`,
  `expect(src).not.toMatch(/old-v7-component/)`,
  `expect(src.includes('bg-[#')).toBe(false)`,
  `expect(!src.includes('bg-[#')).toBe(true)`,
  `expect(src.indexOf('window.confirm(')).toBe(-1)`,
  `const violations=src.match(/window.confirm/g);expect(violations).toEqual([])`,
  `const verify=(text)=>{if(text.includes('window.confirm'))throw Error('forbidden')};verify(src)`,
  `const html=renderToStaticMarkup(<button>保存する</button>);expect(html).toContain('保存する')`,
  `const html=renderToStaticMarkup(<div data-list-state="error"/>);expect(html).toContain('data-list-state="error"')`,
  `page.addStyleTag({content:src});expect(page.evaluate(()=>getComputedStyle(document.body).width)).toBe('100px')`,
  `expect(api.save).toHaveBeenCalledWith({name:'保存する'})`,
  `const json=read('fixture.json','utf8');expect(json).toContain('className')`,
  `const sql=read('schema.sql','utf8');db.exec(sql);expect(db.prepare('select count(*)').get()).toEqual({count:1})`,
  `// readFileSync('view.tsx'); expect(source).toContain('styles.row')`,
]
negative.forEach((body,i)=>test(`allow prohibition or executed result ${i+1}`,()=>assert.deepEqual(analyze(body),[],body)))

test('Node assert aliases distinguish match / doesNotMatch and false predicates',()=>{
  assert.ok(analyze(`const a=require('node:assert/strict');a.match(src,/styles.row/)`).length)
  const make=body=>analyzeSourceTests(new Map([[entry,`import fs from 'node:fs';import assertion from 'node:assert/strict';const src=fs.readFileSync('view.tsx','utf8');${body}`]]))
  assert.ok(make(`assertion.match(src,/styles.row/)`).length)
  assert.deepEqual(make(`assertion.doesNotMatch(src,/window.confirm/)`),[])
  assert.deepEqual(make(`assertion.equal(src.includes('window.confirm'),false)`),[])
  assert.deepEqual(analyzeSourceTests(new Map([[entry,`import {readFileSync}from'node:fs';import {doesNotMatch as prohibit}from'node:assert/strict';prohibit(readFileSync('view.tsx'),/window.confirm/)`]])),[])
})

test('conditional reader aliases remain source values',()=>{
  const source=`import {readFileSync as file} from 'node:fs';import {readUiSource as ui} from './helper.mjs';import {it,expect}from'vitest';const read=flag?ui:file;it('case',()=>expect(read('view.tsx')).toContain('styles.row'))`
  const files=new Map([[entry,source],['apps/web/src/helper.mjs',`import {readFileSync}from'node:fs';export function readUiSource(path){return readFileSync(path,'utf8')}`]])
  assert.ok(analyzeSourceTests(files).length)
})

test('local imported helpers propagate source and scopes do not taint unrelated exports',()=>{
  const helper='apps/web/src/helper.mjs'
  const files=new Map([[entry,`import {getUi as load,answer}from './helper.mjs';import {it,expect}from'vitest';it('source',()=>expect(load()).toContain('styles.row'));it('data',()=>expect(answer()).toBe('styles.row'))`],
    [helper,`import {readFileSync}from'node:fs';export const getUi=()=>readFileSync('view.tsx','utf8');export const answer=()=> 'styles.row'`]])
  const findings=analyzeSourceTests(files)
  assert.equal(findings.length,1)
  assert.equal(findings[0].test,'source')
})
test('conditional module-level reads in imported helpers keep their source origin', () => {
  const helper = 'apps/web/src/helper.mjs'
  const files = new Map([[entry, `import {getUi} from './helper.mjs';import {it,expect} from 'vitest';it('case',()=>expect(getUi()).toContain('styles.row'))`],
    [helper, `import {readFileSync} from 'node:fs';let source='';if(enabled){source=readFileSync('view.tsx')}export function getUi(){return source}`]])
  assert.ok(analyzeSourceTests(files).length)
})

test('helper changes introduce a different reading path even with unchanged test text',()=>{
  const helper='apps/web/src/helper.mjs',body=`import {getUi}from './helper.mjs';import {it,expect}from'vitest';it('case',()=>expect(getUi()).toContain('styles.row'))`
  const run=path=>analyzeSourceTests(new Map([[entry,body],[helper,`import {readFileSync}from'node:fs';export const getUi=()=>readFileSync('${path}','utf8')`]]))
  assert.equal(newSourceAssertions(run('a.tsx'),run('b.tsx')).length,1)
})

test('B/U numbers, contract filename and absence plus positive assertion do not exempt A',()=>{
  const hits=analyze(`expect(src).not.toContain('oldClass');expect(src).toContain('newClass')`,new Map(),'apps/web/src/b273-contract.test.ts')
  assert.equal(hits.length,1)
})

test('formatting and line moves preserve identity; replacement and copying never cancel',()=>{
  const before=analyze(`expect(src).toContain('styles.row')`)
  assert.equal(newSourceAssertions(before,analyze(`\n\n expect ( src ) . toContain ( 'styles.row' )`)).length,0)
  assert.equal(newSourceAssertions(before,analyze(`expect(src).toContain('styles.menu')`)).length,1)
  assert.equal(newSourceAssertions(before,analyze(`expect(src).toContain('styles.row')`,new Map(),'apps/web/src/moved.test.ts')).length,1)
  assert.equal(newSourceAssertions(before,[...before,...before]).length,1)
})

test('it.each constants and generated strings are part of identity',()=>{
  const run=parts=>analyzeSourceTests(new Map([[entry,`import {readFileSync}from'node:fs';import {it,expect}from'vitest';const src=readFileSync('view.tsx');it.each(${JSON.stringify(parts)})('case %s',part=>expect(src).toContain('styles.'+part))`]]))
  assert.equal(newSourceAssertions(run(['row']),run(['row','menu'])).length,1)
})

test('namespace and asynchronous file reads are traced',()=>{
  const run=body=>analyzeSourceTests(new Map([[entry,`import fs from 'node:fs';import {it,expect}from'vitest';it('case',async()=>{${body}})`]]))
  assert.ok(run(`const src=await fs.promises.readFile('view.tsx','utf8');expect(src).toContain('styles.row')`).length)
})

test('forbidden-result aggregation is allowed and lexical shadowing stays untainted',()=>{
  assert.deepEqual(analyze(`const forbidden=values=>values.filter(text=>text.includes('window.confirm'));expect(forbidden([src])).toEqual([])`),[])
  assert.deepEqual(analyze(`{const src='fixture';expect(src).toContain('fixture')}`),[])
})

test('conditional assignments keep both source paths instead of taking the last branch',()=>{
  assert.ok(analyze(`let text='fixture';if(flag)text=src;else text='data';expect(text).toContain('styles.row')`).length)
})

test('raw imports are source while existence checks are metadata',()=>{
  const make=code=>analyzeSourceTests(new Map([[entry,code]]))
  assert.ok(make(`import source from './view.tsx?raw';import {it,expect}from'vitest';it('case',()=>expect(source).toContain('styles.row'))`).length)
  assert.deepEqual(make(`import {existsSync as exists}from'node:fs';import {it,expect}from'vitest';it('case',()=>expect(exists('view.tsx')).toBe(true))`),[])
})

test('unknown consumers and opaque readers stay closed instead of ignoring an unresolved path',()=>{
  assert.ok(analyze(`expect(dynamicReader('view.tsx')).toContain('styles.row')`).length)
  assert.ok(analyze(`externalAssert(src)`)[0].reason==='unknown-source-consumer')
})

test('an imported prohibition helper can be interpreted without tainting its module',()=>{
  const helper='apps/web/src/helper.mjs'
  const files=new Map([[entry,`import {readFileSync}from'node:fs';import {it}from'vitest';import {prohibit}from'./helper.mjs';it('case',()=>prohibit(readFileSync('view.tsx')))`],
    [helper,`export function prohibit(source){if(source.includes('window.confirm'))throw Error('forbidden')}`]])
  assert.deepEqual(analyzeSourceTests(files),[])
})

test('large generated domains retain changes beyond the enumeration limit',()=>{
  const parts=Array.from({length:150},(_,i)=>'part'+i)
  const run=names=>analyzeSourceTests(new Map([[entry,`import{readFileSync}from'node:fs';import{it,expect}from'vitest';const src=readFileSync('view.tsx');it.each(${JSON.stringify(names)})('case',part=>expect(src).toContain('styles.'+part))`]]))
  assert.equal(newSourceAssertions(run(parts),run([...parts,'last-new-part'])).length,1)
})

test('source reads in setup hooks are traced, including hooks declared after tests',()=>{
  for(const hook of ['beforeEach','beforeAll']){
    const code=`import{readFileSync}from'node:fs';import{it,expect,${hook},afterEach}from'vitest';let src;it('case',()=>expect(src).toContain('styles.row'));${hook}(()=>src=readFileSync('view.tsx'));afterEach(()=>src='');`
    assert.ok(analyzeSourceTests(new Map([[entry,code]])).length)
  }
})

test('AST parsing is not a rendering boundary for a raw getText comparison',()=>{
  assert.ok(analyze(`const ast=ts.createSourceFile('view.tsx',src);expect(ast.getFullText()).toContain('styles.row')`).length)
  assert.deepEqual(analyze(`const ast=ts.createSourceFile('view.tsx',src);expect(findForbiddenImports(ast)).toEqual([])`),[])
})

test('class readers trace constructor fields, methods and getters',()=>{
  const run=path=>analyzeSourceTests(new Map([[entry,`import{readFileSync}from'node:fs';import{it,expect}from'vitest';class Reader{constructor(private path:string){}get source(){return readFileSync(this.path)}read(){return readFileSync(this.path)}}const reader=new Reader('${path}');it('getter',()=>expect(reader.source).toContain('styles.row'));it('method',()=>expect(reader.read()).toContain('styles.row'));`]]))
  assert.equal(run('view.tsx').length,2)
  assert.equal(newSourceAssertions(run('old.tsx'),run('new.tsx')).length,2)
  assert.deepEqual(run('data.json'),[])
})


test('git renames consume identical assertions once; a copied or changed assertion stays new', () => {
  const before = analyze(`expect(src).toContain('styles.row')`)
  const moved = analyze(`expect(src).toContain('styles.row')`, new Map(), 'apps/web/src/moved.test.ts')
  const moves = new Map([[entry, 'apps/web/src/moved.test.ts']])
  assert.equal(newSourceAssertions(before, moved, moves).length, 0)
  assert.equal(newSourceAssertions(before, [...moved, ...moved], moves).length, 1)
  assert.equal(newSourceAssertions(before, analyze(`expect(src).toContain('styles.new')`, new Map(), 'apps/web/src/moved.test.ts'), moves).length, 1)
})

test('adopting the split-file reader retains old assertions and detects new strings, copies and roots', () => {
  const helper = 'apps/web/src/helper.mjs'
  const helperSource = `import{readFileSync}from'node:fs';export function readUiSource(path){return readFileSync(path,'utf8')}`
  const run = (body, path = 'apps/web/src/example.tsx', reader = helperSource) => analyzeSourceTests(new Map([
    [entry, `import {readUiSource} from './helper.mjs';import {it,expect}from'vitest';const src=readUiSource('${path}');it('case',()=>{${body}})`],
    [helper, reader],
  ]))
  const direct = analyze(`expect(src).toContain('styles.row')`)
  const established = run(`expect(src).toContain('styles.established')`, 'established.tsx')
  const before = [...direct, ...established]
  const compare = current => newSourceAssertions(before, [...current, ...established])
  assert.equal(compare(run(`expect(src).toContain('styles.row')`)).length, 0)
  assert.equal(compare(run(`expect(src).toContain('styles.row');expect(src).toContain('styles.new')`)).length, 1)
  assert.equal(compare(run(`expect(src).toContain('styles.row');expect(src).toContain('styles.row')`)).length, 1)
  assert.equal(compare(run(`expect(src).toContain('styles.row')`, 'different.tsx')).length, 1)
  assert.equal(newSourceAssertions(direct, run(`expect(src).toContain('styles.row')`)).length, 1)
  assert.equal(compare(run(`expect(src).toContain('styles.row')`, 'apps/web/src/example.tsx', helperSource.replace("readFileSync(path,'utf8')", "readFileSync(path,'utf8')+'styles.row'"))).length, 1)
})
