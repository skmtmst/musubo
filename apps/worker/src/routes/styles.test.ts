import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { styles } from './styles.js';
import {
  styleSnapshot,
  readWindow,
  ratio,
  personMetrics,
} from '../services/style-analytics.js';
import { initializeAccountStyle } from '../services/style-setup.js';
import { eventModeRemaining } from '../services/event-mode-capacity.js';
const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(
    async (_d: unknown, _s: unknown, ids: string[]) =>
      ids.every((id) => id === 'a'),
  ),
  getVisibleLineAccountScope: vi.fn(async () => ({
    accounts: [{ id: 'a' }],
    allowedAccountIds: ['a'],
  })),
}));
vi.mock('../services/account-access.js', () => access);
let raw: Database.Database, db: D1Database, app: Hono<Env>;
let actor = {
  id: 'owner',
  tenantId: 'tenant',
  name: '店長',
  role: 'owner',
  readOnly: false,
  permissionKeys: [] as string[],
  viewPermissionKeys: [] as string[],
};
const env = () => ({ DB: db }) as Env['Bindings'];
const request = (method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env(),
  );
const root = '/api/dashboard/style';
const get = (suffix = '', account = 'a') =>
  request('GET', root + suffix + '?account_id=' + account);
const write = (suffix: string, body: unknown, method = 'PUT') =>
  request(method, root + suffix + '?account_id=a', body);
