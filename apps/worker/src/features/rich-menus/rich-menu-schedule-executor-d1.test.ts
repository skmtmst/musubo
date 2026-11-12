import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  claimRichMenuSchedule,
  listScheduleGroupIndividualLinks,
  reclaimStalePublishingSchedule,
  recordRichMenuScheduleSuccess,
} from '@line-crm/db'
import {
  PublishLeaseLostError,
  createRichMenuShells,
  deleteRichMenuShells,
  publishRichMenuGroup,
  unpublishRichMenuGroup,
  restorePreSwitchDefault,
  restorePreSwitchLive,
  switchRichMenuLive,
} from '../../lib/rich-menu-publisher.js'
import { processDueRichMenuSchedules } from './rich-menu-schedule-executor.js'

type FakeLine = {
  menus: Map<string, { name: string }>;
  aliases: Map<string, string>;
  defaultId: string | null;
  seq: number;
  calls: { create: number; upsert: number; setDefault: number; clear: number; del: number; getDefault: number };
  failUpsertOn: number;
  /**
   * setDefaultRichMenu の1回ごとの振る舞い。先頭から消費し、無ければ 'ok'。
   * 'apply-then-throw' は「LINE側には効いたが応答が返らなかった」を再現する。
   */
  setDefaultPlan: Array<'ok' | 'apply-then-throw' | 'throw'>;
  createRichMenu(payload: unknown): Promise<{ richMenuId: string }>;
  uploadRichMenuImage(richMenuId: string, image: Uint8Array, contentType: string): Promise<void>;
  deleteRichMenuAlias(aliasId: string): Promise<void>;
  createRichMenuAlias(aliasId: string, richMenuId: string): Promise<void>;
  upsertRichMenuAlias(aliasId: string, richMenuId: string): Promise<void>;
  deleteRichMenu(richMenuId: string): Promise<void>;
  setDefaultRichMenu(richMenuId: string): Promise<void>;
  clearDefaultRichMenu(): Promise<void>;
  getCurrentDefaultRichMenuId(): Promise<string | null>;
  linkRichMenuBulk(richMenuId: string, userIds: string[]): Promise<void>;
};

function makeFakeLine(): FakeLine {
  const line: FakeLine = {
    menus: new Map(),
    aliases: new Map(),
    defaultId: null,
    seq: 0,
    calls: { create: 0, upsert: 0, setDefault: 0, clear: 0, del: 0, getDefault: 0 },
    failUpsertOn: 0,
    setDefaultPlan: [],
    async createRichMenu(payload: unknown) {
      line.calls.create += 1;
      const id = `line-new-${++line.seq}`;
      line.menus.set(id, { name: String((payload as { name?: unknown }).name ?? id) });
      return { richMenuId: id };
    },
    async uploadRichMenuImage() {},
    async deleteRichMenuAlias(aliasId: string) {
      line.aliases.delete(aliasId);
    },
    async createRichMenuAlias(aliasId: string, richMenuId: string) {
      line.aliases.set(aliasId, richMenuId);
    },
    async upsertRichMenuAlias(aliasId: string, richMenuId: string) {
      line.calls.upsert += 1;
      if (line.failUpsertOn > 0 && line.calls.upsert === line.failUpsertOn) {
        throw new Error('LINE updateRichMenuAlias failed: 500');
      }
      line.aliases.set(aliasId, richMenuId);
    },
    async deleteRichMenu(richMenuId: string) {
      line.calls.del += 1;
      line.menus.delete(richMenuId);
    },
    async setDefaultRichMenu(richMenuId: string) {
      line.calls.setDefault += 1;
      if (!line.menus.has(richMenuId)) throw new Error(`LINE setDefaultRichMenu failed: 404`);
      const plan = line.setDefaultPlan.shift() ?? 'ok';
      if (plan === 'throw') throw new Error('LINE setDefaultRichMenu failed: 500, try again');
      line.defaultId = richMenuId;
      if (plan === 'apply-then-throw') {
        // LINEには効いたが応答が返らなかった。呼び出し側からは失敗に見える。
        throw new Error('LINE setDefaultRichMenu failed: fetch failed');
      }
    },
    async clearDefaultRichMenu() {
      line.calls.clear += 1;
      line.defaultId = null;
    },
    async getCurrentDefaultRichMenuId() {
      line.calls.getDefault += 1;
      return line.defaultId;
    },
    async linkRichMenuBulk() {},
  };
  return line;
}

const fakeR2 = {
  async get(_key: string) {
    return { body: new Uint8Array([1, 2, 3]) };
  },
};

