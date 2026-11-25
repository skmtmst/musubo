import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { issueSession } from './admin-session.js';
import { sha256Hex } from '../middleware/auth.js';
const mail=vi.hoisted(()=>vi.fn(async()=>{}));vi.mock('./plain-mail.js',()=>({sendPlainMail:mail}));
let db:ReturnType<typeof createTestD1>;let deviceCookie='';
beforeEach(()=>{db=createTestD1();db.raw.exec("INSERT INTO staff_members(id,name,email,role,api_key) VALUES ('actor','Fixture','fixture@example.invalid','owner','unused-fixture')");mail.mockClear();deviceCookie='';});
afterEach(()=>db.raw.close());
function app(){const a=new Hono<Env>();a.post('/issue',async c=>c.json(await issueSession(c,'actor','Lax')));return a;}
const login=async(ua:string,environment='staging',newDevice=false)=>{
  const res=await app().request('/issue',{method:'POST',headers:{'user-agent':ua,'cf-connecting-ip':'203.0.113.1',...!newDevice&&deviceCookie?{Cookie:deviceCookie}:{}}},{DB:db.db,DEPLOY_ENV:environment} as Env['Bindings']);
  deviceCookie=res.headers.get('set-cookie')?.match(/lh_login_device=[A-Za-z0-9_-]+/)?.[0]??'';return res;
};
describe('new device detection survives logout without sending real staging mail',()=>{
  it('remembers first device, recognizes browser upgrades, and notices a new device after all sessions were revoked',async()=>{
    expect((await login('Macintosh Chrome/121.0')).status).toBe(200);expect(mail).not.toHaveBeenCalled();
    db.raw.exec('DELETE FROM admin_sessions');
    expect((await login('Macintosh Chrome/122.0')).status).toBe(200);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='auth.login_unfamiliar'").get()).toEqual({n:0});
    db.raw.exec('DELETE FROM admin_sessions');
    expect((await login('Android Firefox/125.0','staging',true)).status).toBe(200);expect(mail).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='auth.login_notice.simulated'").get()).toEqual({n:1});
    expect(db.raw.prepare("SELECT unfamiliar_at FROM admin_sessions").get()).toEqual({unfamiliar_at:expect.any(String)});
    expect(db.raw.prepare('SELECT COUNT(*) n FROM auth_known_devices').get()).toEqual({n:2});
  });
  it('production invokes the existing mail transport once for an unknown device',async()=>{
    await login('Macintosh Chrome/121.0');db.raw.exec('DELETE FROM admin_sessions');await login('Android Firefox/125.0','production',true);expect(mail).toHaveBeenCalledOnce();
  });
});

it('two browsers with identical user agents are distinct devices and only hashed markers enter the database',async()=>{
 await login('Macintosh Chrome/125.0');const first=deviceCookie;db.raw.exec('DELETE FROM admin_sessions');
 await login('Macintosh Chrome/125.0','staging',true);expect(deviceCookie).not.toBe(first);
 expect(db.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='auth.login_notice.simulated'").get()).toEqual({n:1});
 const rows=JSON.stringify(db.raw.prepare('SELECT * FROM auth_known_devices').all());expect(rows).not.toContain(first.slice('lh_login_device='.length));expect(rows).not.toContain('Macintosh');
});

it('確認済みの端末と接続元の組は、古い端末記録がなくても次のログインで信頼する', async () => {
  await login('Macintosh Chrome/125.0');
  const marker = deviceCookie.slice('lh_login_device='.length);
  db.raw.exec("DELETE FROM admin_sessions; DELETE FROM auth_known_devices; INSERT INTO auth_known_devices VALUES ('actor', 'different-device', '2026-01-01', '2026-01-01')");
  db.raw.prepare('INSERT INTO auth_trusted_logins (staff_id, marker_hash, ip_prefix, confirmed_at) VALUES (?, ?, ?, ?)').run('actor', await sha256Hex(`login-device:${marker}`), '203.0.*.*', new Date().toISOString());
  await login('Macintosh Chrome/125.0');
  expect(db.raw.prepare('SELECT unfamiliar_at FROM admin_sessions').get()).toEqual({ unfamiliar_at: null });
});
