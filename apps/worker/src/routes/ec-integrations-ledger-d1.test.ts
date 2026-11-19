import { processDueEcRetries } from '../features/ec-commerce/ec-retry.js';
/*
 *  ECイベントからの顧客通知送信を、実D1で共通送信台帳
 * (notification_instances / notification_deliveries /
 *  notification_delivery_attempts) へつなぐことを固定する。
 *
 * 見る点:
 *  - 受理・失敗・対象外の各結果が台帳へ残る
 *  - 冪等キーは LINE へ渡す固定 retry key と同じ値で、再送で行が増えない
 *  - 顧客通知定義があるイベントは定義だけが正本(下書き・停止は送らない)
 *  - 従来の ec_v6_dispatches / イベント台帳の動きは維持する
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';

const pushMessageWithRequestId = vi.hoisted(() => vi.fn());
vi.mock('@line-crm/line-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/line-sdk')>();
  return {
    ...actual,
    LineClient: class {
      pushMessageWithRequestId = pushMessageWithRequestId;
    },
  };
});
vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn(), logOutgoingMessage: vi.fn() }));
vi.mock('../services/operator-notification-dispatch.js', () => ({ dispatchOperatorEvent: vi.fn() }));
vi.mock('../services/nen-tag-sync.js', () => ({ syncNenEcTags: vi.fn(), syncNenPetTags: vi.fn() }));
vi.mock('../services/nen-engagement.js', () => ({
  enqueuePostShippingFollowUps: vi.fn(),
  syncNenPetProfiles: vi.fn(),
}));

const { ecIntegrations } = await import('./ec-integrations.js');
const { ecNotificationRetryKey } = await import('../features/ec-commerce/ec-event-publish.js');

const LINE_USER_ID = `U${'a'.repeat(32)}`;

let sqlite: SqliteD1['raw'];
let db: D1Database;
const SECRET = 'a'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  const created = createTestD1();
  sqlite = created.raw;
  db = created.db;
  sqlite.exec(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', 'A店', 'token-a', 'secret-a');
    INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
    VALUES ('friend-a', '${LINE_USER_ID}', '山田', 'account-a', 1, '2026-09-01', '2026-09-01');
    INSERT INTO ec_notification_settings
      (event_type, is_enabled, title_override, intro_text, outro_text, category,
       created_at, updated_at)
    VALUES ('ec.order.confirmed', 1, 'ご注文ありがとうございます', '本文', '結び',
            'order', '2026-09-01', '2026-09-01');
  `);
  pushMessageWithRequestId.mockResolvedValue({ data: {}, requestId: 'req-1' });
});

afterEach(()=>vi.useRealTimers());

const app = new Hono<Env>();
app.route('/', ecIntegrations);

async function signature(timestamp: string, accountId: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${accountId}.${body}`),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const baseEvent = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'evt-1001',
  event_type: 'ec.order.confirmed',
  occurred_at: '2026-09-16T09:00:00+09:00',
  customer_id: 'customer-1',
  line_user_id: LINE_USER_ID,
  order: { number: 'NEN-1001', total: 2860, items: [{ name: '鹿肉ミンチ', quantity: 2 }] },
  ...overrides,
});

async function post(event: Record<string, unknown>, accountId = 'account-a') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(event);
  return app.request('/api/integrations/eccube/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-account-id': accountId,
      'x-nen-timestamp': timestamp,
      'x-nen-signature': `sha256=${await signature(timestamp, accountId, body)}`,
    },
    body,
  }, { DB: db, ECCUBE_WEBHOOK_SECRET: SECRET });
}

const instances = () => sqlite.prepare(
  `SELECT * FROM notification_instances WHERE line_account_id = 'account-a'`,
).all() as Record<string, unknown>[];
const deliveries = () => sqlite.prepare(
  `SELECT * FROM notification_deliveries WHERE line_account_id = 'account-a'`,
).all() as Record<string, unknown>[];
const attemptRows = () => sqlite.prepare(
  `SELECT a.* FROM notification_delivery_attempts a
     JOIN notification_deliveries d ON d.id = a.delivery_id
    WHERE d.line_account_id = 'account-a' ORDER BY a.attempt_number`,
).all() as Record<string, unknown>[];
const dispatch = (subscriber = 'notification') => sqlite.prepare(
  `SELECT d.subscriber, d.status, d.attempt_count, e.status AS event_status
     FROM ec_v6_dispatches d JOIN ec_events e ON e.id = d.event_id
    WHERE d.subscriber = ?`,
).get(subscriber) as Record<string, unknown> | undefined;

function seedDefinition(status: string) {
  sqlite.exec(`
    INSERT INTO customer_notification_definitions
      (id, line_account_id, key, name, category, source_event_type, status,
       current_version_id, draft_config_json, version, created_by, updated_by,
       created_at, updated_at)
    VALUES ('def-1', 'account-a', 'ec:ec.order.confirmed', '注文受付', 'order',
            'ec.order.confirmed', '${status}', 'ver-1', '{}', 1, 'staff', 'staff',
            '2026-09-01', '2026-09-01');
    INSERT INTO customer_notification_versions
      (id, definition_id, version_number, config_json, line_template_json,
       published_by, published_at)
    VALUES ('ver-1', 'def-1', 2,
            '{"introText":"公開版の本文","outroText":"公開版の結び"}', '[]',
            'staff', '2026-09-01');
  `);
}

describe('N-328: EC顧客通知を共通送信台帳へ書く', () => {
  it('ECの顧客通知は共通情報がなければ送らず、登録済みの値を送る', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));useSqliteClock(sqlite,()=>new Date());
    try {
      sqlite.prepare("UPDATE ec_notification_settings SET title_override='営業時間: {{var.hours}}' WHERE event_type='ec.order.confirmed'").run();
      await post(baseEvent({event_id:'event-var-missing'}));
      expect(pushMessageWithRequestId).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
      sqlite.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('hours','account-a','営業時間','hours','text','10時')").run();
      expect((await post(baseEvent({event_id:'event-var-success'}))).status).toBe(200);
      expect(pushMessageWithRequestId).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(pushMessageWithRequestId.mock.calls[0][1])).toContain('営業時間: 10時');
    } finally {vi.useRealTimers();}
  });

  it.each([
    [0, 1, '店舗Aの通知', false],
    [1, 0, '店舗Aの通知', true],
    [null, 0, 'ご注文ありがとうございます', true],
  ] as const)('店舗の設定%s・他店舗%sのとき、受信先の設定または共通設定だけで送信する', async (ownEnabled, otherEnabled, title, sent) => {
    sqlite.exec(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-b', 'channel-b', 'B店', 'token-b', 'secret-b')`);
    const setting = sqlite.prepare(`INSERT INTO ec_notification_account_settings
      (line_account_id, event_type, is_enabled, title_override, created_at, updated_at)
      VALUES (?, 'ec.order.confirmed', ?, ?, '2026-10-22', '2026-10-22')`);
    setting.run('account-b', otherEnabled, '店舗Bの通知');
    if (ownEnabled !== null) setting.run('account-a', ownEnabled, '店舗Aの通知');

    expect((await post(baseEvent())).status).toBe(sent ? 200 : 202);

    expect(pushMessageWithRequestId).toHaveBeenCalledTimes(sent ? 1 : 0);
    if (sent) {
      const message = JSON.stringify(pushMessageWithRequestId.mock.calls[0][1]);
      expect(message).toContain(title);
      expect(message).not.toContain('店舗Bの通知');
      expect(deliveries()[0]).toMatchObject({ status: 'provider_accepted' });
    } else {
      expect(deliveries()[0]).toMatchObject({ status: 'excluded', attempts: 0, error_code: 'notification_disabled' });
    }
  });

  it('受理: 通知・送達・試行を1件ずつ残し、従来台帳も sent になる', async () => {
    const response = await post(baseEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, status: 'processed' });

    const retryKey = await ecNotificationRetryKey('account-a', 'evt-1001');
    // LINE へ渡す retry key と台帳の冪等キーは同じ値。
    expect(pushMessageWithRequestId).toHaveBeenCalledWith(
      LINE_USER_ID, expect.any(Array), retryKey,
    );

    expect(instances()).toHaveLength(1);
    expect(instances()[0]).toMatchObject({
      audience_type: 'customer',
      source_event_type: 'ec.order.confirmed',
      source_event_id: 'evt-1001',
      dedupe_key: 'ec:evt-1001',
      status: 'completed',
    });
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({
      recipient_type: 'friend',
      recipient_id: 'friend-a',
      channel: 'line',
      idempotency_key: retryKey,
      status: 'provider_accepted',
      attempts: 1,
      provider_request_id: 'req-1',
    });
    expect(attemptRows()).toHaveLength(1);
    expect(attemptRows()[0]).toMatchObject({
      attempt_number: 1, outcome: 'provider_accepted', provider_request_id: 'req-1',
    });
    expect(dispatch()).toMatchObject({ subscriber: 'notification', status: 'sent' });
  });

  it('定義が published のときは定義の版が台帳に記録される', async () => {
    seedDefinition('published');
    const response = await post(baseEvent());
    expect(response.status).toBe(200);

    expect(instances()[0]).toMatchObject({
      definition_id: 'def-1', definition_version_id: 'ver-1', status: 'completed',
    });
    expect(deliveries()[0]).toMatchObject({ status: 'provider_accepted' });
  });

  it('送信失敗: failed を分類コードつきで残し、従来台帳も failed になる', async () => {
    pushMessageWithRequestId.mockRejectedValueOnce(Object.assign(
      new Error('Request failed with status 500'), { status: 500 },
    ));
    const response = await post(baseEvent());
    expect(response.status).toBe(503);

    expect(instances()[0]).toMatchObject({ status: 'failed' });
    expect(deliveries()[0]).toMatchObject({
      status: 'failed', attempts: 1, error_code: 'delivery_unknown',
    });
    expect(String(deliveries()[0].error_message_safe)).not.toContain('Request failed');
    expect(attemptRows()).toHaveLength(1);
    expect(attemptRows()[0]).toMatchObject({ attempt_number: 1, outcome: 'failed' });
    expect(dispatch()).toMatchObject({ subscriber: 'notification', status: 'failed' });
  });

  it('確定した429の拒否は待機後に同じ冪等キーで再試行し、物理要求だけ数える', async () => {
    vi.useFakeTimers();
    pushMessageWithRequestId.mockRejectedValueOnce(Object.assign(
      new Error('Request failed with status 429'), { status: 429 },
    ));
    expect((await post(baseEvent())).status).toBe(503);
    expect((await post(baseEvent())).status).toBe(503);
    expect(pushMessageWithRequestId).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    pushMessageWithRequestId.mockResolvedValueOnce({ data: {}, requestId: 'req-2' });
    expect((await post(baseEvent())).status).toBe(200);

    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({
      status: 'provider_accepted', attempts: 2, provider_request_id: 'req-2',
      error_code: null, error_message_safe: null,
    });
    expect(attemptRows()).toHaveLength(2);
    expect(attemptRows()[0]).toMatchObject({ attempt_number: 1, outcome: 'failed' });
    expect(attemptRows()[1]).toMatchObject({ attempt_number: 2, outcome: 'provider_accepted' });
  });


  it('応答が不明なEC通知は再受信しても元の送信行を保持し、再送も架空の試行も増やさない',async()=>{
    pushMessageWithRequestId.mockRejectedValueOnce(new Error('lost response'));
    expect((await post(baseEvent())).status).toBe(503);
    const first=deliveries()[0];
    expect((await post(baseEvent())).status).toBe(503);
    expect(pushMessageWithRequestId).toHaveBeenCalledOnce();expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({id:first.id,idempotency_key:first.idempotency_key,attempts:1,error_code:'delivery_unknown'});
    expect(attemptRows()).toHaveLength(1);
  });

  it('受理後の保存失敗でも元のEC送信行へprovider参照を残し、再送しない',async()=>{
    sqlite.exec("CREATE TRIGGER fail_ec_checkpoint BEFORE UPDATE ON workflow_steps WHEN NEW.step_key='customer_notification' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect((await post(baseEvent())).status).toBe(503);
    const receipt=sqlite.prepare("SELECT status,result_json,retry_key FROM workflow_steps WHERE step_key='customer_notification'").get() as {status:string,result_json:string,retry_key:string};
    expect(receipt.status).toBe('unknown');expect(JSON.parse(receipt.result_json)).toEqual({requestId:'req-1'});
    expect((await post(baseEvent())).status).toBe(503);
    expect(pushMessageWithRequestId).toHaveBeenCalledOnce();
    expect(deliveries()).toHaveLength(1);expect(deliveries()[0]).toMatchObject({attempts:1,idempotency_key:receipt.retry_key});
    expect(attemptRows()).toHaveLength(1);
  });

  it('処理済みイベントの再送は新しい台帳行を作らない', async () => {
    expect((await post(baseEvent())).status).toBe(200);
    const response = await post(baseEvent());
    expect(await response.json()).toMatchObject({ duplicate: true });

    expect(instances()).toHaveLength(1);
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].attempts).toBe(1);
    expect(attemptRows()).toHaveLength(1);
  });

  it('通知停止(従来設定OFF)は対象外として残し、試行は増やさない', async () => {
    sqlite.exec(`UPDATE ec_notification_settings SET is_enabled = 0
                  WHERE event_type = 'ec.order.confirmed'`);
    const response = await post(baseEvent());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'skipped' });

    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
    expect(instances()[0]).toMatchObject({ status: 'excluded' });
    expect(deliveries()[0]).toMatchObject({
      status: 'excluded', attempts: 0, error_code: 'notification_disabled',
    });
    expect(attemptRows()).toHaveLength(0);
  });

  it('定義が stopped なら従来設定がONでも送らない(定義だけが正本)', async () => {
    seedDefinition('stopped');
    const response = await post(baseEvent());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'skipped' });

    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
    expect(deliveries()[0]).toMatchObject({
      status: 'excluded', attempts: 0, error_code: 'notification_disabled',
    });
    expect(instances()[0]).toMatchObject({ definition_id: 'def-1' });
  });

  it('友だちがフォローしていないときも対象外として残す', async () => {
    sqlite.exec(`UPDATE friends SET is_following = 0 WHERE id = 'friend-a'`);
    const response = await post(baseEvent());
    expect(response.status).toBe(202);

    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
    expect(deliveries()[0]).toMatchObject({
      status: 'excluded', attempts: 0,
      error_code: 'friend_not_following', recipient_id: 'friend-a',
    });
    expect(attemptRows()).toHaveLength(0);
  });

  it('購読台帳が sent なのに共通台帳へ書けていない分を、再処理で復旧する', async () => {
    expect((await post(baseEvent())).status).toBe(200);
    // 共通台帳への書込だけ落ちた状態を再現する。
    sqlite.exec(`DELETE FROM notification_deliveries`);
    sqlite.exec(`DELETE FROM notification_instances`);
    sqlite.exec(`UPDATE ec_events SET status = 'failed'`);

    const response = await post(baseEvent());
    expect(response.status).toBe(200);

    // この処理ではLINEへ送っていないので、復旧した行の試行は0のまま。
    expect(pushMessageWithRequestId).toHaveBeenCalledTimes(1);
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({ status: 'provider_accepted', attempts: 0 });
    expect(attemptRows()).toHaveLength(0);
  });
});
it('R-EC02: 注文保存が一度失敗してもcronだけで注文と明細を補う',async()=>{
 sqlite.exec("CREATE TEMP TRIGGER fail_order BEFORE INSERT ON ec_orders BEGIN SELECT RAISE(ABORT,'sqlite artificial order failure'); END");
 expect((await post(baseEvent({event_id:'read-model-recovery'}))).status).toBe(503);
 expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ec_orders').get()).toEqual({n:0});
 sqlite.exec('DROP TRIGGER fail_order');
 expect((await processDueEcRetries(db,{now:'2030-01-01T00:00:00Z'})).processed).toBe(1);
 expect(sqlite.prepare('SELECT order_number FROM ec_orders').all()).toEqual([{order_number:'NEN-1001'}]);
 expect(sqlite.prepare('SELECT product_name FROM ec_order_lines').all()).toEqual([{product_name:'鹿肉ミンチ'}]);
 expect(sqlite.prepare("SELECT status FROM ec_events WHERE external_event_id='read-model-recovery'").get()).toEqual({status:'processed'});
});
it.each([true,false])('IN-H01: 停止したECは友だちの有無=%sでも運用者へ知らせない',async(linked)=>{
 sqlite.prepare("INSERT INTO ec_connectors(id,line_account_id,provider,shop_domain,status,created_at,updated_at) VALUES('paused','account-a','ec_cube','fixture.test','paused','fixture','fixture')").run();
 const {dispatchOperatorEvent}=await import('../services/operator-notification-dispatch.js');
 const event:Record<string,unknown>=baseEvent({event_id:'paused-order'});if(!linked)delete event.line_user_id;
 const response=await post(event);
 expect(response.status).toBe(202);expect(await response.json()).toMatchObject({status:'paused'});
 expect(dispatchOperatorEvent).not.toHaveBeenCalled();expect(pushMessageWithRequestId).not.toHaveBeenCalled();
 expect(sqlite.prepare("SELECT error_message FROM ec_events WHERE external_event_id='paused-order'").get()).toEqual({error_message:'connector_paused'});
});
