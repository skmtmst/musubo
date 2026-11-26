// 手動の実ブラウザ試験: リポジトリのルートから browser-host.mjs 経由で実行する。
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { connectGuardBrowser } from '../../../scripts/v8-guard/browser-session.mjs'
import { compileUiStyles } from '../../../scripts/v8-guard/compile-ui-styles.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sheets = new Set()
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PageHeading,PageFrame} from './src/components/templates/page-frame';
import Button from './src/components/shared/button';
import {rememberStaffIdentity} from './src/lib/staff-identity-state';
rememberStaffIdentity({role:'viewer'});
createRoot(document.getElementById('root')).render(<PageFrame kind={globalThis.fixtureKind} standalone><PageHeading title="一斉配信の詳細と送信設定を確認する" readOnlyBand actions={<><Button lockedReason="管理者に頼んでください。">操作を変更する</Button><Button variant="primary" lockedReason="管理者に頼んでください。">設定を保存する</Button></>}/></PageFrame>);
` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: `${webRoot}/tsconfig.json`,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:9"' },
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'navigation' ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();' : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    b.onLoad({ filter: /\.module\.css$/ }, args => {
      let css = readFileSync(args.path, 'utf8'); const globals = []
      css = css.replace(/:global\(([^()]*)\)/g, (_, value) => `GLOBAL_SELECTOR_${globals.push(value) - 1}`)
      const names = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => [m[1], `fixture_${sheets.size}_${m[1]}`]))
      css = css.replace(/\.([A-Za-z][\w-]*)/g, (_, name) => `.${names[name]}`).replace(/GLOBAL_SELECTOR_(\d+)/g, (_, index) => globals[Number(index)])
      sheets.add(css); return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
    })
    b.onLoad({ filter: /\.css$/ }, args => { sheets.add(readFileSync(args.path, 'utf8')); return { contents: '', loader: 'js' } })
  } }],
})
const globals = await compileUiStyles(`${webRoot}/src/app/globals.css`, [])
const css = [globals, ...sheets].join('\n').replace(/:global\(([^()]*)\)/g, '$1')
const browser = await connectGuardBrowser()
try {
  for (const [width, boardWidth] of [[1152, 560], [1440, 700]]) {
   for (const kind of ['settings', 'detail', 'create']) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent(`<html data-theme="v8"><style>${css} *{box-sizing:border-box} body{margin:0;background:#f5f5f7} #root{width:${boardWidth}px;margin:70px auto;background:white} [data-page-template]{min-height:0!important}</style><div id="root"></div></html>`)
    await page.addScriptTag({ content: `globalThis.fixtureKind=${JSON.stringify(kind)};` + compiled.outputFiles[0].text })
    const title = await page.getByRole('heading', { name: '一斉配信の詳細と送信設定を確認する' }).boundingBox()
    const actions = await page.getByRole('button', { name: '設定を保存する' }).boundingBox()
    const firstAction = await page.getByRole('button', { name: '操作を変更する' }).boundingBox()
    const notice = await page.locator('[data-read-only-notice]').boundingBox()
    assert.ok(title && actions && firstAction && notice)
    assert.ok(actions.y < title.y + title.height, '操作は見出しと同じ行にある')
    assert.ok(notice.y >= title.y + title.height, '閲覧帯は見出しの下にある')
    assert.ok(title.x + title.width <= firstAction.x, '題と最初の操作は重ならない')
    assert.ok(title.width >= 120, '題が読める幅を保つ')
    if (process.env.D17_SCREENSHOT_DIR) { mkdirSync(process.env.D17_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.D17_SCREENSHOT_DIR}/heading-${kind}-${width}.png` }) }
    await page.close()
   }
  }
} finally { await browser.close() }
