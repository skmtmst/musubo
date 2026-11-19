import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { mileageHandgift } from './mileage-handgift.js';

describe('手渡し API', () => {
  it('管理者は自分の店の手渡しを一度だけ記録し、閲覧のみは拒否する', async () => {
    const d = createTestD1();
    try {
      d.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','店');
        INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('a','店','channel','s','t','t');
        INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind) VALUES('gift','a','景品','tag');
        INSERT INTO mileage_reward_versions(id,reward_id,version_number,required_miles,status) VALUES('v','gift',1,10,'published');
        INSERT INTO mileage_redemptions(id,line_account_id,program_id,beneficiary_key,reward_id,reward_version_id,spend_ledger_entry_id,idempotency_key,request_fingerprint) VALUES('r','a','default','friend:x','gift','v','ledger','key','fingerprint');
        INSERT INTO mileage_handgift_rewards(reward_id) VALUES('gift');`);
      const app = (readOnly: boolean) => {
        const instance = new Hono<Env>();
        instance.use('*', async (c, next) => { c.env = { DB: d.db } as Env['Bindings']; c.set('staff', { id: 'owner', name: 'owner', role: 'owner', readOnly, tenantId: 't' }); await next(); });
        instance.route('/', mileageHandgift);
        return instance;
      };
      const request = () => new Request('http://local/api/mileage/redemptions/r/hand-delivery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'a' }) });
      expect((await app(true).fetch(request())).status).toBe(403);
      expect((await app(false).fetch(request())).status).toBe(200);
      expect((await app(false).fetch(request())).status).toBe(409);
    } finally { d.raw.close(); }
  });
});
