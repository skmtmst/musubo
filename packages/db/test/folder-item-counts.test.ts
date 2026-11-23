import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { asD1 } from './d1-test-helper.js'
import { FOLDER_ITEM_COUNT_TABLES, FOLDER_KINDS, getFolderItemCounts } from '../src/folders.js'

/**
 * フォルダ件数を、一覧画面と同じ母集団（アカウント可視範囲）で
 * 数えることを、実スキーマ（bootstrap.sql）へ実データを入れて確かめる。
 *
 * 固定モックではなく、`reminders` テーブルへ実際に行を挿入し、
 * `getFolderItemCounts` が実SQLを実行した結果を見る。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, '..')

function setupDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'))
  return db
}

let sqlite: Database.Database
let db: D1Database

beforeEach(() => {
  sqlite = setupDb()
  db = asD1(sqlite)
  sqlite.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`).run('account-a', 'A店', 'c-a', 's-a', 't-a')
  sqlite.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`).run('account-b', 'B店', 'c-b', 's-b', 't-b')

  sqlite.prepare(`INSERT INTO folders (id, kind, name, display_order, created_at, updated_at)
    VALUES (?, 'reminder', ?, 0, '2026-01-01', '2026-01-01')`).run('folder-1', 'フォルダ1')
  sqlite.prepare(`INSERT INTO folders (id, kind, name, display_order, created_at, updated_at)
    VALUES (?, 'reminder', ?, 0, '2026-01-01', '2026-01-01')`).run('folder-2', 'フォルダ2')

  const insertReminder = sqlite.prepare(
    `INSERT INTO reminders (id, name, trigger_type, folder_id, line_account_id, created_at, updated_at)
     VALUES (?, ?, 'manual', ?, ?, '2026-01-01', '2026-01-01')`,
  )
  // account-a: folder-1に2件、folder-2に1件
  insertReminder.run('r-a1', 'A1', 'folder-1', 'account-a')
  insertReminder.run('r-a2', 'A2', 'folder-1', 'account-a')
  insertReminder.run('r-a3', 'A3', 'folder-2', 'account-a')
  // account-a: 未割当1件
  insertReminder.run('r-a4', 'A4', null, 'account-a')
  // account-b: folder-1に5件(他アカウントの行、境界確認用)
  for (let i = 0; i < 5; i++) insertReminder.run(`r-b${i}`, `B${i}`, 'folder-1', 'account-b')
  // 未割当・アカウント自体も未設定(NULL)の行(canSeeUnassigned確認用)
  insertReminder.run('r-null1', 'N1', 'folder-1', null)
})

describe('閲覧できる項目をフォルダごとに数える', () => {
  it('自アカウントの行だけを、フォルダごとに数える', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts).toBeDefined()
    expect(counts!.byFolderId).toEqual({ 'folder-1': 2, 'folder-2': 1 })
    // 他アカウント(account-b)の5件やNULLアカウントの1件が混ざらない。
    expect(counts!.byFolderId['folder-1']).not.toBe(7)
  })

  it('未割当（folder_id IS NULL）の件数を、一覧の「未分類」と同じ母集団で数える', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts!.unfiled).toBe(1)
  })

  it('canSeeUnassigned が false の担当者には、line_account_id が NULL の行を数へ入れない', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    // folder-1 は account-a に2件、NULLアカウントに1件。canSeeUnassigned=false なら2のまま。
    expect(counts!.byFolderId['folder-1']).toBe(2)
  })

  it('canSeeUnassigned が true なら、line_account_id が NULL の行も数へ入れる', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: true,
    })
    // folder-1: account-aの2件 + line_account_id NULLの1件 = 3
    expect(counts!.byFolderId['folder-1']).toBe(3)
  })

  it('他アカウントの行が数に入らない（アカウント境界）', async () => {
    const asA = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    const asB = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-b'],
      canSeeUnassigned: false,
    })
    expect(asA!.byFolderId['folder-1']).toBe(2)
    expect(asB!.byFolderId['folder-1']).toBe(5)
    // 両方見られる担当者は合算になる。
    const asBoth = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a', 'account-b'],
      canSeeUnassigned: false,
    })
    expect(asBoth!.byFolderId['folder-1']).toBe(7)
  })

  it('対応表に無い種別（friend_field）は undefined を返す。0件と混同しない', async () => {
    const counts = await getFolderItemCounts(db, 'friend_field', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts).toBeUndefined()
  })

  it('allowedAccountIds が空でも canSeeUnassigned なら未割当だけを数える', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: [],
      canSeeUnassigned: true,
    })
    expect(counts!.byFolderId['folder-1']).toBe(1)
    expect(counts!.unfiled).toBe(0)
  })

  it('allowedAccountIds が空で canSeeUnassigned も false なら何も数えない', async () => {
    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: [],
      canSeeUnassigned: false,
    })
    expect(counts!.byFolderId).toEqual({})
    expect(counts!.unfiled).toBe(0)
  })

  /**
   * 一覧（apps/worker/src/routes/reminders.ts）は
   * `deleted_at IS NULL` で論理削除済みを除くが、件数側にその絞りが
   * 無かった。一覧5件・フォルダ6件のような食い違いが、リマインダを
   * 1件消すだけで起きる。
   */
  it('一覧が除く論理削除済み(deleted_at)のリマインダは、フォルダ件数に入らない', async () => {
    sqlite.prepare(`INSERT INTO folders (id, kind, name, display_order, created_at, updated_at)
      VALUES ('folder-3', 'reminder', 'フォルダ3', 0, '2026-01-01', '2026-01-01')`).run()
    const insertReminder = sqlite.prepare(
      `INSERT INTO reminders (id, name, trigger_type, folder_id, line_account_id, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'manual', ?, ?, ?, '2026-01-01', '2026-01-01')`,
    )
    // folder-3: 生きた1件 + 消した1件。一覧に出るのは1件だけ。
    insertReminder.run('r-live', '生きている', 'folder-3', 'account-a', null)
    insertReminder.run('r-deleted', '消した', 'folder-3', 'account-a', '2026-02-01')

    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts!.byFolderId['folder-3']).toBe(1)
    // 消した行を含めた2にはならない。
    expect(counts!.byFolderId['folder-3']).not.toBe(2)
  })

  it('未分類の件数も、論理削除済みを除いた数になる', async () => {
    const insertReminder = sqlite.prepare(
      `INSERT INTO reminders (id, name, trigger_type, folder_id, line_account_id, deleted_at, created_at, updated_at)
       VALUES (?, ?, 'manual', ?, ?, ?, '2026-01-01', '2026-01-01')`,
    )
    // beforeEach で account-a の未割当は r-a4 の1件。生きた1件を足して2、
    // 消した1件は入らない。
    insertReminder.run('r-live-unfiled', '生きている未分類', null, 'account-a', null)
    insertReminder.run('r-deleted-unfiled', '消した未分類', null, 'account-a', '2026-02-01')

    const counts = await getFolderItemCounts(db, 'reminder', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts!.unfiled).toBe(2)
    expect(counts!.unfiled).not.toBe(3)
  })

  /**
   * 自動応答も reminder と同じ不変条件。一覧（packages/db/src/
   * auto-replies.ts:76、GET /api/auto-replies が使う getAutoReplies）は
   * `deleted_at IS NULL` で論理削除済みを除くため、件数側にも同じ絞りが要る。
   * ここを付け忘れると、消した自動応答がフォルダ件数にだけ残る。
   */
  it('一覧が除く論理削除済み(deleted_at)の自動応答は、フォルダ件数に入らない', async () => {
    sqlite.prepare(`INSERT INTO folders (id, kind, name, display_order, created_at, updated_at)
      VALUES ('folder-ar', 'auto_reply', '自動応答フォルダ', 0, '2026-01-01', '2026-01-01')`).run()
    const insertAutoReply = sqlite.prepare(
      `INSERT INTO auto_replies (id, keyword, response_content, folder_id, line_account_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    // folder-ar: 生きた1件 + 消した1件。一覧に出るのは1件だけ。
    insertAutoReply.run('ar-live', '生きている', '応答文', 'folder-ar', 'account-a', null)
    insertAutoReply.run('ar-deleted', '消した', '応答文', 'folder-ar', 'account-a', '2026-02-01')

    const counts = await getFolderItemCounts(db, 'auto_reply', {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
    })
    expect(counts!.byFolderId['folder-ar']).toBe(1)
    // 消した行を含めた2にはならない。
    expect(counts!.byFolderId['folder-ar']).not.toBe(2)
  })
})

describe('フォルダ内の件数を数える対象種別を管理する', () => {
  it('対応表のキーはすべて FOLDER_KINDS に含まれる', () => {
    for (const kind of Object.keys(FOLDER_ITEM_COUNT_TABLES)) {
      expect(FOLDER_KINDS).toContain(kind)
    }
  })

  it('対応表は統一パターンの16種別ちょうど。新しい種別が増減したらこの試験が気づく', () => {
    // 自動化・共通アクション・成果も folder_id 列（migration 582）で件数を数える。
    expect(Object.keys(FOLDER_ITEM_COUNT_TABLES).sort()).toEqual(
      ['affiliate', 'affiliate_offer', 'mileage_reward', 'friend_add_rule', 'auto_reply', 'automation', 'broadcast', 'common_action', 'common_var', 'conversion', 'media', 'reminder', 'rich_menu', 'scenario', 'tag', 'template'].sort(),
    )
  })

  it('対応表に無い残り5種別(webinar・webhookを除く)は、理由コメント付きで意図して外している', () => {
    const covered = new Set(Object.keys(FOLDER_ITEM_COUNT_TABLES))
    covered.add('webinar') // 別実装(getWebinarFolderCounts)でカバー済み
    covered.add('webhook') // getFolderItemCounts の中の別処理（受け取る・送るの2表を合算）でカバー済み
    const uncovered = FOLDER_KINDS.filter((kind) => !covered.has(kind))
    expect(uncovered.sort()).toEqual(
      ['entry_route', 'event', 'form', 'friend_field', 'mileage_rule'].sort(),
    )
  })
})
