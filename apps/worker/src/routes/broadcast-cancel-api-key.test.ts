import { expect, test } from 'vitest';
import { app } from '../index.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';

test('APIキーによる予約取消はフォームの版を照合し、版なしも受け付ける', async () => {
  const fixture = createTestD1();
  const id = '11111111-2222-4333-8444-555555555555';
  try {
    fixture.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','c','A','token','secret')");
    fixture.raw.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,scheduled_at,line_account_id,lock_version)
      VALUES (?,'予約','text','本文','all','scheduled','2099-01-01T00:00:00Z','a',3)`).run(id);
    const call = (body: string) => app.request(`https://worker.test/api/broadcasts/${id}/cancel`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    }, { DB: fixture.db, API_KEY: 'fixture-key', DEPLOY_ENV: 'test' } as Env['Bindings']);
    expect((await call('expectedVersion=2')).status).toBe(409);
    expect(fixture.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(id)).toEqual({ status: 'scheduled' });
    expect((await call('expectedVersion=3&other=%ZZ')).status).toBe(400);
    expect((await call('expectedVersion=3')).status).toBe(200);
    fixture.raw.prepare("UPDATE broadcasts SET status='scheduled', scheduled_at='2099-01-01T00:00:00Z' WHERE id=?").run(id);
    expect((await call('other=value')).status).toBe(200);
  } finally { fixture.raw.close(); }
});
