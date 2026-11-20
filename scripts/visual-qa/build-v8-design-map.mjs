/**
 * V8・V8-B の板と画面の対応表（`v8-design-map.json`）を作る。
 *
 * 絵の正本は作業フォルダ（`V8_DESIGN_DIR`、既定は
 * `/Users/kentakenta/lh-work/design/v8`）にあり、リポジトリには入れない。
 * この道具は、その3つの表を読んで「板ID → 画面の場所・種類・幅」だけを
 * 抜き出した JSON を作る。JSON は画面を開くための案内として使い、見た目の合否には使わない。
 *
 * 使い方
 *   node scripts/visual-qa/build-v8-design-map.mjs [--out <JSON>]
 *
 * 読みもの（優先順位は上から）
 *   1. BOARD-INDEX.md … 板ID・文書（V8/V8-B）・板の名前・見本の場所（496枚）
 *   2. HANDOVER-MAP.md … V8 の板の画面の場所・種類
 *   3. V8B-HANDOVER-MAP.md … V8-B の板の画面の場所・種類
 *   4. specs/pages/*.md … 仕様が名指しする板ID（対応表に無いと警告だけ出す）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_URLS } from './v8-board-urls.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DESIGN_DIR = process.env.V8_DESIGN_DIR ?? '/Users/kentakenta/lh-work/design/v8'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 && args[outIndex + 1]
  ? resolve(ROOT, args[outIndex + 1])
  : join(HERE, 'v8-design-map.json')

/** 表の1行を `|` で割る。見出しと区切り行は捨てる。 */
function tableRows(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|[\s-:|]+\|$/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0 && !/^[-—]+$/.test(cells[0].replace(/\s/g, '')))
}

/**
 * 板IDを抜く。BOARD-INDEX は `` `板ID` ``、対応表は裸の ID で書いてある。
 * 無い行は null。見出し（`Pencil ID`）は空白を含むので拾わない。
 */
function boardIdOf(cell) {
  const text = (cell ?? '').trim()
  const quoted = /`([A-Za-z0-9]{5,6})`/.exec(text)
  if (quoted) return quoted[1]
  if (/^[A-Za-z0-9]{5,6}$/.test(text)) return text
  return null
}

/**
 * 画面の場所の欄を整える。`A・B・C` と並んでいたら全部残し、
 * いちばん前を代表にする（撮影は代表で開く）。
 * `?view=…` のような指定つきも残す（そのタブで開くため）。
 * `apps/liff` のような管理画面でない置き場は拾わない。
 */
function routesOf(cell) {
  if (!cell) return []
  return cell
    .split(/[・、]/)
    .map((part) => part.trim())
    .map((part) => (/^\/[A-Za-z0-9\-/_?=&]*$/.exec(part) ? part : null))
    .filter(Boolean)
    .filter((route, index, all) => all.indexOf(route) === index)
}

/** （1152）と書いてある板は 1152 幅で見る。それ以外は 1440。 */
function widthOf(kind, name) {
  const text = `${kind} ${name}`
  if (/1152/.test(text)) return 1152
  // お客さまの画面（LIFF・414幅）は PC の点検対象外。幅を決めない。
  if (/LIFF|414/.test(text)) return null
  return 1440
}

function fail(message) {
  console.error(`[build-v8-design-map] ${message}`)
  process.exit(1)
}

const boardIndexPath = join(DESIGN_DIR, 'BOARD-INDEX.md')
const handoverPath = join(DESIGN_DIR, 'HANDOVER-MAP.md')
const handoverV8BPath = join(DESIGN_DIR, 'V8B-HANDOVER-MAP.md')
const specsDir = join(DESIGN_DIR, 'specs', 'pages')
for (const path of [boardIndexPath, handoverPath, handoverV8BPath]) {
  if (!existsSync(path)) fail(`設計の表が無い: ${path}（V8_DESIGN_DIR を見直してください）`)
}

const boards = new Map()

// 1. 板の一覧（496枚）が土台。見本の有無もここで確かめる。
for (const cells of tableRows(readFileSync(boardIndexPath, 'utf8'))) {
  // | 文書 | 板ID | 板の名前 | 見本 |
  if (cells.length < 4) continue
  const [doc, idCell, name, shotCell] = cells
  if (doc !== 'V8' && doc !== 'V8-B') continue
  const id = boardIdOf(idCell)
  if (!id) continue
  const shot = /lint\/(V8(?:-B)?)\/shots\/([A-Za-z0-9]+\.png)/.exec(shotCell)
  boards.set(id, {
    doc,
    name: name.trim(),
    kind: null,
    route: null,
    routes: [],
    width: widthOf('', name),
    shot: shot ? `lint/${shot[1]}/shots/${shot[2]}` : null,
  })
}

