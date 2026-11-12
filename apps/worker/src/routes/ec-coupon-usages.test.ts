/*
 *  ECからのクーポン利用通知口を実D1で固定する。
 *  1. 署名のある通知で発行台帳の used_at が立ち、利用率の分母に入る
 *  2. 同じコードの再送は上書きしない（alreadyUsed）
 *  3. 署名が違う・コードが無い・知らないコードは記録しない
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const { nenCampaigns } = await import('./nen-campaigns.js');

const SECRET = 'test-webhook-secret-test-webhook-s'; // 32文字以上

let sql: Database.Database;
let db: D1Database;

function seed(raw: Database.Database): void {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-nen', 'channel-nen', '然', 'token', 'secret'),
           ('account-other', 'channel-o', '別', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', 'account-nen', 1, '2026-09-01', '2026-09-01'),
      ('friend-x', 'U-x', '別店', 'account-other', 1, '2026-09-01', '2026-09-01');
    INSERT INTO nen_pet_profiles (id, friend_id, name, animal_type, gender, birthday, created_at, updated_at) VALUES
      ('pet-1', 'friend-a', 'モモ', 'dog', 'female', '2020-03-15', '2026-09-01', '2026-09-01'),
      ('pet-x', 'friend-x', 'ヨソ', 'dog', 'male', '2020-01-01', '2026-09-01', '2026-09-01');
    INSERT INTO nen_coupon_issues
      (id, pet_id, friend_id, issue_year, coupon_code, benefit_label, expires_at, issued_at) VALUES
      ('issue-1', 'pet-1', 'friend-a', 2026, 'NENBDAY-26-AAAA', 'お誕生日クーポン', '2026-04-15', '2026-03-12 01:00:00'),
      ('issue-x', 'pet-x', 'friend-x', 2026, 'NENBDAY-26-XXXX', 'お誕生日クーポン', '2026-02-01', '2026-01-01 00:00:00');
  `);
}

async function sign(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const signature = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { timestamp, signature };
}

async function post(body: Record<string, unknown>, opts: { signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const { timestamp, signature } = await sign(raw);
  const app = new Hono<any>();
  app.use('*', async (c, next) => { c.env = { DB: db, ECCUBE_WEBHOOK_SECRET: SECRET }; await next(); });
  app.route('/', nenCampaigns);
  return app.request('/api/integrations/eccube/coupon-usages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nen-timestamp': timestamp,
      'x-nen-signature': opts.signature ?? signature,
    },
    body: raw,
  });
}

const usedAt = (id: string) =>
  (sql.prepare(`SELECT used_at FROM nen_coupon_issues WHERE id = ?`).get(id) as { used_at: string | null } | undefined)?.used_at;

beforeEach(() => {
  const created = createTestD1();
  sql = created.raw;
  db = created.db;
  seed(sql);
});

describe('ECクーポン利用通知（POST /api/integrations/eccube/coupon-usages）', () => {
  it('署名のある通知で used_at が立つ', async () => {
    const res = await post({ code: 'NENBDAY-26-AAAA', used_at: '2026-03-20T12:34:56+09:00', order_number: '1001', event_id: 'evt-use-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { couponCode: 'NENBDAY-26-AAAA', usedAt: '2026-03-20 12:34:56' } });
    expect(usedAt('issue-1')).toBe('2026-03-20 12:34:56');
  });

  it('同じコードの再送は最初の利用日時を上書きしない', async () => {
    await post({ code: 'NENBDAY-26-AAAA', used_at: '2026-03-20T12:00:00+09:00' });
    const res = await post({ code: 'NENBDAY-26-AAAA', used_at: '2026-03-21T09:00:00+09:00' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { alreadyUsed: true } });
    expect(usedAt('issue-1')).toBe('2026-03-20 12:00:00');
  });

  it('署名が違う通知は記録しない（401）', async () => {
    const res = await post({ code: 'NENBDAY-26-AAAA' }, { signature: '0'.repeat(64) });
    expect(res.status).toBe(401);
    expect(usedAt('issue-1')).toBeNull();
  });

  it('コードが無い本文・使えない日付は弾く（400）', async () => {
    expect((await post({ order_number: '1001' })).status).toBe(400);
    expect((await post({ code: 'NENBDAY-26-AAAA', used_at: 'not-a-date' })).status).toBe(400);
    expect(usedAt('issue-1')).toBeNull();
  });

  it('知らないコードは 404', async () => {
    const res = await post({ code: 'NENBDAY-99-ZZZZ' });
    expect(res.status).toBe(404);
  });

  it('どのアカウントの発行分でもコードそのものが合えば記録される', async () => {
    // 署名はアカウントを名乗らない（EC標準）。発行台帳の行が正本で、
    // 別アカウントの子へ届くのは「そのコードを使った」という事実だけ。
    const res = await post({ code: 'NENBDAY-26-XXXX' });
    expect(res.status).toBe(200);
    expect(usedAt('issue-x')).not.toBeNull();
  });
});
