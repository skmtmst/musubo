import { signedLiffState } from '../test-utils/liff-oauth.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import { tenantPublicBoundaryMiddleware } from '../middleware/tenant-public-boundary.js';
import { liffRoutes } from './liff.js';

let db: ReturnType<typeof createTestD1>;
let push = vi.fn<(body: { to: string; messages: Array<{ type: string }> }, auth: string | null) => void>();
let identity = 'user-a';
let tokenValid = true;
function send(body: Record<string, unknown>) {
  const app = new Hono<Env>();
  app.use('/api/liff/*', tenantPublicBoundaryMiddleware);
  app.route('/', liffRoutes);
  return app.request('https://api.fixture.test/api/liff/send-form-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, { DB: db.db, LINE_LOGIN_CHANNEL_ID: 'channel-a', LINE_CHANNEL_ACCESS_TOKEN: 'unused' } as Env['Bindings']);
}
const valid = { lineUserId: 'user-a', formId: 'form-fixture', idToken: 'fixture-token' };
beforeEach(() => {
  db = createTestD1({ foreignKeys: false }); identity = 'user-a'; tokenValid = true; push = vi.fn();
  db.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id,login_channel_id)
    VALUES ('account-a','bot-a','Fixture A','fixture-token-a','unused','liff-a','channel-a'),
           ('account-b','bot-b','Fixture B','fixture-token-b','unused','liff-b','channel-b');
    INSERT INTO friends(id,line_user_id,display_name,line_account_id)
    VALUES ('friend-a','user-a','Fixture A','account-a'),('friend-b','user-b','Fixture B','account-b');`);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://api.line.me/oauth2/v2.1/token') return Response.json({ access_token: 'fixture-access', id_token: 'fixture-token' });
    if (url === 'https://api.line.me/v2/profile') return Response.json({ userId: identity, displayName: 'Fixture' });
    if (url === 'https://api.line.me/oauth2/v2.1/verify') {
      const channel = new URLSearchParams(init?.body as string).get('client_id');
      return channel === 'channel-a' && tokenValid
        ? new Response(JSON.stringify({ sub: identity }), { status: 200 }) : new Response('{}', { status: 400 });
    }
    if (url === 'https://api.line.me/v2/bot/message/push') {
      push(JSON.parse(init?.body as string), new Headers(init?.headers).get('Authorization'));
      return new Response('{}', { status: 200 });
    }
    throw new Error('Unexpected external call in mocked test');
  }));
});
afterEach(() => { db.raw.close(); vi.unstubAllGlobals(); });

describe('Q03 form send keeps identity and account validation before the narrowed payload', () => {
  it('sends the correct account message only to its verified friend', async () => {
    expect((await send(valid)).status).toBe(200);
    expect(push).toHaveBeenCalledTimes(1);
    const [body, auth] = push.mock.calls[0];
    expect(body.to).toBe('user-a');
    expect(body.messages[0].type).toBe('flex');
    expect(JSON.stringify(body)).toContain('liff-a');
    expect(auth).toBe('Bearer fixture-token-a');
  });
  it.each([
    [{ ...valid, idToken: undefined }, 401],
    [{ ...valid, lineUserId: 42 }, 400],
    [{ ...valid, formId: {} }, 400],
    [{ ...valid, lineUserId: 'user-b' }, 403],
  ] as const)('rejects missing/invalid input or another identity %# without sending', async (body, status) => {
    expect((await send(body)).status).toBe(status);
    expect(push).not.toHaveBeenCalled();
  });
  it('rejects a token for another channel without sending', async () => {
    tokenValid = false;
    expect((await send(valid)).status).toBe(401);
    expect(push).not.toHaveBeenCalled();
  });
  it('cannot borrow a friend from another account even for a verified matching subject', async () => {
    identity = 'user-b';
    expect((await send({ ...valid, lineUserId: 'user-b' })).status).toBe(404);
    expect(push).not.toHaveBeenCalled();
  });
});


describe('form intro referral ownership', () => {
  function seedLink(account: string | null, active = 1) {
    db.raw.prepare(`INSERT INTO message_templates(id,name,message_type,message_content) VALUES('intro','Intro','text','Campaign hello {formUrl}')`).run();
    db.raw.prepare(`INSERT INTO tracked_links(id,name,original_url,line_account_id,is_active,intro_template_id)
      VALUES('ref-link','Ref','https://example.test',?,?, 'intro')`).run(account, active);
  }
  function firstLink() { return db.raw.prepare("SELECT first_tracked_link_id FROM friends WHERE id='friend-a'").get(); }
  it('フォーム案内は未解決の共通情報を送らず、登録後の値を送る', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));useSqliteClock(db.raw,()=>new Date());
    try {
      seedLink('account-a');
      db.raw.prepare("UPDATE message_templates SET message_content='営業時間: {{var.hours}} {formUrl}' WHERE id='intro'").run();
      const oauth = async () => {
        const signed = await signedLiffState('fixture-signing-key', { account: 'bot-a', form: 'form-fixture', ref: 'ref-link' });
        return liffRoutes.request(`https://api.fixture.test/auth/callback?code=fixture&state=${encodeURIComponent(signed.state)}`,
          { headers: { Cookie: signed.cookie } }, { DB: db.db, LINE_CHANNEL_SECRET: 'fixture-signing-key', LINE_LOGIN_CHANNEL_ID: 'channel-a',
            LINE_LOGIN_CHANNEL_SECRET: 'fixture-login', LINE_CHANNEL_ACCESS_TOKEN: 'unused' } as Env['Bindings']);
      };
      await send({...valid,ref:'ref-link'});
      expect(push).not.toHaveBeenCalled();
      expect(db.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
      db.raw.prepare('DELETE FROM common_var_resolution_failures').run();
      await oauth();
      expect(push).not.toHaveBeenCalled();
      expect(db.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
      db.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES('hours','account-a','営業時間','hours','text','10時')").run();
      expect((await send({...valid,ref:'ref-link'})).status).toBe(200);
      await oauth();expect(push).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(push.mock.calls)).toContain('営業時間: 10時');
    } finally {vi.useRealTimers();}
  });
  it('pins an active same-account ref and sends the normal campaign intro', async () => {
    seedLink('account-a');
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: 'ref-link' });
    expect(JSON.stringify(push.mock.calls[0][0])).toContain('Campaign hello');
  });
  it.each([['account-b',1], ['account-a',0]] as const)('ignores foreign/inactive ref %s/%i while preserving generic form guidance', async (account, active) => {
    seedLink(account, active);
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: null });
    const message = JSON.stringify(push.mock.calls[0][0]);
    expect(message).not.toContain('Campaign hello');
    expect(message).not.toContain('ref-link');
    expect(message).toContain('form-fixture');
  });
  it.each(['account-a', 'account-b'])('resolves scenario ownership before accepting a legacy direct owner: %s', async account => {
    seedLink(null);
    db.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,line_account_id)VALUES('scenario','Campaign','manual',?)").run(account);
    db.raw.exec("UPDATE tracked_links SET scenario_id='scenario' WHERE id='ref-link'");
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: account === 'account-a' ? 'ref-link' : null });
    expect(JSON.stringify(push.mock.calls[0][0]).includes('Campaign hello')).toBe(account === 'account-a');
  });
  it('uses the verified default account for a NULL friend campaign intro and delivery', async () => {
    seedLink('account-a');
    db.raw.exec("UPDATE friends SET line_account_id=NULL WHERE id='friend-a'");
    expect((await send({...valid,ref:'ref-link'})).status).toBe(200);
    expect(firstLink()).toEqual({first_tracked_link_id:'ref-link'});
    expect(JSON.stringify(push.mock.calls[0][0])).toContain('Campaign hello');
    expect(JSON.stringify(push.mock.calls[0][0])).toContain('liff-a');
    expect(push.mock.calls[0][1]).toBe('Bearer fixture-token-a');
  });
  it('does not borrow a NULL friend for a nondefault tenant', async () => {
    seedLink('account-a');
    db.raw.exec("INSERT INTO tenants(id,name)VALUES('other','Other'); UPDATE line_accounts SET tenant_id='other' WHERE id='account-a'; UPDATE friends SET line_account_id=NULL WHERE id='friend-a'");
    expect((await send({...valid,ref:'ref-link'})).status).toBe(404);
    expect(firstLink()).toEqual({first_tracked_link_id:null});
    expect(push).not.toHaveBeenCalled();
  });
  it('keeps a stopped entry route suppressed even when its ref matches an active tracked link', async () => {
    seedLink('account-a');
    db.raw.exec("INSERT INTO entry_routes(id,ref_code,name,is_active)VALUES('stopped','ref-link','Stopped',0)");
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: null });
    expect(JSON.stringify(push.mock.calls[0][0])).not.toContain('Campaign hello');
    expect(JSON.stringify(push.mock.calls[0][0])).not.toContain('ref-link');
  });
  it.each([['account-a',1,true,false], ['account-b',1,false,false], ['account-a',0,false,false], [null,1,true,false], ['account-a',1,true,true]] as const)
    ('applies the same referral boundary in OAuth form delivery: %s/%i', async (account, active, allowed, nullFriend) => {
      seedLink(account, active);
      if (nullFriend) db.raw.exec("UPDATE friends SET line_account_id=NULL WHERE id='friend-a'");
      const signed = await signedLiffState('fixture-signing-key', { account: 'bot-a', form: 'form-fixture', ref: 'ref-link' });
      const response = await liffRoutes.request(`https://api.fixture.test/auth/callback?code=fixture&state=${encodeURIComponent(signed.state)}`,
        { headers: { Cookie: signed.cookie } }, { DB: db.db, LINE_CHANNEL_SECRET: 'fixture-signing-key',
          LINE_LOGIN_CHANNEL_ID: 'channel-a', LINE_LOGIN_CHANNEL_SECRET: 'fixture-login', LINE_CHANNEL_ACCESS_TOKEN: 'unused' } as Env['Bindings']);
      expect(response.status).toBe(200);
      expect(push).toHaveBeenCalledTimes(1);
      expect(firstLink()).toEqual({ first_tracked_link_id: allowed ? 'ref-link' : null });
      const message = JSON.stringify(push.mock.calls[0][0]);
      expect(message.includes('Campaign hello')).toBe(allowed);
      expect(message.includes('ref-link')).toBe(allowed);
      expect(message).toContain('form-fixture');
    });
  it('accepts legacy null owner only for the default tenant', async () => {
    seedLink(null);
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: 'ref-link' });
    db.raw.exec("UPDATE friends SET first_tracked_link_id=NULL; UPDATE line_accounts SET tenant_id='foreign-tenant' WHERE id='account-a'; INSERT INTO tenants(id,name)VALUES('foreign-tenant','Other')");
    push.mockClear();
    expect((await send({ ...valid, ref: 'ref-link' })).status).toBe(200);
    expect(firstLink()).toEqual({ first_tracked_link_id: null });
    expect(JSON.stringify(push.mock.calls[0][0])).not.toContain('Campaign hello');
  });
});
