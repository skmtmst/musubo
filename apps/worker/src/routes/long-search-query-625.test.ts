/*
 * 検索窓にとても長い文字を入れても一覧が壊れない。
 *
 * Cloudflare D1 は LIKE / GLOB のパターンを **最大50バイト** に制限する。
 * 検索語を `%<検索語>%` で束縛していた各一覧口は、検索語が48バイトを超えると
 * (ASCIIなら49文字、日本語なら約16文字) SQLite エラー → HTTP 500 で落ちていた。
 * 実測: `/api/scenarios?query=` に `a`×48 で 200、`a`×49 で 500。
 *
 * 直し方は LIKE をやめて `instr(lower(<col>), lower(?)) > 0` の部分一致に
 * 変えること。パターンではなく関数引数なのでバイト数制限はかからず、
 * 2000文字の検索語でも正当に 0件/ヒット を返せる。
 *
 * ここでは **実 SQLite** に各一覧口を当てて、
 *   1. 長文検索が 500 にならず 0件で返る
 *   2. 実行される SQL に LIKE / GLOB が残っていない（= D1 の制限を踏みえない）
 *   3. 通常検索・記号を含む検索がこれまでどおり当たる
 * を確かめる。better-sqlite3 自体は50バイト制限を持たないため、
 * 「LIKE が SQL に残っていないこと」まで見ないと D1 での再発を検出できない。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { computeUnansweredInbox } from '../services/unanswered-inbox.js';

vi.mock('../services/account-access.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/account-access.js')>();
  return {
    ...original,
    canAccessAllLineAccounts: vi.fn(async () => true),
    getVisibleLineAccountScope: vi.fn(async () => ({
      accounts: [],
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: true,
      ids: ['account-a'],
      isAccountScoped: false,
    })),
  };
});

const { chats } = await import('./chats.js');
const { supportInbox } = await import('./support-inbox.js');
const { default: events } = await import('./events.js');
const { scenarios } = await import('./scenarios.js');

/*
 * D1 の LIKE/GLOB 50バイト制限をはるかに超える検索語。
 * staging の再現語と同じく、一覧を壊した 2000文字を使う。
 */
const LONG_QUERY = 'とても長い検索語'.repeat(200);
const LONG_ASCII_QUERY = 'a'.repeat(2000);

let db: SqliteD1;
let preparedSql: string[];

beforeEach(() => {
  db = createTestD1();
  preparedSql = [];
  const original = db.db.prepare.bind(db.db);
  db.db.prepare = ((sql: string) => {
    preparedSql.push(sql);
    return original(sql);
  }) as typeof db.db.prepare;
  db.raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', '本店', 'token', 'secret')`).run();
});

afterEach(() => {
  db.raw.close();
});

function appFor(module: Hono<Env>) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: 'reader-a',
      name: '監査担当',
      role: 'owner',
      readOnly: false,
      permissionKeys: ['/scenarios'],
    });
    await next();
  });
  app.route('/', module);
  return app;
}

/** その要求で発行された SQL に、D1 の50バイト制限を踏む LIKE/GLOB が残っていないこと。 */
function expectNoLikeOrGlob(sqlList: string[]) {
  for (const sql of sqlList) {
    expect(sql).not.toMatch(/\b(LIKE|GLOB)\b/i);
  }
}

function seedScenario(id: string, name: string) {
  db.raw.prepare(`INSERT INTO scenarios
    (id, name, trigger_type, is_active, delivery_mode, line_account_id, created_at, updated_at)
    VALUES (?, ?, 'friend_add', 1, 'relative', 'account-a', '2026-09-01', '2026-09-01')`)
    .run(id, name);
}

function seedEvent(id: string, name: string) {
  db.raw.prepare(`INSERT INTO events (id, line_account_id, name, is_published)
    VALUES (?, 'account-a', ?, 1)`).run(id, name);
}

function seedLineThread(id: string, options: { name?: string; content?: string } = {}) {
  const at = '2026-09-13T03:00:00.000Z';
  db.raw.prepare('INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following) VALUES (?,?,?,?,1)')
    .run(id, `U-${id}`, options.name ?? id, 'account-a');
  db.raw.prepare(`INSERT INTO chats (id, friend_id, operator_id, status, last_message_at, last_customer_message_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(`chat-${id}`, id, null, 'unread', at, at, at, at);
  db.raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
    VALUES (?,?,'incoming','text',?,?)`)
    .run(`msg-${id}`, id, options.content ?? `msg-${id}`, at);
}

