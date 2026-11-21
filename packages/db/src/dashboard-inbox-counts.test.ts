import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboardOverview, getInboxStatusCounts } from './dashboard.js';

const packageRoot = join(import.meta.dirname, '..');

function asD1(sqlite: Database.Database): D1Database {
  function prepare(query: string): D1PreparedStatement {
    const statement = sqlite.prepare(query);
    const bound = (params: unknown[]): D1PreparedStatement => ({
      bind: (...next: unknown[]) => bound(next),
      async all<T>() {
        return { results: statement.all(...params) as T[], success: true, meta: {} };
      },
      async first<T>() {
        return (statement.get(...params) as T | undefined) ?? null;
      },
      async run<T>() {
        const result = statement.run(...params);
        return { success: true, meta: { changes: result.changes }, results: [] } as T;
      },
    } as unknown as D1PreparedStatement);
    return bound([]);
  }
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run())) as T;
    },
  } as unknown as D1Database;
}

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const AT = (ageMinutes: number) => new Date(NOW - ageMinutes * 60_000).toISOString();

let sqlite: Database.Database;
let db: D1Database;

function seedLineAccount(id: string): void {
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES (?, ?, ?, 'token', 'secret')`,
  ).run(id, `channel-${id}`, id);
}

function seedFriend(id: string, accountId: string, status: string | null, ageMinutes: number, withMessage: boolean): void {
  sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
     VALUES (?, ?, ?, ?)`,
  ).run(id, id, id, accountId);
  if (status !== null) {
    const at = AT(ageMinutes);
    sqlite.prepare(
      `INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`chat-${id}`, id, status, at, at, at);
  }
  if (withMessage) {
    const at = AT(ageMinutes);
    sqlite.prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
       VALUES (?, ?, 'incoming', 'text', ?, ?)`,
    ).run(`msg-${id}`, id, `msg-${id}`, at);
  }
}

function seedMail(id: string, status: string, ageMinutes: number): void {
  const at = AT(ageMinutes);
  sqlite.prepare(
    `INSERT INTO support_email_threads
       (id, customer_email, customer_name, subject, normalized_subject, status,
        last_message_at, last_incoming_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.test`, id, id, id, status, at, at, at, at);
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
  db = asD1(sqlite);
  seedLineAccount('account-a');
  seedLineAccount('account-b');

  // LINE（account-a）: 4状態を1人ずつ + 行なし1人（対応済み扱い） + 履歴なし1人（対象外）。
  seedFriend('fa-unread', 'account-a', 'unread', 30, true);
  seedFriend('fa-progress', 'account-a', 'in_progress', 60, true);
  seedFriend('fa-hold', 'account-a', 'on_hold', 90, true);
  seedFriend('fa-resolved', 'account-a', 'resolved', 120, true);
  seedFriend('fa-norow', 'account-a', null, 150, true);
  seedFriend('fa-silent', 'account-a', null, 0, false);
  // 別アカウントの未対応。account-a の範囲では数えない。
  seedFriend('fb-unread', 'account-b', 'unread', 30, true);

  // MAIL: 未対応2・対応中1・保留1・対応済み1。
  seedMail('mail-unread-1', 'unread', 10);
  seedMail('mail-unread-2', 'unread', 20);
  seedMail('mail-progress', 'in_progress', 40);
  seedMail('mail-hold', 'on_hold', 50);
  seedMail('mail-resolved', 'resolved', 70);
});

describe('getInboxStatusCounts（受信箱の対応状況の正本）', () => {
  it('LINEだけの範囲ではMAILを数えない', async () => {
    const counts = await getInboxStatusCounts(db, { allowedAccountIds: ['account-a'], includeUnassigned: false });
    expect(counts.line).toEqual({ unanswered: 1, inProgress: 1, onHold: 1, resolved: 2 });
    expect(counts.email).toEqual({ unanswered: 0, inProgress: 0, onHold: 0, resolved: 0 });
    expect(counts).toMatchObject({ unanswered: 1, inProgress: 1, onHold: 1, resolved: 2 });
  });

  it('未割り当てが見える範囲ではMAILを合わせる', async () => {
    const counts = await getInboxStatusCounts(db, { allowedAccountIds: ['account-a'], includeUnassigned: true });
    expect(counts.line).toEqual({ unanswered: 1, inProgress: 1, onHold: 1, resolved: 2 });
    expect(counts.email).toEqual({ unanswered: 2, inProgress: 1, onHold: 1, resolved: 1 });
    expect(counts).toMatchObject({ unanswered: 3, inProgress: 2, onHold: 2, resolved: 3 });
  });

  it('別アカウントのLINEは混ぜない', async () => {
    const counts = await getInboxStatusCounts(db, { allowedAccountIds: ['account-b'], includeUnassigned: false });
    expect(counts.line.unanswered).toBe(1);
    expect(counts.line.resolved).toBe(0);
  });

  it('最も古い未対応はLINEとMAILのうち待ちが長い方', async () => {
    // 最も古い未対応は fa-unread（30分前）。MAIL を足しても変わらない。
    const lineOnly = await getInboxStatusCounts(db, { allowedAccountIds: ['account-a'], includeUnassigned: false });
    expect(lineOnly).toMatchObject({ unanswered: 1 });
    const { getDashboardOverview: overview } = await import('./dashboard.js');
    const withMail = await overview(db, 'today', { allowedAccountIds: ['account-a'], includeUnassigned: false }, { allowedAccountIds: ['account-a'], includeUnassigned: true });
    expect(withMail.inbox.oldestUnansweredMinutes).toBe(30);
  });
});

describe('ダッシュボードの対応状況は正本と同じ数を出す', () => {
  it('overview.inbox が getInboxStatusCounts と一致する', async () => {
    const scope = { allowedAccountIds: ['account-a'], includeUnassigned: false } as const;
    const inboxScope = { allowedAccountIds: ['account-a'], includeUnassigned: true } as const;
    const [overview, counts] = await Promise.all([
      getDashboardOverview(db, 'today', scope, inboxScope),
      getInboxStatusCounts(db, inboxScope),
    ]);
    expect(overview.inbox.unanswered).toBe(counts.unanswered);
    expect(overview.inbox.inProgress).toBe(counts.inProgress);
    expect(overview.inbox.onHold).toBe(counts.onHold);
    expect(overview.inbox.resolved).toBe(counts.resolved);
    expect(overview.inbox.line).toEqual(counts.line);
    expect(overview.inbox.email).toEqual(counts.email);
  });
});

it('指定した日本時間の日付の初めから終わりまでだけ成果を集計する', async () => {
  const { conversionSummary } = await import('./dashboard-snapshots.js');
  sqlite.prepare("INSERT INTO conversion_points(id, name, event_type) VALUES ('p', '成果', 'manual')").run();
  const insert = sqlite.prepare('INSERT INTO conversion_events(id, conversion_point_id, friend_id, created_at) VALUES (?, ?, ?, ?)');
  insert.run('before', 'p', 'fa-unread', '2026-09-18T23:59:59.999');
  insert.run('start', 'p', 'fa-unread', '2026-09-19T00:00:00.000');
  insert.run('end', 'p', 'fa-unread', '2026-09-20T23:59:59.999');
  insert.run('after', 'p', 'fa-unread', '2026-09-21T00:00:00.000');
  const result = await conversionSummary(db, 'custom', { allowedAccountIds: ['account-a'], includeUnassigned: false }, { from: '2026-09-19', to: '2026-09-20' });
  expect(result).toEqual({ total: 2, byPoint: [{ name: '成果', count: 2 }] });
});
