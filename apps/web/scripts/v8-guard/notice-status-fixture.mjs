import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { compileUiStyles } from './compile-ui-styles.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))

/** 同じ依存・書式で、実部品の旧新だけを入れ替えて比較する。認証は閲覧者の表示用fixture。 */
export async function compileNoticeFixture({ baselineDirectory, nativeActions = false, includeTypography = false } = {}) {
  const sheets = []
  const typographySamples = includeTypography ? `
{['info','success','warn','danger'].map(tone=><section data-kind-sample={'compact-'+tone} key={'compact-'+tone}><h2>{'compact / '+tone}</h2><Notice tone={tone} compact title={'登録した内容は消えていません。内容を確認してもう一度お試しください。'.repeat(8)}>{'登録した内容は消えていません。内容を確認してもう一度お試しください。'.repeat(8)}</Notice></section>)}
{['info','success','warn','danger'].map(tone=><section data-kind-sample={'small-'+tone} key={'small-'+tone}><h2>{'text-xs / '+tone}</h2><Notice tone={tone}><p className="text-xs font-semibold">登録した内容を確認してください。</p></Notice></section>)}
<section data-kind-sample="small-readonly"><h2>text-xs / ReadOnlyNotice</h2><ReadOnlyNotice><p className="text-xs font-semibold">登録した内容を確認してください。</p></ReadOnlyNotice></section>
<section data-kind-sample="small-relaxed"><h2>text-xs leading-relaxed / warn</h2><Notice tone="warn"><p className="text-xs leading-relaxed">登録した内容を確認してください。</p></Notice></section>
` : ''
  const compiled = await build({
    stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import Notice from './src/components/shared/notice';
import ReadOnlyNotice from './src/components/shared/read-only-notice';
import Button from './src/components/shared/button';
import FriendFilterBand from './src/components/shared/friend-filter-band';
${nativeActions ? "import legacyStyles from './src/v8/tags/list.module.css';" : ''}
const cases=[];
for(const tone of ['info','success','warn','danger','readonly']) {
  for(const prefix of (tone==='warn'||tone==='danger'?[true,false]:[false])) {
    for(const variant of ['single','multi','action']) cases.push({tone,prefix,variant});
  }
}
for(const tone of ['warn','danger']) for(const prefix of [true,false]) cases.push({tone,prefix,variant:'heading'});
function Fixture(){return <main><h1>知らせの実部品・表示対照</h1><p>認証の控えだけを閲覧者に固定した見た目の試験です。</p><div className="matrix">{cases.map(({tone,prefix,variant})=>{
 const id=tone+'-'+prefix+'-'+variant;
 const text=variant==='single'?'登録した内容を確認してください。':'登録した内容は消えていません。通信が戻ってから、内容を確認してもう一度お試しください。';
 const click=()=>{window.fixtureClicks=(window.fixtureClicks||0)+1};
 const action=${nativeActions ? '<button type="button" className={legacyStyles.inlineRetry} onClick={click}>もう一度</button>' : '<Button variant="text" size="inline" data-notice-inline-action onClick={click}>もう一度</Button>'};
 const body=variant==='multi'?<p>{text}<br/>入力した内容と選んだ行はそのまま残ります。</p>:<>{text}{variant==='action'?action:null}</>;
 return <section key={id} data-case={id}><h2>{tone} / 札{prefix?'あり':'なし'} / {variant}</h2><div data-before>上の内容</div>{tone==='readonly'?<ReadOnlyNotice>{body}</ReadOnlyNotice>:<Notice tone={tone} statusWord={prefix?undefined:false} heading={variant==='heading'?'接続の状態':undefined}>{body}</Notice>}<div data-after>次の内容</div></section>
})}</div><section data-disabled><Notice tone="danger">通信を待っています。<Button variant="text" size="inline" data-notice-inline-action disabled>もう一度</Button></Notice></section><section data-gap-check><Notice tone="danger">変更できませんでした。${nativeActions ? '<button type="button" className={legacyStyles.inlineRetry}>もう一度</button>' : '<Button variant="text" size="inline" data-notice-inline-action>もう一度</Button>'}</Notice></section><section data-paragraph-margin><Notice tone="danger"><p style={{marginBlock:12}}>内容を確認してください。<a href="#details">設定の案内</a></p></Notice></section><div data-placement-reference style={{display:"flex",flexDirection:"column",alignItems:"flex-start"}}><Button variant="primary">連携を確認する</Button></div><section data-placement-standalone><Notice tone="info"><div style={{display:'flex',flexDirection:'column',alignItems:'flex-start'}}><Button variant="primary">連携を確認する</Button><p>この下の注記と左の位置をそろえます。</p></div></Notice></section><section data-placement-flex><FriendFilterBand friend={{id:'friend-a',displayName:'見本 141'}} subject="配信" listHref="/broadcasts"/></section>${typographySamples}</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: webRoot + '/tsconfig.json', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'notice-fixture', setup(b) {
      b.onResolve({ filter: /(?:staff-identity-state|session-snapshot)$/ }, args => ({ path: args.path, namespace: 'identity-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'identity-fixture' }, args => ({ contents: args.path.endsWith('staff-identity-state')
        ? 'const identity={role:"viewer"};export const readStaffIdentity=()=>identity;export const effectiveStaffRole=()=>"viewer";export const subscribeStaffIdentity=()=>()=>{};'
        : 'export const readPermissionSessionSnapshot=()=>null;export const SESSION_SNAPSHOT_CHANGED="fixture-session";', loader: 'js' }))
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'next-fixture' }))
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'next-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'next-fixture' }, args => ({ contents: args.path === 'navigation'
        ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();'
        : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
      if (baselineDirectory) b.onLoad({ filter: /[/\\](?:notice|read-only-notice)\.tsx$/ }, args => ({ contents: readFileSync(baselineDirectory + '/' + basename(args.path), 'utf8'), loader: 'tsx', resolveDir: fileURLToPath(new URL('../../src/components/shared', import.meta.url)) }))
      b.onLoad({ filter: /\.module\.css$/ }, args => {
        const original = baselineDirectory && args.path.endsWith('/notice.module.css') ? baselineDirectory + '/notice.module.css' : args.path
        const prefix = `fixture_${sheets.length}_`, names = {}
        const css = readFileSync(original, 'utf8').replace(/\.([A-Za-z][\w-]*)/g, (_, name) => { names[name] = prefix + name; return '.' + names[name] })
        sheets.push(css.replace(/:global\(([^()]+)\)/g, '$1'))
        return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
      })
      b.onLoad({ filter: /\.css$/ }, async args => { sheets.push(await compileUiStyles(args.path)); return { contents: '', loader: 'js' } })
    } }],
  })
  const css = [await compileUiStyles(webRoot + '/src/app/globals.css', includeTypography ? ['text-xs','font-semibold','leading-relaxed'] : []), ...sheets].join('\n')
  return { script: compiled.outputFiles[0].text, css }
}

