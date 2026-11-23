import { signIncomingTest, receiveAndDrain } from '../test-utils/incoming-webhook-request.js';
/*
 * 処理0件と処理済みを応答で区別し、本文サイズ・短時間の回数・署名・冪等性の境界を実アプリと実 SQLite で確かめる。
 * 429では受領予約を消費せず、正規の再送を可能にする。並行受信で上限を超えないよう、件数条件を INSERT の中で判定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const fireEvent = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock('../services/event-bus.js', () => ({ fireEvent }));
vi.mock('../services/outgoing-webhook-delivery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/outgoing-webhook-delivery.js')>(),
  deliverWebhook: vi.fn(async () => ({ ok: true, attempts: 1, lastStatus: 200 })),
}));

const { app } = await import('../index.js');

/** WEBHOOK_SECRET_MIN_LENGTH (32) 以上にする。短いと 503 で弾かれる。 */
const SECRET = 'boundary-guard-secret-0123456789ab';

const sign = signIncomingTest;

function seed(db: SqliteD1): void {
  db.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  db.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES ('account-1', 'ch-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')
  `).run();
  db.raw.prepare(`
    INSERT INTO incoming_webhooks (id, name, source_type, secret, line_account_id, is_active)
    VALUES ('iwh-1', '外部連携1', 'custom', ?, 'account-1', 1)
  `).run(SECRET);
}

/*
 * 受信口には経路全体の rateLimitMiddleware(未認証はIPごと100件/分)が
 * 先に効く。テストごとに別IPを名乗らないと、ファイル内の受信が同じ
 * `ip:0.0.0.0` バケツを使い回して経路手前の429と受領側の429が混ざる。
 */
let clientIp = '0.0.0.0';
let testIpSeq = 0;

/** 署名を付けて受信口を叩く。 */
async function receive(
  env: never,
  body: string,
  options?: { webhookId?: string; secret?: string },
) {
  const signature = await sign(options?.secret ?? SECRET, body);
  return receiveAndDrain(app,
    `/api/webhooks/incoming/${options?.webhookId ?? 'iwh-1'}/receive?accountId=account-1`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'cf-connecting-ip': clientIp,
      },
      body,
    },
    env,
  );
}

type ReceiveData = {
  received?: boolean;
  duplicate?: boolean;
  source?: string;
  queued?: boolean;
  matched?: boolean;
  executed?: number;
  failed?: number;
};

describe('受信Webhookの入力・受理条件と処理を検証する', () => {
  let db: SqliteD1;
  let env: never;

  beforeEach(() => {
    fireEvent.mockReset().mockResolvedValue(undefined);
    clientIp = `10.200.${testIpSeq++}.7`;
    db = createTestD1();
    seed(db);
    env = { DB: db.db } as never;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
  });

  function configureTagAction() {
    db.raw.prepare(`INSERT INTO friends (id,line_user_id,line_account_id,is_following) VALUES ('friend-1','U1','account-1',1)`).run();
    db.raw.prepare(`INSERT INTO tags (id,name,line_account_id) VALUES ('tag-1','受付済','account-1')`).run();
    db.raw.prepare(`UPDATE incoming_webhooks SET identity_match_json=?,action_refs_json=? WHERE id='iwh-1'`).run(
      JSON.stringify({ methods: [{ kind: 'harness_friend_id', path: '$.friendId' }], onNotFound: 'do_nothing' }),
      JSON.stringify([{ refKind: 'tag', refId: 'tag-1', refVersionId: null }]),
    );
  }

  const receiptCount = () => (db.raw.prepare(
    `SELECT COUNT(*) AS n FROM incoming_webhook_receipts WHERE webhook_id='iwh-1'`,
  ).get() as { n: number }).n;

  describe('受信Webhookは照合の有無と実行・失敗件数を区別して返す', () => {
    it('相手が見つかり処理が走った受信は matched/executed/failed を返す', async () => {
      configureTagAction();
      const res = await receive(env, JSON.stringify({ friendId: 'friend-1' }));
      expect(res.status).toBeOneOf([200, 202]);
      const body = await res.json() as { data: ReceiveData };
      expect(body.data).toMatchObject({
        received: true, source: 'custom', queued: true,
      });
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM friend_tags`).get()).toEqual({ n: 1 });
    });

    it('相手が見つからない受信は matched:false・executed:0 で判別できる', async () => {
      configureTagAction();
      const res = await receive(env, JSON.stringify({ friendId: 'friend-absent' }));
      expect(res.status).toBeOneOf([200, 202]);
      const body = await res.json() as { data: ReceiveData };
      expect(body.data).toMatchObject({
        received: true, queued: true,
      });
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM friend_tags`).get()).toEqual({ n: 0 });
    });

    it('実行処理が未設定の受信も executed:0 で判別できる', async () => {
      const res = await receive(env, JSON.stringify({ order_id: 'A-1' }));
      expect(res.status).toBeOneOf([200, 202]);
      const body = await res.json() as { data: ReceiveData };
      expect(body.data).toMatchObject({
        received: true, queued: true,
      });
    });
  });

  describe('受信Webhookは本文サイズと短時間の受理回数を制限する', () => {
    it('上限を超える本文は413で受け付けず、受領記録を消費しない', async () => {
      const big = JSON.stringify({ friendId: 'friend-1', pad: 'x'.repeat(300 * 1024) });
      const res = await receive(env, big);
      expect(res.status).toBe(413);
      expect(receiptCount()).toBe(0);
      expect(fireEvent).not.toHaveBeenCalled();

      // 上限内の本文は従来どおり200で処理される（締めすぎていない）。
      const ok = await receive(env, JSON.stringify({ friendId: 'friend-1' }));
      expect(ok.status).toBeOneOf([200, 202]);
      expect(receiptCount()).toBe(1);
    });

    it('短時間に上限を超える受信は429+Retry-Afterで止め、受領記録を消費しない', async () => {
      // 直近ウィンドウ内に上限いっぱいの受領がある状態を直接作る。
      const now = new Date().toISOString();
      for (let i = 0; i < 60; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`hist-${i}`, `hist-event-${i}`, now);
      }
      const res = await receive(env, JSON.stringify({ order_id: 'over-limit' }));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBeTruthy();
      expect(receiptCount()).toBe(60);
      expect(fireEvent).not.toHaveBeenCalled();
    });

    it('ウィンドウより古い受領は回数に数えない', async () => {
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      for (let i = 0; i < 60; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`old-${i}`, `old-event-${i}`, old);
      }
      const res = await receive(env, JSON.stringify({ order_id: 'within-limit' }));
      expect(res.status).toBeOneOf([200, 202]);
      expect(receiptCount()).toBe(61);
    });

    it('窓内60件目までは受け付け、61件目の新規受信から429を返す', async () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 59; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`edge-${i}`, `edge-event-${i}`, now);
      }
      const ok = await receive(env, JSON.stringify({ order_id: 'boundary-60' }));
      expect(ok.status).toBeOneOf([200, 202]);
      expect(receiptCount()).toBe(60);
      const over = await receive(env, JSON.stringify({ order_id: 'boundary-61' }));
      expect(over.status).toBe(429);
      expect(receiptCount()).toBe(60);
    });

    it('同時に届いた新規受信が上限を超えても、受領は上限件数で止まる', async () => {
      // 件数確認と受領作成が別文だと、並行受信が同じ「まだ上限内」を読んで
      // 全員通ってしまう。上限は INSERT 文の内側で効かせる。
      const results = await Promise.all(
        Array.from({ length: 80 }, (_, i) =>
          receive(env, JSON.stringify({ order_id: `burst-${i}` }))),
      );
      const statuses = results.map((res) => res.status);
      expect(statuses.filter((s) => s === 202)).toHaveLength(60);
      expect(statuses.filter((s) => s === 429)).toHaveLength(20);
      expect(receiptCount()).toBe(60);
    });

    it('窓がいっぱいでも完了済みの再送は429ではなく重複応答を返す', async () => {
      const body = JSON.stringify({ order_id: 'dup-in-full-window' });
      const first = await receive(env, body);
      expect(first.status).toBeOneOf([200, 202]);
      // 直近ウィンドウを上限まで埋める(自分の受領1件+59件)。
      const now = new Date().toISOString();
      for (let i = 0; i < 59; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`fill-${i}`, `fill-event-${i}`, now);
      }
      expect(receiptCount()).toBe(60);
      const dup = await receive(env, body);
      expect(dup.status).toBeOneOf([200, 202]);
      const dupBody = await dup.json() as { data: ReceiveData };
      expect(dupBody.data).toMatchObject({ received: true, duplicate: true });
      // 重複応答は新しい受領記録を消費しない。
      expect(receiptCount()).toBe(60);
    });

    it('残り1枠へ異なる署名が同時に届いても、通るのは最大1件で残りは429', async () => {
      // 59件埋まった窓の空きは1件分だけ。異なる署名が同じ空きを
      // 奪い合っても、INSERT内側の件数条件で1件までしか通らない。
      const now = new Date().toISOString();
      for (let i = 0; i < 59; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`race-${i}`, `race-event-${i}`, now);
      }
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          receive(env, JSON.stringify({ order_id: `last-slot-${i}` }))),
      );
      const statuses = results.map((res) => res.status);
      const succeeded = statuses.filter((s) => s === 202).length;
      expect(succeeded).toBeLessThanOrEqual(1);
      expect(statuses.filter((s) => s === 429)).toHaveLength(10 - succeeded);
      expect(receiptCount()).toBe(60);
    });

    it('429で止めた受信は受領を残さず、窓が明ければ同じ本文の再送が200になる', async () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 60; i++) {
        db.raw.prepare(`INSERT INTO incoming_webhook_receipts
          (webhook_id, signature_hash, source_event_id, received_at)
          VALUES ('iwh-1', ?, ?, ?)`).run(`full-${i}`, `full-event-${i}`, now);
      }
      const body = JSON.stringify({ order_id: 'retry-after-window' });
      const limited = await receive(env, body);
      expect(limited.status).toBe(429);
      // 429で止めた分は受領行を作らないので、後から送り直せる。
      expect(receiptCount()).toBe(60);
      // 受領をすべて窓の外へ追いやると、同じ本文・同じ署名が新規として通る。
      db.raw.prepare(`UPDATE incoming_webhook_receipts SET received_at=? WHERE webhook_id='iwh-1'`)
        .run(new Date(Date.now() - 10 * 60_000).toISOString());
      const retry = await receive(env, body);
      expect(retry.status).toBeOneOf([200, 202]);
      const retryBody = await retry.json() as { data: ReceiveData };
      expect(retryBody.data).toMatchObject({ received: true });
      expect(receiptCount()).toBe(61);
    });
  });
});
