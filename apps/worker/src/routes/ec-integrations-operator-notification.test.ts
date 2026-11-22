import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
//  EC受注から運用者通知を自動発火する接続の実挙動。
//
// 受注は「起きたこと」なので、LINEの友だち照合や取引通知の設定より先に
// 運用者へ出す。EC側の再送で通知が増えないこと、通知が落ちても受注の
// 取り込みが止まらないことをここで確かめる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  dispatchOperatorEvent: vi.fn(),
  getAccount: vi.fn(),
  getFriend: vi.fn(),
  pushMessage: vi.fn(),
  upsertReadModels: vi.fn(),
  attachOrderFriend: vi.fn(),
  setActionStatus: vi.fn(),
  getCustomerSource: vi.fn(),
  recordEcDelivery: vi.fn(),
  syncEcTags: vi.fn(),
  enqueueFollowUps: vi.fn(),
  syncPetProfiles: vi.fn(),
}));
vi.mock('@line-crm/db', async importOriginal => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  attachEcOrderFriend: mocks.attachOrderFriend,
  getCustomerNotificationSource: mocks.getCustomerSource,
  getLineAccountById: mocks.getAccount,
  getFriendByLineUserIdForAccount: mocks.getFriend,
  jstNow: vi.fn(() => '2026-09-10 02:00:00'),
  recordCustomerEcDelivery: mocks.recordEcDelivery,
  setEcActionExecutionStatus: mocks.setActionStatus,
  upsertEcEventReadModels: mocks.upsertReadModels,
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return ({
    pushMessage: mocks.pushMessage,
    pushMessageWithRequestId: mocks.pushMessage,
  }); }),
}));
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(),
  logOutgoingMessage: vi.fn(),
}));
vi.mock('../services/nen-tag-sync.js', () => ({
  syncNenEcTags: mocks.syncEcTags,
  syncNenPetTags: vi.fn(),
}));
vi.mock('../services/nen-engagement.js', () => ({
  enqueuePostShippingFollowUps: mocks.enqueueFollowUps,
  syncNenPetProfiles: mocks.syncPetProfiles,
}));
vi.mock('../services/operator-notification-dispatch.js', () => ({
  dispatchOperatorEvent: mocks.dispatchOperatorEvent,
}));

const { ecIntegrations } = await import('./ec-integrations.js');

type EcRow = { id: string; status: string };

const workflowStores:SqliteD1[]=[];
afterEach(()=>{for(const item of workflowStores)item.raw.close();workflowStores.length=0;vi.useRealTimers()});