export function noticeFixtureHtml(css) {
  return `<html lang="ja" data-theme="v8"><head><meta charset="utf-8"><style>${css}
body{margin:0}main{max-width:1100px;margin:auto;padding:24px}.matrix{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{min-width:0}h1{font-size:18px}h2{font-size:13px;margin:0 0 8px}p{margin:0}[data-before],[data-after]{font-size:12px;color:var(--color-ink-secondary)}
</style></head><body class="font-sans"><div id="root"></div></body></html>`
}

export function measureNoticeMatrix() {
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  return [...document.querySelectorAll('[data-case]')].map(section => {
    const notice = section.querySelector('[data-design-part="notice"]')
    const n = rect(notice), before = rect(section.querySelector('[data-before]')), after = rect(section.querySelector('[data-after]'))
    const css = getComputedStyle(notice)
    const lines = []
    const walker = document.createTreeWalker(notice.querySelector('[data-notice-message]'), NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue
      const range = document.createRange(); range.selectNodeContents(node)
      for (const box of range.getClientRects()) if (box.width > 0 && !lines.some(y => Math.abs(y - box.y) < 0.75)) lines.push(box.y)
    }
    return { id: section.dataset.case, notice: n, before, after, gapBefore: n.y - before.y - before.height, gapAfter: after.y - n.y - n.height, fontSize: css.fontSize, fontFamily: css.fontFamily, lineHeight: css.lineHeight, textLines: lines.length, readOnly: notice.hasAttribute('data-read-only-notice') }
  })
}
