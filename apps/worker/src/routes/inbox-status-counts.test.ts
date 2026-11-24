import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { getInboxStatusCounts } from '@line-crm/db';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { chats } from './chats.js';
import { supportInbox } from './support-inbox.js';

/*
 * ダッシュボードの「現在の対応状況」と受信箱の数が一致すること。
 * どちらも受信箱の正本（getInboxStatusCounts）と同じ定義・同じ範囲で
 * 数えていることを、実SQLite・実ルートで確かめる。
 *
 * 見本は LINE と MAIL、4つの状態を混ぜる。
 */

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
let db: SqliteD1;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  db = createTestD1();
  db.raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', '本店', 'token', 'secret')`).run();
  db.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('fixture-legacy','account-a','inbox_email_legacy_enabled','true')");
});
afterEach(() => { db.raw.close(); vi.restoreAllMocks(); });

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'reader-a', name: 'reader-a', role: 'owner', readOnly: false });
    await next();
  });
  instance.route('/', chats);
  instance.route('/', supportInbox);
  return instance;
}

function seedLine(id: string, status: string, withChatRow = true) {
  const at = new Date(NOW - 30 * 60_000).toISOString();
  db.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)')
    .run(id, id, id, 'account-a');
  if (withChatRow) {
    db.raw.prepare(`INSERT INTO chats(id,friend_id,operator_id,status,last_message_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, id, null, status, at, at, at);
  }
  db.raw.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at)
    VALUES (?,?,'incoming','text',?,?)`).run(id, id, `msg-${id}`, at);
}

function seedMail(id: string, status: string) {
  const at = new Date(NOW - 30 * 60_000).toISOString();
  db.raw.prepare(`INSERT INTO support_email_threads
    (id,customer_email,customer_name,subject,normalized_subject,status,last_message_at,last_incoming_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `${id}@example.test`, id, id, id, status, at, at, at, at);
}

async function seedMixed() {
  seedLine('line-unread', 'unread');
  seedLine('line-progress', 'in_progress');
  seedLine('line-hold', 'on_hold');
  seedLine('line-resolved', 'resolved');
  // chats 行なし＋受信ありは対応済み扱い（一覧の COALESCE と同じ）。
  seedLine('line-norow', 'resolved', false);
  seedMail('mail-unread-1', 'unread');
  seedMail('mail-unread-2', 'unread');
  seedMail('mail-progress', 'in_progress');
  seedMail('mail-hold', 'on_hold');
  seedMail('mail-resolved', 'resolved');
}

describe('受信箱の対応状況は正本と一致する', () => {
  test('quick-counts の合計と正本の合計が一致する（LINE＋MAIL）', async () => {
    await seedMixed();
    const scope = { allowedAccountIds: ['account-a'], includeUnassigned: true };
    const counts = await getInboxStatusCounts(db.db, scope);
    expect(counts).toMatchObject({
      unanswered: 3, inProgress: 2, onHold: 2, resolved: 3,
      line: { unanswered: 1, inProgress: 1, onHold: 1, resolved: 2 },
      email: { unanswered: 2, inProgress: 1, onHold: 1, resolved: 1 },
    });

    const res = await app().request('/api/chats/quick-counts?channel=all', {}, { DB: db.db });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { all: number; reply: number; line: { all: number }; email: { all: number } } };
    expect(body.data.all).toBe(counts.unanswered + counts.inProgress + counts.onHold + counts.resolved);
    expect(body.data.reply).toBe(counts.unanswered);
    expect(body.data.line.all).toBe(5);
    expect(body.data.email.all).toBe(5);
  });

  test('状態で絞った一覧の件数が正本の状態別件数と一致する', async () => {
    await seedMixed();
    const scope = { allowedAccountIds: ['account-a'], includeUnassigned: true };
    const counts = await getInboxStatusCounts(db.db, scope);
    const pairs = [
      ['unread', 'unanswered'],
      ['in_progress', 'inProgress'],
      ['on_hold', 'onHold'],
      ['resolved', 'resolved'],
    ] as const;
    for (const [status, key] of pairs) {
      const lineRes = await app().request(
        `/api/chats?status=${status}&lineAccountId=account-a&limit=200`, {}, { DB: db.db });
      expect(lineRes.status).toBe(200);
      const lineBody = await lineRes.json() as { success: boolean; data: unknown[] };
      expect(lineBody.data.length).toBe(counts.line[key]);

      const mailRes = await app().request(
        `/api/support/inbox?channel=email&status=${status}&limit=200`, {}, { DB: db.db });
      expect(mailRes.status).toBe(200);
      const mailBody = await mailRes.json() as {
        success: boolean; data: { items: unknown[]; summary: { total: number } };
      };
      expect(mailBody.data.items.length).toBe(counts.email[key]);
      expect(mailBody.data.summary.total).toBe(counts.email[key]);
    }
  });

  test('LINEアカウント選択中もMAILを数える（受信箱の一覧と同じ）', async () => {
    await seedMixed();
    // メールはLINEアカウントに所属しない。選択中のアカウントがあっても、
    // 未割り当てが見える範囲ではメールを数える。一覧と同じ条件。
    const scope = { allowedAccountIds: ['account-a'], includeUnassigned: true };
    const counts = await getInboxStatusCounts(db.db, scope);
    const res = await app().request('/api/chats/quick-counts?channel=all&lineAccountId=account-a', {}, { DB: db.db });
    const body = await res.json() as {
      success: boolean;
      data: { all: number; reply: number; email: { all: number } };
    };
    expect(body.data.all).toBe(
      counts.unanswered + counts.inProgress + counts.onHold + counts.resolved,
    );
    expect(body.data.reply).toBe(counts.unanswered);
    expect(body.data.email.all).toBe(
      counts.email.unanswered + counts.email.inProgress + counts.email.onHold + counts.email.resolved,
    );
  });

  test('アカウント選択中もメール一覧が返る', async () => {
    await seedMixed();
    const res = await app().request(
      '/api/support/inbox?channel=email&status=all&lineAccountId=account-a&limit=200', {}, { DB: db.db });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean; data: { items: unknown[]; summary: { total: number } };
    };
    expect(body.data.items.length).toBe(5);
    expect(body.data.summary.total).toBe(5);
  });
});