function setupSqlite() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, channel_access_token TEXT, is_active INTEGER DEFAULT 1, archived_at TEXT);
    CREATE TABLE staff_members (id TEXT PRIMARY KEY);
    CREATE TABLE rich_menu_groups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      size TEXT NOT NULL DEFAULT 'large',
      chat_bar_text TEXT NOT NULL DEFAULT '',
      is_default_for_all INTEGER NOT NULL DEFAULT 0,
      confirmation_revision INTEGER NOT NULL DEFAULT 1,
      publishing_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-09-06T00:00:00+09:00'
    );
    CREATE TABLE rich_menu_pages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
      order_index INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      image_r2_key TEXT,
      image_content_type TEXT,
      line_richmenu_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-09-06T00:00:00+09:00'
    );
    CREATE TABLE rich_menu_assignments (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      group_id TEXT,
      version_id TEXT,
      line_richmenu_id TEXT,
      reason_kind TEXT,
      reason_event_id TEXT,
      assigned_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      line_user_id TEXT
    );
    INSERT INTO line_accounts VALUES ('account-1', 'token', 1, NULL);
  `)
  const dbDir = join(import.meta.dirname, '../../../../../packages/db/migrations')
  sqlite.exec(readFileSync(join(dbDir, '291_rich_menu_schedules.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(dbDir, '342_rich_menu_schedule_execution.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(dbDir, '344_rich_menu_schedule_publications.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(dbDir, '355_rich_menu_schedule_lease.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(dbDir, '365_rich_menu_schedule_default_pin.sql'), 'utf8'))
  return sqlite
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const build = (...params: unknown[]) => {
        const stmt = sqlite.prepare(query)
        return {
          async run() {
            const info = stmt.run(...params)
            return { success: true, meta: { changes: info.changes } }
          },
          async first<T>() {
            return (stmt.get(...params) as T) ?? null
          },
          async all<T>() {
            return { results: (stmt.all(...params) as T[]), success: true, meta: {} }
          },
        }
      }
      return {
        bind: (...params: unknown[]) => build(...params),
        run: () => build().run(),
        first: <T,>() => build().first<T>(),
        all: <T,>() => build().all<T>(),
      }
    },
    batch: async (stmts: unknown[]) => {
      const results = []
      for (const stmt of stmts as Array<{ run: () => Promise<unknown> }>) results.push(await stmt.run())
      return results
    },
  } as unknown as D1Database
}

/**
 * 指定文が実行される直前に一度だけ割り込む。
 * 「Aがこの1文を書く直前にBが回収した」を実際に作るために使う。
 */
function hookedDb(db: D1Database, match: RegExp, hook: () => Promise<void>): D1Database {
  let fired = false
  const runHook = async () => {
    if (fired) return
    fired = true
    await hook()
  }
  type Bound = { run(): Promise<unknown>; first<T>(): Promise<T>; all<T>(): Promise<T> }
  const wrapBound = (bound: Bound) => ({
    async run() { await runHook(); return bound.run() },
    async first<T,>() { await runHook(); return bound.first<T>() },
    async all<T,>() { await runHook(); return bound.all<T>() },
  })
  return {
    ...(db as unknown as Record<string, unknown>),
    prepare: (query: string) => {
      const real = (db as unknown as { prepare(q: string): { bind(...p: unknown[]): Bound } & Bound }).prepare(query)
      if (!match.test(query)) return real
      return {
        bind: (...p: unknown[]) => wrapBound(real.bind(...p)),
        run: () => wrapBound(real).run(),
        first: <T,>() => wrapBound(real).first<T>(),
        all: <T,>() => wrapBound(real).all<T>(),
      }
    },
  } as unknown as D1Database
}

/** 指定文に一致するprepareをN回だけ失敗させるD1失敗注入。 */
function failingDb(db: D1Database, match: RegExp, times = 1): D1Database {
  let remaining = times
  const failer = () => {
    throw new Error('injected D1 failure')
  }
  return {
    ...(db as unknown as Record<string, unknown>),
    prepare: (query: string) => {
      if (remaining > 0 && match.test(query)) {
        remaining -= 1
        return { bind: failer, run: failer, first: failer, all: failer }
      }
      return (db as { prepare(query: string): unknown }).prepare(query)
    },
  } as unknown as D1Database
}

function insertSchedule(sqlite: Database.Database, overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'schedule-1',
    group_id: 'menu-1',
    account_id: 'account-1',
    mode: 'scheduled',
    starts_at: '2026-09-10T01:00:00.000Z',
    ends_at: null,
    restore_group_id: null,
    definition_snapshot: JSON.stringify({ pages: [{ id: 'p1' }] }),
    status: 'scheduled',
    idempotency_key: 'key-1',
    requested_by_staff_id: 'env-owner',
    started_run_id: null,
    ended_run_id: null,
    last_error_code: null,
    created_at: '2026-09-06T00:00:00+09:00',
    updated_at: '2026-09-06T00:00:00+09:00',
    ...overrides,
  }
  sqlite.prepare(`INSERT INTO rich_menu_schedules
    (id, group_id, account_id, mode, starts_at, ends_at, restore_group_id,
     definition_snapshot, status, idempotency_key, requested_by_staff_id,
     started_run_id, ended_run_id, last_error_code, created_at, updated_at)
    VALUES (@id, @group_id, @account_id, @mode, @starts_at, @ends_at, @restore_group_id,
            @definition_snapshot, @status, @idempotency_key, @requested_by_staff_id,
            @started_run_id, @ended_run_id, @last_error_code, @created_at, @updated_at)`).run(row)
}

function insertGroup(
  sqlite: Database.Database,
  group: { id: string; status?: string; isDefault?: boolean; pages: Array<{ id: string; order?: number; lineId?: string | null }> },
) {
  sqlite.prepare(`INSERT INTO rich_menu_groups
    (id, account_id, name, status, size, chat_bar_text, is_default_for_all, publishing_at, updated_at)
    VALUES (?, 'account-1', ?, ?, 'large', 'test', ?, NULL, '2026-09-06T00:00:00+09:00')`).run(
    group.id, group.id, group.status ?? 'draft', group.isDefault ? 1 : 0,
  )
  for (const page of group.pages) {
    sqlite.prepare(`INSERT INTO rich_menu_pages
      (id, group_id, order_index, name, image_r2_key, image_content_type, line_richmenu_id, updated_at)
      VALUES (?, ?, ?, ?, 'img-key', 'image/jpeg', ?, '2026-09-06T00:00:00+09:00')`).run(
      page.id, group.id, page.order ?? 0, page.id, page.lineId ?? null,
    )
  }
}

/**  以降、公開には「切替以外の行き先を持つボタン」が1つ必要。検証を通る最小のボタン。 */
const VALID_AREA = {
  id: 'a1',
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  actionType: 'uri',
  actionData: { uri: 'https://example.com' },
  label: 'リンク',
}

/** 予約スナップショット(GroupInput形)。 areas空の素直なメニュー。 */
function snapshotFor(groupId: string, pages: string[], isDefault: boolean) {
  return JSON.stringify({
    id: groupId,
    size: 'large',
    chatBarText: 'test',
    isDefaultForAll: isDefault,
    pages: pages.map((id, orderIndex) => ({
      id,
      orderIndex,
      name: id,
      imageR2Key: 'img-key',
      imageContentType: 'image/jpeg',
      lineRichmenuId: null,
      areas: [VALID_AREA],
    })),
  })
}

function scheduleRow(sqlite: Database.Database, id: string) {
  return sqlite.prepare(`SELECT * FROM rich_menu_schedules WHERE id = ?`).get(id) as Record<string, unknown>
}

function depsFor(
  sqlite: Database.Database,
  db: D1Database,
  line: FakeLine,
  unlinked: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    getGroupWithPages: async (_db: unknown, groupId: string) => {
      const group = sqlite.prepare(`SELECT * FROM rich_menu_groups WHERE id = ?`).get(groupId) as Record<string, unknown> | undefined
      if (!group) return null
      const pages = sqlite.prepare(`SELECT * FROM rich_menu_pages WHERE group_id = ? ORDER BY order_index`).all(groupId)
      return { ...group, pages } as never
    },
    getLineAccount: async () => ({ id: 'account-1', channel_access_token: 'token', is_active: 1, archived_at: null }),
    getRequestingStaff: async () => null,
    isStaffAllowedForAccount: async () => true,
    createLineShells: async (snapshot: unknown, _schedule: unknown, heartbeat: () => Promise<void>) => {
      const { shells } = await createRichMenuShells(snapshot as never, line as never, fakeR2 as never, heartbeat)
      const oldById = new Map(
        ((snapshot as { pages: Array<{ id: string; lineRichmenuId: string | null }> }).pages ?? []).map((page) => [page.id, page.lineRichmenuId ?? null]),
      )
      return shells.map((shell) => ({
        pageId: shell.pageId,
        orderIndex: shell.orderIndex,
        newRichMenuId: shell.newRichMenuId,
        oldLineRichMenuId: oldById.get(shell.pageId) ?? null,
      }))
    },
    createRestoreShells: async (restoreGroup: never, _schedule: unknown, heartbeat: () => Promise<void>) => {
      const group = restoreGroup as unknown as {
        id: string; is_default_for_all: number;
        pages: Array<{ id: string; order_index: number; name: string; image_r2_key: string | null; image_content_type: string | null; line_richmenu_id: string | null }>;
      }
      const input = {
        id: group.id,
        size: 'large',
        chatBarText: 'test',
        isDefaultForAll: group.is_default_for_all === 1,
        formBaseUrl: null,
        pages: group.pages.map((page) => ({
          id: page.id,
          orderIndex: page.order_index,
          name: page.name,
          imageR2Key: page.image_r2_key,
          imageContentType: page.image_content_type,
          lineRichMenuId: page.line_richmenu_id,
          areas: [VALID_AREA],
        })),
      }
      const { shells } = await createRichMenuShells(input as never, line as never, fakeR2 as never, heartbeat)
      const oldById = new Map(input.pages.map((page) => [page.id, page.lineRichMenuId ?? null]))
      return shells.map((shell) => ({
        pageId: shell.pageId,
        orderIndex: shell.orderIndex,
        newRichMenuId: shell.newRichMenuId,
        oldLineRichMenuId: oldById.get(shell.pageId) ?? null,
      }))
    },
    readCurrentDefaultId: async () => line.getCurrentDefaultRichMenuId(),
    switchLiveTo: async ({ groupId, setDefault, shells, heartbeat }: { groupId: string; setDefault: boolean; shells: Array<{ pageId: string; orderIndex: number; newRichMenuId: string; oldLineRichMenuId: string | null }>; heartbeat: () => Promise<void> }) => {
      await switchRichMenuLive(line as never, {
        id: groupId,
        size: 'large',
        chatBarText: '',
        isDefaultForAll: setDefault,
        pages: shells.map((shell) => ({
          id: shell.pageId,
          orderIndex: shell.orderIndex,
          name: '',
          imageR2Key: null,
          imageContentType: null,
          lineRichMenuId: shell.oldLineRichMenuId,
          areas: [VALID_AREA],
        })),
      } as never, shells.map((shell) => ({
        pageId: shell.pageId,
        orderIndex: shell.orderIndex,
        newRichMenuId: shell.newRichMenuId,
      })), heartbeat)
    },
    compensateSwitchToPrevious: async ({ groupId, prev, newIds }: { groupId: string; prev: unknown; newIds: string[] }) => {
      const unrestoredPageIds = await restorePreSwitchLive(line as never, groupId, prev as never)
      const defaultRestore = await restorePreSwitchDefault(line as never, prev as never, newIds)
      return { unrestoredPageIds, defaultRestore }
    },
    deleteLineShells: async (_schedule: unknown, ids: string[]) => {
      await deleteRichMenuShells(line as never, ids)
    },
    restoreCapturedDefault: async (_schedule: unknown, lineId: string) => {
      const current = await line.getCurrentDefaultRichMenuId()
      if (current === lineId) return
      try {
        await line.setDefaultRichMenu(lineId)
      } catch (error) {
        if (error instanceof Error && /setDefaultRichMenu failed: 404/.test(error.message)) {
          throw new Error(`no_restore_target: pinned default menu ${lineId} was deleted`)
        }
        throw error
      }
    },
    clearAccountDefault: async (schedule: { group_id: string }) => {
      const pages = sqlite.prepare(`SELECT line_richmenu_id FROM rich_menu_pages WHERE group_id = ?`).all(schedule.group_id) as Array<{ line_richmenu_id: string | null }>
      const own = new Set(pages.map((page) => page.line_richmenu_id).filter((id): id is string => !!id))
      const current = await line.getCurrentDefaultRichMenuId()
      if (current && own.has(current)) {
        await line.clearDefaultRichMenu()
      }
    },
    unlinkIndividualLinks: async (schedule: { id: string; account_id: string; group_id: string }) => {
      const targets = await listScheduleGroupIndividualLinks(db, schedule.account_id, schedule.group_id)
      for (const target of targets) unlinked.push(target.lineUserId)
      return targets.length
    },
    ...overrides,
  }
}

const T0 = new Date('2026-09-10T01:00:00.000Z')
const T0_ISO = '2026-09-10T01:00:00.000Z'

/**
 * 進められる実時間の時計。lease の期限はここから刻まれる。
 * cron の tick 時刻(`now`)とは別。実行に何分かかったかを試験から作るために使う。
 */
function makeClock(start: Date = T0) {
  let at = start.getTime()
  return {
    now: () => new Date(at),
    iso: () => new Date(at).toISOString(),
    advance(ms: number) {
      at += ms
    },
  }
}

describe('executor 段階公開（実D1 + fake LINE）', () => {
  let sqlite: Database.Database
  let db: D1Database
  let line: FakeLine
  let unlinked: string[]
  let clock: ReturnType<typeof makeClock>

  beforeEach(() => {
    sqlite = setupSqlite()
    db = asD1(sqlite)
    line = makeFakeLine()
    unlinked = []
    clock = makeClock()
  })

  test('正常系：作る→journal→切替→反映→旧削除で完了する', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'ok-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(result).toMatchObject({ processed: 1, succeeded: 1 })
    // LINEは切替わっている。
    expect(line.aliases.get('lhx-menu-1-0')).toMatch(/^line-new-/)
    expect(line.defaultId).toBe(line.aliases.get('lhx-menu-1-0'))
    // DBへ反映されている。
    const page = sqlite.prepare(`SELECT line_richmenu_id FROM rich_menu_pages WHERE id = 'p1'`).get() as { line_richmenu_id: string }
    expect(page.line_richmenu_id).toBe(line.aliases.get('lhx-menu-1-0'))
    expect((sqlite.prepare(`SELECT status FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { status: string }).status).toBe('published')
    expect(scheduleRow(sqlite, 'ok-1').status).toBe('completed')
    // journalは1行だけ。
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_schedule_publications`).get() as { n: number }).n).toBe(1)
  })

  test('journal失敗：新メニューだけ消し、既存alias/defaultを変えない', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'jfail-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const result = await processDueRichMenuSchedules(
      failingDb(db, /INTO rich_menu_schedule_publications/), depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now },
    )
    expect(result).toMatchObject({ retried: 1 })
    // 作りかけは消え、liveは何も変わらない。
    expect(line.menus.size).toBe(0)
    expect(line.aliases.size).toBe(0)
    expect(line.defaultId).toBeNull()
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_schedule_publications`).get() as { n: number }).n).toBe(0)
    const row = scheduleRow(sqlite, 'jfail-1')
    expect(row.status).toBe('scheduled')
    expect(row.next_retry_at).not.toBeNull()
    // 再試行で完了する（5分後）。
    clock.advance(5 * 60_000)
    const retry = await processDueRichMenuSchedules(
      db, depsFor(sqlite, db, line, unlinked) as never,
      { now: new Date('2026-09-10T01:05:00.000Z'), clock: clock.now },
    )
    expect(retry).toMatchObject({ succeeded: 1 })
    expect(scheduleRow(sqlite, 'jfail-1').status).toBe('completed')
  })

  test('切替途中失敗：旧alias/defaultへ補償し、新メニューを片付ける', async () => {
    insertGroup(sqlite, {
      id: 'menu-1',
      status: 'draft',
      isDefault: true,
      pages: [
        { id: 'a', order: 0, lineId: 'line-old-a' },
        { id: 'b', order: 1, lineId: 'line-old-b' },
      ],
    })
    line.menus.set('line-old-a', { name: 'old-a' })
    line.menus.set('line-old-b', { name: 'old-b' })
    line.aliases.set('lhx-menu-1-0', 'line-old-a')
    line.aliases.set('lhx-menu-1-1', 'line-old-b')
    line.defaultId = 'line-old-a'
    line.failUpsertOn = 2
    insertSchedule(sqlite, { id: 'comp-1', definition_snapshot: snapshotFor('menu-1', ['a', 'b'], true) })

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(result).toMatchObject({ retried: 1 })
    // 旧へ戻っている。
    expect(line.aliases.get('lhx-menu-1-0')).toBe('line-old-a')
    expect(line.aliases.get('lhx-menu-1-1')).toBe('line-old-b')
    expect(line.defaultId).toBe('line-old-a')
    // 新メニューは消え、journalも消えている。
    expect([...line.menus.keys()].sort()).toEqual(['line-old-a', 'line-old-b'])
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_schedule_publications`).get() as { n: number }).n).toBe(0)
    expect(scheduleRow(sqlite, 'comp-1').status).toBe('scheduled')
  })

  test('切替後停止→再開：作り直さずjournalで終わらせる', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'resume-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    // 反映の1手目で停止した想定。切替は済み、DB反映だけ残る。
    const first = await processDueRichMenuSchedules(
      failingDb(db, /UPDATE rich_menu_pages SET line_richmenu_id/), depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now },
    )
    expect(first).toMatchObject({ retried: 1 })
    expect(line.calls.create).toBe(1)
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_schedule_publications`).get() as { n: number }).n).toBe(1)

    clock.advance(5 * 60_000)
    const second = await processDueRichMenuSchedules(
      db, depsFor(sqlite, db, line, unlinked) as never,
      { now: new Date('2026-09-10T01:05:00.000Z'), clock: clock.now },
    )
    expect(second).toMatchObject({ succeeded: 1 })
    // 作り直しはしない。
    expect(line.calls.create).toBe(1)
    expect(scheduleRow(sqlite, 'resume-1').status).toBe('completed')
    const page = sqlite.prepare(`SELECT line_richmenu_id FROM rich_menu_pages WHERE id = 'p1'`).get() as { line_richmenu_id: string }
    expect(page.line_richmenu_id).toBe(line.aliases.get('lhx-menu-1-0'))
  })

  test('lease takeover：期限内は作らず、期限切れで回収して進む', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'take-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })
    const { acquirePublishLease } = await import('@line-crm/db')
    expect(await acquirePublishLease(db, 'menu-1', 'run-A', T0_ISO)).toBe(1)

    const first = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(first).toMatchObject({ retried: 1 })
    expect(line.calls.create).toBe(0)

    // 11分後：期限切れを回収して進む。
    clock.advance(11 * 60_000)
    const second = await processDueRichMenuSchedules(
      db, depsFor(sqlite, db, line, unlinked) as never,
      { now: new Date('2026-09-10T01:11:00.000Z'), clock: clock.now },
    )
    expect(second).toMatchObject({ succeeded: 1 })
    expect(line.calls.create).toBe(1)
    expect(scheduleRow(sqlite, 'take-1').status).toBe('completed')
  })

  test('期間終了：外部で変わったdefaultでも固定値へ戻す', async () => {
    line.menus.set('line-old', { name: 'old' })
    line.defaultId = 'line-old'
    insertGroup(sqlite, { id: 'menu-1', status: 'draft', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, {
      id: 'ext-1', mode: 'period', ends_at: '2026-09-10T02:00:00.000Z',
      definition_snapshot: snapshotFor('menu-1', ['p1'], true),
    })

    const published = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(published).toMatchObject({ succeeded: 1 })
    expect(scheduleRow(sqlite, 'ext-1').restore_default_state).toBe('captured')
    expect(scheduleRow(sqlite, 'ext-1').restore_default_line_id).toBe('line-old')

    // 期間中に管理画面の外でdefaultが変わる。
    line.menus.set('line-external', { name: 'external' })
    line.defaultId = 'line-external'
    sqlite.prepare(`UPDATE rich_menu_schedules SET ends_at = ? WHERE id = 'ext-1'`).run(T0_ISO)

    const restored = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: new Date('2026-09-10T03:00:00.000Z') })
    expect(restored).toMatchObject({ restored: 1 })
    expect(line.defaultId).toBe('line-old')
    expect(scheduleRow(sqlite, 'ext-1').status).toBe('completed')
  })

  test('固定メニュー削除済み：解除せず恒久失敗に残す', async () => {
    line.menus.set('line-other', { name: 'other' })
    line.defaultId = 'line-other'
    insertGroup(sqlite, { id: 'menu-1', status: 'published', isDefault: true, pages: [{ id: 'p1', lineId: 'line-new-9' }] })
    line.menus.set('line-new-9', { name: 'new-9' })
    insertSchedule(sqlite, { id: 'gone-1', mode: 'period', status: 'published', started_run_id: 'run-S', ends_at: T0_ISO })
    sqlite.prepare(`UPDATE rich_menu_schedules SET restore_default_state = 'captured', restore_default_line_id = 'line-gone' WHERE id = 'gone-1'`).run()

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: new Date('2026-09-10T03:00:00.000Z') })
    expect(result).toMatchObject({ failed: 1 })
    // 勝手に解除しない。
    expect(line.defaultId).toBe('line-other')
    expect(line.calls.clear).toBe(0)
    expect(scheduleRow(sqlite, 'gone-1').status).toBe('failed')
  })

  test('no_default：終了時に表示を外す', async () => {
    insertGroup(sqlite, { id: 'menu-1', status: 'published', isDefault: true, pages: [{ id: 'p1', lineId: 'line-new-9' }] })
    line.menus.set('line-new-9', { name: 'new-9' })
    line.defaultId = 'line-new-9'
    sqlite.prepare(`INSERT INTO friends VALUES ('f1', 'account-1', 'U111')`).run()
    sqlite.prepare(`INSERT INTO rich_menu_assignments VALUES ('a1', 'f1', 'account-1', 'menu-1', NULL, 'line-new-9', 'tag_bulk_apply', NULL, 'x', 'x')`).run()
    insertSchedule(sqlite, { id: 'nodef-1', mode: 'period', status: 'published', started_run_id: 'run-S', ends_at: T0_ISO })
    sqlite.prepare(`UPDATE rich_menu_schedules SET restore_default_state = 'no_default', restore_default_line_id = NULL WHERE id = 'nodef-1'`).run()

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: new Date('2026-09-10T03:00:00.000Z') })
    expect(result).toMatchObject({ restored: 1 })
    expect(line.defaultId).toBeNull()
    expect(scheduleRow(sqlite, 'nodef-1').status).toBe('completed')
    expect(unlinked).toEqual(['U111'])
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_assignments`).get() as { n: number }).n).toBe(0)
  })

  test('明示の戻し先：現内容を段階公開で戻す', async () => {
    insertGroup(sqlite, { id: 'menu-1', status: 'draft', isDefault: false, pages: [{ id: 'p1' }] })
    insertGroup(sqlite, { id: 'restore-1', status: 'published', isDefault: false, pages: [{ id: 'r1' }] })
    insertSchedule(sqlite, {
      id: 'exp-1', mode: 'period', restore_group_id: 'restore-1', ends_at: '2026-09-10T02:00:00.000Z',
      definition_snapshot: snapshotFor('menu-1', ['p1'], false),
    })

    const published = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(published).toMatchObject({ succeeded: 1 })
    expect(scheduleRow(sqlite, 'exp-1').status).toBe('published')

    sqlite.prepare(`UPDATE rich_menu_schedules SET ends_at = ? WHERE id = 'exp-1'`).run(T0_ISO)
    const restored = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: new Date('2026-09-10T03:00:00.000Z') })
    expect(restored).toMatchObject({ restored: 1 })
    // 戻し先のaliasが新IDを向く。
    const restoreAlias = line.aliases.get('lhx-restore--0')
    expect(restoreAlias).toMatch(/^line-new-/)
    expect(scheduleRow(sqlite, 'exp-1').status).toBe('completed')
    expect((sqlite.prepare(`SELECT status FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { status: string }).status).toBe('draft')
  })

  test('旧メニューは反映前のIDで消える（LINE側に置き去りにしない）', async () => {
    // 反映(DB)のあとに page 行を読み直して旧IDを引くと、もう新IDへ変わっていて
    // 旧メニューが1つも消えない。反映前に控えたIDで消すことを固定する。
    insertGroup(sqlite, {
      id: 'menu-1',
      status: 'published',
      isDefault: true,
      pages: [{ id: 'p1', order: 0, lineId: 'line-old-1' }],
    })
    line.menus.set('line-old-1', { name: 'old-1' })
    line.aliases.set('lhx-menu-1-0', 'line-old-1')
    line.defaultId = 'line-old-1'
    insertSchedule(sqlite, { id: 'old-del-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    expect(result).toMatchObject({ processed: 1, succeeded: 1 })
    const newId = line.aliases.get('lhx-menu-1-0') as string
    expect(newId).toMatch(/^line-new-/)
    // 旧メニューはLINEから消えている。残っているのは新メニューだけ。
    expect([...line.menus.keys()]).toEqual([newId])
    expect(line.defaultId).toBe(newId)
    const page = sqlite.prepare(`SELECT line_richmenu_id FROM rich_menu_pages WHERE id = 'p1'`).get() as { line_richmenu_id: string }
    expect(page.line_richmenu_id).toBe(newId)
  })

  test('pin失敗：作成済みの新メニューを片付けてから一時失敗にする', async () => {
    // 実LINE defaultの読み取り(pin)が落ちたとき、作ったメニューを消さないと
    // 参照されないメニューがLINE側に溜まり続ける。
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'pin-fail-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })
    const deps = depsFor(sqlite, db, line, unlinked, {
      readCurrentDefaultId: async () => {
        throw new Error('LINE getCurrentDefaultRichMenu failed: 500, try again')
      },
    })

    const result = await processDueRichMenuSchedules(db, deps as never, { now: T0, clock: clock.now })
    expect(result).toMatchObject({ processed: 1, retried: 1 })
    // 作ったのは1枚。片付いてLINE側に残っていない。
    expect(line.calls.create).toBe(1)
    expect([...line.menus.keys()]).toEqual([])
    // 切替もjournalもしていない。
    expect(line.aliases.size).toBe(0)
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM rich_menu_schedule_publications`).get() as { n: number }).n).toBe(0)
    expect(scheduleRow(sqlite, 'pin-fail-1').status).toBe('scheduled')
  })

  test('default復元に失敗したら、defaultが指したままの新メニューを消さない', async () => {
    // 切替の default 設定はLINEに効いたが応答が返らず、補償の戻しも落ちた。
    // ここで新メニューを消すと全友だちのメニューがリンク切れになる。
    insertGroup(sqlite, {
      id: 'menu-1',
      status: 'published',
      isDefault: true,
      pages: [
        { id: 'a', order: 0, lineId: 'line-old-a' },
        { id: 'b', order: 1, lineId: 'line-old-b' },
      ],
    })
    line.menus.set('line-old-a', { name: 'old-a' })
    line.menus.set('line-old-b', { name: 'old-b' })
    line.aliases.set('lhx-menu-1-0', 'line-old-a')
    line.aliases.set('lhx-menu-1-1', 'line-old-b')
    line.defaultId = 'line-old-a'
    // 1回目(切替): LINEには効くが応答が返らない。2回目(補償の戻し): 失敗。
    line.setDefaultPlan = ['apply-then-throw', 'throw']
    insertSchedule(sqlite, { id: 'defrestore-1', definition_snapshot: snapshotFor('menu-1', ['a', 'b'], true) })

    const result = await processDueRichMenuSchedules(db, depsFor(sqlite, db, line, unlinked) as never, { now: T0, clock: clock.now })
    // 結果に「defaultを戻し切れていない」が出る。
    expect(result).toMatchObject({ processed: 1, retried: 1, defaultRestoreIncomplete: 1 })
    // aliasは旧へ戻っている。
    expect(line.aliases.get('lhx-menu-1-0')).toBe('line-old-a')
    expect(line.aliases.get('lhx-menu-1-1')).toBe('line-old-b')
    // defaultはまだ新メニューを指したまま。そのメニューは消さずに残す。
    const retained = line.defaultId as string
    expect(retained).toMatch(/^line-new-/)
    expect(line.menus.has(retained)).toBe(true)
    // 指されていないもう1枚の新メニューは片付ける。
    expect([...line.menus.keys()].filter((id) => id.startsWith('line-new-'))).toEqual([retained])
    // 失敗理由からも「defaultが戻っていない」と分かる。
    expect(String(scheduleRow(sqlite, 'defrestore-1').last_error_code)).toContain('default_restore_incomplete')
  })

  test('2実行主体interleave：期限内はBが割り込めず、Aがそのまま完了する', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'inter-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })
    // Bは別接続(別のD1ハンドル)から同じ行を見る。
    const dbB = asD1(sqlite)
    let bResult: Awaited<ReturnType<typeof processDueRichMenuSchedules>> | null = null

    const depsA = depsFor(sqlite, db, line, unlinked, {
      // Aが外部へ作っている最中にBのtickが走る（lease期限内）。
      createLineShells: async (snapshot: unknown) => {
        // Aの作成中に1分だけ経つ。leaseはまだ切れていない。
        clock.advance(60_000)
        bResult = await processDueRichMenuSchedules(
          dbB,
          depsFor(sqlite, dbB, line, unlinked) as never,
          { now: T0, clock: clock.now, runIdPrefix: 'B' },
        )
        const { shells } = await createRichMenuShells(snapshot as never, line as never, fakeR2 as never)
        return shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
          oldLineRichMenuId: null,
        }))
      },
    })

    const aResult = await processDueRichMenuSchedules(db, depsA as never, { now: T0, clock: clock.now, runIdPrefix: 'A' })
    // Bは触れない（claim済みでdueに出ず、leaseも期限内）。
    expect(bResult).toMatchObject({ processed: 0, succeeded: 0, reclaimed: 0 })
    expect(aResult).toMatchObject({ processed: 1, succeeded: 1 })
    expect(line.calls.create).toBe(1)
    const row = scheduleRow(sqlite, 'inter-1')
    expect(row.status).toBe('completed')
    expect(String(row.started_run_id)).toMatch(/^A-/)
  })

  test('2実行主体interleave：期限切れでBが引き継ぎ、旧holder Aは切替も確定もせず作った分を片付ける', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'inter-2', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })
    const dbB = asD1(sqlite)
    let bResult: Awaited<ReturnType<typeof processDueRichMenuSchedules>> | null = null
    const aCreated: string[] = []

    const depsA = depsFor(sqlite, db, line, unlinked, {
      // Aは作成に手間取り、その間にleaseが切れてBが回収して完了させる。
      createLineShells: async (snapshot: unknown) => {
        const { shells } = await createRichMenuShells(snapshot as never, line as never, fakeR2 as never)
        for (const shell of shells) aCreated.push(shell.newRichMenuId)
        // Aの作成が11分かかり、leaseが切れる。
        clock.advance(11 * 60_000)
        bResult = await processDueRichMenuSchedules(
          dbB,
          depsFor(sqlite, dbB, line, unlinked) as never,
          { now: T0, clock: clock.now, runIdPrefix: 'B' },
        )
        return shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
          oldLineRichMenuId: null,
        }))
      },
    })

    const aResult = await processDueRichMenuSchedules(db, depsA as never, { now: T0, clock: clock.now, runIdPrefix: 'A' })

    // Bが回収して完了させた。
    expect(bResult).toMatchObject({ reclaimed: 1, processed: 1, succeeded: 1 })
    // Aは切替も確定もせず、自分が作った分だけ片付けて手を引く。
    expect(aResult).toMatchObject({ processed: 1, succeeded: 0, skipped: 1 })
    expect(aCreated).toHaveLength(1)
    expect(line.menus.has(aCreated[0])).toBe(false)
    // liveなのはBの1枚だけ。aliasもdefaultもBの分を指す。
    const liveId = line.aliases.get('lhx-menu-1-0') as string
    expect(liveId).toMatch(/^line-new-/)
    expect(liveId).not.toBe(aCreated[0])
    expect([...line.menus.keys()]).toEqual([liveId])
    expect(line.defaultId).toBe(liveId)
    // journalはBのrunの1行だけ。予約はBのrunで completed。
    const journal = sqlite.prepare(`SELECT run_id, line_richmenu_id FROM rich_menu_schedule_publications`).all() as Array<{ run_id: string; line_richmenu_id: string }>
    expect(journal).toHaveLength(1)
    expect(journal[0].run_id).toMatch(/^B-/)
    expect(journal[0].line_richmenu_id).toBe(liveId)
    const row = scheduleRow(sqlite, 'inter-2')
    expect(row.status).toBe('completed')
    expect(String(row.started_run_id)).toMatch(/^B-/)
    // 反映されたのもBのID。Aの古いIDでDBを上書きしていない。
    const page = sqlite.prepare(`SELECT line_richmenu_id FROM rich_menu_pages WHERE id = 'p1'`).get() as { line_richmenu_id: string }
    expect(page.line_richmenu_id).toBe(liveId)
    // 引き継ぎ後、leaseは開いている（次の手動公開・再試行を塞がない）。
    const group = sqlite.prepare(`SELECT publishing_owner, publishing_expires_at FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { publishing_owner: string | null; publishing_expires_at: string | null }
    expect(group.publishing_owner).toBeNull()
    expect(group.publishing_expires_at).toBeNull()
  })

  test('2実行主体interleave：Aの反映直前に手動公開が引き継ぐと、Aは反映もできずleaseも壊さない', async () => {
    // 予約実行Aと手動公開Mは別の実行主体で、Mは予約行を触らない。
    // つまりAの「予約行のrun一致」だけでは守れない。group leaseの世代で守る。
    insertGroup(sqlite, {
      id: 'menu-1', status: 'published', isDefault: true,
      pages: [{ id: 'p1', order: 0, lineId: 'line-old-1' }],
    })
    line.menus.set('line-old-1', { name: 'old-1' })
    line.aliases.set('lhx-menu-1-0', 'line-old-1')
    line.defaultId = 'line-old-1'
    insertSchedule(sqlite, { id: 'refl-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const dbM = asD1(sqlite)
    let manualFence: { owner: string; generation: number } | null = null
    const { acquirePublishLease } = await import('@line-crm/db')

    // Aが「pageへ新IDを書く」1文の直前で、期限切れの隙にMがleaseを取る。
    const dbA = hookedDb(db, /UPDATE rich_menu_pages SET line_richmenu_id = \?/, async () => {
      clock.advance(11 * 60_000)
      const generation = await acquirePublishLease(dbM, 'menu-1', 'manual-M', clock.iso())
      manualFence = generation === null ? null : { owner: 'manual-M', generation }
    })

    const aResult = await processDueRichMenuSchedules(
      dbA, depsFor(sqlite, db, line, unlinked) as never,
      { now: T0, clock: clock.now, runIdPrefix: 'A' },
    )

    // Mは確かにleaseを取れている（Aの世代1の次）。
    expect(manualFence).toEqual({ owner: 'manual-M', generation: 2 })
    // Aは反映も確定もできない。失権として一時失敗に戻り、あとで回収される。
    expect(aResult).toMatchObject({ processed: 1, succeeded: 0, retried: 1 })
    const page = sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string }
    expect(page.v).toBe('line-old-1')
    // AはMのleaseを消していない。Mはまだ守られている。
    const group = sqlite.prepare(`SELECT publishing_owner AS o, publishing_generation AS g FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { o: string | null; g: number }
    expect(group.o).toBe('manual-M')
    expect(group.g).toBe(2)
    // 予約は完了になっていない。一時失敗として scheduled へ戻り、やり直す。
    const row = scheduleRow(sqlite, 'refl-1')
    expect(row.status).toBe('scheduled')
    expect(row.next_retry_at).not.toBeNull()
  })

  test('2実行主体interleave：Aの確定直前に手動公開が引き継ぐと、Aは確定できない', async () => {
    // 公開確定はleaseを開けないので、Mが割り込めるのは期限切れのときだけ。
    // 確定の直前に引き継がれても、旧holderは確定できてはいけない。
    insertGroup(sqlite, {
      id: 'menu-1', status: 'published', isDefault: true,
      pages: [{ id: 'p1', order: 0, lineId: 'line-old-1' }],
    })
    line.menus.set('line-old-1', { name: 'old-1' })
    line.aliases.set('lhx-menu-1-0', 'line-old-1')
    line.defaultId = 'line-old-1'
    insertSchedule(sqlite, { id: 'fin-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const dbM = asD1(sqlite)
    let manualGeneration: number | null = null
    const { acquirePublishLease } = await import('@line-crm/db')

    // Aが「予約を完了にする」1文を書く直前にMが割り込む。
    const dbA = hookedDb(
      db,
      /UPDATE rich_menu_schedules\s+SET status = \?, ended_run_id = \?/,
      async () => {
        // Aの確定が11分遅れ、leaseが切れたところをMが取る。
        clock.advance(11 * 60_000)
        manualGeneration = await acquirePublishLease(dbM, 'menu-1', 'manual-M', clock.iso())
      },
    )

    const aResult = await processDueRichMenuSchedules(
      dbA, depsFor(sqlite, db, line, unlinked) as never,
      { now: T0, clock: clock.now, runIdPrefix: 'A' },
    )

    expect(manualGeneration).toBe(2)
    // Aは確定できない。予約は publishing のまま残り、あとで回収される。
    expect(aResult).toMatchObject({ processed: 1, succeeded: 0, skipped: 1 })
    const row = scheduleRow(sqlite, 'fin-1')
    expect(row.status).toBe('publishing')
    expect(String(row.started_run_id)).toMatch(/^A-/)
    // AはMのleaseを消していない。
    const group = sqlite.prepare(`SELECT publishing_owner AS o, publishing_generation AS g FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { o: string | null; g: number }
    expect(group.o).toBe('manual-M')
    expect(group.g).toBe(2)
  })

  test('別接続：A公開中にBが停止経路を最後まで走らせても、AのleaseもAの反映も壊れない', async () => {
    // 停止(unpublish)も group の状態を変える経路。lease契約に乗っていないと、
    // 公開中Aのownerと期限を消してしまう。Bは経路そのものを最後まで走らせる。
    insertGroup(sqlite, {
      id: 'menu-1', status: 'published', isDefault: true,
      pages: [{ id: 'p1', order: 0, lineId: 'line-old-1' }],
    })
    line.menus.set('line-old-1', { name: 'old-1' })
    line.aliases.set('lhx-menu-1-0', 'line-old-1')
    line.defaultId = 'line-old-1'
    insertSchedule(sqlite, { id: 'stopwar-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const dbB = asD1(sqlite)
    let stopOutcome: 'blocked' | 'unpublished' = 'unpublished'
    const {
      acquirePublishLease, markRichMenuGroupUnpublished, renewPublishLease, releasePublishLease,
    } = await import('@line-crm/db')

    // Aが切替を終えてDBへ反映する直前に、Bが停止経路を丸ごと走らせる。
    const dbA = hookedDb(db, /UPDATE rich_menu_pages SET line_richmenu_id = \?/, async () => {
      // 停止経路(routes)と同じ順番: lease取得 → LINE解除 → 札付きで畳む。
      const generation = await acquirePublishLease(dbB, 'menu-1', 'unpublish-B', clock.iso())
      if (generation === null) {
        stopOutcome = 'blocked'
        return
      }
      const stopFence = { owner: 'unpublish-B', generation }
      if (!(await renewPublishLease(dbB, 'menu-1', stopFence, clock.iso()))) {
        stopOutcome = 'blocked'
        return
      }
      await unpublishRichMenuGroup({
        id: 'menu-1', size: 'large', chatBarText: '', isDefaultForAll: true,
        pages: [{ id: 'p1', orderIndex: 0, name: '', imageR2Key: null, imageContentType: null, lineRichMenuId: 'line-old-1', areas: [VALID_AREA] }],
      } as never, line as never)
      if (!(await markRichMenuGroupUnpublished(dbB, 'menu-1', stopFence))) stopOutcome = 'blocked'
      await releasePublishLease(dbB, 'menu-1', stopFence)
    })

    const aResult = await processDueRichMenuSchedules(
      dbA, depsFor(sqlite, db, line, unlinked) as never,
      { now: T0, clock: clock.now, runIdPrefix: 'A' },
    )

    // Aはleaseを持ったままなので、Bの停止は取得の時点で弾かれる。
    expect(stopOutcome).toBe('blocked')
    // Aは最後まで通る。
    expect(aResult).toMatchObject({ processed: 1, succeeded: 1 })
    const liveId = line.aliases.get('lhx-menu-1-0') as string
    expect(liveId).toMatch(/^line-new-/)
    const page = sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string }
    expect(page.v).toBe(liveId)
    const group = sqlite.prepare(`SELECT status AS s FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { s: string }
    expect(group.s).toBe('published')
    expect(scheduleRow(sqlite, 'stopwar-1').status).toBe('completed')
  })

  test('別接続：明示復元が期限切れgroupを畳むとき、そのgroupを持つ実行のleaseを消さない', async () => {
    // 明示の戻し先がある復元は、期限切れgroupと戻し先groupの2つを触る。
    // 期限切れgroup側をleaseなしで畳むと、そこを公開中の実行を壊す。
    insertGroup(sqlite, {
      id: 'menu-1', status: 'published', isDefault: true,
      pages: [{ id: 'p1', order: 0, lineId: 'line-exp-1' }],
    })
    insertGroup(sqlite, {
      id: 'menu-back', status: 'published', isDefault: true,
      pages: [{ id: 'b1', order: 0, lineId: 'line-back-1' }],
    })
    line.menus.set('line-exp-1', { name: 'exp' })
    line.menus.set('line-back-1', { name: 'back' })
    line.aliases.set('lhx-menu-1-0', 'line-exp-1')
    line.defaultId = 'line-exp-1'
    insertSchedule(sqlite, {
      id: 'exprest-1', mode: 'period', status: 'published',
      starts_at: '2026-09-10T00:00:00.000Z', ends_at: '2026-09-10T01:00:00.000Z',
      restore_group_id: 'menu-back', started_run_id: 'old-start',
      definition_snapshot: snapshotFor('menu-1', ['p1'], true),
    })

    // 期限切れgroup menu-1 を別の実行主体Mが握っている。
    const dbM = asD1(sqlite)
    const { acquirePublishLease } = await import('@line-crm/db')
    const mGeneration = await acquirePublishLease(dbM, 'menu-1', 'manual-M', clock.iso())
    expect(mGeneration).toBe(1)

    const result = await processDueRichMenuSchedules(
      db, depsFor(sqlite, db, line, unlinked) as never,
      { now: T0, clock: clock.now, runIdPrefix: 'R' },
    )

    // 復元は期限切れgroupのleaseを取れないので、畳まずに一時失敗へ戻す。
    expect(result).toMatchObject({ processed: 1, restored: 0, retried: 1 })
    const expiring = sqlite.prepare(`SELECT status AS s, publishing_owner AS o, publishing_generation AS g FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { s: string; o: string | null; g: number }
    // Mのleaseは消えていない。期限切れgroupも勝手に draft にされていない。
    expect(expiring.o).toBe('manual-M')
    expect(expiring.g).toBe(1)
    expect(expiring.s).toBe('published')
    expect(scheduleRow(sqlite, 'exprest-1').status).toBe('published')
  })

  test('別接続：予約行だけを別実行が回収したら、Aは外部工程を続けない', async () => {
    // groupのleaseは持っていても、予約行を取られたら所有権は失っている。
    // 片方だけ見ていると、Aが切替を続けて二重に公開してしまう。
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'rowtake-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })

    const dbB = asD1(sqlite)
    const { claimRichMenuSchedule, reclaimStalePublishingSchedule } = await import('@line-crm/db')
    let rowTaken = false
    let switchCalls = 0

    // Aが作り終えて切替へ入る直前に、予約行だけをBが回収して claim し直す。
    // 切替は本物どおり動かす。呼ばれてしまったかどうかを数で見る
    // (投げて止めると「呼ばれた」と「呼ばれなかった」が同じ形になる)。
    const base = depsFor(sqlite, db, line, unlinked)
    const depsA = depsFor(sqlite, db, line, unlinked, {
      switchLiveTo: async (input: never) => {
        switchCalls += 1
        await (base as { switchLiveTo: (i: never) => Promise<void> }).switchLiveTo(input)
      },
      createLineShells: async (snapshot: unknown, _s: unknown, heartbeat: () => Promise<void>) => {
        const { shells } = await createRichMenuShells(snapshot as never, line as never, fakeR2 as never, heartbeat)
        // 予約行のleaseだけ切らして、Bが取り直す（groupのleaseはAのまま）。
        clock.advance(11 * 60_000)
        await reclaimStalePublishingSchedule(dbB, 'rowtake-1', 'account-1', clock.iso())
        rowTaken = await claimRichMenuSchedule(dbB, 'rowtake-1', 'account-1', 'run-B', T0_ISO, clock.iso())
        return shells.map((shell) => ({
          pageId: shell.pageId, orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId, oldLineRichMenuId: null,
        }))
      },
    })

    const aResult = await processDueRichMenuSchedules(
      db, depsA as never, { now: T0, clock: clock.now, runIdPrefix: 'A' },
    )

    expect(rowTaken).toBe(true)
    // Aは切替を一度も呼ばない。groupのleaseはAのままでも、予約行を
    // 取られた時点で所有権は失っている。
    expect(switchCalls).toBe(0)
    expect(aResult).toMatchObject({ processed: 1, succeeded: 0, skipped: 1 })
    expect(line.aliases.size).toBe(0)
    expect(line.defaultId).toBeNull()
    // 作った分は片付いている。
    expect([...line.menus.keys()]).toEqual([])
    // DBにもAの反映は入っていない。
    const page = sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string | null }
    expect(page.v).toBeNull()
    expect((sqlite.prepare(`SELECT status AS s FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { s: string }).s).toBe('draft')
    // 予約行はBのものになっている。
    const row = scheduleRow(sqlite, 'rowtake-1')
    expect(row.started_run_id).toBe('run-B')
  })

  test('別接続：手動公開が長いLINE処理の途中で失権したら、成功扱いにしない', async () => {
    // 手動公開はページ数ぶんの作成・uploadで時間がかかる。その間に
    // renewしないと、自分が動いている最中に予約実行へ回収される。
    insertGroup(sqlite, {
      id: 'menu-1', status: 'published', isDefault: true,
      pages: [
        { id: 'p1', order: 0, lineId: 'line-old-a' },
        { id: 'p2', order: 1, lineId: 'line-old-b' },
      ],
    })
    line.menus.set('line-old-a', { name: 'old-a' })
    line.menus.set('line-old-b', { name: 'old-b' })
    line.aliases.set('lhx-menu-1-0', 'line-old-a')
    line.aliases.set('lhx-menu-1-1', 'line-old-b')
    line.defaultId = 'line-old-a'

    const dbM = asD1(sqlite)
    const dbR = asD1(sqlite)
    const {
      acquirePublishLease, renewPublishLease, markRichMenuGroupPublished, setPageRichMenuId,
    } = await import('@line-crm/db')

    // 手動公開Mがleaseを取り、1枚目を作ったところで期限が切れる。
    const mGeneration = await acquirePublishLease(dbM, 'menu-1', 'manual-M', clock.iso()) as number
    const mFence = { owner: 'manual-M', generation: mGeneration }
    let robbedGeneration: number | null = null
    let pageWrites = 0
    let markResult: boolean | null = null

    const heartbeat = async () => {
      if (!(await renewPublishLease(dbM, 'menu-1', mFence, clock.iso()))) {
        throw new PublishLeaseLostError()
      }
    }

    const groupInput = {
      id: 'menu-1', size: 'large' as const, chatBarText: 'test', isDefaultForAll: true,
      formBaseUrl: null,
      pages: [
        { id: 'p1', orderIndex: 0, name: 'p1', imageR2Key: 'img', imageContentType: 'image/jpeg', lineRichMenuId: 'line-old-a', areas: [VALID_AREA] },
        { id: 'p2', orderIndex: 1, name: 'p2', imageR2Key: 'img', imageContentType: 'image/jpeg', lineRichMenuId: 'line-old-b', areas: [VALID_AREA] },
      ],
    }

    const robbingLine = {
      ...line,
      async createRichMenu(payload: unknown) {
        const created = await line.createRichMenu(payload)
        if (line.calls.create === 1) {
          // 1枚目のあとで11分経ち、別の実行主体Rがleaseを奪う。
          clock.advance(11 * 60_000)
          robbedGeneration = await acquirePublishLease(dbR, 'menu-1', 'rms-R', clock.iso())
        }
        return created
      },
    }

    let thrown: unknown = null
    try {
      const result = await publishRichMenuGroup(groupInput as never, robbingLine as never, fakeR2 as never, heartbeat)
      for (const r of result.pages) {
        if (await setPageRichMenuId(dbM, r.pageId, r.newRichMenuId, mFence)) pageWrites += 1
      }
      markResult = await markRichMenuGroupPublished(dbM, 'menu-1', mFence)
    } catch (e) {
      thrown = e
    }

    // Rは確かに奪えている。
    expect(robbedGeneration).toBe(mGeneration + 1)
    // Mは途中で止まる。成功応答へ進まない。
    expect(thrown).toBeInstanceOf(PublishLeaseLostError)
    expect(pageWrites).toBe(0)
    expect(markResult).toBeNull()
    // liveの切替も起きていない。旧メニューのままで、作りかけは片付いている。
    expect(line.aliases.get('lhx-menu-1-0')).toBe('line-old-a')
    expect(line.aliases.get('lhx-menu-1-1')).toBe('line-old-b')
    expect(line.defaultId).toBe('line-old-a')
    expect([...line.menus.keys()].filter((id) => id.startsWith('line-new-'))).toEqual([])
    // Rのleaseは無傷。
    const group = sqlite.prepare(`SELECT publishing_owner AS o, publishing_generation AS g, status AS s FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { o: string; g: number; s: string }
    expect(group.o).toBe('rms-R')
    expect(group.g).toBe(robbedGeneration)
    expect(group.s).toBe('published')
  })

  test('renewは実時間で期限を延ばす：9分かかってもBは11分後に割り込めない', async () => {
    insertGroup(sqlite, { id: 'menu-1', isDefault: true, pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'renew-1', definition_snapshot: snapshotFor('menu-1', ['p1'], true) })
    const dbB = asD1(sqlite)
    let bResult: Awaited<ReturnType<typeof processDueRichMenuSchedules>> | null = null
    let expiresAtSwitch = ''

    const depsA = depsFor(sqlite, db, line, unlinked, {
      // 作成に9分かかる。tick開始の時刻を使い回していると期限が伸びない。
      createLineShells: async (snapshot: unknown) => {
        clock.advance(9 * 60_000)
        const { shells } = await createRichMenuShells(snapshot as never, line as never, fakeR2 as never)
        return shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
          oldLineRichMenuId: null,
        }))
      },
      // 切替の直前（=renew済み）に、実際に刻まれた期限とBの割り込みを見る。
      switchLiveTo: async (input: { groupId: string; setDefault: boolean; shells: Array<{ pageId: string; orderIndex: number; newRichMenuId: string; oldLineRichMenuId: string | null }> }) => {
        expiresAtSwitch = (sqlite.prepare(`SELECT publishing_expires_at AS e FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { e: string }).e
        clock.advance(2 * 60_000)
        bResult = await processDueRichMenuSchedules(
          dbB,
          depsFor(sqlite, dbB, line, unlinked) as never,
          { now: T0, clock: clock.now, runIdPrefix: 'B' },
        )
        await switchRichMenuLive(line as never, {
          id: input.groupId,
          size: 'large',
          chatBarText: '',
          isDefaultForAll: input.setDefault,
          pages: input.shells.map((shell) => ({
            id: shell.pageId, orderIndex: shell.orderIndex, name: '',
            imageR2Key: null, imageContentType: null,
            lineRichMenuId: shell.oldLineRichMenuId, areas: [VALID_AREA],
          })),
        } as never, input.shells.map((shell) => ({
          pageId: shell.pageId, orderIndex: shell.orderIndex, newRichMenuId: shell.newRichMenuId,
        })))
      },
    })

    const aResult = await processDueRichMenuSchedules(
      db, depsA as never, { now: T0, clock: clock.now, runIdPrefix: 'A' },
    )

    // 9分時点のrenewで期限が T0+10分 より先へ進んでいる。
    expect(expiresAtSwitch > new Date(T0.getTime() + 10 * 60_000).toISOString()).toBe(true)
    // だからT0+11分のBは、予約行もgroup leaseも取れない。
    expect(bResult).toMatchObject({ reclaimed: 0, processed: 0, succeeded: 0 })
    // Aがそのまま最後まで通す。
    expect(aResult).toMatchObject({ processed: 1, succeeded: 1 })
    expect(line.calls.create).toBe(1)
    const row = scheduleRow(sqlite, 'renew-1')
    expect(row.status).toBe('completed')
    expect(String(row.started_run_id)).toMatch(/^A-/)
  })

  test('run A/B fencing：古いrunは新しいclaim後に書けない（実D1）', async () => {
    insertGroup(sqlite, { id: 'menu-1', pages: [{ id: 'p1' }] })
    insertSchedule(sqlite, { id: 'fence-1' })
    expect(await claimRichMenuSchedule(db, 'fence-1', 'account-1', 'run-A', T0_ISO)).toBe(true)
    expect(await reclaimStalePublishingSchedule(db, 'fence-1', 'account-1', T0_ISO)).toBe(false)
    const expired = new Date(T0.getTime() + 11 * 60_000).toISOString()
    expect(await reclaimStalePublishingSchedule(db, 'fence-1', 'account-1', expired)).toBe(true)
    expect(await claimRichMenuSchedule(db, 'fence-1', 'account-1', 'run-B', expired)).toBe(true)
    expect(await recordRichMenuScheduleSuccess(db, 'fence-1', 'account-1', 'run-A', 'completed')).toBe(false)
    expect(await recordRichMenuScheduleSuccess(db, 'fence-1', 'account-1', 'run-B', 'completed')).toBe(true)
  })
})
