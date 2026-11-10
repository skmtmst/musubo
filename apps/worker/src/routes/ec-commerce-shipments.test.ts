import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { ecCommerce } from './ec-commerce.js';

/**
 * 出荷予定エンドポイントの検証。
 *
 * D1 は用意せず、prepare/bind/all だけを備えた最小の偽物を渡す。
 * 見たいのは「payload から取り出した値が、どう組み立てられて返るか」で、
 * SQL の実行そのものではない。出荷予定日の算出は @line-crm/shared 側の
 * テストで押さえてある。
 */

type Row = Record<string, unknown>;

function dbReturning(rows: Row[]) {
  return {
    prepare(sql: string) {
      const statement = {
        bind() { return statement; },
        all: async () => ({ results: sql.includes('FROM line_accounts') ? [] : rows }),
      };
      return statement;
    },
  };
}

async function callShipments(rows: Row[], query = '') {
  // 注文内容を含むため、閲覧はスタッフ以上に限定した。ここで見たいのは
  // payload の組み立てなので、認証は通った状態にしてから渡す。
  // 権限そのものの検証は middleware/role-guard.test.ts が持つ。
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'env-owner', name: 'Staff', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', ecCommerce);
  const res = await app.request(`/api/ec-commerce/shipments${query}`, {}, {
    DB: dbReturning(rows),
  } as never);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  return body.data;
}

function orderRow(over: Row = {}): Row {
  return {
    id: 'evt-1',
    event_type: 'ec.order.confirmed',
    friend_id: 'f-1',
    friend_name: '見本 48',
    received_at: '2026-08-14T09:00:00+09:00',
    order_number: 'NEN-1001',
    occurred_at: '2026-08-14T09:00:00+09:00',
    scheduled_shipping_date: null,
    order_items: JSON.stringify([{ name: '鹿肉ミンチ', quantity: 2 }]),
    subscription_items: null,
    ...over,
  };
}

describe('GET /api/ec-commerce/shipments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('通常注文は注文日時から出荷予定日を算出する', async () => {
    const data = await callShipments([orderRow()]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all).toHaveLength(1);
    // 2026-08-14 は金曜の午前 → 当日
    expect(all[0].shipDate).toBe('2026-08-14');
    expect(all[0].shipDateSource).toBe('ordered_at');
    expect(all[0].orderNumber).toBe('NEN-1001');
    expect(all[0].items).toBe('鹿肉ミンチ × 2');
    expect(all[0].quantity).toBe(2);
  });

  it('定期便は EC 側の発送予定日をそのまま使う', async () => {
    const data = await callShipments([
      orderRow({
        id: 'evt-2',
        event_type: 'ec.subscription.upcoming',
        scheduled_shipping_date: '2026-08-31',
        occurred_at: '2026-08-14T09:00:00+09:00',
      }),
    ]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all[0].shipDate).toBe('2026-08-31');
    expect(all[0].shipDateSource).toBe('subscription');
  });

  it('定期便の商品は subscription.items を優先し、無ければ order.items へ落とす', async () => {
    const withSubscriptionItems = await callShipments([
      orderRow({
        event_type: 'ec.subscription.upcoming',
        scheduled_shipping_date: '2026-08-31',
        subscription_items: JSON.stringify([{ name: '猪肉スライス', quantity: 1 }]),
        order_items: JSON.stringify([{ name: '鹿肉ミンチ', quantity: 2 }]),
      }),
    ]);
    const withItems = [
      ...(withSubscriptionItems.soon as Row[]),
      ...(withSubscriptionItems.later as Row[]),
    ];
    expect(withItems[0].items).toBe('猪肉スライス × 1');

    const withoutSubscriptionItems = await callShipments([
      orderRow({
        event_type: 'ec.subscription.upcoming',
        scheduled_shipping_date: '2026-08-31',
        subscription_items: null,
        order_items: JSON.stringify([{ name: '鹿肉ミンチ', quantity: 2 }]),
      }),
    ]);
    const withoutItems = [
      ...(withoutSubscriptionItems.soon as Row[]),
      ...(withoutSubscriptionItems.later as Row[]),
    ];
    expect(withoutItems[0].items).toBe('鹿肉ミンチ × 2');
  });

  it('商品情報がどちらにも無くても壊れない', async () => {
    const data = await callShipments([orderRow({ order_items: null, subscription_items: null })]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all).toHaveLength(1);
    expect(all[0].items).toBe('');
    expect(all[0].itemCount).toBe(0);
  });

  it('壊れたJSONでも落ちない', async () => {
    const data = await callShipments([orderRow({ order_items: '{壊れている' })]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all[0].items).toBe('');
  });

  it('3件以上の商品は「ほかN点」にまとめる', async () => {
    const data = await callShipments([
      orderRow({
        order_items: JSON.stringify([
          { name: 'A', quantity: 1 },
          { name: 'B', quantity: 2 },
          { name: 'C', quantity: 3 },
          { name: 'D', quantity: 4 },
        ]),
      }),
    ]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all[0].items).toBe('A × 1、B × 2 ほか2点');
    expect(all[0].itemCount).toBe(4);
    expect(all[0].quantity).toBe(10);
  });

  it('出荷予定日が決まらない行は返さない', async () => {
    const data = await callShipments([
      orderRow({ occurred_at: 'これは日付ではない', received_at: 'これも日付ではない' }),
    ]);
    expect(data.soon).toHaveLength(0);
    expect(data.later).toHaveLength(0);
  });

  it('occurred_at が欠けていれば received_at で代替する', async () => {
    const data = await callShipments([
      orderRow({ occurred_at: null, received_at: '2026-08-14T09:00:00+09:00' }),
    ]);
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all[0].shipDate).toBe('2026-08-14');
  });

  it('過去の注文は今日・明日の出荷予定へ混ぜない', async () => {
    const data = await callShipments([
      orderRow({
        occurred_at: '2026-08-13T09:00:00+09:00',
        received_at: '2026-08-13T09:00:00+09:00',
      }),
      orderRow({
        id: 'today',
        occurred_at: '2026-08-14T09:00:00+09:00',
        received_at: '2026-08-14T09:00:00+09:00',
      }),
    ]);

    expect((data.soon as Row[]).map((row) => row.id)).toEqual(['today']);
    expect(data.later).toHaveLength(0);
    expect(data.soonCount).toBe(1);
  });

  it('出荷予定日の早い順に並ぶ', async () => {
    const data = await callShipments([
      orderRow({ id: 'a', event_type: 'ec.subscription.upcoming', scheduled_shipping_date: '2026-09-30' }),
      orderRow({ id: 'b', event_type: 'ec.subscription.upcoming', scheduled_shipping_date: '2026-09-01' }),
      orderRow({ id: 'c', event_type: 'ec.subscription.upcoming', scheduled_shipping_date: '2026-09-15' }),
    ]);
    // 実行日が予定日に近づくと先頭行は「今日・明日」へ移る。区分に依存せず、
    // 返事全体で日付順が保たれることを確認する。
    const all = [...(data.soon as Row[]), ...(data.later as Row[])];
    expect(all.map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('走査した件数と上限を返す（取りこぼしの判断に使う）', async () => {
    /*
     * 走査の下限は200件（DASH-22）。明細の表示件数 limit=5 に合わせて
     * 走査を25件へ縮めると、上部カードの「今日の件数」が過少になる。
     */
    const data = await callShipments([orderRow()], '?limit=5');
    expect(data.scanned).toBe(1);
    expect(data.scanLimit).toBe(200);
  });
});
