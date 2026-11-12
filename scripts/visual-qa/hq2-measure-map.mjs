// 統括2周目の撮影条件。共有対応表を変えず、現在の押し口で各状態を撮る。
// node scripts/visual-qa/hq2-measure-map.mjs <正本の対応表> > .measure/hq2-map.json
import fs from 'node:fs'
import { HQ_BANNER_PROJECTS, HQ_BANNER_IMAGES, HQ_BANNER_USAGE, LINE_ACCOUNTS } from './fixtures.mjs'

const map = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const id of ['B24oNg', 'I0w2e', 'UcBQ5', 'iMnph', 'rI5uh', 'zOpMG', 'p03ImY']) {
  delete map.boards[id].state.manual
}
map.boards.BHEl9.state.click = ['見本 31さんの権限を変更']
map.boards.I0w2e.state.click = ['アーカイブ']
map.boards.X4JcOf.state.click = ['テンプレート「秋の新商品のお知らせ」の操作', '編集']
map.boards.meBRB.state.click = ['秋の新商品のお知らせを配る']
map.boards.p03ImY.url = '/hq/banners/project?id=banner-project-qa-1'
map.boards.p03ImY.state.api = {
  match: 'GET /api/hq/banners/projects/banner-project-qa-1$',
  body: { success: true, data: {
    project: { ...HQ_BANNER_PROJECTS[0], runningCount: 1 },
    images: HQ_BANNER_IMAGES.filter(image => image.projectId === 'banner-project-qa-1'),
    generations: [{ ...HQ_BANNER_IMAGES[0].generation, status: 'running', requestedCount: 4, doneCount: 1, failedCount: 0 }],
  } },
}
// 図の入力済み状態。初期値を製品側へ埋め込まず、撮影で入力する。
const filled = ['fill:テキスト 1行目=秋の新商品、はじまりました', '行を足す',
  'fill:テキスト 2行目=10/31 まで 送料無料', '行を足す', 'fill:テキスト 3行目=今すぐチェック']
map.boards.iMnph.state.click = filled
map.boards.zOpMG.state.click = filled
for (const id of ['B24oNg', 'I0w2e', 'UcBQ5', 'rI5uh']) map.boards[id].state.click = [...filled, ...map.boards[id].state.click]
map.boards.UcBQ5.state.api = { match: 'GET /api/hq/banners/images', body: { success: true, data: HQ_BANNER_IMAGES.slice(0, 12), nextBefore: null } }
const running = { ...map.boards.p03ImY.state.api.body.data.generations[0], id: 'banner-generation-qa-running', doneCount: 2 }
const projectImages = HQ_BANNER_IMAGES.filter(image => image.projectId === 'banner-project-qa-1')
const freshImages = projectImages.slice(0, 2).map((image, index) => ({ ...image, id: `banner-image-qa-fresh-${index}`, generationId: running.id, generation: running, deliveredAccountIds: [], isFavorite: false }))
map.boards.p03ImY.state.api = [
  { match: 'GET /api/hq/banners/projects/banner-project-qa-1$', body: { success: true, data: { project: HQ_BANNER_PROJECTS[0], images: [...freshImages, ...projectImages], generations: [] } } },
  { match: 'POST /api/hq/banners/projects/banner-project-qa-1/generations', body: { success: true, data: running } },
  { match: 'GET /api/hq/banners/generations/banner-generation-qa-running$', delayMs: 30000, body: { success: true, data: running } },
  { match: 'GET /api/hq/banners/usage$', body: { success: true, data: HQ_BANNER_USAGE } },
]
map.boards.p03ImY.state.click = [...filled, '4', 'press:Control+Home', '生成する（4枚）', '画像を生成']
const [testAccount, main, shibuya, archived, event] = LINE_ACCOUNTS
map.boards.rI5uh.state.api = { match: 'GET /api/line-accounts$', body: { success: true, data: [main, shibuya, { ...shibuya, id: 'visual-qa-account-futako', name: '然-NEN- 二子玉川店', displayName: '然-NEN- 二子玉川店', basicId: 'nen-futako' }, { ...event, displayName: '然-NEN- イベント' }, { ...testAccount, displayName: '然-NEN- テスト' }] } }
process.stdout.write(JSON.stringify(map, null, 2) + '\n')
