/**
 * `docs/v8-board-to-code.md`（V8 の絵の板 → 画面の URL → 画面のファイル）を作り直す。
 *
 * 対応表を作る際は、次の取り違えを防ぐ。
 *   - `?id=` などの指定つきの URL で入口（page.tsx）を探せず「page.tsx なし」になる
 *   - 入口が読む共通の見出し（readonly-header-v8）を画面のファイルとして載せる
 *   - 分類の行の板（LINEアカウント・プールなど）を /notifications の画面に載せる
 *
 * 作り方
 *   1. 板の並びは今の文書から読む。画面の URL は撮影の対応表を優先し、
 *      両方とも同じ実URL・タブ指定から作る。--out で保護文書の変更案だけを出せる。
 *   2. 入口・画面のファイルは、その URL の入口 `apps/web/src/app/<URL の道>/page.tsx` が
 *      import する V8 の画面から毎回作り直す（`@/v8/…` を先に、次に `*-v8` のファイル。共通の見出しは除く）。
 *
 * 使い方
 *   node scripts/visual-qa/build-v8-board-to-code.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_URLS } from './v8-board-urls.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SRC = join(ROOT, 'apps', 'web', 'src')
const APP = join(SRC, 'app')
const DOC = join(ROOT, 'docs', 'v8-board-to-code.md')
const outAt = process.argv.indexOf('--out')
const OUT = outAt >= 0 && process.argv[outAt + 1] ? resolve(ROOT, process.argv[outAt + 1]) : DOC

const NO_SPLIT = '（入口から画面本体を自動特定できないため要確認）'
const NO_PAGE = '（page.tsx なし）'
const NO_URL = '（撮らない板・URL なし）'

/** 入口の page.tsx。URL の指定（? の後ろ）は外して探す。 */
export function entryOf(url) {
  if (!url) return null
  const path = url.split('?')[0].replace(/\/+$/, '')
  const file = join(APP, path, 'page.tsx')
  return existsSync(file) ? file : null
}

/** 共通の見出し・枠は画面のファイルではない。 */
const NOT_A_SCREEN = /(?:^|\/)readonly-header-v8$/

/** 入口が読む V8 の画面のファイル（src からの相対、拡張子つき）。 */
export function v8FilesOf(entryFile) {
  const source = readFileSync(entryFile, 'utf8')
  const v8 = []
  const local = []
  // 静的な import と、dynamic(() => import('…')) の両方を読む（リッチメニューの編集などは後者）。
  for (const match of source.matchAll(/(?:from\s+|import\(\s*)'([^']+)'/g)) {
    const spec = match[1]
    if (spec.startsWith('@/v8/')) {
      v8.push(resolveTsx(join(SRC, spec.slice(2))))
    } else if (spec.startsWith('.') && /-v8(?:$|[/.])/.test(spec)) {
      if (NOT_A_SCREEN.test(spec)) continue
      local.push(resolveTsx(normalize(join(dirname(entryFile), spec))))
    } else if (spec.startsWith('@/app/') && /-v8(?:$|[/.])/.test(spec)) {
      if (NOT_A_SCREEN.test(spec)) continue
      local.push(resolveTsx(join(SRC, spec.slice(2))))
    }
  }
  return [...new Set([...v8, ...local].filter(Boolean))].map((file) => relative(SRC, file))
}

function resolveTsx(base) {
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|')
}

export function buildRows(map, previous) {
  return previous.map(([doc, id, name, urlCell]) => {
    const kept = urlCell && urlCell !== '—' ? urlCell : null
    const entryInMap = map.boards[id]
    const url = entryInMap ? (entryInMap.url ?? entryInMap.route ?? null) : (BOARD_URLS[id] ?? kept)
    const board = { doc, name: map.boards[id]?.name ?? name }
    const entry = entryOf(url)
    const files = entry ? v8FilesOf(entry) : []
    return { id, board, url, entry, files }
  })
}

function main() {
  const map = JSON.parse(readFileSync(join(HERE, 'v8-design-map.json'), 'utf8'))
  const previous = readFileSync(DOC, 'utf8')
    .split('\n')
    .filter((line) => /^\| V8(?:-B)? \|/.test(line))
    .map((line) => line.slice(1, -1).split(' | ').map((part) => part.trim()))
  const rows = buildRows(map, previous)
  rows.sort((a, b) => {
    if ((a.url === null) !== (b.url === null)) return a.url === null ? 1 : -1
    return (a.url ?? '').localeCompare(b.url ?? '') || a.board.doc.localeCompare(b.board.doc) || a.id.localeCompare(b.id)
  })
  let readsV8 = 0
  let readsApp = 0
  let noSplit = 0
  let noUrl = 0
  const lines = rows.map(({ id, board, url, entry, files }) => {
    let entryCell
    let fileCell
    if (!url) {
      noUrl += 1
      entryCell = '—'
      fileCell = NO_URL
    } else if (!entry) {
      entryCell = NO_PAGE
      fileCell = '—'
    } else {
      entryCell = `\`${relative(SRC, entry)}\``
      if (files.length === 0) {
        noSplit += 1
        fileCell = NO_SPLIT
      } else {
        if (files.some((file) => file.startsWith('v8/'))) readsV8 += 1
        else readsApp += 1
        fileCell = files.map((file) => `\`${file}\``).join('<br>')
      }
    }
    return `| ${board.doc} | ${id} | ${cell(board.name)} | ${url ?? '—'} | ${entryCell} | ${fileCell} |`
  })
  const verifiedOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date())
  const head = [
    `> 文書：V8の板とコードの対応｜区分：今の説明（自動生成）｜最終確認：${verifiedOn}（日本時間）`,
    '',
    '# V8 の絵（Pencil の板）と画面のコードの対応表',
    '',
    '- 作り直し：`node scripts/visual-qa/build-v8-board-to-code.mjs`（手で直さない）。URL は `scripts/visual-qa/v8-design-map.json` と同じもの（実URL・タブ指定）。入口・画面のファイルは、その URL の入口（`page.tsx`、`?` の後ろは外して探す）が読む `@/v8/…` または `*-v8` のファイル。共通の見出し（`readonly-header-v8`）は画面のファイルに数えない。',
    '- 画面本体は `apps/web/src/v8/<機能>/` に置き、`app/**/page.tsx` は入口だけにする。現在のimportから本体を探し、見た目の一致率で置き場を選ばない（`apps/web/src/v8/README.md`）。1つの入口が複数の画面を読むとき（タブごと）は全部並べる。',
    '- この表はURLとコードの対応を調べる案内。板の合否・対象数の正本は `docs/v8-requirements/v8-switch.md` と正式台帳を参照し、この表の行数を合格の分母にしない。',
    '- 画面の中の見た目は型・部品で決まるので、まず `docs/v8-where-to-change.md` を読む。',
    `- 数：src/v8 を読む板 ${readsV8}・app の V8 ファイルだけを読む板 ${readsApp}・入口から画面本体を自動特定できない板（要確認） ${noSplit}・URL なし ${noUrl}。`,
    '',
    '| 文書 | 板ID | 板の名前 | 画面のURL | 入口 | V8 の画面ファイル |',
    '|---|---|---|---|---|---|',
  ]
  writeFileSync(OUT, `${[...head, ...lines].join('\n')}\n`)
  console.log(`[build-v8-board-to-code] ${rows.length} 板 → ${relative(ROOT, OUT)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) main()
