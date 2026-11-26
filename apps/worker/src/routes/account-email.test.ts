import { Hono } from 'hono';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { EMPTY_INBOX_SAVED_VIEW_CONDITIONS } from './chats-definition.js';
import { countInboxSavedViewMatches } from './inbox-saved-view-matches.js';
import { getInboxStatusCounts } from '@line-crm/db';
import { accountEmail } from './account-email.js';
import { routeInboundEmail } from '../services/inbound-email-router.js';
import { sendPlainMail } from '../services/plain-mail.js';
import type { Env } from '../worker-env.js';

vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: vi.fn() }));
let data: ReturnType<typeof createTestD1>;
let env: Env['Bindings'];
const app = new Hono<Env>();
app.use('*', async (c, next) => {
  c.set('staff', {
    id: c.req.header('store') || 'A',
    name: '見本 担当者',
    role: c.req.header('role') === 'staff' ? 'staff' : 'owner',
    readOnly: c.req.header('readonly') === '1',
    permissionKeys: ['/chats'],
  });
  return next();
});
app.route('/api/account-email/:accountId', accountEmail);
beforeEach(() => {
  data = createTestD1({ foreignKeys: true });
  data.raw.exec(
    "INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('A','A','見本 店舗A','a','a'),('B','B','見本 店舗B','b','b')",
  );
  data.raw.exec(`INSERT INTO staff_members(id,name,role,api_key,account_scope) VALUES
    ('A','見本 担当A','owner','fixture-a','accounts'),('B','見本 担当B','owner','fixture-b','accounts');
    INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES ('A','A','now'),('B','B','now');`);
  env = { DB: data.db, ACCOUNT_EMAIL_DOMAIN: 'inbox.example.org' } as Env['Bindings'];
  vi.mocked(sendPlainMail).mockReset();
});
afterEach(() => data.raw.close());
type Payload = {
  data: {
    status: string;
    issue: string | null;
    forwardingConfirmation: string | null;
    checkedAt: string | null;
    address: string;
    connectionId: string;
    total: number;
    summary: { total: number };
    items: { threadId: string }[];
    messages: { attachments: { id: string; filename: string; size: number }[] }[];
  };
};
function request(
  store: string,
  path: string,
  method = 'GET',
  body?: unknown,
  headers?: Record<string, string>,
) {
  return app.request(
    '/api/account-email/' + store + '/' + path,
    {
      method,
      headers: { store, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function issue(store: string) {
  const res = await request(store, 'connection', 'POST', { mailbox: store + '@shop.example' });
  expect(res.status).toBe(200);
  return (await res.json<Payload>()).data.address as string;
}
async function incoming(
  to: string,
  subject: string,
  body: string,
  extra: string[] = [],
  sender = 'reader@example.com',
) {
  const lines = ['From: 見本 送信者 <' + sender + '>', 'Subject: ' + subject, ...extra, '', body];
  const raw = lines.join('\r\n');
  const reject = vi.fn();
  const headers = new Headers(
    extra.map((line) => [line.split(':')[0], line.slice(line.indexOf(':') + 1).trim()]),
  );
  await routeInboundEmail(
    {
      to,
      from: sender,
      rawSize: new TextEncoder().encode(raw).length,
      raw: new Response(raw).body,
      headers,
      setReject: reject,
    } as unknown as ForwardableEmailMessage,
    env,
  );
  return reject;
}
async function connect(store: string) {
  const address = await issue(store);
  const pending = await request(store, 'connection/verify', 'POST', {});
  expect((await pending.json<Payload>()).data.status).toBe('pending');
  const mail = vi.mocked(sendPlainMail).mock.calls.at(-1)![1];
  expect(mail.to).toBe(store.toLowerCase() + '@shop.example');
  await incoming(address, mail.subject, mail.body);
  expect((await (await request(store, 'connection')).json<Payload>()).data.status).toBe('connected');
  return address;
}
it('発行・確認・失効・再発行の世代を分ける', async () => {
  const a = await connect('A');
  expect((await request('A', 'connection', 'POST', { mailbox: 'other@example.com' })).status).toBe(409);
  await incoming(a, 'first', 'saved');
  const previous = (await (await request('A', 'connection')).json<Payload>()).data.connectionId;
  const expected = { 'if-match': JSON.stringify(previous) };
  expect(
    (await (await request('A', 'connection', 'DELETE', undefined, expected)).json<Payload>()).data.status,
  ).toBe('revoked');
  expect(await incoming(a, 'old', 'cannot arrive')).toHaveBeenCalledOnce();
  data.raw.exec('UPDATE account_email_connections SET challenge_sent=0');
  const b = await connect('A');
  expect(a).not.toBe(b);
  expect((await request('A', 'connection', 'DELETE', undefined, expected)).status).toBe(409);
  expect((await (await request('A', 'inbox')).json<Payload>()).data.summary.total).toBe(0);
  expect(data.raw.prepare('SELECT count(*) FROM support_email_threads').pluck().get()).toBe(0);
});
it('送信失敗・再送・間違った証明・有効期限・普通のメールを区別する', async () => {
  const a = await issue('A');
  vi.mocked(sendPlainMail).mockRejectedValueOnce(new Error('fixture'));
  expect((await request('A', 'connection/verify', 'POST')).status).toBe(503);
  data.raw.exec('UPDATE account_email_connections SET challenge_sent=0');
  await request('A', 'connection/verify', 'POST');
  const mail = vi.mocked(sendPlainMail).mock.calls.at(-1)![1];
  expect((await request('A', 'connection/verify', 'POST')).status).toBe(409);
  await incoming(a, 'ordinary', mail.body);
  await incoming(a, mail.subject, 'musubo-verify=' + crypto.randomUUID());
  expect((await (await request('A', 'connection')).json<Payload>()).data.status).toBe('pending');
  data.raw.exec('UPDATE account_email_connections SET challenge_sent=0');
  await incoming(a, mail.subject, mail.body);
  expect((await (await request('A', 'connection')).json<Payload>()).data.status).toBe('pending');
  expect(data.raw.prepare('SELECT count(*) FROM account_email_messages').pluck().get()).toBe(0);
});
it('同じ差出人・Message-IDでも店舗内だけでまとめ、添付・検索・既読・件数を分離する', async () => {
  const a = await connect('A'),
    b = await connect('B');
  const parts = [
    '--part',
    'Content-Type: text/plain',
    '',
    'private content',
    '--part',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="sample.txt"',
    'Content-Transfer-Encoding: base64',
    '',
    'aGVsbG8=',
    '--part--',
  ].join('\r\n');
  const headers = ['Message-ID: <id@example.org>', 'Content-Type: multipart/mixed; boundary=part'];
  await Promise.all([incoming(a, 'shop A', parts, headers), incoming(a, 'shop A', parts, headers)]);
  await incoming(b, 'shop B', 'other', ['Message-ID: <id@example.org>']);
  const list = (await (await request('A', 'inbox?q=private')).json<Payload>()).data;
  expect(list.summary).toMatchObject({ total: 1, emailUnread: 1 });
  const id = list.items[0].threadId;
  const detail = (await (await request('A', 'threads/' + id)).json<Payload>()).data;
  expect(
    data.raw
      .prepare(
        "SELECT line_account_id,count(*) AS n FROM notifications WHERE event_type='account_email_received' GROUP BY line_account_id ORDER BY line_account_id",
      )
      .all(),
  ).toEqual([
    { line_account_id: 'A', n: 1 },
    { line_account_id: 'B', n: 1 },
  ]);
  expect(detail.total).toBe(1);
  const [file] = detail.messages[0].attachments;
  expect(file).toMatchObject({ filename: 'sample.txt', size: 5 });
  expect(await (await request('A', 'attachments/' + file.id)).text()).toBe('hello');
  for (const path of ['threads/' + id, 'attachments/' + file.id])
    expect((await request('B', path)).status).toBe(404);
  expect((await request('B', 'threads/' + id + '/read', 'POST')).status).toBe(404);
  expect((await (await request('B', 'inbox?q=private')).json<Payload>()).data.summary.total).toBe(0);
  expect((await request('A', 'read-all', 'POST')).status).toBe(200);
  expect((await (await request('B', 'inbox?unreadOnly=1')).json<Payload>()).data.summary.total).toBe(1);
  expect((await (await request('A', 'inbox?unreadOnly=1')).json<Payload>()).data.summary.total).toBe(0);
  await incoming(a, 'followup', 'same customer');
  expect((await (await request('A', 'threads/' + id)).json<Payload>()).data.total).toBe(2);
});
it('担当外・閲覧専用の設定変更を拒み、店舗には返信の送信口を公開しない', async () => {
  const a = await connect('A');
  expect((await request('A', 'connection', 'GET', undefined, { store: 'B' })).status).toBe(404);
  for (const headers of [{ role: 'staff' }, { readonly: '1' }] as Record<string, string>[]) {
    const state = (await (await request('A', 'connection', 'GET', undefined, headers)).json<Payload>()).data;
    expect(state).toMatchObject({ address: null, mailbox: null, canReply: false });
    expect((await request('A', 'connection', 'DELETE', undefined, headers)).status).toBe(403);
  }
  await incoming(a, 'away', 'automatic', ['Auto-Submitted: auto-replied']);
  await incoming(a, 'loop', 'automated', ['Auto-Submitted: auto-generated']);
  expect((await (await request('A', 'inbox')).json<Payload>()).data.summary.total).toBe(0);
  expect((await request('A', 'threads/one/reply', 'POST', { from: 'fake@shop.example' })).status).toBe(404);
  expect(vi.mocked(sendPlainMail)).toHaveBeenCalledTimes(1);
});

it('転送事業者の確認コードを管理者にだけ表示し、受信確認と取り違えない', async () => {
  const address = await issue('A');
  await incoming(
    address,
    'Forwarding Confirmation',
    'Confirmation code: 123456',
    [],
    'forwarding-noreply@google.com',
  );
  const settings = async (headers?: Record<string, string>) =>
    (await (await request('A', 'connection', 'GET', undefined, headers)).json<Payload>()).data;
  expect(await settings()).toMatchObject({ status: 'setup', forwardingConfirmation: '123456' });
  expect((await settings({ role: 'staff' })).forwardingConfirmation).toBeNull();
  await incoming(
    address,
    'Yahoo! JAPAN - 連絡用メールアドレス 確認コードのご連絡',
    '確認コード：654321',
    [],
    'reg-master@mail.yahoo.co.jp',
  );
  expect((await settings()).forwardingConfirmation).toBe('654321');
  await incoming(
    address,
    'Yahoo! JAPAN - 確認コード',
    '確認コード：111111',
    [],
    'login-master@mail.yahoo.co.jp',
  );
  expect((await settings()).forwardingConfirmation).toBe('654321');
});
it('接続後の再確認の遅れ・期限切れと自動返信を表示し、実際の再確認で復旧する', async () => {
  const address = await connect('A');
  const state = async () => (await (await request('A', 'connection')).json<Payload>()).data;
  await incoming(address, '不在', '返信', ['Auto-Submitted: auto-replied']);
  expect((await state()).issue).toBe('automated_mail');
  data.raw.exec('UPDATE account_email_connections SET challenge_sent=0');
  expect((await request('A', 'connection/verify', 'POST')).status).toBe(200);
  const sent = data.raw.prepare('UPDATE account_email_connections SET challenge_sent=?');
  sent.run(Date.now() - 6 * 60_000);
  expect(await state()).toMatchObject({ status: 'connected', issue: 'confirmation_delayed' });
  await incoming(address, 'received', 'still working');
  expect((await (await request('A', 'inbox')).json<Payload>()).data.summary.total).toBe(1);
  sent.run(0);
  expect((await state()).issue).toBe('verification_expired');
  await request('A', 'connection/verify', 'POST');
  const mail = vi.mocked(sendPlainMail).mock.calls.at(-1)![1];
  await incoming(address, mail.subject, mail.body);
  expect(await state()).toMatchObject({ status: 'connected', issue: null, checkedAt: expect.any(String) });
});

it('対応済み・未読・要返信を区別し、古い版の変更や他店からの変更を拒む', async () => {
  const address = await connect('A');
  await incoming(address, '見積もり', 'お願いします');
  const list = async (q: string) => (await (await request('A', 'inbox?' + q)).json<Payload>()).data;
  const [{ threadId }] = (await list('quickFilter=reply')).items;
  const path = 'threads/' + threadId + '/status';
  const body = { status: 'resolved', expectedRevision: 1 };
  expect((await request('B', path, 'PATCH', body)).status).toBe(404);
  expect((await request('A', path, 'PATCH', body)).status).toBe(200);
  expect((await request('A', path, 'PATCH', body)).status).toBe(409);
  expect((await list('quickFilter=reply')).summary.total).toBe(0);
  expect((await list('status=resolved')).summary.total).toBe(1);
  await incoming(address, '追記', 'お知らせ');
  expect((await list('quickFilter=reply')).summary.total).toBe(1);
});
it('写真サイズの添付を分割保存して元のバイト列を返す', async () => {
  const address = await connect('A');
  const original = Buffer.alloc(1200 * 1024, 85);
  const parts = [
    '--part',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="photo.bin"',
    'Content-Transfer-Encoding: base64',
    '',
    original.toString('base64'),
    '--part--',
  ].join('\r\n');
  await incoming(address, '写真', parts, ['Content-Type: multipart/mixed; boundary=part']);
  const id = data.raw.prepare('SELECT id FROM account_email_attachments').pluck().get() as string;
  const response = await request('A', 'attachments/' + id);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(original)).toBe(true);
});

it('保存ビューとダッシュボードの集計は選択した店舗に限る', async () => {
  const a = await connect('A');
  const b = await connect('B');
  await incoming(a, '見本 店舗A', '特注品');
  await incoming(b, '見本 店舗B', '別の相談');
  const conditions = { ...EMPTY_INBOX_SAVED_VIEW_CONDITIONS, query: '特注品' };
  for (const [staffId, expected] of [['A', 1], ['B', 0]] as const) {
    const result = await countInboxSavedViewMatches(data.db, {
      lineAccountId: staffId, staffId, canSeeUnassigned: false, conditions,
    });
    expect(result.matchCount).toBe(expected);
  }
  const counts = await getInboxStatusCounts(data.db, { allowedAccountIds: ['A'], includeUnassigned: false });
  expect(counts.email.unanswered).toBe(1);
});

it('統括が変わった店舗の旧転送先・会話・新着通知は引き継がない', async () => {
  const address = await connect('A');
  await incoming(address, '受信', '本文');
  data.raw.exec("INSERT INTO tenants(id,name) VALUES ('new-tenant','New tenant'); UPDATE line_accounts SET tenant_id='new-tenant' WHERE id='A'");
  expect(await incoming(address, '旧アドレス', '届かない')).toHaveBeenCalledOnce();
  expect(data.raw.prepare("SELECT status FROM account_email_connections WHERE address=?").pluck().get(address)).toBe('revoked');
  expect(data.raw.prepare("SELECT count(*) FROM notifications WHERE event_type='account_email_received'").pluck().get()).toBe(0);
  expect((await request('A','inbox')).status).toBe(404);
});

it('共通窓口と店舗メールの両方を保存ビューで数え、権限外には共通窓口を含めない', async () => {
  const address = await connect('A');
  await incoming(address, '店舗', '共通の検索語');
  const at = new Date().toISOString();
  data.raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value)
    VALUES('legacy-fixture','A','inbox_email_legacy_enabled','true')`).run();
  data.raw.prepare(`INSERT INTO support_email_threads
    (id,customer_email,subject,normalized_subject,status,last_message_at,last_incoming_at,created_at,updated_at)
    VALUES ('legacy-thread','shared@example.com','共通の検索語','共通の検索語','unread',?,?,?,?)`)
    .run(at, at, at, at);
  const conditions = { ...EMPTY_INBOX_SAVED_VIEW_CONDITIONS, channels: ['email'] as ('email'|'line')[], query: '共通の検索語' };
  const both = await countInboxSavedViewMatches(data.db, { lineAccountId: 'A', staffId: 'A', canSeeUnassigned: true, conditions });
  const scoped = await countInboxSavedViewMatches(data.db, { lineAccountId: 'A', staffId: 'A', canSeeUnassigned: false, conditions });
  expect(both.matchCount).toBe(2);
  expect(scoped.matchCount).toBe(1);
});
