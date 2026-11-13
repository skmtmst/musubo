import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

vi.mock('../services/account-access.js', async (original) => ({
  ...(await original<Record<string, unknown>>()), canAccessAllLineAccounts: async () => true,
}));
const { nenCampaigns } = await import('./nen-campaigns.js');
const { processNenDeliveries } = await import('../services/nen-engagement.js');
let testDb: SqliteD1;
function app() {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner', role: 'owner', readOnly: false });
    c.env = { DB: testDb.db, WORKER_PUBLIC_URL: 'https://example.test' };
    await next();
  });
  app.route('/', nenCampaigns);
  return app;
}
function preview() { return app().request('/api/nen-campaigns/columns/column-1/send-preview?lineAccountId=account-a'); }
function deliver(body: unknown) { return app().request('/api/nen-campaigns/columns/column-1/deliver', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
beforeEach(() => {
  testDb = createTestD1();
  testDb.raw.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-a','ca','店舗','fake','fake')").run();
  testDb.raw.prepare("INSERT INTO nen_campaign_settings (campaign_key,label,category,title,body_text,is_enabled,created_at,updated_at) VALUES ('column','コラム','column','題','本文',1,'2026-01-01','2026-01-01')").run();
  testDb.raw.prepare("INSERT INTO nen_columns (id,slug,title,excerpt,intro_text,article_url,line_account_id,created_at,updated_at) VALUES ('column-1','column-1','題','抜粋','紹介','https://example.test/1','account-a','2026-01-01','2026-01-01')").run();
  for (const id of ['a','b']) testDb.raw.prepare('INSERT INTO friends (id,line_user_id,display_name,line_account_id,is_following,created_at,updated_at) VALUES (?,?,?,?,1,?,?)').run(id,`U-${id}`,id,'account-a','2026-01-01','2026-01-01');
});
afterEach(() => testDb.raw.close());

describe('コラム配信の確認', () => {
  it('確認窓に返した内容をそのまま送る', async () => {
    testDb.raw.prepare("DELETE FROM friends WHERE id='b'").run();
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string; messages: unknown[] } };
    expect(data.data.messages).toHaveLength(2);
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    const sent:unknown[]=[];
    await processNenDeliveries(testDb.db,{proxyBaseUrl:'https://proxy.invalid',defaultAccessToken:'fake',now:new Date('2030-01-01T03:00:00Z'),proxyDispatch:async(request:Request)=>{sent.push((await request.json() as {messages:unknown[]}).messages);return new Response('{}',{status:200});}});
    expect(sent).toEqual([data.data.messages]);
  });
  it('非表示の人は確認人数にも予約にも含めない', async () => {
    testDb.raw.prepare("UPDATE friends SET is_hidden=1 WHERE id='b'").run();
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect(data.data.recipientCount).toBe(1);
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    expect(testDb.raw.prepare('SELECT friend_id FROM nen_delivery_jobs').all()).toEqual([{friend_id:'a'}]);
  });
  it('予約後に非表示になった人へは送らない', async () => {
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    testDb.raw.prepare("UPDATE friends SET is_hidden=1 WHERE id='b'").run();
    const recipients:string[]=[];
    await processNenDeliveries(testDb.db,{proxyBaseUrl:'https://proxy.invalid',defaultAccessToken:'fake',now:new Date('2030-01-01T03:00:00Z'),proxyDispatch:async(request:Request)=>{recipients.push((await request.json() as {to:string}).to);return new Response('{}',{status:200});}});
    expect(recipients).toEqual(['U-a']);
  });
  it('配信停止中の人は確認人数にも予約にも含めない', async () => {
    testDb.raw.prepare("INSERT INTO friend_delivery_consents (line_account_id,friend_id,purpose,state,reason,source) VALUES ('account-a','b','marketing','revoked','希望','manual')").run();
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect(data.data.recipientCount).toBe(1);
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    expect(testDb.raw.prepare('SELECT friend_id FROM nen_delivery_jobs').all()).toEqual([{friend_id:'a'}]);
  });
  it('予約後に配信を止めた人へは送らない', async () => {
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    testDb.raw.prepare("INSERT INTO friend_delivery_consents (line_account_id,friend_id,purpose,state,reason,source) VALUES ('account-a','b','marketing','revoked','希望','manual')").run();
    const recipients:string[]=[];
    await processNenDeliveries(testDb.db,{proxyBaseUrl:'https://proxy.invalid',defaultAccessToken:'fake',now:new Date('2030-01-01T03:00:00Z'),proxyDispatch:async(request:Request)=>{recipients.push((await request.json() as {to:string}).to);return new Response('{}',{status:200});}});
    expect(recipients).toEqual(['U-a']);
    expect(testDb.raw.prepare("SELECT last_error FROM nen_delivery_jobs WHERE friend_id='b'").get()).toEqual({last_error:'friend_unavailable'});
  });
  it('確認の人数が一致しなければトークンが同じでも予約しない', async () => {
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    const response=await deliver({accountId:'account-a',...data.data,recipientCount:1});
    expect(response.status).toBe(409);expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
  });
  it.each([
    ["コラム", "UPDATE nen_columns SET intro_text='割り込み' WHERE id='column-1'"],
    ["配信設定", "UPDATE nen_campaign_settings SET button_label='割り込み' WHERE campaign_key='column'"],
  ])('送信待ちの書込み直前に%sが変われば予約しない', async (_label, sql) => {
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    const original=testDb.db.batch.bind(testDb.db);let changed=false;
    const spy=vi.spyOn(testDb.db,'batch').mockImplementation(async (statements)=>{
      if(!changed){changed=true;testDb.raw.prepare(sql).run();}return original(statements);
    });
    try {
      const response=await deliver({accountId:'account-a',...data.data});
      expect(changed).toBe(true);expect(response.status).toBe(409);
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
    } finally { spy.mockRestore(); }
  });
  it('直前に宛先が元へ戻った場合も確認した宛先へ送る', async () => {
    testDb.raw.prepare("DELETE FROM friends WHERE id='b'").run();
    const data=await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    testDb.raw.prepare("UPDATE friends SET line_user_id='U-new' WHERE id='a'").run();
    const original=testDb.db.prepare.bind(testDb.db);let restored=false;
    const spy=vi.spyOn(testDb.db,'prepare').mockImplementation((sql: string)=>{
      if (!restored && sql.includes('SELECT f.line_user_id,f.line_account_id')) { restored=true;testDb.raw.prepare("UPDATE friends SET line_user_id='U-a' WHERE id='a'").run(); }
      return original(sql);
    });
    const recipients:string[]=[];
    try { await processNenDeliveries(testDb.db,{proxyBaseUrl:'https://proxy.invalid',defaultAccessToken:'fake',now:new Date('2030-01-01T03:00:00Z'),proxyDispatch:async(request:Request)=>{recipients.push((await request.json() as {to:string}).to);return new Response('{}',{status:200});}}); } finally { spy.mockRestore(); }
    expect(restored).toBe(true);expect(recipients).toEqual(['U-a']);
  });
  it('確認後にコラムが消えたら409で止める', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    testDb.raw.prepare("DELETE FROM nen_columns WHERE id='column-1'").run();
    const response=await deliver({accountId:'account-a',...data.data});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({data:{recipientCount:null}});
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
  });
  it('確認後に配信が停止されたら現在人数を返す', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    testDb.raw.prepare("UPDATE nen_campaign_settings SET is_enabled=0 WHERE campaign_key='column'").run();
    const response=await deliver({accountId:'account-a',...data.data});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({data:{recipientCount:2}});
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
  });
  it('500人を超えても確認した全員を一度ずつ予約する', async () => {
    const insert=testDb.raw.prepare('INSERT INTO friends (id,line_user_id,line_account_id,is_following) VALUES (?,?,?,1)');
    for(let i=0;i<500;i++)insert.run(`extra-${i}`,`U-extra-${i}`,'account-a');
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect(data.data.recipientCount).toBe(502);
    const response=await deliver({accountId:'account-a',...data.data});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({data:{queued:502}});
    expect(testDb.raw.prepare('SELECT COUNT(DISTINCT friend_id) AS n FROM nen_delivery_jobs').get()).toEqual({n:502});
  });
  it('同じ確認の同時実行は片方だけ予約する', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    const responses=await Promise.all([deliver({accountId:'account-a',...data.data}),deliver({accountId:'account-a',...data.data})]);
    expect(responses.map((response)=>response.status).sort()).toEqual([200,409]);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:2});
  });
  it('確認後に人数が増えたら新しい人数を返す', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    testDb.raw.prepare("INSERT INTO friends (id,line_user_id,line_account_id,is_following) VALUES ('c','U-c','account-a',1)").run();
    const response=await deliver({accountId:'account-a',...data.data});
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({data:{recipientCount:3}});
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
  });
  it('確認後に配信設定が変われば予約しない', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    testDb.raw.prepare("UPDATE nen_campaign_settings SET button_label='変更' WHERE campaign_key='column'").run();
    const response=await deliver({accountId:'account-a',...data.data});
    expect(response.status).toBe(409);expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
  });
  it('復旧前後の処理が重なっても同じ宛先へ二重送信しない', async () => {
    testDb.raw.prepare("DELETE FROM friends WHERE id='b'").run();
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect((await deliver({accountId:'account-a',...data.data})).status).toBe(200);
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>((resolve)=>{entered=resolve}),wait=new Promise<void>((resolve)=>{release=resolve});
    const keys:string[]=[];const accepted=new Set<string>();let delivered=0;
    const proxyDispatch=async(request:Request)=>{
      const key=request.headers.get('X-Line-Retry-Key')!;keys.push(key);
      if(accepted.has(key))return new Response(null,{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
      accepted.add(key);delivered++;if(keys.length===1){entered();await wait;}return new Response('{}',{status:200});
    };
    const options={proxyBaseUrl:'https://proxy.invalid',defaultAccessToken:'fake',now:new Date('2030-01-01T03:00:00Z'),proxyDispatch};
    const old=processNenDeliveries(testDb.db,options);await started;
    testDb.raw.prepare("UPDATE nen_delivery_jobs SET updated_at='2020-01-01T00:00:00Z' WHERE friend_id='a'").run();
    try { await processNenDeliveries(testDb.db,options); } finally { release();await old; }
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(delivered).toBe(1);
  });
  it('予約後にLINE宛先が変わった人には送らない', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    expect((await deliver({ accountId: 'account-a', ...data.data })).status).toBe(200);
    testDb.raw.prepare("UPDATE friends SET line_user_id='U-new' WHERE id='a'").run();
    const recipients: string[]=[];
    await processNenDeliveries(testDb.db, { proxyBaseUrl: 'https://proxy.invalid', defaultAccessToken: 'fake', now: new Date('2030-01-01T03:00:00Z'), proxyDispatch: async (request: Request) => { recipients.push((await request.json() as {to:string}).to); return new Response('{}', {status:200}); } });
    expect(recipients).toEqual(['U-b']);
    expect(testDb.raw.prepare("SELECT status,last_error FROM nen_delivery_jobs WHERE friend_id='a'").get()).toEqual({status:'skipped',last_error:'recipient_changed'});
    const job=testDb.raw.prepare("SELECT id FROM nen_delivery_jobs WHERE friend_id='a'").get() as {id:string};
    const detail=await app().request(`/api/nen-campaigns/deliveries/${job.id}?lineAccountId=account-a`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({data:{unmetReasonCode:'recipient_changed',unmetReason:'確認したLINE宛先が変わったため送りません'}});
  });
  it('確認した対象へだけ予約し、次の確認では予約済みを数えない', async () => {
    const before = await preview();
    const data = await before.json() as { data: { recipientCount: number; confirmationToken: string } };
    const response = await deliver({ accountId: 'account-a', ...data.data });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { queued: 2 } });
    const rows = testDb.raw.prepare("SELECT friend_id,payload FROM nen_delivery_jobs ORDER BY friend_id").all() as Array<{ friend_id: string; payload: string }>;
    expect(rows.map((row) => [row.friend_id, JSON.parse(row.payload).expectedLineUserId])).toEqual([['a','U-a'],['b','U-b']]);
    const next = await preview();
    expect(await next.json()).toMatchObject({ data: { recipientCount: 0 } });
  });
  it('確認後に本文が変われば新しい人数を返し予約しない', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    testDb.raw.prepare("UPDATE nen_columns SET intro_text='変更' WHERE id='column-1'").run();
    const response = await deliver({ accountId: 'account-a', ...data.data });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'COLUMN_CONFIRMATION_CHANGED', data: { recipientCount: 2 } });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({ n: 0 });
  });
  it('確認の照合後、書込み前に宛先が変わっても全件を取り消す', async () => {
    const data = await (await preview()).json() as { data: { recipientCount: number; confirmationToken: string } };
    const original=testDb.db.batch.bind(testDb.db);let changed=false;
    const spy=vi.spyOn(testDb.db,'batch').mockImplementation(async (statements) => {
      if(!changed){changed=true;testDb.raw.prepare("UPDATE friends SET line_user_id='U-new' WHERE id='a'").run();}
      return original(statements);
    });
    try {
      const response=await deliver({accountId:'account-a',...data.data});
      expect(changed).toBe(true);expect(response.status).toBe(409);
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({n:0});
    } finally { spy.mockRestore(); }
  });
  it('確認情報のない従来の呼び出しは受け付ける', async () => {
    const response=await deliver({accountId:'account-a'});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({data:{queued:2}});
  });
  it('確認した後で宛先が同じ人数のまま入れ替われば送信待ちを作らない', async () => {
    const before = await preview();
    expect(before.status).toBe(200);
    const data = await before.json() as { data: { recipientCount: number; confirmationToken: string } };
    expect(data.data.recipientCount).toBe(2);
    testDb.raw.prepare("UPDATE friends SET line_user_id='U-different' WHERE id='b'").run();
    const response = await deliver({ accountId: 'account-a', ...data.data });
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM nen_delivery_jobs').get()).toEqual({ n: 0 });
  });
});
