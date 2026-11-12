import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTemplate, updateTemplate } from '../src/templates.js'
import { asD1 } from './d1-test-helper.js'

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '252_template_questions.sql'),
  'utf8',
)
// 347 は 252 の後ろに積む。本番のDBもこの順で進化する。
const migration347 = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '347_template_published_version.sql'),
  'utf8',
)

function setup() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      message_type TEXT NOT NULL,
      message_content TEXT NOT NULL,
      folder_id TEXT,
      carousel_actions_json TEXT,
      carousel_tap_limit_mode TEXT NOT NULL DEFAULT 'none',
      carousel_tap_limit_text TEXT,
      line_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE auto_replies (template_id TEXT, line_account_id TEXT);
    CREATE TABLE scenarios (id TEXT PRIMARY KEY, line_account_id TEXT);
    CREATE TABLE scenario_steps (template_id TEXT, scenario_id TEXT);
    CREATE TABLE reminders (id TEXT PRIMARY KEY, line_account_id TEXT);
    CREATE TABLE reminder_steps (template_id TEXT, reminder_id TEXT);
    CREATE TABLE rich_menu_groups (id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
    CREATE TABLE rich_menu_pages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL);
    CREATE TABLE rich_menu_areas (template_id TEXT, page_id TEXT NOT NULL);
    CREATE TABLE automations (actions TEXT NOT NULL DEFAULT '[]', line_account_id TEXT);
    CREATE TABLE common_actions (id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL);
    CREATE TABLE common_action_versions (
      common_action_id TEXT NOT NULL,
      action_config TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE friend_bulk_runs (id TEXT PRIMARY KEY, operation_json TEXT NOT NULL);
    CREATE TABLE friend_bulk_run_items (run_id TEXT NOT NULL, line_account_id TEXT);
    -- 現在のtemplate repositoryは保存時にメディア使用台帳も同じbatchで更新する。
    -- 252→347だけを再現するこのfixtureにも、その後追加された必要最小表を置く。
    CREATE TABLE media (id TEXT PRIMARY KEY, line_account_id TEXT, r2_key TEXT NOT NULL);
    CREATE TABLE media_versions (media_id TEXT NOT NULL, r2_key TEXT NOT NULL);
    CREATE TABLE media_usages (
      media_id TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (media_id, ref_kind, ref_id)
    );
  `)
  sqlite.exec(migration)
  sqlite.exec(migration347)
  const revisionMigration = readFileSync(join(import.meta.dirname, '..', 'migrations', '757_confirmation_revisions.sql'), 'utf8')
  sqlite.exec(revisionMigration.split('\n').find(line => line.startsWith('ALTER TABLE templates '))!)
  sqlite.exec('ALTER TABLE templates ADD COLUMN deleted_at TEXT')
  return sqlite
}

describe('migration 252 template questions', () => {
  it('stores a valid question and draft state through the template repository', async () => {
    const sqlite = setup()
    const questionJson = JSON.stringify({
      text: '続けますか？',
      tapMode: 'single',
      choices: [{ label: 'はい', behavior: 'none' }],
    })
    const created = await createTemplate(asD1(sqlite), {
      name: '継続確認',
      category: '定期便',
      messageType: 'text',
      messageContent: '続けますか？',
      questionJson,
      questionStatus: 'draft',
    })
    expect(created.question_json).toBe(questionJson)
    expect(created.question_status).toBe('draft')

    await updateTemplate(asD1(sqlite), created.id, { questionStatus: 'published' })
    expect(sqlite.prepare('SELECT question_status FROM templates WHERE id = ?').get(created.id))
      .toEqual({ question_status: 'published' })
  })

  it('rejects invalid JSON and an unknown publication state', () => {
    const sqlite = setup()
    expect(() => sqlite.prepare(`
      INSERT INTO templates
        (id, name, category, message_type, message_content, question_json, created_at, updated_at)
      VALUES ('bad-json', 'x', 'x', 'text', 'x', '{', '2026-08-29', '2026-08-29')
    `).run()).toThrow()
    expect(() => sqlite.prepare(`
      INSERT INTO templates
        (id, name, category, message_type, message_content, question_status, created_at, updated_at)
      VALUES ('bad-state', 'x', 'x', 'text', 'x', 'unknown', '2026-08-29', '2026-08-29')
    `).run()).toThrow()
  })
})