function seedEmailThread(id: string, options: { name?: string; subject?: string; body?: string } = {}) {
  const at = '2026-09-13T03:00:00.000Z';
  const subject = options.subject ?? '通常件名';
  db.raw.prepare(`INSERT INTO support_email_threads
    (id, customer_email, customer_name, subject, normalized_subject, status, assigned_staff_id,
     last_message_at, last_incoming_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `${id}@example.test`, options.name ?? '通常顧客', subject, subject,
      'unread', null, at, at, at, at);
  db.raw.prepare(`INSERT INTO support_email_messages
    (id, thread_id, direction, sender_email, recipient_email, subject, body_text, created_at)
    VALUES (?,?,'incoming',?,?,?,?,?)`)
    .run(`msg-${id}`, id, `${id}@example.test`, 'support@example.test', subject,
      options.body ?? '通常本文', at);
}

function seedSavedView(id: string, query: string) {
  const conditions = {
    version: 1,
    query,
    channels: ['line', 'email'],
    statuses: ['unread', 'in_progress', 'on_hold', 'resolved'],
    assignees: [],
    unread: 'all',
    quickFilter: 'all',
    messageTypes: [],
    receivedFrom: null,
    receivedTo: null,
    sort: 'newest',
    due: 'all',
  };
  db.raw.prepare(`INSERT INTO saved_searches
    (id, name, scope, conditions_json, created_by, is_shared, line_account_id, condition_format)
    VALUES (?,?,?,?,?,?,?, 'search_v1')`)
    .run(id, '長文を保存した検索', 'chats', JSON.stringify(conditions), 'reader-a', 1, 'account-a');
}

describe('#625 シナリオ一覧 GET /api/scenarios', () => {
  test('2000文字の検索語でも500にならず0件で返り、SQLにLIKEを使わない', async () => {
    seedScenario('sc-1', '夏のキャンペーン');
    const app = appFor(scenarios);

    const res = await app.request(
      `/api/scenarios?${new URLSearchParams({ lineAccountId: 'account-a', query: LONG_QUERY })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { items: unknown[]; total: number } };
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
    expectNoLikeOrGlob(preparedSql);
  });

  test('通常の検索語と、ワイルドカード記号を含む検索語はこれまでどおり当たる', async () => {
    seedScenario('sc-1', '100%還元キャンペーン');
    seedScenario('sc-2', '冬のお知らせ');
    const app = appFor(scenarios);

    const hit = await app.request(
      `/api/scenarios?${new URLSearchParams({ lineAccountId: 'account-a', query: 'キャンペーン' })}`,
      {}, { DB: db.db },
    );
    expect(hit.status).toBe(200);
    const hitBody = await hit.json() as { data: { items: Array<{ id: string }> } };
    expect(hitBody.data.items.map((item) => item.id)).toEqual(['sc-1']);

    // を防ぐ。独自ヘッダーは上流の LINE API へ転送しない。
    const literal = await app.request(
      `/api/scenarios?${new URLSearchParams({ lineAccountId: 'account-a', query: '100%' })}`,
      {}, { DB: db.db },
    );
    expect(literal.status).toBe(200);
    const literalBody = await literal.json() as { data: { items: Array<{ id: string }> } };
    expect(literalBody.data.items.map((item) => item.id)).toEqual(['sc-1']);
  });
});

describe('#625 イベント予約一覧 GET /api/events/admin/events', () => {
  test('2000文字の検索語でも500にならず0件で返り、SQLにLIKEを使わない', async () => {
    seedEvent('ev-1', '夏祭り説明会');
    const res = await appFor(events).request(
      `/api/events/admin/events?${new URLSearchParams({ account_id: 'account-a', q: LONG_ASCII_QUERY })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expectNoLikeOrGlob(preparedSql);
  });

  test('通常の検索語はこれまでどおりイベント名に当たる', async () => {
    seedEvent('ev-1', '夏祭り説明会');
    seedEvent('ev-2', '冬の相談会');
    const res = await appFor(events).request(
      `/api/events/admin/events?${new URLSearchParams({ account_id: 'account-a', q: '説明会' })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id)).toEqual(['ev-1']);
  });
});

