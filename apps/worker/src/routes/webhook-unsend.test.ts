import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { getLineRegistrationReceipt } from '../services/line-registration-receipt.js';

const lineClient = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  replyMessageWithRequestId: vi.fn(),
  pushMessage: vi.fn(),
}));
const autoReply = vi.hoisted(() => vi.fn().mockResolvedValue({
  matched: false,
  replyTokenConsumed: false,
}));
const fire=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
const mileage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: actual.verifySignature,
    LineClient: vi.fn().mockImplementation(function () { return lineClient; }),
  };
});
vi.mock('../features/auto-replies/auto-reply.js', () => ({ matchAndReply: autoReply }));
vi.mock('../services/activity-mileage.js', () => ({ awardActivityMileage: mileage }));
vi.mock('../services/event-bus.js', () => ({
  fireEvent: fire,
  processScoring: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

const { webhook } = await import('./webhook.js');
const { chats } = await import('./chats.js');
const {lineWebhookEvents}=await import('./line-webhook-events.js');
const { processDueLineWebhookRetries } = await import('../services/line-webhook-recovery.js');

const owner: AuthenticatedStaff = {
  id: 'owner-1',
  name: 'オーナー',
  role: 'owner',
  readOnly: false,
  tenantId: 'tenant-1',
};

function seed(db: SqliteD1): void {
  db.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')").run();
  db.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES
      ('account-a', 'channel-a', '店舗A', 'token-a', 'secret-a', 1, 'tenant-1'),
      ('account-b', 'channel-b', '店舗B', 'token-b', 'secret-b', 1, 'tenant-1')
  `).run();
  insertFriend(db.raw, 'friend-a', { line_user_id: 'U-a', line_account_id: 'account-a' });
  insertFriend(db.raw, 'friend-b', { line_user_id: 'U-b', line_account_id: 'account-b' });
}

function webhookApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.route('/', webhook);
  return app;
}

function chatsApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', owner);
    await next();
  });
  app.route('/', chats);
  return app;
}

function recoveryApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', owner); await next(); });
  app.route('/', lineWebhookEvents);
  return app;
}

async function retry(db: SqliteD1, id: string) {
  return recoveryApp().request(`/api/line-webhook-events/${id}/retry`, { method: 'POST' }, { DB: db.db } as Env['Bindings']);
}

async function postEvent(
  db: SqliteD1,
  account: 'a' | 'b',
  event: Record<string, unknown>,
  expectScheduled = true,
): Promise<void> {
  const waitUntil = vi.fn();
  const body = JSON.stringify({ destination: `destination-${account}`, events: [event] });
  const response = await webhookApp().request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': createHmac('sha256', `secret-${account}`).update(body).digest('base64') },
    body,
  }, {
    DB: db.db,
    LINE_CHANNEL_SECRET: `secret-${account}`,
    LINE_CHANNEL_ACCESS_TOKEN: `token-${account}`,
  } as Env['Bindings'], {
    waitUntil,
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  if (expectScheduled) {
    await expect(waitUntil.mock.calls[0]?.[0] as Promise<void>).resolves.toBeUndefined();
  } else {
    expect(waitUntil).not.toHaveBeenCalled();
  }
}

const base = (account: 'a' | 'b', eventId: string, timestamp: number) => ({
  timestamp,
  source: { type: 'user', userId: `U-${account}` },
  webhookEventId: eventId,
  deliveryContext: { isRedelivery: false },
  mode: 'active',
});

async function postText(
  db: SqliteD1,
  account: 'a' | 'b',
  eventId: string,
  messageId: string,
  text: string,
  timestamp: number,
): Promise<void> {
  await postEvent(db, account, {
    ...base(account, eventId, timestamp),
    type: 'message',
    replyToken: `reply-${eventId}`,
    message: { type: 'text', id: messageId, text },
  });
}

async function postUnsend(
  db: SqliteD1,
  account: 'a' | 'b',
  eventId: string,
  messageId: string,
  timestamp: number,
  expectScheduled = true,
): Promise<void> {
  await postEvent(db, account, {
    ...base(account, eventId, timestamp),
    type: 'unsend',
    unsend: { messageId },
  }, expectScheduled);
}

describe('N-024 LINE送信取消', () => {
  let db: SqliteD1;

  beforeEach(() => {
    db = createTestD1();
    seed(db);
    autoReply.mockClear();
    mileage.mockClear();
    fire.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.raw.close();
    vi.clearAllMocks();
  });

  it('同じLINE利用者から店舗別に受信し、それぞれのアカウントの登録を確認できる', async () => {
    expect(await getLineRegistrationReceipt(db.db, 'account-b')).toMatchObject({ status: 'waiting' });
    await postText(db, 'a', 'shared-a', 'message-a', '接続テスト', Date.now());
    await postEvent(db, 'b', {
      ...base('a', 'shared-b', Date.now()),
      type: 'message',
      replyToken: 'fixture-b',
      message: { type: 'text', id: 'message-b', text: '接続テスト' },
    });

    const messages = db.raw.prepare(`SELECT m.line_account_id, m.friend_id, f.line_platform_user_id
      FROM messages_log m JOIN friends f ON f.id = m.friend_id AND f.line_account_id = m.line_account_id
      WHERE m.direction = 'incoming' ORDER BY m.line_account_id`).all() as Array<{
      line_account_id: string; friend_id: string; line_platform_user_id: string;
    }>;
    expect(messages).toEqual([
      { line_account_id: 'account-a', friend_id: 'friend-a', line_platform_user_id: 'U-a' },
      { line_account_id: 'account-b', friend_id: expect.any(String), line_platform_user_id: 'U-a' },
    ]);
    expect(messages[1]?.friend_id).not.toBe('friend-a');
    expect(await getLineRegistrationReceipt(db.db, 'account-a')).toMatchObject({ status: 'confirmed' });
    expect(await getLineRegistrationReceipt(db.db, 'account-b')).toMatchObject({ status: 'confirmed' });
  });

  it('IN-C02: 200応答後の失敗は受信箱から未完のマイルだけ再開して200になる',async()=>{
    mileage.mockRejectedValueOnce(new Error('fixture interruption after acknowledgement'));
    await postText(db,'a','missing-payload','missing-payload-message','人工の本文',1_800_000_000_000);
    const recovery=new Hono<Env>();recovery.use('*',async(c,next)=>{c.set('staff',owner);await next()});recovery.route('/',lineWebhookEvents);
    const response=await recovery.request('/api/line-webhook-events/missing-payload/retry',{method:'POST'},{DB:db.db} as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({success:true,status:'succeeded'});
    expect(mileage).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare("SELECT status FROM line_webhook_events WHERE webhook_event_id='missing-payload'").get()).toEqual({status:'succeeded'});
    const checkpoints=JSON.stringify(db.raw.prepare("SELECT input_json FROM workflow_steps WHERE subject_id='missing-payload' AND step_key='__run'").all());
    expect(checkpoints).not.toContain('人工の本文');
    expect(checkpoints).not.toContain('reply-missing-payload');
    await retry(db, 'missing-payload');
    expect(mileage).toHaveBeenCalledTimes(2);
    expect(autoReply).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('IN-C02: 返信が必要な受信もマイルは回復し、返信の鍵なしは理由つき要確認になる', async () => {
    db.raw.exec("INSERT INTO auto_replies(id,name,keyword,match_type,response_type,response_content,line_account_id) VALUES('reply','人工','人工','contains','text','偽の返信','account-a')");
    mileage.mockRejectedValueOnce(new Error('fixture'));
    await postText(db,'a','needs-reply','needs-reply-message','人工の本文',1_800_000_000_000);
    const response = await retry(db,'needs-reply');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({status:'needs_review',reasonCode:'reply_input_unavailable',error:expect.stringContaining('要確認')});
    expect(mileage).toHaveBeenCalledTimes(2);
    expect(autoReply).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    const list = await recoveryApp().request('/api/line-webhook-events?status=failed', {}, {DB:db.db} as Env['Bindings']);
    const view = await list.json() as {data:Array<Record<string,unknown>>};
    expect(view.data[0]).toMatchObject({recoveryLabel:'要確認',recoveryReasonCode:'reply_input_unavailable'});
    expect(JSON.stringify(view)).not.toContain('人工の本文');
    await retry(db,'needs-reply');
    await processDueLineWebhookRetries({DB:db.db} as Env['Bindings']);
    expect(mileage).toHaveBeenCalledTimes(2);
  });

  it('IN-C02: 自動応答済みで後続が落ちた時は応答とマイルを重ねず自動化だけ再開する', async () => {
    fire.mockRejectedValueOnce(new Error('fixture late failure'));
    await postText(db,'a','late-retry','late-retry-message','人工の本文',1_800_000_000_000);
    const response = await retry(db,'late-retry');
    expect(response.status).toBe(200);
    expect(mileage).toHaveBeenCalledOnce();
    expect(autoReply).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledTimes(2);
    await processDueLineWebhookRetries({DB:db.db} as Env['Bindings']);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('IN-C02: 保存SQLだけ確定した中断も本文を作り直さずマイルまで回復する', async () => {
    const batch=db.db.batch.bind(db.db);let interrupted=false;
    db.db.batch=async<T=unknown>(statements:D1PreparedStatement[])=>{
      const result=await batch<T>(statements);
      if(!interrupted && statements.some(s=>/INSERT OR IGNORE INTO messages_log/.test((s as unknown as {sql:string}).sql))){interrupted=true;throw new Error('sqlite fixture committed');}
      return result;
    };
    await postText(db,'a','sql-only','sql-only-msg','人工の本文',1_800_000_000_000);
    const response=await retry(db,'sql-only');
    // 受信箱への保存は確定し、返信方針には未到達なので、マイルだけが安全に実行できる。
    expect(await response.json()).toMatchObject({status:'needs_review',reasonCode:'reply_input_unavailable'});
    expect(mileage).toHaveBeenCalledOnce();
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({n:1});
  });

  it.each(['text','sticker'])('IN-C02: %s の内部回収と管理者retryが競合しても未完工程は1回だけ', async (kind) => {
    mileage.mockRejectedValueOnce(new Error('fixture'));
    await postEvent(db,'a',{...base('a',`sweep-${kind}`,1_800_000_000_000),type:'message',replyToken:'fake',
      message:kind==='text'?{id:`sweep-msg-${kind}`,type:'text',text:'人工の本文'}:{id:`sweep-msg-${kind}`,type:'sticker',stickerId:'1',packageId:'1'}});
    await Promise.all([processDueLineWebhookRetries({DB:db.db} as Env['Bindings']),retry(db,`sweep-${kind}`)]);
    expect(mileage).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare('SELECT status FROM line_webhook_events WHERE webhook_event_id=?').get(`sweep-${kind}`)).toEqual({status:'succeeded'});
  });

  it.each(['unsend','delete','move'])('IN-C02: 取消・削除・別アカウントへの移動（%s）後は再開しない', async (change) => {
    mileage.mockRejectedValueOnce(new Error('fixture'));
    await postText(db,'a','removed','removed-message','人工の本文',1_800_000_000_000);
    if(change==='unsend') await postUnsend(db,'a','remove-unsend','removed-message',1_800_000_000_100);
    else if(change==='delete') db.raw.exec("DELETE FROM friends WHERE id='friend-a'");
    else db.raw.exec("UPDATE friends SET line_account_id='account-b' WHERE id='friend-a'");
    const response=await retry(db,'removed');
    expect(await response.json()).toMatchObject({status:'needs_review',reasonCode:'source_removed'});
    expect(mileage).toHaveBeenCalledOnce();
  });

  it('IN-C02: unfollowの状態保存後の失敗も状態を二度変えず残りを回復する', async () => {
    fire.mockRejectedValueOnce(new Error('fixture'));
    await postEvent(db,'a',{...base('a','unfollow-retry',1_800_000_000_000),type:'unfollow'});
    expect((await retry(db,'unfollow-retry')).status).toBe(200);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare("SELECT unfollow_count FROM friends WHERE id='friend-a'").get()).toEqual({unfollow_count:1});
  });

  it('IN-C02: followのマイルは回復し、入力の足りない配信と振り分けは要確認に止める', async () => {
    mileage.mockRejectedValueOnce(new Error('fixture'));
    await postEvent(db,'a',{...base('a','follow-retry',1_800_000_000_000),type:'follow',replyToken:'fake'});
    expect(await (await retry(db,'follow-retry')).json()).toMatchObject({status:'needs_review',reasonCode:'follow_routing_unavailable'});
    await processDueLineWebhookRetries({DB:db.db} as Env['Bindings']);
    expect(mileage).toHaveBeenCalledTimes(2);
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
  });

  it('IN-C02: 停止した契約は管理者retryと内部回収のどちらも副作用を再開しない', async () => {
    mileage.mockRejectedValueOnce(new Error('fixture'));
    await postText(db,'a','stopped-retry','stopped-retry-msg','人工の本文',1_800_000_000_000);
    db.raw.exec("UPDATE tenants SET status='suspended' WHERE id='tenant-1'");
    expect(await (await retry(db,'stopped-retry')).json()).toMatchObject({status:'needs_review',reasonCode:'account_inactive'});
    await processDueLineWebhookRetries({DB:db.db} as Env['Bindings']);
    expect(mileage).toHaveBeenCalledOnce();
  });

  it('IN-C02: 保存した通常postbackは自動化だけ再開して200になる', async () => {
    fire.mockRejectedValueOnce(new Error('fixture'));
    await postEvent(db,'a',{...base('a','postback-retry',1_800_000_000_000),type:'postback',postback:{data:'人工ボタン'},replyToken:'fake'});
    const response=await retry(db,'postback-retry');
    expect(await response.json()).toMatchObject({status:'succeeded'});
    expect(response.status).toBe(200);
    await processDueLineWebhookRetries({DB:db.db} as Env['Bindings']);
    expect(fire).toHaveBeenCalledTimes(2);
    expect(autoReply).toHaveBeenCalledOnce();
  });

  it('IN-C02: 通常postbackの履歴SQL確定後に止まっても二重保存せず完了する', async () => {
    const batch=db.db.batch.bind(db.db);let interrupted=false;
    db.db.batch=async<T=unknown>(statements:D1PreparedStatement[])=>{
      const result=await batch<T>(statements);
      if(!interrupted && statements.some(s=>/INSERT INTO messages_log/.test((s as unknown as {sql:string}).sql))){interrupted=true;throw new Error('sqlite postback committed fixture');}
      return result;
    };
    await postEvent(db,'a',{...base('a','postback-sql',1_800_000_000_000),type:'postback',postback:{data:'人工ボタン'},replyToken:'fake'});
    expect(await (await retry(db,'postback-sql')).json()).toMatchObject({status:'succeeded'});
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({n:1});
    expect(fire).toHaveBeenCalledOnce();
    expect(autoReply).toHaveBeenCalledOnce();
  });

  it('IN-C01: 停止した統括の初回追加も出来事時刻を保持する',async()=>{
    db.raw.exec("UPDATE tenants SET status='suspended' WHERE id='tenant-1'; DELETE FROM friends WHERE id='friend-a'");
    lineClient.getProfile.mockResolvedValue({displayName:'人工ユーザー'});
    await postEvent(db,'a',{...base('a','stopped-follow',1_700_000_002_000),type:'follow',replyToken:'fake'});
    await postEvent(db,'a',{...base('a','stopped-new-unfollow',1_700_000_003_000),type:'unfollow'});
    expect(db.raw.prepare("SELECT is_following,last_followed_at FROM friends WHERE line_account_id='account-a' AND line_platform_user_id='U-a'").get()).toEqual({is_following:0,last_followed_at:'2023-11-15T07:13:22.000+09:00'});
  });

  it.each(['2026-10-11T10:00:00.000','2026-10-11T10:00:00.000+09:00','2026-10-11T01:00:00.000Z'])('IN-C01: 旧形式の時刻 %s も日本時間で比較する',async(stamp)=>{
    db.raw.prepare("UPDATE friends SET last_followed_at=?,last_unfollowed_at=NULL WHERE id='friend-a'").run(stamp);
    await postEvent(db,'a',{...base('a','legacy-clock',Date.parse('2026-10-11T10:01:00+09:00')),type:'unfollow'});
    expect(db.raw.prepare("SELECT is_following FROM friends WHERE id='friend-a'").get()).toEqual({is_following:0});
  });

  it('IN-C01: 初回メッセージで登録した人の後続解除も出来事時刻で判定する',async()=>{
    db.raw.exec("DELETE FROM friends WHERE id='friend-a'");lineClient.getProfile.mockResolvedValue({displayName:'人工ユーザー'});
    await postText(db,'a','first-message','first-message-id','人工の本文',1_700_000_002_000);
    await postEvent(db,'a',{...base('a','first-message-unfollow',1_700_000_003_000),type:'unfollow'});
    expect(db.raw.prepare("SELECT is_following,last_followed_at FROM friends WHERE line_account_id='account-a' AND line_platform_user_id='U-a'").get()).toEqual({is_following:0,last_followed_at:'2023-11-15T07:13:22.000+09:00'});
  });

  it('IN-C01: 新しい解除のあとに古い追加が届いてもブロックを戻さない', async () => {
    lineClient.getProfile.mockResolvedValue({displayName:'人工ユーザー'});
    await postEvent(db,'a',{...base('a','new-unfollow',1_800_000_002_000),type:'unfollow'});
    await postEvent(db,'a',{...base('a','old-follow',1_800_000_001_000),type:'follow',replyToken:'fake'});
    expect(db.raw.prepare("SELECT is_following FROM friends WHERE id='friend-a'").get()).toEqual({is_following:0});
  });
  it('IN-C01: 新しい追加のあとに古い解除が届いても解除しない', async () => {
    lineClient.getProfile.mockResolvedValue({displayName:'人工ユーザー'});
    await postEvent(db,'a',{...base('a','new-follow',1_800_000_002_000),type:'follow',replyToken:'fake'});
    await postEvent(db,'a',{...base('a','old-unfollow',1_800_000_001_000),type:'unfollow'});
    expect(db.raw.prepare("SELECT is_following FROM friends WHERE id='friend-a'").get()).toEqual({is_following:1});
  });

  it('IN-C01: 未登録でも新しい解除を覚え、旧追加で戻さない',async()=>{
    db.raw.prepare("DELETE FROM friends WHERE id='friend-a'").run();
    await postEvent(db,'a',{...base('a','unknown-unfollow',1_800_000_002_000),type:'unfollow'});
    await postEvent(db,'a',{...base('a','unknown-old-follow',1_800_000_001_000),type:'follow',replyToken:'fake'});
    expect(db.raw.prepare("SELECT is_following,last_unfollowed_at FROM friends WHERE line_account_id='account-a' AND line_platform_user_id='U-a'").get()).toMatchObject({is_following:0,last_unfollowed_at:'2027-01-15T17:00:02.000+09:00'});
  });

  it('R-IN01: 途中失敗の再配達で担当者の完了/返信時刻を戻さない',async()=>{
    fire.mockRejectedValueOnce(new Error('fixture late failure'));
    await postText(db,'a','late-failure','late-message','人工の本文',1_800_000_000_000);
    db.raw.exec("UPDATE chats SET status='resolved',first_replied_at='operator-reply' WHERE friend_id='friend-a'");
    await postText(db,'a','late-failure','late-message','人工の本文',1_800_000_000_000);
    expect(db.raw.prepare("SELECT status,first_replied_at FROM chats WHERE friend_id='friend-a'").get()).toEqual({status:'resolved',first_replied_at:'operator-reply'});
  });

  it.each(['text', 'sticker'])('R-IN01: %s の保存直後に落ちても再配達で未完工程だけ続ける', async (kind) => {
    const originalBatch = db.db.batch.bind(db.db);
    let interrupted = false;
    db.db.batch = async <T=unknown>(statements:D1PreparedStatement[]) => {
      const result = await originalBatch<T>(statements);
      if (!interrupted && statements.some((item) => /INSERT OR IGNORE INTO messages_log/.test((item as unknown as { sql: string }).sql))) {
        interrupted = true;
        throw new Error('sqlite simulated interruption after commit');
      }
      return result;
    };
    const event = {
      ...base('a', `recover-${kind}`, 1_800_000_000_000), type: 'message', replyToken: 'fake-reply',
      message: kind === 'text' ? { type: kind, id: `message-${kind}`, text: '人工の本文' }
        : { type: kind, id: `message-${kind}`, stickerId: '1', packageId: '1', stickerResourceType: 'STATIC' },
    };
    await postEvent(db, 'a', event);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({ n: 1 });
    expect(mileage).not.toHaveBeenCalled();
    await postEvent(db, 'a', event);
    expect(mileage).toHaveBeenCalledTimes(1);
    expect(autoReply).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare('SELECT status FROM line_webhook_events WHERE webhook_event_id=?').get(`recover-${kind}`)).toEqual({ status: 'succeeded' });
    await postEvent(db, 'a', event);
    await postEvent(db, 'a', { ...event, webhookEventId: `other-${kind}` });
    expect(mileage).toHaveBeenCalledTimes(1);
    expect(autoReply).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({ n: 1 });
  });

  it('既存messageを取消し、重複unsendと別account同一message IDを分離してAPIを伏せる', async () => {
    await postText(db, 'a', 'event-message-a', 'line-message-shared', 'Aだけの秘密本文', 1_800_000_000_000);
    await postText(db, 'b', 'event-message-b', 'line-message-shared', 'Bの通常本文', 1_800_000_000_100);

    await postUnsend(db, 'a', 'event-unsend-a-1', 'line-message-shared', 1_800_000_000_200);
    await postUnsend(db, 'a', 'event-unsend-a-2', 'line-message-shared', 1_800_000_000_300);

    expect(db.raw.prepare(`
      SELECT line_account_id, content, unsent_at IS NOT NULL AS is_unsent
        FROM messages_log
       WHERE line_message_id = 'line-message-shared'
       ORDER BY line_account_id
    `).all()).toEqual([
      { line_account_id: 'account-a', content: '', is_unsent: 1 },
      { line_account_id: 'account-b', content: 'Bの通常本文', is_unsent: 0 },
    ]);
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM line_message_unsends
       WHERE line_message_account_key = 'account:account-a' AND line_message_id = 'line-message-shared'
    `).get()).toEqual({ count: 1 });

    const env = { DB: db.db } as Env['Bindings'];
    const cancelled = await chatsApp().request('/api/chats/friend-a', {}, env);
    expect(cancelled.status).toBe(200);
    const cancelledBody = await cancelled.json() as { data: { messages: Array<Record<string, unknown>> } };
    expect(cancelledBody.data.messages).toHaveLength(1);
    expect(cancelledBody.data.messages[0]).toMatchObject({
      messageType: 'text',
      content: '',
      isUnsent: true,
    });
    expect(JSON.stringify(cancelledBody)).not.toContain('Aだけの秘密本文');

    const list = await chatsApp().request('/api/chats?lineAccountId=account-a', {}, env);
    const listText = await list.text();
    expect(list.status).toBe(200);
    expect(listText).toContain('"lastMessageType":"unsent"');
    expect(listText).not.toContain('Aだけの秘密本文');

    const other = await chatsApp().request('/api/chats/friend-b', {}, env);
    const otherBody = await other.json() as { data: { messages: Array<Record<string, unknown>> } };
    expect(otherBody.data.messages[0]).toMatchObject({
      content: 'Bの通常本文',
      isUnsent: false,
    });
  });

  it('unsendが先着しても後着messageの本文・添付を復活させず副作用を起こさない', async () => {
    await postUnsend(db, 'a', 'event-unsend-first', 'line-message-late', 1_800_000_001_000);
    autoReply.mockClear();
    mileage.mockClear();

    await postText(
      db,
      'a',
      'event-message-late',
      'line-message-late',
      '後から届いたが表示してはいけない本文 https://attachment.example/secret',
      1_800_000_000_000,
    );

    expect(db.raw.prepare(`
      SELECT content, unsent_at IS NOT NULL AS is_unsent
        FROM messages_log
       WHERE line_message_account_key = 'account:account-a' AND line_message_id = 'line-message-late'
    `).get()).toEqual({ content: '', is_unsent: 1 });
    expect(autoReply).not.toHaveBeenCalled();
    expect(mileage).not.toHaveBeenCalled();

    const response = await chatsApp().request(
      '/api/chats/friend-a',
      {},
      { DB: db.db } as Env['Bindings'],
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"isUnsent":true');
    expect(text).not.toContain('後から届いた');
    expect(text).not.toContain('attachment.example');
  });

  it('未解決の取消は記録せず、解決後の再配信は同じdestinationで後着messageを伏せる', async () => {
    // 最初のunsendではenv secretに一致するDBアカウントを見つけられない状態にする。
    db.raw.prepare(
      "UPDATE line_accounts SET channel_secret = 'old-secret-a' WHERE id = 'account-a'",
    ).run();
    await postUnsend(
      db,
      'a',
      'event-unsend-before-account-resolution',
      'line-message-resolution-change',
      1_800_000_002_000,
      false,
    );
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM line_message_unsends').get()).toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM messages_log').get()).toEqual({ count: 0 });
    expect(autoReply).not.toHaveBeenCalled();
    expect(mileage).not.toHaveBeenCalled();

    // 同じLINE OAがDBアカウントへ解決できるようになったあとmessageが遅れて届く。
    db.raw.prepare(
      "UPDATE line_accounts SET channel_secret = 'secret-a' WHERE id = 'account-a'",
    ).run();
    await postUnsend(db, 'a', 'event-unsend-before-account-resolution',
      'line-message-resolution-change', 1_800_000_002_000);
    await postText(
      db,
      'a',
      'event-message-after-account-resolution',
      'line-message-resolution-change',
      '解決状態が変わっても復活してはいけない本文',
      1_800_000_001_000,
    );

    expect(db.raw.prepare(`
      SELECT line_account_id, line_message_account_key, content,
             unsent_at IS NOT NULL AS is_unsent
        FROM messages_log
       WHERE line_message_id = 'line-message-resolution-change'
    `).get()).toEqual({
      line_account_id: 'account-a',
      line_message_account_key: 'account:account-a',
      content: '',
      is_unsent: 1,
    });
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count FROM line_message_unsends
       WHERE line_message_account_key = 'account:account-a'
         AND line_message_id = 'line-message-resolution-change'
    `).get()).toEqual({ count: 1 });
  });
});
