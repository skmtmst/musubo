import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCommonVarUsageCounts, getCommonVarUsageSummaries, getCommonVarUsageImpact } from '../src/common-vars/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let sqlite: Database.Database
let db: D1Database

function asD1(database: Database.Database): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let values: unknown[] = []
    const statement = database.prepare(sql)
    return {
      bind(...bound: unknown[]) {
        values = bound
        return this
      },
      async all<T>() {
        return { results: statement.all(...values) as T[], success: true, meta: {} }
      },
      async first<T>() {
        return (statement.get(...values) as T | undefined) ?? null
      },
      async run<T>() {
        statement.run(...values)
        return { success: true, results: [], meta: {} } as T
      },
      async raw() { return [] },
    } as unknown as D1PreparedStatement
  }
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.all())) as T
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.exec(readFileSync(join(HERE, '..', 'bootstrap.sql'), 'utf8'))
  db = asD1(sqlite)

  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES (?, ?, ?, ?, ?)`)
    .run('account-1', 'channel-1', '店舗1', 'token', 'secret')
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES (?, ?, ?, ?, ?)`)
    .run('account-2', 'channel-2', '店舗2', 'token', 'secret')
  sqlite.prepare(`INSERT INTO common_vars
    (id, line_account_id, name, var_key, type, value)
    VALUES (?, ?, ?, ?, 'text', '')`)
    .run('var-1', 'account-1', '営業時間', 'shop_hours')
  sqlite.prepare(`INSERT INTO common_vars
    (id, line_account_id, name, var_key, type, value)
    VALUES (?, ?, ?, ?, 'text', '')`)
    .run('var-2', 'account-1', '未使用', 'unused')
})

afterEach(() => sqlite.close())

describe('getCommonVarUsageCounts', () => {
  it('同じ使用先の複数欄に差し込まれても1か所として数え、別アカウントを混ぜない', async () => {
    sqlite.prepare(`INSERT INTO templates
      (id, line_account_id, name, message_type, message_content, question_json)
      VALUES (?, ?, ?, 'text', ?, ?)`)
      .run(
        'template-1',
        'account-1',
        '営業時間の案内',
        '{{var.shop_hours}}です',
        JSON.stringify({ text: '{{var.shop_hours}}' }),
      )
    sqlite.prepare(`INSERT INTO templates
      (id, line_account_id, name, message_type, message_content)
      VALUES (?, ?, ?, 'text', ?)`)
      .run('template-other', 'account-2', '別店舗', '{{var.shop_hours}}')

    const counts = await getCommonVarUsageCounts(
      db,
      ['shop_hours', 'unused', 'shop_hours'],
      'account-1',
    )

    expect(counts).toEqual(new Map([
      ['shop_hours', 1],
      ['unused', 0],
    ]))
  })
})


describe('構造化された使用先の数', () => {
  it('所属不明の使用先を含め、別アカウントの使用先は混ぜない', async () => {
    const layout = JSON.stringify({ references: [{ varKey: 'shop_hours' }] })
    sqlite.prepare('INSERT INTO forms (id, name, layout) VALUES (?, ?, ?)').run('unknown', '未割当', layout)
    sqlite.prepare('INSERT INTO forms (id, name, layout) VALUES (?, ?, ?)').run('other', '別店舗', layout)
    sqlite.prepare('INSERT INTO form_accounts (form_id, line_account_id) VALUES (?, ?)').run('other', 'account-2')
    const summary = await getCommonVarUsageSummaries(db, ['shop_hours', 'unused'], 'account-1')
    const impact = await getCommonVarUsageImpact(db, 'shop_hours', 'account-1')
    expect(summary.get('shop_hours')?.total).toBe(1)
    expect(summary.get('shop_hours')?.byKind.form).toBe(1)
    expect(summary.get('unused')?.total).toBe(0)
    expect(impact.unscopedFormTotal).toBe(1)
    expect(impact.blockingTotal).toBe(1)
  })
})
