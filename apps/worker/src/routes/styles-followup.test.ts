import {
  featureReadiness,
  profile,
  saveProfile,
} from '../services/style-setup.js';
import {
  styleSnapshot,
  styleRows,
  personMetrics,
} from '../services/style-analytics.js';
import {
  resourceSnapshot,
  snapshotGuard,
} from '../services/style-starter-resource.js';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ACCOUNT_STYLES,
  findUnsupportedInterpolations,
} from '@line-crm/shared';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { styles } from './styles.js';
import { hqTemplates } from './hq-templates.js';
import type { Env } from '../worker-env.js';
import { permissionForApiPath } from '../middleware/auth.js';
import * as googleCalendar from '../features/booking/booking-calendar-sync.js';
import { readWindow, instant } from '../services/style-analytics.js';
import {
  initializeAccountStyle,
  standardStarter,
} from '../services/style-setup.js';
import { templateSamples } from '../services/style-template-samples.js';
import {
  openSeatTables,
  openSeatTablePeriods,
} from '../services/restaurant-closures.js';

vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: async () => ({
    accounts: [{ id: 'a' }],
    allowedAccountIds: ['a'],
    canSeeUnassigned: false,
  }),
  canAccessAllLineAccounts: async (_db: unknown, _s: unknown, ids: string[]) =>
    ids.every((id) => id === 'a'),
}));
let sql: ReturnType<typeof createTestD1>,
  app: Hono<Env>,
  actor: Env['Variables']['staff'];
const base = '/api/dashboard/style';
async function request(path: string, method = 'GET', body?: unknown) {
  const r = await app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      DB: sql.db,
      RESTAURANT_TEST_ENABLED: 'true',
      DEPLOY_ENV: 'test',
      IMAGES: { head: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn() },
    } as unknown as Env['Bindings'],
  );
  return { status: r.status, body: (await r.json()) as any };
}
beforeEach(async () => {
  sql = createTestD1({ foreignKeys: true, now: () => new Date() });
  sql.raw
    .exec(`INSERT INTO tenants(id,name,feature_packs) VALUES('t','本部','["restaurant"]');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret) VALUES('a','t','a','店A','fixture','fixture'),('b','t','b','店B','fixture','fixture');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','店長','owner','fixture','t');
    INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('f','Uf','a','花子');
    INSERT INTO staff(id,line_account_id,name,display_name,staff_member_id) VALUES('s','a','担当A','担当A','owner'),('s2','a','担当B','担当B',NULL),('foreign','b','他店','他店',NULL);
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('m','a','面談',60,5000);
    INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('s','m',1);
    INSERT INTO booking_settings(id,line_account_id,business_hours_configured,cutoff_minutes_before) VALUES('settings','a',1,0);
    INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time) VALUES('h','settings',4,'09:00','18:00');
    INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES('rule','s',4,'09:00','18:00');`);
  await initializeAccountStyle(sql.db, 'a', 't', 'owner');
  actor = {
    id: 'owner',
    name: '店長',
    tenantId: 't',
    role: 'owner',
    readOnly: false,
  } as Env['Variables']['staff'];
  app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', actor);
    await next();
  });
  app.route('/', styles);
  app.route('/', hqTemplates);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'));
});
afterEach(() => {
  vi.restoreAllMocks();
  sql.raw.close();
  vi.useRealTimers();
});

const setup = (body: Record<string, unknown>) =>
  request(base + '?account_id=a', 'PUT', body);
const hqPath = '/api/hq/style-starter-sets/salon';
async function setDefinition(items: unknown[], version = 0) {
  const r = await request(hqPath, 'PUT', {
    expectedVersion: version,
    name: '本部の見本',
    definition: { items },
  });
  expect(r.status).toBe(200);
  return r.body.data;
}
async function preflight(version: number, target = { accountIds: ['a'] }) {
  const r = await request(hqPath + '/preflight', 'POST', {
    expectedVersion: version,
    target,
  });
  expect(r.status).toBe(200);
  return r.body.data;
}
const template = (text = '最初の文') => ({
  key: 'hq-welcome',
  kind: 'template',
  name: 'ごあいさつ',
  text,
});
const booking = (
  id: string,
  date = '2026-10-15T01:00:00Z',
  friend = 'f',
  status = 'confirmed',
) =>
  sql.raw
    .prepare(
      `INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at) VALUES(?,'a',?,'s','m',?,?,?,?,5000,'2026-10-01T00:00:00Z')`,
    )
    .run(
      id,
      friend,
      date,
      new Date(Date.parse(date) + 3600000).toISOString(),
      new Date(Date.parse(date) + 3600000).toISOString(),
      status,
    );