async function value(response: Response) {
  const data = (await response.json()) as any;
  return data;
}
function booking(
  id: string,
  start: string,
  status = 'confirmed',
  friend = 'f',
  staff = 's',
  extra: { requested?: string; price?: number } = {},
) {
  raw
    .prepare(
      `INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,requested_at,price_at_booking) VALUES(?,'a',?,?,'m',?,?,?,?,?,?)`,
    )
    .run(
      id,
      friend,
      staff,
      start,
      new Date(Date.parse(start) + 3600000).toISOString(),
      new Date(Date.parse(start) + 3600000).toISOString(),
      status,
      extra.requested ?? '2026-10-01T00:00:00Z',
      extra.price ?? 5000,
    );
}
function event(id = 'e', slot = 'slot') {
  raw
    .prepare(
      "INSERT INTO events(id,line_account_id,name,is_published) VALUES(?,'a','クラス',1)",
    )
    .run(id);
  raw
    .prepare(
      "INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity,is_active) VALUES(?,?,'2026-10-15T01:00:00Z','2026-10-15T02:00:00Z',10,1)",
    )
    .run(slot, id);
}
beforeEach(async () => {
  const fixture = createTestD1();
  raw = fixture.raw;
  db = fixture.db;
  raw.exec(`INSERT INTO tenants(id,name) VALUES('tenant','本部');INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret) VALUES('a','tenant','a','店A','token','secret'),('b','tenant','b','店B','token','secret');
 INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','店長','owner','key','tenant');
 INSERT INTO friends(id,line_user_id,line_account_id,display_name,is_following) VALUES('f','Uf','a','花子',1),('g','Ug','a','太郎',1),('foreign','Ux','b','別の店',1);
 INSERT INTO staff(id,line_account_id,name,display_name,staff_member_id,is_active) VALUES('s','a','担当A','担当A','owner',1),('other','b','担当B','担当B',NULL,1);
 INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('m','a','面談',60,5000);`);
  await initializeAccountStyle(db, 'a', 'tenant', 'owner');
  actor = {
    id: 'owner',
    tenantId: 'tenant',
    name: '店長',
    role: 'owner',
    readOnly: false,
    permissionKeys: [],
    viewPermissionKeys: [],
  };
  app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', actor as Env['Variables']['staff']);
    await next();
  });
  app.route('/', styles);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'));
});
afterEach(() => {
  raw.close();
  vi.useRealTimers();
});
describe('style setup', () => {
  test('new account has a standard sample without sending or enabling anything', async () => {
    const p = await value(await get());
    expect(p.data).toMatchObject({
      style: 'standard',
      styleSelected: false,
      shouldPromptStyleSelection: true,
      version: 1,
    });
    expect(
      raw
        .prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'")
        .get(),
    ).toEqual({ n: 5 });
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) n FROM automation_definitions WHERE status='active'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
  test('unknown legacy later stays deferred, while other answers keep a new selection pending', async () => {
    expect((await value(await get())).data.shouldPromptStyleSelection).toBe(true);
    expect((await write('', { expectedVersion: 1, answers: { booking: { mode: 'later' } } })).status).toBe(200);
    expect((await value(await get())).data.shouldPromptStyleSelection).toBe(true);
    raw.prepare("UPDATE account_styles SET answers_json=json_remove(answers_json,'$.style.selectionPending') WHERE line_account_id='a'").run();
    expect((await value(await get())).data).toMatchObject({ styleSelected: false, styleMode: 'later', shouldPromptStyleSelection: false });
  });
  test.each(['standard', 'restaurant', 'salon', 'consult', 'lesson', 'ec'])('explicit %s choice clears initial selection pending', async style => {
    expect((await write('', { expectedVersion: 1, style })).status).toBe(200);
    expect((await value(await get())).data).toMatchObject({ style, styleSelected: true, shouldPromptStyleSelection: false });
  });
  test('deferred and manual answers do not create resources; configured sample automations stay stopped', async () => {
    let r = await write('', {
      expectedVersion: 1,
      style: 'salon',
      answers: {
        booking: { mode: 'later' },
        reminders: { mode: 'manual' },
        stamps: { mode: 'later' },
      },
    });
    expect(r.status).toBe(200);
    expect(
      raw
        .prepare("SELECT COUNT(*) n FROM menus WHERE name LIKE '【見本】%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      raw.prepare('SELECT COUNT(*) n FROM automation_definitions').get(),
    ).toEqual({ n: 0 });
    r = await write('', {
      expectedVersion: 2,
      answers: {
        booking: { mode: 'configured', value: true },
        reminders: { mode: 'configured', value: true },
        approval: { mode: 'configured', value: 'manual' },
      },
    });
    expect(r.status).toBe(200);
    expect(
      raw.prepare("SELECT COUNT(*) n FROM reminders WHERE is_active=0 AND lifecycle_status='draft'").get(),
    ).toEqual({ n: 3 });
    expect(
      raw.prepare('SELECT approval_mode FROM booking_settings').get(),
    ).toBeUndefined();
    const count = (
      raw
        .prepare(
          "SELECT COUNT(*) n FROM style_starter_items WHERE line_account_id='a'",
        )
        .get() as any
    ).n;
    expect((await write('', { expectedVersion: 3 })).status).toBe(200);
    expect(
      (
        raw
          .prepare(
            "SELECT COUNT(*) n FROM style_starter_items WHERE line_account_id='a'",
          )
          .get() as any
      ).n,
    ).toBe(count);
    expect((await write('', { expectedVersion: 3 })).status).toBe(409);
  });
  test('restaurant exposes all eleven owner-approved questions and retains the new answers', async () => {
    const answers = {
      cancelDeadline: { mode: 'configured', value: 'day_before' },
      seats: { mode: 'configured', value: 'sample' },
      hours: { mode: 'configured', value: 'day' },
      partySize: { mode: 'configured', value: '1-6' },
      nomination: { mode: 'later' },
      assignment: { mode: 'manual' },
      classCapacity: { mode: 'configured', value: '8' },
    };
    expect(
      (await write('', { expectedVersion: 1, style: 'restaurant', answers }))
        .status,
    ).toBe(200);
    const state = (await value(await get())).data;
    expect(state.answers).toMatchObject(answers);
    expect(state.questions.map((q: any) => q.key)).toEqual([
      'style',
      'image',
      'approval',
      'payment',
      'cancelDeadline',
      'reminders',
      'stamps',
      'coupons',
      'seats',
      'hours',
      'partySize',
    ]);
    expect(
      state.questions.every(
        (q: any) =>
          q.canChangeLater &&
          q.modes.includes('later') &&
          q.modes.includes('manual'),
      ),
    ).toBe(true);
    expect(
      (
        await write('', {
          expectedVersion: 2,
          answers: { unknown: { mode: 'later' } },
        })
      ).status,
    ).toBe(400);
    expect((await value(await get())).data.version).toBe(2);
  });
  test('newly selected restaurant starts with the agreed menu features', async () => {
    const response = await write('', { expectedVersion: 1, style: 'restaurant' });
    expect(response.status).toBe(200);
    const row = raw.prepare("SELECT value FROM account_settings WHERE line_account_id='a' AND key='feature.settings_bundle_v1'").get() as { value: string };
    const saved = JSON.parse(row.value) as { data: { features: Record<string, boolean> } };
    expect(saved.data.features.restaurant_test).toBe(true);
    expect(saved.data.features.visit_stamps).toBe(true);
    expect(saved.data.features.events).toBe(false);
    expect(saved.data.features.webinars).toBe(false);
    expect(saved.data.features.automations).toBe(false);
    expect(saved.data.features.external_integrations).toBe(false);
  });
  test.each(['later', 'manual'])(
    'style %s persists without creating samples or enabling booking',
    async (mode) => {
      const before = raw
        .prepare('SELECT COUNT(*) n FROM style_starter_items')
        .get();
      expect(
        (
          await write('', {
            expectedVersion: 1,
            style: 'restaurant',
            styleMode: mode,
            answers: {
              approval: { mode: 'configured', value: 'manual' },
              booking: { mode: 'configured', value: true },
            },
          })
        ).status,
      ).toBe(200);
      expect((await value(await get())).data).toMatchObject({
        style: 'restaurant',
        styleMode: mode,
        styleSelected: false,
        shouldPromptStyleSelection: false,
        answers: { style: { mode } },
      });
      expect(
        raw.prepare('SELECT COUNT(*) n FROM style_starter_items').get(),
      ).toEqual(before);
      expect(
        raw.prepare('SELECT COUNT(*) n FROM booking_settings').get(),
      ).toEqual({ n: 0 });
      const warnings = (await value(await get('/warnings'))).data;
      expect(warnings[mode === 'later' ? 'pending' : 'manual']).toContainEqual(
        expect.objectContaining({ key: 'style' }),
      );
      expect(
        (await write('', { expectedVersion: 2, styleMode: 'configured' }))
          .status,
      ).toBe(200);
      expect((await value(await get())).data.styleSelected).toBe(true);
      expect(
        raw.prepare('SELECT COUNT(*) n FROM style_starter_items').get(),
      ).not.toEqual(before);
    },
  );
  test('deferring the style prevents activating existing booking samples', async () => {
    await write('', {
      expectedVersion: 1,
      style: 'salon',
      answers: { booking: { mode: 'configured', value: true } },
    });
    const menu = raw
      .prepare(
        "SELECT target_id id FROM style_starter_items WHERE kind='booking_menu'",
      )
      .get() as { id: string };
    const revision = raw
      .prepare('SELECT version FROM menus WHERE id=?')
      .get(menu.id) as { version: number };
    await write('', { expectedVersion: 2, styleMode: 'later' });
    const result = await value(
      await write(
        '/activate',
        {
          confirmed: true,
          items: [
            {
              id: menu.id,
              kind: 'booking_menu',
              expectedVersion: revision.version,
            },
          ],
        },
        'POST',
      ),
    );
    expect(result.data).toMatchObject({
      complete: false,
      items: [{ success: false, code: 'feature_unconfigured' }],
    });
    expect(
      raw.prepare('SELECT is_active FROM menus WHERE id=?').get(menu.id),
    ).toEqual({ is_active: 0 });
  });
  test('style answer mode is accepted, conflicts and invalid modes do not mutate the profile', async () => {
    expect(
      (
        await write('', {
          expectedVersion: 1,
          answers: { style: { mode: 'manual' } },
        })
      ).status,
    ).toBe(200);
    expect((await value(await get())).data.styleMode).toBe('manual');
    expect(
      (
        await write('', {
          expectedVersion: 2,
          styleMode: 'configured',
          answers: { style: { mode: 'later' } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await write('', { expectedVersion: 2, styleMode: 'invalid' })).status,
    ).toBe(400);
    expect((await value(await get())).data.version).toBe(2);
  });
  test('legacy selected profiles do not regain a pending style question', async () => {
    raw.exec(
      "UPDATE account_styles SET selection_mode='configured',selected_at='2026-10-15',answers_json='{}'",
    );
    expect((await value(await get())).data.answers.style).toEqual({
      mode: 'configured',
      value: 'standard',
    });
    expect(
      (await value(await get('/warnings'))).data.pending.some(
        (item: any) => item.key === 'style',
      ),
    ).toBe(false);
    expect(
      (
        await write('', {
          expectedVersion: 1,
          answers: { style: { mode: 'configured', value: 'restaurant' } },
        })
      ).status,
    ).toBe(200);
    expect((await value(await get())).data.style).toBe('restaurant');
    expect(
      (
        await write('', {
          expectedVersion: 2,
          style: 'salon',
          answers: { style: { mode: 'configured', value: 'restaurant' } },
        })
      ).status,
    ).toBe(400);
    expect((await value(await get())).data.version).toBe(2);
  });
  test('missing settings pages omit links while real pages keep their tabs', async () => {
    await write('', {
      expectedVersion: 1,
      style: 'restaurant',
      answers: {
        coupons: { mode: 'manual' },
        payment: { mode: 'manual' },
        tickets: { mode: 'manual' },
        cancelDeadline: { mode: 'manual' },
      },
    });
    const state = (await value(await get())).data;
    expect(
      state.questions.find((q: any) => q.key === 'payment'),
    ).toHaveProperty('changeAt', '/booking/menus?tab=payments');
    expect(
      state.questions.find((q: any) => q.key === 'cancelDeadline').changeAt,
    ).toBe('/booking/menus?tab=rules');
    const warnings = (await value(await get('/warnings'))).data;
    expect(
      warnings.manual.find((q: any) => q.key === 'coupons'),
    ).not.toHaveProperty('href');
    expect(
      warnings.manual.find((q: any) => q.key === 'payment'),
    ).toHaveProperty('href','/booking/menus?tab=payments');
    raw.exec(
      "INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size) VALUES('coupon-menu','a','メニュー','メニュー','large'); INSERT INTO rich_menu_pages(id,group_id,order_index,name,alias_id) VALUES('coupon-page','coupon-menu',0,'ページ','alias'); INSERT INTO rich_menu_areas(id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,label,intent,action_data) VALUES('coupon-area','coupon-page',0,0,100,100,'postback','クーポン','postback','{}')",
    );
    const couponWarnings = (await value(await get('/warnings'))).data.items;
    expect(
      couponWarnings.find((item: any) => item.feature === 'coupons'),
    ).not.toHaveProperty('href');
    expect(JSON.stringify({ state, warnings })).not.toMatch(
      /\/booking\/settings|\/booking\/tickets|\/line-accounts|"href":"\/coupons"/,
    );
  });
  test('reuse is restricted to the same account and is not marked as a sample', async () => {
    raw.exec(
      "INSERT INTO templates(id,line_account_id,name,message_type,message_content) VALUES('own','a','既存','text','{}'),('foreign-template','b','他店','text','{}')",
    );
    expect(
      (
        await write('', {
          expectedVersion: 1,
          style: 'salon',
          choices: {
            welcome: { mode: 'existing', resourceId: 'foreign-template' },
          },
        })
      ).status,
    ).toBe(404);
    expect((await value(await get())).data.version).toBe(1);
    const result = await value(
      await write('', {
        expectedVersion: 1,
        style: 'salon',
        choices: { welcome: { mode: 'configured', resourceId: 'own' } },
      }),
    );
    expect(result.data.inserted).toContainEqual(
      expect.objectContaining({ id: 'own', isSample: false }),
    );
  });
  test('invalid answers and hidden mandatory bands are rejected, order and reset persist', async () => {
    expect(
      (
        await write('', {
          expectedVersion: 1,
          answers: { nonsense: { mode: 'later' } },
        })
      ).status,
    ).toBe(400);
    await write('', { expectedVersion: 1, style: 'consult' });
    expect(
      (
        await write('/cards', {
          expectedVersion: 2,
          cards: [{ id: 'connection-alert', visible: false }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await write('/cards', {
          expectedVersion: 2,
          cards: [
            { id: 'staff', visible: true },
            { id: 'consultations', visible: true },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await value(await get())).data.cards[0]).toEqual({
      id: 'staff',
      visible: true,
    });
    expect(
      (await write('/cards', { expectedVersion: 3 }, 'DELETE')).status,
    ).toBe(200);
    expect((await value(await get())).data.cards[0]).toEqual({
      id: 'connection-alert',
      visible: true,
    });
  });
  test('unknown account and read-only mutation are rejected at route boundary', async () => {
    expect((await get('', 'b')).status).toBe(404);
    actor.readOnly = true;
    expect((await write('', { expectedVersion: 1 })).status).toBe(403);
    expect((await get()).status).toBe(200);
  });
  test('unconfigured existing menu buttons are counted with their setting destination', async () => {
    raw.exec(
      `INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size) VALUES('rm','a','メニュー','メニュー','large');INSERT INTO rich_menu_pages(id,group_id,order_index,name,alias_id) VALUES('page','rm',0,'ページ','alias');INSERT INTO rich_menu_areas(id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,action_data,label) VALUES('area','page',0,0,100,100,'message','ポイントカード','ポイントカード');`,
    );
    expect((await value(await get('/warnings'))).data).toMatchObject({
      count: 1,
      items: [
        {
          feature: 'stamps',
          areaId: 'area',
          href: '/visit-stamps',
          customerState: 'preparing',
        },
      ],
    });
  });
  test('HQ list returns style account count, last edit and auto insertion preference', async () => {
    const payload = {
      expectedVersion: 0,
      name: '初期セット',
      autoInsert: false,
      definition: {
        items: [
          { key: 'hello', kind: 'template', name: '案内', text: 'こんにちは' },
        ],
      },
    };
    expect(
      (await request('PUT', '/api/hq/style-starter-sets/restaurant', payload))
        .status,
    ).toBe(200);
    const before = raw
      .prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'")
      .get();
    await write('', { expectedVersion: 1, style: 'restaurant' });
    expect(
      raw
        .prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'")
        .get(),
    ).toEqual(before);
    const readSet = (
      await value(await request('GET', '/api/hq/style-starter-sets'))
    ).data[0];
    expect(readSet).toMatchObject({
      style: 'restaurant',
      accountCount: 1,
      autoInsert: false,
      updatedAt: '2026-10-15T03:00:00.000Z',
      updatedBy: 'owner',
      version: 1,
    });
    raw.exec(
      "UPDATE line_accounts SET tenant_id='other' WHERE id='b'; INSERT INTO account_styles(line_account_id,style,updated_at,selected_at) VALUES('b','restaurant','now','now')",
    );
    expect(
      (await value(await request('GET', '/api/hq/style-starter-sets'))).data[0]
        .accountCount,
    ).toBe(1);
    expect(
      (
        await request('PUT', '/api/hq/style-starter-sets/restaurant', {
          ...payload,
          expectedVersion: 1,
          autoInsert: 'false',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('PUT', '/api/hq/style-starter-sets/restaurant', {
          ...payload,
          expectedVersion: 1,
          autoInsert: true,
        })
      ).status,
    ).toBe(200);
    await write('', { expectedVersion: 2 });
    expect(
      raw
        .prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'")
        .get(),
    ).not.toEqual(before);
    // 後から内容を編集しても、省略した希望設定を消さない。
    const { autoInsert, ...withoutPreference } = payload;
    expect(
      (
        await request('PUT', '/api/hq/style-starter-sets/restaurant', {
          ...withoutPreference,
          expectedVersion: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (await value(await request('GET', '/api/hq/style-starter-sets'))).data[0]
        .autoInsert,
    ).toBe(true);
    actor.readOnly = true;
    expect(
      (
        await request('PUT', '/api/hq/style-starter-sets/restaurant', {
          ...payload,
          expectedVersion: 3,
        })
      ).status,
    ).toBe(403);
  });
  test('HQ starter overrides standard for this tenant only, with version checks', async () => {
    const payload = {
      expectedVersion: 0,
      name: '本部サロン',
      definition: {
        items: [
          {
            key: 'welcome',
            kind: 'template',
            name: '本部のごあいさつ',
            text: 'こんにちは',
          },
        ],
      },
    };
    const r = await request('PUT', '/api/hq/style-starter-sets/salon', payload);
    expect(r.status).toBe(200);
    const set = await value(
      await request('GET', root + '/starter-set?account_id=a&style=salon'),
    );
    expect(set.data.definition.items[0].name).toBe('本部のごあいさつ');
    expect(
      (await request('PUT', '/api/hq/style-starter-sets/salon', payload))
        .status,
    ).toBe(409);
    raw.exec(
      "UPDATE staff_members SET account_scope='accounts' WHERE id='owner'",
    );
    expect((await request('GET', '/api/hq/style-starter-sets')).status).toBe(
      403,
    );
  });
});
describe('industry metrics', () => {
  test('new bookings exclude cancelled records while using the creation date', async () => {
    booking('kept', '2026-10-16T01:00:00Z', 'confirmed', 'f', 's', { requested: '2026-10-15T01:30:00Z' });
    booking('cancelled', '2026-10-16T02:00:00Z', 'cancelled', 'f', 's', { requested: '2026-10-15T01:45:00Z' });
    const result = await styleSnapshot(db, 'a', 'salon', {});
    expect(result.metrics.newBookings.value).toBe(1);
    expect(result.newBookings.map(row => row.id)).toEqual(['kept']);
  });

  test('restaurant unseated counts the selected day including past starts, excluding departed, held, cancelled and no-show', async () => {
    raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org-count','a','架空店');
      INSERT INTO rt_stores(id,organization_id,line_account_id,name,code) VALUES('store-count','org-count','a','架空店','C');`);
    const insert = raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status,departed_at,hold_expires_at)
      VALUES (?, 'store-count', 'phone', '架空', 2, ?, ?, ?, ?, ?)`);
    insert.run('past', '2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z', 'confirmed', null, null);
    insert.run('future', '2026-10-15T05:00:00Z', '2026-10-15T06:00:00Z', 'confirmed', null, null);
    insert.run('tomorrow', '2026-10-16T01:00:00Z', '2026-10-16T02:00:00Z', 'confirmed', null, null);
    insert.run('no-show', '2026-10-15T06:00:00Z', '2026-10-15T07:00:00Z', 'no_show', null, null);
    insert.run('cancelled', '2026-10-15T06:00:00Z', '2026-10-15T07:00:00Z', 'cancelled', null, null);
    insert.run('departed', '2026-10-15T07:00:00Z', '2026-10-15T08:00:00Z', 'visited', '2026-10-15T08:30:00Z', null);
    insert.run('hold', '2026-10-15T08:00:00Z', '2026-10-15T09:00:00Z', 'pending', null, '2026-10-15T09:00:00Z');
    insert.run('linked', '2026-10-15T08:00:00Z', '2026-10-15T09:00:00Z', 'confirmed', null, null);
    raw.exec(`INSERT INTO rt_tables(id,store_id,code,label,seat_type,min_capacity,max_capacity)
      VALUES('linked-table','store-count','T1','T1','table',1,4);
      INSERT INTO rt_reservation_table_links(reservation_id,table_id) VALUES('linked','linked-table');`);
    const result = await styleSnapshot(db, 'a', 'restaurant', { range: 'today', date: '2026-10-15' });
    expect(result.metrics.unseated.value).toBe(2);
    const week = await styleSnapshot(db, 'a', 'restaurant', { range: 'week', date: '2026-10-15' });
    expect(week.metrics.unseated.value).toBe(3);
  });

  test('no-show help uses the configured period and keeps the same numerator and denominator', async () => {
    booking('recent-no-show', '2026-10-14T01:00:00Z', 'no_show');
    booking('older-confirmed', '2026-10-01T01:00:00Z');
    await write('', { expectedVersion: 1, style: 'salon', settings: { noShowDays: 7, minimumSample: 1 } });
    const snapshot = await styleSnapshot(db, 'a', 'salon', {});
    expect(snapshot.metrics.noShowRate).toMatchObject({
      value: 1, numerator: 1, denominator: 1,
      formula: '過去7日の無断 / （予約 − 取消 − 押さえ）',
    });
  });

  test('visit dates and newly-created dates are different and timezone days are honored', async () => {
    booking('today', '2026-10-15T01:00:00Z');
    booking('tomorrow', '2026-10-16T01:00:00Z', 'confirmed', 'g', 's', {
      requested: '2026-10-15T01:30:00Z',
    });
    booking('past', '2026-10-01T01:00:00Z', 'no_show');
    const result = await styleSnapshot(db, 'a', 'salon', {}, undefined);
    expect(result.items.map((r) => r.id)).toEqual(['today']);
    expect(result.newBookings.map((r) => r.id)).toEqual(['tomorrow']);
    expect(result.metrics.bookings.value).toBe(1);
    expect(result.metrics.estimatedRevenue.value).toBe(5000);
    expect(result.metrics.noShowRate.value).toBe(0.5);
    const tomorrow = await styleSnapshot(
      db,
      'a',
      'salon',
      { range: 'today', date: '2026-10-16' },
      undefined,
    );
    expect(tomorrow.items.map((r) => r.id)).toEqual(['tomorrow']);
    expect(
      readWindow({ range: 'week' }, 'Asia/Tokyo', Date.now()).fromDate,
    ).toBe('2026-10-12');
    expect(ratio(0, 0, 'test').value).toBeNull();
    expect(ratio(0, 3, 'test').value).toBe(0);
  });
  test('cancellations and payment holds are excluded from no-show denominator', async () => {
    booking('visited', '2026-10-12T01:00:00Z', 'completed');
    booking('no', '2026-10-13T01:00:00Z', 'no_show');
    booking('cancel', '2026-10-14T01:00:00Z', 'cancelled');
    const s = await styleSnapshot(db, 'a', 'salon', {
      from: '2026-10-01',
      to: '2026-10-16',
    });
    expect(s.metrics.noShowRate).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    });
    expect(s.analytics.periodMetrics).toMatchObject({
      estimatedRevenue: { value: 5000 },
    });
  });
  test('Meet の担当変更と復帰では確認版がそれぞれ進む', async () => {
    raw.exec("INSERT INTO meet_consultations(id,external_event_id,friend_id,title,starts_at,ends_at,meet_url,status,staff_id,updated_at) VALUES('solo','cal2','g','面談','2026-10-15T02:00:00Z','2026-10-15T02:30:00Z','https://meet.google.com/abc-defg-hij','confirmed','s','old')");
    const first = await write('/meet/solo', { expectedUpdatedAt: 'old', staffId: null }, 'PATCH');
    expect(first.status).toBe(200);
    const current = raw.prepare("SELECT updated_at,confirmation_revision FROM meet_consultations WHERE id='solo'").get() as { updated_at: string; confirmation_revision: number };
    expect(current.confirmation_revision).toBe(2);
    const second = await write('/meet/solo', { expectedUpdatedAt: current.updated_at, staffId: 's' }, 'PATCH');
    expect(second.status).toBe(200);
    expect(raw.prepare("SELECT confirmation_revision FROM meet_consultations WHERE id='solo'").get()).toEqual({ confirmation_revision: 3 });
  });

  test('Meet and person bookings merge into one timeline without linked duplicates; outcome is per booking', async () => {
    booking('b', '2026-10-15T01:00:00Z', 'completed');
    raw.exec(
      `INSERT INTO meet_consultations(id,external_event_id,friend_id,title,starts_at,ends_at,meet_url,booking_id,status) VALUES('linked','cal1','f','面談','2026-10-15T01:00:00Z','2026-10-15T02:00:00Z','https://meet.google.com/abc-defg-hij','b','confirmed'),('solo','cal2','g','面談','2026-10-15T02:00:00Z','2026-10-15T02:30:00Z','https://meet.google.com/abc-defg-hij',NULL,'confirmed');`,
    );
    const s = await styleSnapshot(db, 'a', 'consult', {});
    expect(s.items.map((r) => r.id)).toEqual(['b', 'solo']);
    expect(
      (
        await write(
          '/bookings/b',
          { expectedVersion: 0, outcome: 'won' },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    expect(
      raw
        .prepare("SELECT consultation_outcome FROM bookings WHERE id='b'")
        .get(),
    ).toEqual({ consultation_outcome: 'won' });
  });
  test('audience snapshots omit people without reachable LINE and reject foreign IDs', async () => {
    booking('b', '2026-10-15T01:00:00Z');
    const s = await styleSnapshot(db, 'a', 'salon', {});
    let r = await write(
      '/results/' + s.resultId + '/audiences',
      { friendIds: ['foreign'] },
      'POST',
    );
    expect(r.status).toBe(422);
    r = await write('/results/' + s.resultId + '/audiences', {}, 'POST');
    expect(r.status).toBe(201);
    expect((await value(r)).data).toMatchObject({
      memberCount: 1,
      unreachableCount: 0,
    });
    expect(
      raw.prepare('SELECT source_kind FROM analytics_result_audiences').get(),
    ).toEqual({ source_kind: 'booking' });
  });
  test('staff consultation summaries are restricted to own assignment', async () => {
    booking('b', '2026-10-15T01:00:00Z');
    actor.role = 'staff';
    actor.permissionKeys = ['/booking/bookings'];
    const ok = await request(
      'GET',
      root + '/summary?account_id=a&style=consult',
    );
    expect(ok.status).toBe(200);
    const denied = await request(
      'GET',
      root + '/summary?account_id=a&style=consult&staff_id=other',
    );
    expect(denied.status).toBe(403);
  });
  test('lesson attendance, membership tags, capacities and trial conversion', async () => {
    event();
    raw.exec(
      `UPDATE event_slots SET classroom_capacity=5,online_capacity=5,instructor_id='s';UPDATE events SET is_trial=1;INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb','a','e','slot','f','attended','2026-10-01T00:00:00Z');INSERT INTO tags(id,name,line_account_id) VALUES('member','会員','a');INSERT INTO friend_tags(friend_id,tag_id,assigned_at) VALUES('f','member','2026-10-15T02:30:00Z');`,
    );
    const s = await styleSnapshot(db, 'a', 'lesson', {});
    expect(s.metrics.classes.value).toBe(1);
    expect(s.metrics.capacity.value).toBe(10);
    expect(s.metrics.trialConversion.value).toBe(1);
  });
});
describe('classes, closure, and HQ attention', () => {
  test('人の予約とレッスン予約の編集は確認専用の版を進める', async () => {
    booking('person', '2026-10-15T01:00:00Z');
    expect((await write('/bookings/person', { expectedVersion: 0, outcome: 'won' }, 'PATCH')).status).toBe(200);
    expect(raw.prepare("SELECT confirmation_revision FROM bookings WHERE id='person'").get()).toEqual({ confirmation_revision: 2 });
    event();
    raw.exec("INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb','a','e','slot','f','confirmed','2026-10-01T00:00:00Z')");
    expect((await write('/event-bookings/eb', { participationMode: 'online' }, 'PATCH')).status).toBe(200);
    expect(raw.prepare("SELECT confirmation_revision FROM event_bookings WHERE id='eb'").get()).toEqual({ confirmation_revision: 2 });
  });

  test('休業の確認後に予約の版が変われば409、一致なら作成する', async () => {
    booking('b', '2026-10-15T01:00:00Z');
    const input = { date: '2026-10-15', target: 'store', staffIds: [], allDay: true, reason: '臨時休業' };
    const preview = await write('/closures/confirmation', input, 'POST');
    expect(preview.status).toBe(200);
    const first = (await value(preview)).data;
    expect(first.reservations).toHaveLength(1);
    expect((await write('/bookings/b', { expectedVersion: 0, outcome: 'won' }, 'PATCH')).status).toBe(200);
    const conflict = await write('/closures/confirmed', { ...input, expectedSnapshot: first.snapshot }, 'POST');
    expect(conflict.status).toBe(409);
    expect(raw.prepare('SELECT COUNT(*) n FROM booking_availability_exceptions').get()).toEqual({ n: 0 });
    const next = (await value(await write('/closures/confirmation', input, 'POST'))).data;
    expect((await write('/closures/confirmed', { ...input, expectedSnapshot: next.snapshot }, 'POST')).status).toBe(201);
  });

  test('複数担当の予約が変われば全件止まり、一致した確認は1回しか使えない', async () => {
    raw.exec("INSERT INTO staff(id,line_account_id,name,display_name,is_active) VALUES('s2','a','担当B','担当B',1)");
    booking('b1','2026-10-15T01:00:00Z','confirmed','f','s');
    booking('b2','2026-10-15T03:00:00Z','confirmed','g','s2');
    const input = { date:'2026-10-15', target:'staff', staffIds:['s','s2'], allDay:true, reason:'研修' };
    const first = (await value(await write('/closures/confirmation', input, 'POST'))).data;
    expect(first.reservations).toHaveLength(2);
    expect((await write('/bookings/b2',{expectedVersion:0,outcome:'won'},'PATCH')).status).toBe(200);
    expect((await write('/closures/confirmed',{...input,expectedSnapshot:first.snapshot},'POST')).status).toBe(409);
    expect(raw.prepare('SELECT COUNT(*) n FROM booking_availability_exceptions').get()).toEqual({n:0});
    const current=(await value(await write('/closures/confirmation',input,'POST'))).data;
    expect((await write('/closures/confirmed',{...input,expectedSnapshot:current.snapshot},'POST')).status).toBe(201);
    expect(raw.prepare('SELECT COUNT(*) n FROM booking_availability_exceptions').get()).toEqual({n:2});
    expect((await write('/closures/confirmed',{...input,expectedSnapshot:current.snapshot},'POST')).status).toBe(409);
    expect(raw.prepare('SELECT COUNT(*) n FROM booking_availability_exceptions').get()).toEqual({n:2});
  });

  test('予約が0件の確認後に新しい予約が入ったら休業を作らない', async () => {
    const input={date:'2026-10-15',target:'store',staffIds:[],allDay:true,reason:'臨時休業'};
    const first=(await value(await write('/closures/confirmation',input,'POST'))).data;
    expect(first.reservations).toHaveLength(0);
    booking('later','2026-10-15T01:00:00Z');
    const result=await write('/closures/confirmed',{...input,expectedSnapshot:first.snapshot},'POST');
    expect(result.status).toBe(409);
    expect((await value(result)).data.count).toBe(1);
    expect(raw.prepare('SELECT COUNT(*) n FROM booking_availability_exceptions').get()).toEqual({n:0});
  });

  test('separate class capacities are atomic and cannot shrink below occupied seats', async () => {
    event();
    expect(
      (
        await write(
          '/classes/slot',
          {
            expectedVersion: 1,
            classroomCapacity: 1,
            onlineCapacity: 2,
            instructorId: 's',
          },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    raw.exec(
      `INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb','a','e','slot','f','confirmed','2026-10-01T00:00:00Z');`,
    );
    expect(await eventModeRemaining(db, 'slot', 'classroom')).toBe(0);
    expect(await eventModeRemaining(db, 'slot', 'online')).toBe(2);
    const ignored = raw
      .prepare(
        `INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb2','a','e','slot','g','confirmed','2026-10-01T00:00:00Z')`,
      )
      .run();
    expect(ignored.changes).toBe(0);
    expect(
      (
        await write(
          '/classes/slot',
          { expectedVersion: 2, classroomCapacity: 0 },
          'PATCH',
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await write(
          '/event-bookings/eb',
          { participationMode: 'online' },
          'PATCH',
        )
      ).status,
    ).toBe(200);
  });
  test('members validate friend account, dates, reason and version', async () => {
    expect(
      (
        await write('/members/foreign', {
          expectedVersion: 0,
          joinedAt: '2026-10-01',
        })
      ).status,
    ).toBe(404);
    expect(
      (await write('/members/f', { expectedVersion: 0, joinedAt: 'bad' }))
        .status,
    ).toBe(400);
    expect(
      (
        await write('/members/f', {
          expectedVersion: 0,
          joinedAt: '2026-10-01',
          planName: '月会費',
          remainingUses: 4,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await write('/members/f', {
          expectedVersion: 0,
          joinedAt: '2026-10-01',
        })
      ).status,
    ).toBe(409);
  });
  test('store and staff hours use existing availability exceptions and preserve reservations', async () => {
    booking('b', '2026-10-15T01:00:00Z');
    raw.exec(
      "INSERT INTO booking_settings(id,line_account_id) VALUES('settings','a');INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time) VALUES('hours','settings',4,'09:00','18:00')",
    );
    let r = await write(
      '/closures',
      {
        date: '2026-10-15',
        target: 'store',
        allDay: false,
        startTime: '12:00',
        endTime: '13:00',
      },
      'POST',
    );
    expect(r.status).toBe(201);
    expect((await value(r)).data).toMatchObject({
      existingReservationsCancelled: false,
      exception: {
        kind: 'custom_hours',
        intervals: [
          { start: '09:00', end: '12:00' },
          { start: '13:00', end: '18:00' },
        ],
      },
    });
    expect(
      raw.prepare("SELECT status FROM bookings WHERE id='b'").get(),
    ).toEqual({ status: 'confirmed' });
    r = await write(
      '/closures',
      { date: '2026-10-16', target: 'staff', staffId: 'other', allDay: true },
      'POST',
    );
    expect(r.status).toBe(404);
  });
  test('HQ attention never includes an account outside visible scope', async () => {
    booking('b', '2026-10-15T01:00:00Z', 'requested');
    raw.exec(
      "INSERT INTO chats(id,friend_id,line_account_id,status,created_at,updated_at) VALUES('c','f','a','unread','2026-10-15','2026-10-15'),('hidden','foreign','b','unread','2026-10-15','2026-10-15')",
    );
    await write('', { expectedVersion: 1, style: 'salon' });
    raw.exec(
      "INSERT INTO line_account_connection_checks(id,line_account_id,check_kind,result,checked_at,checked_by,correlation_id,idempotency_key,account_revision) VALUES('check','a','webhook_test','failed','2026-10-15','owner','correlation','idempotency',1)",
    );
    const response = await request('GET', '/api/hq/style-attention');
    expect(response.status).toBe(200);
    const data = await value(response);
    expect(data.data.items).toHaveLength(1);
    expect(data.data.items[0]).toMatchObject({
      accountId: 'a',
      style: 'salon',
      counts: { unhandledChats: 1, pendingBookings: 1 },
      details: {
        connections: [{ id: 'check', href: '/accounts' }],
        pendingBookings: [{ id: 'b', href: '/booking/bookings' }],
      },
    });
  });
});

describe('style additions contract', () => {
  test('metadata can be read back, outcomes update the current-person tag, and foreign resources stay hidden', async () => {
    booking('booking', '2026-10-15T01:00:00Z');
    let r = await write(
      '/menus/m',
      {
        expectedVersion: 1,
        meetingMode: 'customer_choice',
        location: '面談室',
      },
      'PATCH',
    );
    expect(r.status).toBe(200);
    expect((await value(await get('/menus/m'))).data).toMatchObject({
      meetingMode: 'customer_choice',
      location: '面談室',
      version: 2,
    });
    r = await write(
      '/bookings/booking',
      {
        expectedVersion: 0,
        outcome: 'won',
        designation: 'designated',
        entryPoint: 'rich_menu',
        cancellationReason: '日程変更',
      },
      'PATCH',
    );
    expect(r.status).toBe(200);
    expect((await value(await get('/bookings/booking'))).data).toMatchObject({
      outcome: 'won',
      version: 1,
      designation: 'designated',
      entryPoint: 'rich_menu',
    });
    expect(
      raw
        .prepare(
          `SELECT name FROM tags t JOIN friend_tags f ON f.tag_id=t.id WHERE f.friend_id='f'`,
        )
        .all(),
    ).toEqual([{ name: '面談：成約' }]);
    expect(
      (
        await write(
          '/menus/nope',
          { expectedVersion: 1, meetingMode: 'online' },
          'PATCH',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await write(
          '/bookings/booking',
          {
            expectedVersion: 1,
            meetingUrl: 'https://meet.google.com/abc-defg-hij',
          },
          'PATCH',
        )
      ).status,
    ).toBe(422);
  });
  test('trial, waitlist mode, holidays and targets persist with validation', async () => {
    event();
    expect((await get('/classes/slot')).status).toBe(200);
    expect(
      (await write('/events/e', { expectedVersion: 1, isTrial: true }, 'PATCH'))
        .status,
    ).toBe(200);
    raw.exec(
      `INSERT INTO event_waitlist(id,line_account_id,event_id,slot_id,friend_id,identity_key,status,created_at,updated_at) VALUES('wait','a','e','slot','f','f','waiting','2026-10-15','2026-10-15')`,
    );
    expect(
      (
        await write(
          '/event-waitlist/wait',
          { expectedVersion: 1, participationMode: 'online' },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    expect((await write('/holidays/2026-10-15', { name: '休み' })).status).toBe(
      200,
    );
    expect(
      (
        await write('/targets', {
          metric: 'bookings',
          period: '2026-10',
          value: 100,
        })
      ).status,
    ).toBe(200);
    expect((await value(await get('/analytics-settings'))).data).toMatchObject({
      holidays: [{ date: '2026-10-15', name: '休み' }],
      targets: [{ metric: 'bookings', period: '2026-10', value: 100 }],
    });
    expect(
      (
        await write('/targets', {
          metric: 'bookings',
          period: '2026-10',
          value: -1,
        })
      ).status,
    ).toBe(400);
  });
  test('membership joins/withdrawals synchronize the member tag without deleting attendance', async () => {
    await write('/members/f', { expectedVersion: 0, joinedAt: '2026-10-01' });
    expect(
      raw
        .prepare(
          `SELECT name FROM tags t JOIN friend_tags f ON f.tag_id=t.id WHERE f.friend_id='f'`,
        )
        .all(),
    ).toEqual([{ name: '会員' }]);
    expect((await get('/members')).status).toBe(200);
    await write('/members/f', {
      expectedVersion: 1,
      joinedAt: '2026-10-01',
      endedAt: '2026-10-15',
      withdrawalReason: '転居',
    });
    expect(
      raw
        .prepare(
          `SELECT name FROM tags t JOIN friend_tags f ON f.tag_id=t.id WHERE f.friend_id='f'`,
        )
        .all(),
    ).toEqual([]);
  });
  test('small samples use null while zero stays a measured value, and holiday filters use store dates', async () => {
    booking('b', '2026-10-15T01:00:00Z');
    await write('', {
      expectedVersion: 1,
      style: 'salon',
      settings: { minimumSample: 5 },
    });
    await write('/holidays/2026-10-15', { name: '祝日' });
    const s = await styleSnapshot(db, 'a', 'salon', {});
    expect(s.metrics.noShowRate).toMatchObject({
      value: null,
      status: 'insufficient_sample',
      denominator: 1,
    });
    expect(s.metrics.bookings.value).toBe(1);
    const filtered = await styleSnapshot(db, 'a', 'salon', {
      holidays: 'exclude',
    });
    expect(filtered.items).toEqual([]);
    expect(
      (
        await request(
          'GET',
          root + '/summary?account_id=a&style=salon&date=invalid',
        )
      ).status,
    ).toBe(400);
  });
  test('activation uses canonical draft versions and never publishes a rich menu or sends LINE', async () => {
    raw.prepare(`INSERT INTO style_starter_sets(id,tenant_id,style,name,definition_json,updated_at) VALUES('thankyou','tenant','salon','お礼',?,'now')`).run(JSON.stringify({items:[{key:'thanks',kind:'automation',feature:'reminders',name:'来店のお礼',text:'ありがとうございました。',triggerType:'restaurant.departed'}]}));
    await write('', {
      expectedVersion: 1,
      style: 'salon',
      answers: { reminders: { mode: 'configured', value: true } },
    });
    const data = (await value(await get('/starter-items'))).data;
    const item = data.items.find((i: any) => i.kind === 'automation');
    expect(item.status).toBe('draft');
    expect(item.draftRevision).toContain('.');
    const result = await value(
      await write(
        '/activate',
        {
          confirmed: true,
          items: [
            {
              id: item.target_id,
              kind: 'automation',
              expectedDraftVersionId: item.draftRevision,
            },
          ],
        },
        'POST',
      ),
    );
    expect(result.data).toMatchObject({
      complete: true,
      items: [{ success: true, status: 'active' }],
    });
    expect(
      raw.prepare('SELECT COUNT(*) count FROM messages_log').get(),
    ).toEqual({ count: 0 });
    expect(
      (
        await write(
          '/activate',
          { confirmed: true, items: [{ id: 'foreign', kind: 'automation' }] },
          'POST',
        )
      ).status,
    ).toBe(404);
  });
});

test('restaurant counts include guests, staff assignment and real closure-aware table availability', async () => {
  raw.exec(
    `INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','店');INSERT INTO rt_stores(id,organization_id,line_account_id,name,code) VALUES('store','org','a','店','STORE');INSERT INTO rt_tables(id,store_id,code,label,seat_type,min_capacity,max_capacity) VALUES('table','store','T','T','table',1,4);INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,staff_id) VALUES('r','store','line','花子','Uf',2,'2026-10-15T01:00:00Z','2026-10-15T05:00:00Z','table','confirmed','s');`,
  );
  const data = await styleSnapshot(db, 'a', 'restaurant', {}, 's');
  expect(data.items).toHaveLength(1);
  expect(data.items[0]).toMatchObject({
    meetingMode: null,
    outcome: null,
    attendance: null,
  });
  expect(data.metrics.guests.value).toBe(2);
  expect(data.metrics.freeTables.value).toBe(0);
  expect(data.analytics.rotationSummary).toMatchObject({
    averageStayMinutes: null,
  });
  raw.exec(
    `UPDATE tenants SET feature_packs='["restaurant"]' WHERE id='tenant'`,
  );
  const r = await app.request(
    root + '/restaurant-reservations/r?account_id=a',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, staffId: null }),
    },
    { DB: db, RESTAURANT_TEST_ENABLED: 'true', DEPLOY_ENV:'test' } as Env['Bindings'],
  );
  expect(r.status).toBe(200);
  expect((await styleSnapshot(db, 'a', 'restaurant', {}, 's')).items).toEqual(
    [],
  );
});

test('salon next-booking KPI uses the past 30 days and a reservation created after the visit ends', async () => {
  booking('visit1', '2026-10-10T01:00:00Z', 'completed', 'f');
  booking('visit2', '2026-10-12T01:00:00Z', 'completed', 'g');
  booking('next', '2026-10-20T01:00:00Z', 'confirmed', 'f', 's', {
    requested: '2026-10-10T03:00:00Z',
  });
  const s = await styleSnapshot(db, 'a', 'salon', {});
  expect(s.items).toEqual([]);
  expect(s.metrics.nextBookingRate).toMatchObject({
    value: 0.5,
    numerator: 1,
    denominator: 2,
  });
});
test('reminder delivery comparison uses sent records separately from the confirmation response', async () => {
  booking('absent', '2026-10-15T01:00:00Z', 'no_show');
  booking('other', '2026-10-15T02:00:00Z', 'confirmed', 'g');
  raw.exec(
    `INSERT INTO booking_reminders(id,booking_id,kind,scheduled_at,status,sent_at) VALUES('reminder','absent','day_before','2026-10-14T01:00:00Z','sent','2026-10-14T01:00:00Z')`,
  );
  const s = await styleSnapshot(db, 'a', 'salon', {});
  expect(s.analytics.reminderDeliveryComparison).toMatchObject([
    { sent: true, noShowRate: { value: 1, numerator: 1, denominator: 1 } },
    { sent: false, noShowRate: { value: 0, numerator: 0, denominator: 1 } },
  ]);
});

test('changing an answer back to later keeps an old booking sample stopped during bulk activation', async () => {
  await write('', {
    expectedVersion: 1,
    style: 'salon',
    answers: { booking: { mode: 'configured', value: true } },
  });
  const item = (await value(await get('/starter-items'))).data.items.find(
    (i: any) => i.kind === 'booking_menu',
  );
  await write('', {
    expectedVersion: 2,
    answers: { booking: { mode: 'later' } },
  });
  const r = await value(
    await write(
      '/activate',
      {
        confirmed: true,
        items: [
          { id: item.target_id, kind: 'booking_menu', expectedVersion: 1 },
        ],
      },
      'POST',
    ),
  );
  expect(r.data).toMatchObject({
    complete: false,
    items: [{ success: false, code: 'feature_unconfigured' }],
  });
  expect(
    raw.prepare('SELECT is_active FROM menus WHERE id=?').get(item.target_id),
  ).toEqual({ is_active: 0 });
});

test('deferring content does not add new templates or rich menus for the selected style', async () => {
  const result = await value(
    await write('', {
      expectedVersion: 1,
      style: 'consult',
      answers: { content: { mode: 'later' } },
    }),
  );
  expect(result.data.inserted).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'template' })]),
  );
  expect(result.data.inserted).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'rich_menu' })]),
  );
  expect(
    raw
      .prepare("SELECT COUNT(*) n FROM templates WHERE line_account_id='a'")
      .get(),
  ).toEqual({ n: 5 });
});
