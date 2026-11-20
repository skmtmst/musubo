import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * 偽 API が、
 * 本物の Worker と同じ器で返すことを見張る。
 *
 * 起動して叩くのではなく `bodyFor` を直接読む。bind が要らないので
 * 砂場でも走る。必要な口が無いとすべて既定の器
 *（`{items:[],total:0,page:1,limit:20}`）が返り、画面が落ちたり
 * 「読み込めませんでした」と表示されたりする。
 */
const HERE = dirname(fileURLToPath(import.meta.url))

type BodyFor = (method: string, pathname: string, query?: URLSearchParams) => { success: boolean; data?: unknown; error?: string }

let bodyFor: BodyFor
let writeBody: (method: string, pathname: string) => unknown

const SCRATCH = join(HERE, '.mock-bodyfor.check.mjs')

beforeAll(async () => {
  const src = readFileSync(join(HERE, 'mock-api.mjs'), 'utf8')
  const cut = src.indexOf('const server = createServer')
  if (cut < 0) throw new Error('mock-api.mjs から server 生成部が見つかりません')
  const body = `${src.slice(0, cut)}\nexport { bodyFor, visualQaWriteBody };\n`
  writeFileSync(SCRATCH, body)
  const loaded = (await import(pathToFileURL(SCRATCH).href)) as { bodyFor: BodyFor; visualQaWriteBody: typeof writeBody }
  bodyFor = loaded.bodyFor
  writeBody = loaded.visualQaWriteBody
})

afterAll(() => {
  try { unlinkSync(SCRATCH) } catch { /* 消せなくても残さない */ }
})

function get(pathname: string, query = '') {
  return bodyFor('GET', pathname, new URLSearchParams(query)) as { success: boolean; data: Record<string, unknown> }
}

describe('監査Aで足した口の形', () => {
  it('テスト送信先の候補は配列', () => {
    const res = get('/api/account-settings/test-recipient-login-users', 'accountId=x')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    if (!Array.isArray(res.data)) throw new Error('test-recipient-login-users の応答は配列のはず')
    const first = res.data[0] as Record<string, unknown>
    expect(typeof first.staffName).toBe('string')
    expect(typeof first.sameAccount).toBe('boolean')
  })

  it('バナー生成の集計・プリセット・一覧は本物の器', () => {
    const stats = get('/api/hq/banners/stats')
    expect((stats.data.projects as { active: unknown }).active).toBeTypeOf('number')
    const presets = get('/api/hq/banners/presets')
    expect(Array.isArray(presets.data.presets)).toBe(true)
    expect((presets.data.usage as { month: { used: unknown } }).month.used).toBeTypeOf('number')
    expect(Array.isArray(get('/api/hq/banners/projects').data)).toBe(true)
    expect(Array.isArray(get('/api/hq/banners/images').data)).toBe(true)
  })

  it('送信経路の台帳は capabilities と paths の配列', () => {
    const res = get('/api/operations/send-paths')
    expect(Array.isArray(res.data.capabilities)).toBe(true)
    expect(Array.isArray(res.data.paths)).toBe(true)
  })

  it('NEN 会員・ペット・健康日記は kpis と pageSize を持つ', () => {
    const settings = get('/api/nen/rank-settings')
    expect((settings.data.kpis as { members: unknown }).members).toBeTypeOf('number')
    expect(Array.isArray(settings.data.ranks)).toBe(true)
    for (const pathname of ['/api/nen/members', '/api/nen/pets', '/api/nen/health']) {
      const res = get(pathname)
      expect(Array.isArray(res.data.items)).toBe(true)
      expect(res.data.pageSize).toBeTypeOf('number')
      expect(typeof res.data.kpis).toBe('object')
    }
  })

  it('友だち追加の実行詳細は actionRuns の配列', () => {
    const res = get('/api/friend-add-runs/friend-add-run-1')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data.actionRuns)).toBe(true)
  })

  it('リマインダの登録者は配列', () => {
    const res = get('/api/reminders/reminder-1/registrants')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
  })

  it('運用者へのお知らせは line-notifications 名でも返す', () => {
    const res = get('/api/line-notifications/operator-rules', 'lineAccountId=x')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data.items)).toBe(true)
    expect((res.data.summary as { total: unknown }).total).toBeTypeOf('number')
    const preview = writeBody('POST', '/api/line-notifications/operator-rules/recipients-preview') as { items: unknown[] }
    expect(Array.isArray(preview.items)).toBe(true)
  })

  it('取り込みの記録（view=actions）は処理1件ずつの器', () => {
    const res = get('/api/ec-commerce/events', 'lineAccountId=x&view=actions&limit=20&offset=0')
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data.items)).toBe(true)
    expect((res.data.items as Array<Record<string, unknown>>).length).toBeGreaterThan(0)
    expect(typeof res.data.summary).toBe('object')
  })

  it('未知のレシピは失敗にする', () => {
    const res = bodyFor('GET', '/api/recipes/no-such-recipe', new URLSearchParams())
    expect(res.success).toBe(false)
  })
})