// 2・3. 対応表（画面の場所・種類）を重ねる。V8-B を後に読むので、
// 同じ ID が両方にあれば V8-B 側の行が勝つ（V8-B が新しいため）。
for (const path of [handoverPath, handoverV8BPath]) {
  const text = readFileSync(path, 'utf8')
  for (const cells of tableRows(text)) {
    // V8: | 機能 | Pencil ID | 板の名前 | 種類 | 画面の場所 | 主な API | 要るもの |
    // V8-B: | 組 | 行 | ID | 板 | 種類 | 画面の場所 | C | D | X | できるか | 手間 | 直し |
    const isV8B = path === handoverV8BPath
    const idCell = isV8B ? cells[2] : cells[1]
    const nameCell = isV8B ? cells[3] : cells[2]
    const kindCell = isV8B ? cells[4] : cells[3]
    const routeCell = isV8B ? cells[5] : cells[4]
    const id = boardIdOf(idCell)
    if (!id) continue
    const routes = routesOf(routeCell)
    const entry = boards.get(id) ?? { doc: isV8B ? 'V8-B' : 'V8', name: '', shot: null }
    entry.kind = (kindCell || '').trim() || entry.kind
    // route は画面の場所（`?` の前まで）。url は開く形（タブ指定つき）。
    const full = routes[0] ?? entry.url ?? null
    entry.route = full ? full.split('?')[0] : (entry.route ?? null)
    entry.url = full ?? entry.url ?? null
    entry.routes = [...new Set([...(entry.routes ?? []), ...routes])]
    if (nameCell && nameCell.trim()) entry.name = entry.name || nameCell.trim()
    entry.width = widthOf(entry.kind ?? '', entry.name)
    boards.set(id, entry)
  }
}

// 3b. 分類の行（「そのほか／通知」のように、1行に分類の画面の場所を全部並べた行）は、
// いちばん前（/notifications）を代表にすると、LINEアカウント・運用状態・EC連携などの板を
// 関係ない「通知」の画面と比べてしまう（監査 ROOT-19）。板ごとの正しい場所（開く指定つき）は
// v8-board-urls.mjs で決める。決まっていない分類の行の板は場所を空にし、撮影は --route を求める。
const CATEGORY_ROW_MIN_ROUTES = 4
const unplaced = []
for (const [id, entry] of boards) {
  const exact = BOARD_URLS[id]
  if (exact) {
    entry.url = exact
    entry.route = exact.split('?')[0]
    continue
  }
  if ((entry.routes ?? []).length >= CATEGORY_ROW_MIN_ROUTES) {
    entry.url = null
    entry.route = null
    unplaced.push(id)
  }
}
if (unplaced.length > 0) {
  console.warn(`[build-v8-design-map] 分類の行だけで場所が決まらない板（BOARD_URLS に足す）: ${unplaced.join(', ')}`)
}

// 4. 仕様が名指しする板ID。対応表に無いものは警告（落とさない）。
// 仕様は運用の都合で先に進むことがあるため、ここでは足さない。
const specIds = new Set()
if (existsSync(specsDir)) {
  const { readdirSync } = await import('node:fs')
  for (const file of readdirSync(specsDir).filter((name) => name.endsWith('.md'))) {
    const text = readFileSync(join(specsDir, file), 'utf8')
    for (const m of text.matchAll(/`([A-Za-z0-9]{5,6})`/g)) specIds.add(m[1])
  }
}
const unknownSpecIds = [...specIds].filter((id) => !boards.has(id))
if (unknownSpecIds.length > 0) {
  console.warn(`[build-v8-design-map] 仕様だけが名指しする板（対応表に無し）: ${unknownSpecIds.join(', ')}`)
}

// 採用で消えた板ID。ここに載せた ID を実装が使うと契約試験が落とす。
// 載せるときは、どの判断で消えたかを行末に書く。
const retired = []

const map = {
  generatedBy: 'scripts/visual-qa/build-v8-design-map.mjs',
  sources: ['BOARD-INDEX.md', 'HANDOVER-MAP.md', 'V8B-HANDOVER-MAP.md', 'specs/pages/*.md'],
  designDir: DESIGN_DIR,
  boardCount: boards.size,
  retired,
  boards: Object.fromEntries([...boards.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(map, null, 2)}\n`)
console.log(`[build-v8-design-map] ${boards.size} 板 → ${OUT}`)
const withRoute = [...boards.values()].filter((entry) => entry.route).length
console.log(`[build-v8-design-map] 画面の場所つき ${withRoute} 板・場所なし ${boards.size - withRoute} 板`)