describe('#625 受信箱 GET /api/chats', () => {
  test('2000文字の検索語でも500にならず0件で返り、SQLにLIKEを使わない', async () => {
    seedLineThread('friend-1', { name: '見本' });
    const res = await appFor(chats).request(
      `/api/chats?${new URLSearchParams({ lineAccountId: 'account-a', q: LONG_QUERY })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expectNoLikeOrGlob(preparedSql);
  });

  test('名前と本文への通常検索はこれまでどおり当たる', async () => {
    seedLineThread('by-name', { name: '見本' });
    seedLineThread('by-body', { name: '別人', content: '解約したい' });
    const app = appFor(chats);

    const byName = await app.request(
      `/api/chats?${new URLSearchParams({ lineAccountId: 'account-a', q: '見本' })}`,
      {}, { DB: db.db },
    );
    expect(byName.status).toBe(200);
    const nameBody = await byName.json() as { data: Array<{ friendId: string }> };
    expect(nameBody.data.map((row) => row.friendId)).toEqual(['by-name']);

    const byBody = await app.request(
      `/api/chats?${new URLSearchParams({ lineAccountId: 'account-a', q: '解約' })}`,
      {}, { DB: db.db },
    );
    expect(byBody.status).toBe(200);
    const bodyBody = await byBody.json() as { data: Array<{ friendId: string }> };
    expect(bodyBody.data.map((row) => row.friendId)).toEqual(['by-body']);
  });
});

describe('#625 受信箱タブ件数 GET /api/chats/quick-counts', () => {
  test('2000文字の検索語でも500にならず0件で返り、SQLにLIKEを使わない', async () => {
    seedLineThread('friend-1', { name: '見本' });
    seedEmailThread('mail-1', { name: '見本' });
    const res = await appFor(chats).request(
      `/api/chats/quick-counts?${new URLSearchParams({ channel: 'all', q: LONG_QUERY })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean
      data: { all: number; reply: number; overdue: number; line: { all: number }; email: { all: number } }
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      all: 0,
      reply: 0,
      overdue: 0,
      line: { all: 0 },
      email: { all: 0 },
    });
    expectNoLikeOrGlob(preparedSql);
  });

  test('通常の検索語はLINE・メールとも件数に当たる', async () => {
    seedLineThread('friend-1', { name: '見本' });
    seedEmailThread('mail-1', { name: '見本' });
    const res = await appFor(chats).request(
      `/api/chats/quick-counts?${new URLSearchParams({ channel: 'all', q: '見本' })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { all: number; line: { all: number }; email: { all: number } } };
    expect(body.data.all).toBe(2);
    expect(body.data.line.all).toBe(1);
    expect(body.data.email.all).toBe(1);
  });
});

describe('#625 受信箱メール一覧 GET /api/support/inbox', () => {
  test('2000文字の検索語でも500にならず0件で返り、SQLにLIKEを使わない', async () => {
    seedEmailThread('mail-1', { subject: '定期便の解約について' });
    const res = await appFor(supportInbox).request(
      `/api/support/inbox?${new URLSearchParams({ channel: 'email', status: 'all', q: LONG_QUERY })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { items: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([]);
    expectNoLikeOrGlob(preparedSql);
  });
});

describe('#625 受信箱の保存検索 GET /api/inbox/saved-views', () => {
  test('長い検索語を保存した条件でも一覧全体が500にならない', async () => {
    // 保存条件の検索語は200字で切り詰められる。それでも48バイトは超える。
    seedSavedView('sv-1', 'x'.repeat(150));
    const res = await appFor(chats).request(
      `/api/inbox/saved-views?${new URLSearchParams({ lineAccountId: 'account-a' })}`,
      {}, { DB: db.db },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean
      data: Array<{ id: string; matchCount: number | null }>
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].matchCount).toBe(0);
    expectNoLikeOrGlob(preparedSql);
  });
});

describe('#625 未対応一覧 computeUnansweredInbox', () => {
  test('2000文字の検索語でも例外を投げず0件を返し、通常検索は当たる', async () => {
    seedLineThread('friend-1', { name: '見本', content: '導入相談' });

    const empty = await computeUnansweredInbox(db.db, {
      q: LONG_QUERY,
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: true,
    });
    expect(empty.total).toBe(0);
    expect(empty.rows).toEqual([]);
    expectNoLikeOrGlob(preparedSql);

    const hit = await computeUnansweredInbox(db.db, {
      q: '見本',
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: true,
    });
    expect(hit.total).toBe(1);
    expect(hit.rows.map((row) => row.friendId)).toEqual(['friend-1']);
  });
});
