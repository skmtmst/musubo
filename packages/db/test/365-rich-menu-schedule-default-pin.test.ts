import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  acquirePublishLease,
  isPublishLeaseHeld,
  markRichMenuGroupPublished,
  markRichMenuGroupUnpublished,
  publishLeaseExpiresAt,
  releasePublishLease,
  renewPublishLease,
  setPageRichMenuId,
} from '../src/rich-menus/index.js'
import {
  claimRichMenuSchedule,
  clearSchedulePublications,
  createRichMenuScheduleAtomic,
  getSchedulePublications,
  getScheduleRestoreDefaultPin,
  pinScheduleRestoreDefault,
  recordRichMenuScheduleSuccess,
  recordSchedulePublications,
  renewScheduleLease,
} from '../src/rich-menu-schedules.js'

function setup() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE rich_menu_groups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      publishing_at TEXT,
      confirmation_revision INTEGER NOT NULL DEFAULT 1,
      is_default_for_all INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '2026-09-06T00:00:00+09:00'
    );
    CREATE TABLE rich_menu_pages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
      line_richmenu_id TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-09-06T00:00:00+09:00'
    );
    INSERT INTO line_accounts VALUES ('account-1');
    INSERT INTO rich_menu_groups VALUES ('menu-1', 'account-1', 'draft', NULL, 1, 0, '2026-09-06T00:00:00+09:00');
    INSERT INTO rich_menu_pages VALUES ('p1', 'menu-1', 'line-old-1', '2026-09-06T00:00:00+09:00');
  `)
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/291_rich_menu_schedules.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/342_rich_menu_schedule_execution.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/344_rich_menu_schedule_publications.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/355_rich_menu_schedule_lease.sql'), 'utf8'))
  // 365は列追加だけのため、ALTERが素直に通ることもここで確かめる。
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/365_rich_menu_schedule_default_pin.sql'), 'utf8'))
  sqlite.exec(readFileSync(join(import.meta.dirname, '../migrations/539_rich_menu_group_version.sql'), 'utf8'))
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

function insertSchedule(sqlite: Database.Database, overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'schedule-1',
    group_id: 'menu-1',
    account_id: 'account-1',
    mode: 'period',
    starts_at: '2026-09-10T01:00:00.000Z',
    ends_at: '2026-09-30T00:00:00.000Z',
    restore_group_id: null,
    definition_snapshot: JSON.stringify({ pages: [{ id: 'p1' }] }),
    status: 'scheduled',
    idempotency_key: 'key-1',
    requested_by_staff_id: 'staff-1',
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

const NOW = '2026-09-10T01:00:00.000Z'
const LATER = '2026-09-10T01:11:00.000Z'

describe('365 default固定とlease所有権（実D1）', () => {
  let sqlite: Database.Database
  let db: D1Database

  beforeEach(() => {
    sqlite = setup()
    db = asD1(sqlite)
  })

  test('365の列が足され、既存行はNULLのまま動く', async () => {
    insertSchedule(sqlite, { id: 'pin-0' })
    const row = sqlite.prepare(
      `SELECT restore_default_state, restore_default_line_id FROM rich_menu_schedules WHERE id = 'pin-0'`,
    ).get() as Record<string, unknown>
    expect(row.restore_default_state).toBeNull()
    expect(row.restore_default_line_id).toBeNull()
    const group = sqlite.prepare(
      `SELECT publishing_owner, publishing_expires_at FROM rich_menu_groups WHERE id = 'menu-1'`,
    ).get() as Record<string, unknown>
    expect(group.publishing_owner).toBeNull()
    expect(group.publishing_expires_at).toBeNull()
    expect(await getScheduleRestoreDefaultPin(db, 'pin-0', 'account-1')).toBeNull()
  })

  test('pinは一度だけ書き、再試行は保存値を再利用する', async () => {
    insertSchedule(sqlite, { id: 'pin-1' })
    expect(await pinScheduleRestoreDefault(db, 'pin-1', 'account-1', { state: 'captured', lineId: 'line-old-1' })).toBe(true)
    expect(await getScheduleRestoreDefaultPin(db, 'pin-1', 'account-1')).toEqual({ state: 'captured', lineId: 'line-old-1' })
    // 2回目の固定は書けない（切替後の値で上書きしない）。
    expect(await pinScheduleRestoreDefault(db, 'pin-1', 'account-1', { state: 'captured', lineId: 'line-new-1' })).toBe(false)
    expect(await getScheduleRestoreDefaultPin(db, 'pin-1', 'account-1')).toEqual({ state: 'captured', lineId: 'line-old-1' })
  })

  test('no_defaultも固定でき、不正な状態は投げる', async () => {
    insertSchedule(sqlite, { id: 'pin-2', idempotency_key: 'key-2' })
    expect(await pinScheduleRestoreDefault(db, 'pin-2', 'account-1', { state: 'no_default', lineId: null })).toBe(true)
    expect(await getScheduleRestoreDefaultPin(db, 'pin-2', 'account-1')).toEqual({ state: 'no_default', lineId: null })
    await expect(
      pinScheduleRestoreDefault(db, 'pin-2', 'account-1', { state: 'broken', lineId: null } as never),
    ).rejects.toThrow()
  })

  test('leaseは所有者と世代付きで取り、他人は期限内は取れない', async () => {
    const genA = await acquirePublishLease(db, 'menu-1', 'run-A', NOW)
    expect(genA).toBe(1)
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(true)
    expect(await acquirePublishLease(db, 'menu-1', 'run-B', NOW)).toBeNull()
    const row = sqlite.prepare(`SELECT publishing_owner, publishing_expires_at, publishing_generation FROM rich_menu_groups WHERE id = 'menu-1'`).get() as Record<string, string | number>
    expect(row.publishing_owner).toBe('run-A')
    expect(row.publishing_expires_at).toBe(publishLeaseExpiresAt(NOW))
    expect(row.publishing_generation).toBe(1)
  })

  test('確認から確保までに版が変わればleaseを取らない', async () => {
    const row = sqlite.prepare("SELECT publishing_generation, confirmation_revision FROM rich_menu_groups WHERE id='menu-1'").get() as { publishing_generation: number; confirmation_revision: number }
    sqlite.exec("UPDATE rich_menu_groups SET confirmation_revision=confirmation_revision+1 WHERE id='menu-1'")
    expect(await acquirePublishLease(db, 'menu-1', 'run-A', NOW, undefined, undefined, undefined, row.publishing_generation, row.confirmation_revision)).toBeNull()
    expect(sqlite.prepare("SELECT publishing_owner FROM rich_menu_groups WHERE id='menu-1'").get()).toEqual({ publishing_owner: null })
  })

  test('確認版と公開世代の両方を照合し、更新後の版変更も検知する', async () => {
    const generation = await acquirePublishLease(db, 'menu-1', 'run-A', NOW, undefined, undefined, undefined, 0, 1)
    expect(generation).toBe(1)
    expect(sqlite.prepare("SELECT confirmation_revision FROM rich_menu_groups WHERE id='menu-1'").get()).toEqual({ confirmation_revision: 1 })
    sqlite.exec("UPDATE rich_menu_groups SET confirmation_revision=confirmation_revision+1 WHERE id='menu-1'")
    expect(await renewPublishLease(db, 'menu-1', { owner: 'run-A', generation: 1 }, NOW, undefined, 1)).toBe(false)
  })

  test('期限切れは別runが回収でき、旧所有者はrenewも解放もできない', async () => {
    const genA = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fenceA = { owner: 'run-A', generation: genA }
    // 期限内は旧所有者が延ばせる。
    expect(await renewPublishLease(db, 'menu-1', fenceA, NOW)).toBe(true)
    // 期限切れ（11分後）は別runが回収でき、世代が1つ進む。
    const genB = (await acquirePublishLease(db, 'menu-1', 'run-B', LATER)) as number
    expect(genB).toBe(genA + 1)
    const fenceB = { owner: 'run-B', generation: genB }
    // 回収後に旧所有者は延ばせず、開けられない。
    expect(await renewPublishLease(db, 'menu-1', fenceA, LATER)).toBe(false)
    expect(await releasePublishLease(db, 'menu-1', fenceA)).toBe(false)
    expect(await releasePublishLease(db, 'menu-1', fenceB)).toBe(true)
    expect(await isPublishLeaseHeld(db, 'menu-1', LATER)).toBe(false)
  })

  test('renewは渡した実現在時刻から期限を延ばす（入口の時刻を使い回さない）', async () => {
    // 実行が長引いた場合に、延ばしているつもりで期限が前に進まないと、
    // 途中で別の実行に回収される。renew は「そのときの時刻」から延ばす。
    const gen = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fence = { owner: 'run-A', generation: gen }
    const nineMinutesLater = new Date(Date.parse(NOW) + 9 * 60_000).toISOString()
    expect(await renewPublishLease(db, 'menu-1', fence, nineMinutesLater)).toBe(true)

    const expires = (sqlite.prepare(`SELECT publishing_expires_at AS e FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { e: string }).e
    expect(expires).toBe(publishLeaseExpiresAt(nineMinutesLater))
    // 取得から11分後でも、9分時点で延ばしてあるので他人は取れない。
    expect(await acquirePublishLease(db, 'menu-1', 'run-B', LATER)).toBeNull()
    expect(await renewPublishLease(db, 'menu-1', fence, LATER)).toBe(true)
  })

  test('旧形式(publishing_atのみ)の残留lockは回収できる', async () => {
    // 旧コードが停止時に残した想定。ownerも期限もない。
    sqlite.prepare(`UPDATE rich_menu_groups SET publishing_at = '2026-09-09T00:00:00+09:00' WHERE id = 'menu-1'`).run()
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(false)
    expect(await acquirePublishLease(db, 'menu-1', 'run-new', NOW)).toBe(1)
  })

  test('確定はleaseを開けない。開けるのは所有者付きのreleaseだけ', async () => {
    // 確定と解放を1文に混ぜると、解放後に続く外部操作が無防備になり、
    // 「自分が開けた」と「他人に取られた」も owner=NULL で見分けられなくなる。
    const genA = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fenceA = { owner: 'run-A', generation: genA }
    expect(await markRichMenuGroupPublished(db, 'menu-1', fenceA)).toBe(true)
    // 確定しても持ち主のまま。他人はまだ取れない。
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(true)
    expect(await acquirePublishLease(db, 'menu-1', 'run-X', NOW)).toBeNull()
    expect(await releasePublishLease(db, 'menu-1', fenceA)).toBe(true)
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(false)

    const genB = (await acquirePublishLease(db, 'menu-1', 'run-B', NOW)) as number
    const fenceB = { owner: 'run-B', generation: genB }
    expect(await markRichMenuGroupUnpublished(db, 'menu-1', fenceB)).toBe(true)
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(true)
    expect(await releasePublishLease(db, 'menu-1', fenceB)).toBe(true)
    expect(await isPublishLeaseHeld(db, 'menu-1', NOW)).toBe(false)
  })

  test('停止確定は1つの原子的更新。札が合わなければpage IDも消さない', async () => {
    // page を先に消してから group を落とすと、間に引き継がれたとき
    // 「page ID だけ null、group は published のまま」を作れてしまう。
    const genA = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fenceA = { owner: 'run-A', generation: genA }
    // 期限切れでBが回収する。
    const genB = (await acquirePublishLease(db, 'menu-1', 'run-B', LATER)) as number
    expect(await markRichMenuGroupUnpublished(db, 'menu-1', fenceA)).toBe(false)
    const after = sqlite.prepare(`SELECT g.status AS s, p.line_richmenu_id AS v FROM rich_menu_groups g JOIN rich_menu_pages p ON p.group_id = g.id WHERE g.id = 'menu-1'`).get() as { s: string; v: string }
    expect(after.v).toBe('line-old-1')
    expect(after.s).toBe('draft')
    // 新しい所有者Bのleaseは無傷。
    const held = sqlite.prepare(`SELECT publishing_owner AS o, publishing_generation AS g FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { o: string; g: number }
    expect(held.o).toBe('run-B')
    expect(held.g).toBe(genB)
    // Bは自分の札で畳める。
    expect(await markRichMenuGroupUnpublished(db, 'menu-1', { owner: 'run-B', generation: genB })).toBe(true)
    expect((sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string | null }).v).toBeNull()
  })

  test('回収に負けた旧holderは新しい所有者のleaseを消せず、確定もできない', async () => {
    insertSchedule(sqlite, { id: 'fence-gen', status: 'publishing', started_run_id: 'run-A' })
    const genA = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fenceA = { owner: 'run-A', generation: genA }
    // 期限切れでBが回収。世代が進む。
    const genB = (await acquirePublishLease(db, 'menu-1', 'run-B', LATER)) as number
    const fenceB = { owner: 'run-B', generation: genB }

    // 旧holder Aの公開確定は、Bのleaseを消さない。
    expect(await markRichMenuGroupPublished(db, 'menu-1', fenceA)).toBe(false)
    const held = sqlite.prepare(`SELECT publishing_owner AS o, publishing_generation AS g FROM rich_menu_groups WHERE id = 'menu-1'`).get() as { o: string; g: number }
    expect(held.o).toBe('run-B')
    expect(held.g).toBe(genB)
    // 旧holder Aのpage反映も通らない。
    expect(await setPageRichMenuId(db, 'p1', 'line-from-A', fenceA)).toBe(false)
    expect((sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string }).v).toBe('line-old-1')
    // 旧holder Aの確定も、世代が変わっているので通らない。
    expect(await recordRichMenuScheduleSuccess(db, 'fence-gen', 'account-1', 'run-A', 'completed', {
      groupId: 'menu-1', owner: 'run-A', generation: genA,
    })).toBe(false)
    // 新しい所有者Bは、自分の札で確定できる。
    expect(await markRichMenuGroupPublished(db, 'menu-1', fenceB)).toBe(true)
    expect(await recordRichMenuScheduleSuccess(db, 'fence-gen', 'account-1', 'run-A', 'completed', {
      groupId: 'menu-1', owner: 'run-B', generation: genB,
    })).toBe(true)
  })

  test('自分の公開確定のあとも lease は自分のもの。そのまま確定できる', async () => {
    insertSchedule(sqlite, { id: 'fence-self', status: 'publishing', started_run_id: 'run-A' })
    const genA = (await acquirePublishLease(db, 'menu-1', 'run-A', NOW)) as number
    const fenceA = { owner: 'run-A', generation: genA }
    expect(await markRichMenuGroupPublished(db, 'menu-1', fenceA)).toBe(true)
    expect(await recordRichMenuScheduleSuccess(db, 'fence-self', 'account-1', 'run-A', 'completed', {
      groupId: 'menu-1', owner: 'run-A', generation: genA,
    })).toBe(true)
    expect(await releasePublishLease(db, 'menu-1', fenceA)).toBe(true)
  })

  test('予約leaseは実現在時刻から延ばせる', async () => {
    insertSchedule(sqlite, { id: 'slease-1' })
    expect(await claimRichMenuSchedule(db, 'slease-1', 'account-1', 'run-A', NOW)).toBe(true)
    const before = (sqlite.prepare(`SELECT lease_expires_at AS e FROM rich_menu_schedules WHERE id = 'slease-1'`).get() as { e: string }).e
    const nineMinutesLater = new Date(Date.parse(NOW) + 9 * 60_000).toISOString()
    expect(await renewScheduleLease(db, 'slease-1', 'account-1', 'run-A', nineMinutesLater)).toBe(true)
    const after = (sqlite.prepare(`SELECT lease_expires_at AS e FROM rich_menu_schedules WHERE id = 'slease-1'`).get() as { e: string }).e
    expect(after > before).toBe(true)
    // 別のrunは延ばせない。
    expect(await renewScheduleLease(db, 'slease-1', 'account-1', 'run-B', nineMinutesLater)).toBe(false)
  })

  test('journalの削除は指定kindだけ消す', async () => {
    insertSchedule(sqlite, { id: 'j-1' })
    await recordSchedulePublications(db, 'j-1', 'publish', 'run-A', [{ pageId: 'p1', lineRichMenuId: 'line-new-1' }])
    await recordSchedulePublications(db, 'j-1', 'restore', 'run-R', [{ pageId: 'p1', lineRichMenuId: 'line-restore-1' }])
    await clearSchedulePublications(db, 'j-1', 'publish')
    expect(await getSchedulePublications(db, 'j-1', 'publish')).toEqual([])
    expect((await getSchedulePublications(db, 'j-1', 'restore')).map((row) => row.line_richmenu_id)).toEqual(['line-restore-1'])
  })

  test('予約再送：同じkey・同じ内容は同じ予約、異なる内容は競合', async () => {
    const base = {
      id: 'resend-1',
      groupId: 'menu-1',
      accountId: 'account-1',
      mode: 'scheduled' as const,
      startsAt: '2026-09-10T01:00:00.000Z',
      endsAt: null,
      restoreGroupId: null,
      definitionSnapshot: JSON.stringify({ pages: [{ id: 'p1' }] }),
      idempotencyKey: 'resend-key',
      requestedByStaffId: 'staff-1',
      now: '2026-09-06T00:00:00+09:00',
    }
    expect((await createRichMenuScheduleAtomic(db, base)).outcome).toBe('created')
    const resend = await createRichMenuScheduleAtomic(db, { ...base, id: 'resend-2' })
    expect(resend.outcome).toBe('existing')
    if (resend.outcome === 'existing') expect(resend.id).toBe('resend-1')
    const conflict = await createRichMenuScheduleAtomic(db, {
      ...base,
      id: 'resend-3',
      startsAt: '2026-09-11T01:00:00.000Z',
    })
    expect(conflict.outcome).toBe('conflict')
  })
})