function restaurant() {
  sql.raw
    .exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('o','a','店');
 INSERT INTO rt_stores(id,organization_id,line_account_id,name,code) VALUES('store','o','a','お店','shop');
 INSERT INTO rt_tables(id,store_id,code,label,seat_type,max_capacity) VALUES('table','store','T','卓','table',4);
 INSERT INTO rt_opening_hours_settings(store_id,updated_by,hours_json) VALUES('store','owner','[{"weekday":4,"periods":[{"opensAt":"09:00","closesAt":"18:00"}]}]');
 INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,allergy_note) VALUES('r','store','line','花子','Uf',2,'2026-10-15T04:00:00Z','2026-10-15T06:00:00Z','table','卵');`);
}

describe('safety regressions', () => {
  test('unchanged answers never overwrite booking settings; only changed answers are proposed', async () => {
    const first = await setup({
      expectedVersion: 1,
      style: 'salon',
      answers: { approval: { mode: 'configured', value: 'manual' } },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.changedAnswers).toEqual({
      approval: { mode: 'configured', value: 'manual' },
    });
    expect(
      sql.raw
        .prepare('SELECT approval_mode,version FROM booking_settings')
        .get(),
    ).toEqual({ approval_mode: 'automatic', version: 1 });
    const second = await setup({
      expectedVersion: 2,
      answers: { approval: { mode: 'configured', value: 'manual' } },
    });
    expect(second.body.data.changedAnswers).toEqual({});
    expect(second.body.data.bookingSettingsChanges).toEqual([]);
    expect(
      sql.raw
        .prepare('SELECT approval_mode,version FROM booking_settings')
        .get(),
    ).toEqual({ approval_mode: 'automatic', version: 1 });
  });
  test('no confirmation automation; native reminder drafts are stopped and test-gated', async () => {
    const r = await setup({
      expectedVersion: 1,
      style: 'salon',
      answers: { reminders: { mode: 'configured', value: true } },
    });
    expect(r.status).toBe(200);
    expect(
      sql.raw.prepare('SELECT COUNT(*) n FROM automation_definitions').get(),
    ).toEqual({ n: 0 });
    expect(
      sql.raw
        .prepare(
          "SELECT COUNT(*) n FROM reminders WHERE is_active=0 AND lifecycle_status='draft'",
        )
        .get(),
    ).toEqual({ n: 3 });
    expect(
      sql.raw
        .prepare(
          'SELECT offset_minutes FROM reminder_version_steps ORDER BY offset_minutes',
        )
        .all(),
    ).toEqual([
      { offset_minutes: -1440 },
      { offset_minutes: -120 },
      { offset_minutes: 1440 },
    ]);
    const item = (
      await request(base + '/starter-items?account_id=a')
    ).body.data.items.find((i: any) => i.kind === 'reminder');
    expect(item).toMatchObject({
      key: 'reminder-day-before',
      isSample: true,
      setId: 'musubo:salon',
      setVersion: 1,
      status: 'draft',
    });
    const activate = await request(base + '/activate?account_id=a', 'POST', {
      confirmed: true,
      items: [
        {
          id: item.target_id,
          kind: 'reminder',
          expectedDraftVersionId: item.draftRevision,
        },
      ],
    });
    expect(activate.body.data.items).toEqual([
      { id: item.target_id, success: false, code: 'test_required' },
    ]);
    expect(
      sql.raw.prepare('SELECT COUNT(*) n FROM messages_log').get(),
    ).toEqual({ n: 0 });
  });
  test('first deferred selection keeps standard samples and explicit foreign reuse still fails', async () => {
    const before = sql.raw
      .prepare('SELECT COUNT(*) n FROM templates')
      .get() as { n: number };
    await setup({ expectedVersion: 1, style: 'restaurant' });
    await setup({ expectedVersion: 2, style: 'salon' });
    expect(sql.raw.prepare('SELECT COUNT(*) n FROM templates').get()).toEqual({
      n: before.n + 21,
    });
    expect(
      sql.raw
        .prepare(
          "SELECT COUNT(*) n FROM style_starter_items WHERE item_key='welcome'",
        )
        .get(),
    ).toEqual({ n: 2 });
    sql.raw.exec(
      "INSERT INTO templates(id,line_account_id,name,message_type,message_content) VALUES('foreign','b','他店','text','{}')",
    );
    expect(
      (
        await setup({
          expectedVersion: 3,
          choices: { welcome: { mode: 'existing', resourceId: 'foreign' } },
        })
      ).status,
    ).toBe(404);
  });
  test('native booking readiness uses tables, classes and offered staff respectively', async () => {
    restaurant();
    await setup({ expectedVersion: 1, style: 'restaurant' });
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(true);
    sql.raw.exec('UPDATE rt_tables SET is_active=0');
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(false);
    await setup({ expectedVersion: 2, style: 'lesson' });
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(false);
    sql.raw.exec(
      `INSERT INTO events(id,line_account_id,name,is_published) VALUES('e','a','教室',1);INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES('slot','e','2026-10-15T01:00:00Z','2026-10-15T02:00:00Z',3)`,
    );
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(true);
    await setup({ expectedVersion: 3, style: 'salon' });
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(true);
    sql.raw.exec('UPDATE staff_menus SET is_offered=0');
    expect((await featureReadiness(sql.db, 'a', 'booking')).ready).toBe(false);
  });
  test('switching styles preserves every reservation in summary and calendar', async () => {
    restaurant();
    booking('old');
    sql.raw.exec(
      `INSERT INTO events(id,line_account_id,name,is_published) VALUES('e','a','教室',1);INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES('slot','e','2026-10-15T01:00:00Z','2026-10-15T02:00:00Z',3);INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb','a','e','slot','f','confirmed','2026-10-01T00:00:00Z')`,
    );
    for (const style of ['restaurant', 'salon', 'consult', 'lesson']) {
      const summary = await request(
        base + '/summary?account_id=a&style=' + style,
      );
      expect(summary.status).toBe(200);
      expect(summary.body.data.items.map((i: any) => i.id).sort()).toEqual([
        'eb',
        'old',
        'r',
      ]);
      const schedule = await request(
        base + '/schedule?account_id=a&style=' + style + '&display=calendar',
      );
      expect(schedule.status).toBe(200);
      const ids = schedule.body.data.entries
        .filter((i: any) => i.booking)
        .map((i: any) => i.booking.id);
      expect(ids.sort()).toEqual(['eb', 'old', 'r']);
    }
  });
  test('canonical starter buttons match the saved four areas', async () => {
    await setup({
      expectedVersion: 1,
      style: 'consult',
      answers: {
        content: { mode: 'configured', value: true },
        image: { mode: 'configured', value: 'simple' },
        booking: { mode: 'configured', value: true },
      },
    });
    const set = await request(base + '/starter-set?account_id=a&style=consult');
    const declared = set.body.data.preview.find((i: any) => i.key === 'menu').buttons;
    const actual = sql.raw
      .prepare(
        `SELECT a.label FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id JOIN rich_menu_groups g ON g.id=p.group_id WHERE g.account_id='a' ORDER BY a.bounds_y,a.bounds_x`,
      )
      .all();
    // 元の下書き ID を維持し、未編集の業種内容だけを更新する。
    expect(declared.map((b: any) => b.label)).toEqual(['面談を予約する','予約の確認と変更','ご相談内容を送る','会社のこと']);
    expect(actual).toEqual(declared.map((b: any) => ({ label: b.label })));
  });
});

