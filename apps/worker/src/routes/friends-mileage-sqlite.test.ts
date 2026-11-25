import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { friends } from './friends.js';
import { authMiddleware } from '../middleware/auth.js';
import { featureEnforcementMiddleware } from '../middleware/feature-enforcement.js';
import type { Env } from '../index.js';

describe('friend mileage with real SQLite', () => {
  it('returns an empty wallet for a LINE-only friend with no program or EC connection', async () => {
    const sqlite = createTestD1({ foreignKeys: true, loginPolicy: 'off' });
    sqlite.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','tenant');
      INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a','channel','store','token','secret','t');
      INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','user','a');
      INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('s','owner','owner','test-key','t');`);
    expect((sqlite.raw.prepare('SELECT count(*) AS n FROM mileage_programs').get() as {n:number}).n).toBe(0);
    const app = new Hono<Env>();
    app.use('*', authMiddleware);
    app.use('*', featureEnforcementMiddleware);
    app.route('/', friends);
    const response = await app.request('/api/friends/f/mileage?limit=10', { headers: { Authorization: 'Bearer test-key' } }, { DB: sqlite.db } as Env['Bindings']);
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { summary: { available: number }; history: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.summary.available).toBe(0);
    expect(body.data.history).toEqual([]);
    sqlite.raw.prepare("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('setting','a','feature.mileage',?)").run(JSON.stringify({ enabled: false }));
    const disabled = await app.request('/api/friends/f/mileage?limit=10', { headers: { Authorization: 'Bearer test-key' } }, { DB: sqlite.db } as Env['Bindings']);
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ code: 'FEATURE_DISABLED', featureId: 'mileage' });
    sqlite.raw.close();
  });
});