function harness() {
  const events = new Map<string, EcRow>();
  const app = new Hono<any>();
  app.route('/', ecIntegrations);
  const workflow=createTestD1();workflowStores.push(workflow);
  const db = {
    batch:workflow.db.batch.bind(workflow.db),
    prepare(query: string) {
      if(query.includes('workflow_steps') || query.includes('operation_audit'))return workflow.db.prepare(query);
      const entry = { query, bindings: [] as unknown[] };
      const statement = {
        bind(...bindings: unknown[]) { entry.bindings = bindings; return statement; },
        async run() {
          if (query.includes('INSERT OR IGNORE INTO ec_events')) {
            const [id, source, externalEventId] = entry.bindings as string[];
            const key = `${source}:${externalEventId}`;
            if (events.has(key)) return { success: true, meta: { changes: 0 } };
            events.set(key, { id, status: 'received' });
            return { success: true, meta: { changes: 1 } };
          }
          if (query.includes("UPDATE ec_events SET status = 'processing'")) {
            const row = [...events.values()].find((item) => item.id === entry.bindings[1]);
            if (row && (row.status === 'received' || row.status === 'failed')) {
              row.status = 'processing';
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (query.includes("UPDATE ec_events SET friend_id = ?, status = 'processed'")) {
            const row = [...events.values()].find((item) => item.id === entry.bindings[3]);
            if (row) row.status = 'processed';
            return { success: true, meta: { changes: 1 } };
          }
          if (query.includes("SET status = 'identity_pending'")) {
            const row = [...events.values()].find((item) => item.id === entry.bindings[1]);
            if (row) row.status = 'identity_pending';
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          if (query.includes('FROM ec_events WHERE source = ?')) {
            const [source, externalEventId] = entry.bindings as string[];
            return events.get(`${source}:${externalEventId}`) ?? null;
          }
          return null;
        },
        async all() { return { results: [] }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { app, db, events };
}

async function signature(secret: string, timestamp: string, accountId: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${accountId}.${body}`),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(
  app: Hono<any>, db: D1Database, event: Record<string, unknown>, accountId = 'account-a',
) {
  const secret = 'a'.repeat(32);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(event);
  return app.request('/api/integrations/eccube/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-line-account-id': accountId,
      'x-nen-timestamp': timestamp,
      'x-nen-signature': `sha256=${await signature(secret, timestamp, accountId, body)}`,
    },
    body,
  }, { DB: db, ECCUBE_WEBHOOK_SECRET: secret, LINE_CHANNEL_ACCESS_TOKEN: 'default-token' });
}

const LINE_USER_ID = 'U00000000000000000000000000000000';
const orderEvent = {
  event_id: 'event-87654321', event_type: 'ec.order.confirmed',
  occurred_at: '2026-09-10T01:00:00+09:00', customer_id: 'customer-1',
  line_user_id: LINE_USER_ID,
  order: { number: 'NEN-2001', total: 4200, currency: 'JPY', items: [{ name: '鹿肉ミンチ', quantity: 3 }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispatchOperatorEvent.mockResolvedValue(undefined);
  mocks.upsertReadModels.mockResolvedValue(undefined);
  mocks.attachOrderFriend.mockResolvedValue(undefined);
  mocks.setActionStatus.mockResolvedValue(undefined);
  mocks.syncEcTags.mockResolvedValue(undefined);
  mocks.enqueueFollowUps.mockResolvedValue(undefined);
  mocks.syncPetProfiles.mockResolvedValue(undefined);
  mocks.getAccount.mockResolvedValue({ id: 'account-a', is_active: 1, channel_access_token: 'account-token' });
  mocks.getFriend.mockResolvedValue({ id: 'friend-1', line_account_id: 'account-a', is_following: 1 });
  mocks.getCustomerSource.mockResolvedValue(null);
  mocks.recordEcDelivery.mockResolvedValue(undefined);
  // pushMessageWithRequestId は { requestId } を返すので、呼び出し回数だけを
  // 見る試験は同じ mock を共有する。
  mocks.pushMessage.mockResolvedValue({ data: {}, requestId: 'req-1' });
});

describe('EC受注から運用者通知を自動発火する (N-327 #663)', () => {
  it('受注を受け付けたら、台帳の行を発生元にして運用者通知を出す', async () => {
    const { app, db, events } = harness();

    const response = await signedRequest(app, db, orderEvent);

    expect(response.status).toBe(200);
    const ledgerId = [...events.values()][0].id;
    expect(mocks.dispatchOperatorEvent).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchOperatorEvent).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        lineAccountId: 'account-a',
        eventType: 'ec_order_received',
        sourceEventId: ledgerId,
        executionMode: 'automatic',
      }),
    );
    const [, , input] = mocks.dispatchOperatorEvent.mock.calls[0] as [unknown, unknown, { message: string }];
    expect(input.message).toContain('NEN-2001');
  });

  it('EC側が同じ受注を再送しても通知は1回だけ出す', async () => {
    const { app, db } = harness();

    await signedRequest(app, db, orderEvent);
    const second = await signedRequest(app, db, orderEvent);

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
    expect(mocks.dispatchOperatorEvent).toHaveBeenCalledTimes(1);
  });

  it('LINEの友だちが見つからなくても受注は運用者へ知らせる', async () => {
    const { app, db } = harness();
    const { line_user_id: _omitted, ...withoutLineUser } = orderEvent;

    const response = await signedRequest(app, db, withoutLineUser);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: 'identity_pending' });
    expect(mocks.dispatchOperatorEvent).toHaveBeenCalledTimes(1);
  });

  it('通知が落ちても受注の取り込みは止めない', async () => {
    const { app, db } = harness();
    mocks.dispatchOperatorEvent.mockRejectedValueOnce(new Error('dispatch unavailable'));

    const response = await signedRequest(app, db, orderEvent);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, status: 'processed' });
    expect(mocks.pushMessage).toHaveBeenCalledTimes(1);
  });

  it('受注以外のECイベントでは運用者通知を出さない', async () => {
    const { app, db } = harness();

    const response = await signedRequest(app, db, {
      ...orderEvent, event_id: 'event-11112222', event_type: 'ec.order.shipped',
    });

    expect(response.status).toBe(200);
    expect(mocks.dispatchOperatorEvent).not.toHaveBeenCalled();
  });

  it('別アカウントの受注は、そのアカウントの通知として出す', async () => {
    const { app, db } = harness();
    mocks.getAccount.mockResolvedValue({ id: 'account-b', is_active: 1, channel_access_token: 'token-b' });
    mocks.getFriend.mockResolvedValue({ id: 'friend-2', line_account_id: 'account-b', is_following: 1 });

    await signedRequest(app, db, orderEvent, 'account-b');

    expect(mocks.dispatchOperatorEvent).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'account-b', eventType: 'ec_order_received' }),
    );
  });
});

vi.mock('../services/workflow-execution.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../services/workflow-execution.js')>();
 const {unitWorkflow}=await import('../test-utils/workflow-unit.js');
 return {...actual,acquireWorkflow:async(db:D1Database,ref:any)=>unitWorkflow(db,ref),
  runWorkflowStep:async(_db:any,_ref:any,work:Function,options:any)=>work({input_json:JSON.stringify(options.input),retry_key:options.retryKey,attempt_count:1,first_attempt_at:Date.now()})};
});
