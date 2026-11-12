import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { compileUiStyles } from './compile-ui-styles.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))

/** 実Buttonと、データ名を開く実呼出元を同じテーマで描く。 */
export async function compileTextButtonFixture() {
  const sheets = []
  const compiled = await build({
    stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import Button from './src/components/shared/button';
import TextLink from './src/components/shared/text-link';
import CustomerInfoPanel from './src/components/shared/customer-info-panel';
import ReservationPeopleGrid from './src/components/shared/reservation-people-grid';
const tones=['default','ink','danger','accent','quiet'],states=['enabled','disabled','aria','locked','selected','filter'];
const entry={id:'reservation-a',customerName:'見本 141',startsAt:'2026-10-31T10:00:00+09:00',endsAt:'2026-10-31T11:00:00+09:00',resourceIds:[],status:'confirmed',version:1};
function Fixture(){return <main><p data-body>本文の文字色</p>{['accent-deep','ink','ink-secondary','danger','link'].map(token=><span key={token} data-token={token} style={{color:'var(--color-'+token+')'}}>色の基準</span>)}<span data-selection style={{color:'var(--color-selection-border)'}}>選択中</span><div className="matrix">{['standard','inline'].flatMap(size=>tones.flatMap(tone=>states.map(state=>{const id=[size,tone,state].join('-');return <section data-case={id} data-size={size} data-tone={tone} data-state={state} key={id}><Button variant="text" size={size} textTone={tone==='default'?undefined:tone} disabled={state==='disabled'} aria-disabled={state==='aria'?true:undefined} lockedReason={state==='locked'?'閲覧のみのため変更できません。':undefined} aria-pressed={state==='selected'?true:undefined} filterActive={state==='filter'} onClick={()=>{window.fixtureClicks=(window.fixtureClicks||0)+1}}>内容を確認する</Button></section>})))}</div><Button variant="text" href="#details" data-link>記録を見る</Button><Button variant="text" data-icon aria-label="閉じる"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 2L14 14M2 14L14 2" stroke="currentColor"/></svg></Button><section data-real-data-name><ReservationPeopleGrid entries={[entry]} resources={[]} date="2026-10-31" canWrite={false} busy={false} onOpen={()=>{window.opened=(window.opened||0)+1}} onError={()=>{}}/></section><section data-native-links><TextLink href="#detail" data-native-arrow>記録の詳細を見る</TextLink><TextLink inline href="#settings" data-native-inline>設定を開く</TextLink><CustomerInfoPanel friendId="friend-link" fields={[]} state="ready" canEdit={false} sections={[]}/></section></main>}
window.fixtureClicks=0;window.opened=0;createRoot(document.getElementById('root')).render(<Fixture/>);` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    tsconfig: webRoot + '/tsconfig.json', define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"', 'process.env': '{}' },
    plugins: [{ name: 'text-button-fixture', setup(b) {
      b.onResolve({ filter: /(?:staff-identity-state|session-snapshot)$/ }, args => ({ path: args.path, namespace: 'identity-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'identity-fixture' }, args => ({ contents: args.path.endsWith('staff-identity-state')
        ? 'const identity={role:"viewer"};export const readStaffIdentity=()=>identity;export const effectiveStaffRole=()=>"viewer";export const subscribeStaffIdentity=()=>()=>{};'
        : 'export const readPermissionSessionSnapshot=()=>null;export const SESSION_SNAPSHOT_CHANGED="fixture-session";', loader: 'js' }))
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'next-fixture' }))
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'next-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'next-fixture' }, args => ({ contents: args.path === 'navigation'
        ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();'
        : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
      b.onLoad({ filter: /\.module\.css$/ }, args => {
        const original = args.path
        const prefix = `fixture_${sheets.length}_`, names = {}
        const css = readFileSync(original, 'utf8').replace(/\.([A-Za-z][\w-]*)/g, (_, name) => { names[name] = prefix + name; return '.' + names[name] })
        sheets.push(css.replace(/:global\(([^()]+)\)/g, '$1'))
        return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
      })
      b.onLoad({ filter: /\.css$/ }, async args => { sheets.push(await compileUiStyles(args.path)); return { contents: '', loader: 'js' } })
    } }],
  })
  const css = [await compileUiStyles(webRoot + '/src/app/globals.css'), ...sheets].join('\n')
  return { script: compiled.outputFiles[0].text, css }
}

export function textButtonFixtureHtml(css) {
  return `<html lang="ja" data-theme="v8"><head><meta charset="utf-8"><style>${css}
body{margin:0;color:var(--color-ink)}main{max-width:1100px;margin:auto;padding:24px}.matrix{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}section{min-width:0}
</style></head><body class="font-sans"><div id="root"></div></body></html>`
}