describe('HQ distribution and provenance', () => {
  test('同じキーの標準とサロンがある時、統括の配布はサロンだけを更新する', async () => {
    const item = { ...template('サロン初版'), key: 'welcome' };
    await setDefinition([item]);
    const standard = sql.raw.prepare("SELECT target_id FROM style_starter_items WHERE line_account_id='a' AND style='standard' AND item_key='welcome'").get() as { target_id: string };
    const original = sql.raw.prepare('SELECT * FROM templates WHERE id=?').get(standard.target_id);
    expect((await setup({ expectedVersion: 1, style: 'salon' })).status).toBe(200);
    const salon = sql.raw.prepare("SELECT target_id FROM style_starter_items WHERE line_account_id='a' AND style='salon' AND item_key='welcome'").get() as { target_id: string };
    expect(salon.target_id).not.toBe(standard.target_id);
    await setDefinition([{ ...item, text: 'サロン新版' }], 1);
    const plan = await preflight(2);
    expect((await request(hqPath + '/distribute', 'POST', { expectedVersion: 2, target: { accountIds: ['a'] }, token: plan.token, confirmed: true })).status).toBe(200);
    expect(sql.raw.prepare('SELECT * FROM templates WHERE id=?').get(standard.target_id)).toEqual(original);
    expect(sql.raw.prepare('SELECT message_content FROM templates WHERE id=?').get(salon.target_id)).toEqual({ message_content: 'サロン新版' });
  });
  test('preflight detects local edits, untouched resources update, edits wait for shop consent', async () => {
    restaurant();
    sql.raw.exec(`INSERT INTO rt_store_feature_flags(store_id,feature,enabled,version,created_at,updated_at)
      VALUES('store','reservation',0,7,1,2),('store','coupon',1,3,1,2)`);
    const storeFlags = sql.raw.prepare('SELECT * FROM rt_store_feature_flags ORDER BY feature').all();
    await setDefinition([
      template(),
      { ...template('初版'), key: 'hq-second' },
    ]);
    await setup({ expectedVersion: 1, style: 'salon' });
    const rows = sql.raw
      .prepare(
        "SELECT item_key,target_id FROM style_starter_items WHERE item_key LIKE 'hq-%'",
      )
      .all() as { item_key: string; target_id: string }[];
    const edited = rows.find((r) => r.item_key === 'hq-welcome')!;
    sql.raw
      .prepare("UPDATE templates SET name='店で直した名前' WHERE id=?")
      .run(edited.target_id);
    await setDefinition(
      [template('新版'), { ...template('二つ目新版'), key: 'hq-second' }],
      1,
    );
    const p = await preflight(2);
    expect(p).toMatchObject({ accountCount: 1, editedCount: 1 });
    expect(
      (
        await request(hqPath + '/distribute', 'POST', {
          expectedVersion: 2,
          target: { accountIds: ['a'] },
          token: p.token,
          confirmed: true,
        })
      ).status,
    ).toBe(200);
    expect(sql.raw.prepare('SELECT * FROM rt_store_feature_flags ORDER BY feature').all()).toEqual(storeFlags);
    expect(
      sql.raw
        .prepare('SELECT name FROM templates WHERE id=?')
        .get(edited.target_id),
    ).toEqual({ name: '店で直した名前' });
    const item = (
      await request(base + '/starter-items?account_id=a')
    ).body.data.items.find((i: any) => i.key === 'hq-welcome');
    expect(item.pendingUpdate).toMatchObject({ setVersion: 2 });
    expect(
      sql.raw
        .prepare('SELECT message_content FROM templates WHERE id=?')
        .get(rows.find((r) => r.item_key === 'hq-second')!.target_id),
    ).toEqual({ message_content: '二つ目新版' });
    expect(
      (
        await request(
          base + '/starter-items/hq-welcome/accept-update?account_id=a',
          'POST',
          {
            confirmed: true,
            expectedSetVersion: 2,
            expectedSnapshot: item.currentSnapshot,
          },
        )
      ).status,
    ).toBe(200);
    expect(
      sql.raw
        .prepare('SELECT message_content FROM templates WHERE id=?')
        .get(edited.target_id),
    ).toEqual({ message_content: '新版' });
    const metadata = await withStyleSampleMetadata(
      sql.db,
      [{ id: edited.target_id }],
      'template',
    );
    expect(metadata[0]).toMatchObject({
      isSample: true,
      sampleKey: 'hq-welcome',
      starterSetVersion: 2,
    });
    expect(
      (await request('/api/hq/style-starter-sets')).body.data[0],
    ).toMatchObject({ updatedByName: '店長', accountCount: 1 });
  });
  test('new-copy preserves edited resource and its provenance; invalid target, stale preflight and read-only are rejected', async () => {
    await setDefinition([template()]);
    await setup({ expectedVersion: 1, style: 'salon' });
    sql.raw.exec(
      "UPDATE templates SET name='店の文' WHERE name='【見本】ごあいさつ'",
    );
    await setDefinition([template('新版')], 1);
    let p = await preflight(2);
    sql.raw.exec("UPDATE templates SET name='さらに編集' WHERE name='店の文'");
    expect(
      (
        await request(hqPath + '/distribute', 'POST', {
          expectedVersion: 2,
          target: { accountIds: ['a'] },
          token: p.token,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    p = await preflight(2);
    const r = await request(hqPath + '/distribute', 'POST', {
      expectedVersion: 2,
      target: { accountIds: ['a'] },
      token: p.token,
      confirmed: true,
      editedAction: 'new_copy',
    });
    expect(r.status).toBe(200);
    expect(
      sql.raw
        .prepare("SELECT COUNT(*) n FROM templates WHERE name='さらに編集'")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      sql.raw
        .prepare(
          "SELECT COUNT(*) n FROM style_starter_items WHERE item_key LIKE 'hq-welcome%'",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      (
        await request(hqPath + '/preflight', 'POST', {
          expectedVersion: 2,
          target: { accountIds: ['missing'] },
        })
      ).status,
    ).toBe(404);
    actor.readOnly = true;
    expect(
      (
        await request(hqPath + '/preflight', 'POST', {
          expectedVersion: 2,
          target: { accountIds: ['a'] },
        })
      ).status,
    ).toBe(403);
  });
  test('snapshot guards roll back a batch when shop content changed after planning', async () => {
    await setDefinition([template()]);
    await setup({ expectedVersion: 1, style: 'salon' });
    const id = (
      sql.raw
        .prepare(
          "SELECT target_id FROM style_starter_items WHERE item_key='hq-welcome'",
        )
        .get() as { target_id: string }
    ).target_id;
    const snapshot = await resourceSnapshot(sql.db, 'a', 'template', id);
    sql.raw
      .prepare('UPDATE templates SET message_content=? WHERE id=?')
      .run('{"text":"店の文"}', id);
    await expect(
      sql.db.batch([
        snapshotGuard(sql.db, 'a', 'template', id, snapshot),
        sql.db
          .prepare('UPDATE templates SET name=? WHERE id=?')
          .bind('壊れた上書き', id),
      ]),
    ).rejects.toThrow();
    expect(
      sql.raw.prepare('SELECT name FROM templates WHERE id=?').get(id),
    ).toEqual({ name: '【見本】ごあいさつ' });
  });
});

describe('dashboard followups', () => {
  test('KPI selection and hidden tabs persist, reset restores defaults, connection band cannot hide', async () => {
    await setup({ expectedVersion: 1, style: 'salon' });
    let r = await request(base + '/cards?account_id=a', 'PUT', {
      expectedVersion: 2,
      cards: [
        { id: 'analytics', visible: false },
        { id: 'ledger', visible: true },
      ],
      metricIds: [
        'bookings',
        'paidAmount',
        'newBookings',
        'classroomOccupancy',
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.visibleTabs).toEqual(['main']);
    expect(r.body.data.metricIds).toEqual([
      'bookings',
      'paidAmount',
      'newBookings',
      'classroomOccupancy',
    ]);
    const p = (await request(base + '?account_id=a')).body.data;
    expect(p.metricIds).toEqual([
      'bookings',
      'paidAmount',
      'newBookings',
      'classroomOccupancy',
    ]);
    expect(p.visibleTabs).not.toContain('analytics');
    expect(
      (
        await request(base + '/cards?account_id=a', 'PUT', {
          expectedVersion: 3,
          cards: [{ id: 'connection-alert', visible: false }],
        })
      ).status,
    ).toBe(400);
    r = await request(base + '/cards?account_id=a', 'DELETE', {
      expectedVersion: 3,
    });
    expect(r.body.data.visibleTabs).toContain('analytics');
    expect(r.body.data.metricIds).toEqual([
      'bookings',
      'attention',
      'nextBookingRate',
      'paidAmount',
      'newBookings',
    ]);
  });
  test('daily comparison includes previous dates and zero days with sample suppression', async () => {
    booking('now');
    booking('yesterday', '2026-10-14T01:00:00Z');
    const s = await styleSnapshot(sql.db, 'a', 'salon', {});
    const c = s.analytics.dailyComparison as any;
    expect(c.current).toHaveLength(1);
    expect(c.previous).toHaveLength(1);
    expect(c.current[0]).toMatchObject({
      date: '2026-10-15',
      metrics: { bookings: { value: 1 } },
    });
    expect(c.previous[0]).toMatchObject({
      date: '2026-10-14',
      metrics: { bookings: { value: 1 } },
    });
    sql.raw.exec(
      `UPDATE account_styles SET settings_json='{"minimumSample":5}'`,
    );
    const week = await styleSnapshot(sql.db, 'a', 'salon', { range: 'week' });
    const comparison = week.analytics.dailyComparison as any;
    expect(comparison.current).toHaveLength(7);
    expect(comparison.previous).toHaveLength(7);
    expect(
      comparison.current.some((d: any) => d.metrics.bookings.value === 0),
    ).toBe(true);
    expect(
      comparison.current.find((d: any) => d.date === '2026-10-15').metrics
        .noShowRate,
    ).toMatchObject({ value: null, status: 'insufficient_sample' });
  });
  test('restaurant sidebar and salon no-next-booking use account/staff filtered data', async () => {
    restaurant();
    sql.raw
      .exec(`INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES('past','store','line','花子','Uf',2,'2026-10-01T01:00:00Z','2026-10-01T03:00:00Z','no_show');
  INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,identity_key) VALUES('wait','store','2026-10-15T06:00:00Z',2,'待ち','phone:1');`);
    sql.raw.exec(
      `INSERT INTO friend_field_values(friend_id,field_id,value_date) VALUES('f','fixed-anniversary','2021-10-15')`,
    );
    const s = await styleSnapshot(sql.db, 'a', 'restaurant', {});
    expect(s.analytics.sidebar).toMatchObject({
      attention: [
        { id: 'r', allergy: '卵', anniversary: true, noShowHistory: true },
      ],
      waitlist: [{ id: 'wait' }],
    });
    const restricted = await styleSnapshot(sql.db, 'a', 'restaurant', {}, 's');
    expect(restricted.analytics.sidebar).toMatchObject({
      attention: [],
      waitlist: [],
    });
    booking('old', '2026-10-01T01:00:00Z', 'f', 'completed');
    sql.raw.exec("UPDATE rt_reservations SET status='cancelled'");
    const salon = await styleSnapshot(sql.db, 'a', 'salon', {});
    expect(salon.analytics.sidebar).toMatchObject({
      noNextBooking: [{ friendId: 'f' }],
    });
  });
  test('today payments reuse group3 aggregation and do not count another day or staff', async () => {
    booking('b1');
    sql.raw.exec(
      `INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,idempotency_key,paid_at,created_at,updated_at) VALUES('paid','a','b1',1200,'paid','stripe','k','2026-10-15T01:00:00Z','2026-10-14T01:00:00Z','2026-10-15T01:00:00Z'),('prev','a','b1',900,'paid','stripe','k2','2026-10-14T01:00:00Z','2026-10-14T01:00:00Z','2026-10-14T01:00:00Z');`,
    );
    const r = await request(base + '/summary?account_id=a&style=salon');
    expect(r.status).toBe(200);
    expect(r.body.data.items[0].payment).toMatchObject({
      bookingId: 'b1',
      status: 'paid',
      amount: 1200,
    });
    const schedule = await request(base + '/schedule?account_id=a&style=salon');
    expect(
      schedule.body.data.entries.find((e: any) => e.booking?.id === 'b1')
        .booking.payment,
    ).toMatchObject({ status: 'paid', amount: 1200 });
    expect(r.body.data.payments).toMatchObject({
      status: 'available',
      paidAmount: 1200,
      paidCount: 1,
    });
    const restricted = await request(
      base + '/summary?account_id=a&style=salon&staff_id=s2',
    );
    expect(restricted.body.data.payments.paidAmount).toBe(0);
  });
});

test('store acceptance retains template history and creates a new reminder draft with its exact timing', async () => {
  const items = [
    template(),
    {
      key: 'native-reminder',
      kind: 'reminder',
      feature: 'reminders',
      name: '前日の案内',
      text: '初版',
      offsetMinutes: -1440,
      offsetDays: -1,
      sendAtTime: '18:00',
    },
  ];
  await setDefinition(items);
  await setup({
    expectedVersion: 1,
    style: 'salon',
    answers: { reminders: { mode: 'configured', value: true } },
  });
  const reminder = (
    sql.raw
      .prepare(
        "SELECT target_id FROM style_starter_items WHERE item_key='native-reminder'",
      )
      .get() as { target_id: string }
  ).target_id;
  const oldVersion = (
    sql.raw
      .prepare('SELECT current_draft_version_id id FROM reminders WHERE id=?')
      .get(reminder) as { id: string }
  ).id;
  sql.raw
    .prepare("UPDATE reminders SET name='店の案内' WHERE id=?")
    .run(reminder);
  await setDefinition(
    [
      template('新版'),
      { ...items[1], text: '新しい案内', sendAtTime: '17:00' },
    ],
    1,
  );
  const p = await preflight(2);
  expect(
    (
      await request(hqPath + '/distribute', 'POST', {
        expectedVersion: 2,
        target: { accountIds: ['a'] },
        token: p.token,
        confirmed: true,
      })
    ).status,
  ).toBe(200);
  const row = (
    await request(base + '/starter-items?account_id=a')
  ).body.data.items.find((i: any) => i.key === 'native-reminder');
  expect(
    (
      await request(
        base + '/starter-items/native-reminder/accept-update?account_id=a',
        'POST',
        {
          confirmed: true,
          expectedSetVersion: 2,
          expectedSnapshot: row.currentSnapshot,
        },
      )
    ).status,
  ).toBe(200);
  const drafts = sql.raw
    .prepare(
      'SELECT id,status,settings_snapshot FROM reminder_versions WHERE reminder_id=? ORDER BY version_number',
    )
    .all(reminder) as any[];
  expect(drafts).toHaveLength(2);
  expect(drafts[0]).toMatchObject({ id: oldVersion, status: 'superseded' });
  expect(JSON.parse(drafts[1].settings_snapshot).steps[0]).toMatchObject({
    sendAtTime: '17:00',
    messageContent: '新しい案内',
  });
  expect(
    sql.raw
      .prepare(
        'SELECT send_at_time FROM reminder_version_steps WHERE reminder_version_id=?',
      )
      .get(drafts[1].id),
  ).toEqual({ send_at_time: '17:00' });
  const tpl = (
    sql.raw
      .prepare(
        "SELECT target_id FROM style_starter_items WHERE item_key='hq-welcome'",
      )
      .get() as { target_id: string }
  ).target_id;
  expect(
    sql.raw
      .prepare(
        'SELECT message_content FROM template_versions WHERE template_id=? ORDER BY version_number',
      )
      .all(tpl),
  ).toEqual([
    { message_content: '最初の文' },
    { message_content: '新版' },
  ]);
});

test('cross-industry reads do not expose events or restaurant rows without those permissions', async () => {
  restaurant();
  booking('visible');
  actor.role = 'staff';
  actor.permissionKeys = ['/booking/bookings'];
  actor.viewPermissionKeys = [];
  const r = await request(base + '/summary?account_id=a&style=salon');
  expect(r.status).toBe(200);
  expect(r.body.data.items.map((i: any) => i.id)).toEqual(['visible']);
  expect(
    (await request(base + '/summary?account_id=b&style=salon')).status,
  ).toBe(404);
});

test('two simultaneous distributions create one sample; losing request is a conflict with no orphan', async () => {
  await setDefinition([template()]);
  const p = await preflight(1);
  const body = {
    expectedVersion: 1,
    target: { accountIds: ['a'] },
    confirmed: true,
    token: p.token,
  };
  const before = (
    sql.raw.prepare('SELECT COUNT(*) n FROM templates').get() as { n: number }
  ).n;
  const results = await Promise.all([
    request(hqPath + '/distribute', 'POST', body),
    request(hqPath + '/distribute', 'POST', body),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(sql.raw.prepare('SELECT COUNT(*) n FROM templates').get()).toEqual({
    n: before + 1,
  });
  expect(
    sql.raw
      .prepare(
        "SELECT COUNT(*) n FROM style_starter_items WHERE item_key='hq-welcome'",
      )
      .get(),
  ).toEqual({ n: 1 });
});

test('HQ cannot disguise a confirmation sender by changing its sample name or key', async () => {
  const r = await request(hqPath, 'PUT', {
    expectedVersion: 0,
    name: '見本',
    definition: {
      items: [
        {
          key: 'custom',
          kind: 'automation',
          name: '別の名前',
          text: 'ご予約ありがとうございます。',
          triggerType: 'calendar_booked',
        },
      ],
    },
  });
  expect(r.status).toBe(422);
  expect(r.body.code).toBe('duplicate_confirmation_automation');
});

test('cross-style reservations remain visible without treating restaurant/class visits as pending consultations', async () => {
  restaurant();
  booking('person', '2026-10-01T01:00:00Z', 'f', 'completed');
  sql.raw
    .exec(`UPDATE bookings SET consultation_outcome='won' WHERE id='person';
 UPDATE rt_reservations SET starts_at='2026-10-01T01:00:00Z',ends_at='2026-10-01T02:00:00Z',status='visited',line_uid=NULL WHERE id='r';
 INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('g','Ug','a','教室の人');
 INSERT INTO events(id,line_account_id,name,is_published) VALUES('lesson','a','教室',1);
 INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES('past-slot','lesson','2026-10-01T01:00:00Z','2026-10-01T02:00:00Z',3);
 INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('past-class','a','lesson','past-slot','g','attended','2026-09-01T00:00:00Z');`);
  const s = await styleSnapshot(sql.db, 'a', 'consult', { range: 'month' });
  expect(s.items.map((r) => r.kind).sort()).toEqual([
    'booking',
    'event',
    'restaurant',
  ]);
  expect(s.metrics.resultPending.value).toBe(0);
  expect(s.analytics.resultPending).toEqual([]);
  expect(s.metrics.conversionRate).toMatchObject({
    value: 1,
    numerator: 1,
    denominator: 1,
  });
});

test('daily history calculations scale with records rather than searching every customer for every person', async () => {
  booking('base', '2026-10-01T01:00:00Z', 'f', 'completed');
  const baseRow = (await styleRows(sql.db, 'a', 'salon'))[0];
  const work = (count: number) => {
    let reads = 0;
    const rows = Array.from({ length: count }, (_, i) => {
      const row = { ...baseRow, id: 'booking-' + i };
      Object.defineProperty(row, 'personKey', {
        get() {
          reads++;
          return 'person-' + i;
        },
      });
      return row;
    });
    const result = personMetrics(
      rows,
      Date.parse('2026-10-01T00:00:00Z'),
      Date.parse('2026-10-15T00:00:00Z'),
      Date.now(),
    );
    expect(result.people).toHaveLength(count);
    return reads;
  };
  const small = work(50),
    large = work(100);
  expect(large).toBeLessThan(small * 3);
});
