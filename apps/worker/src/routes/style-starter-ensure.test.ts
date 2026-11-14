import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { styles } from './styles.js';
import { gettingStarted } from './getting-started.js';
import { initializeAccountStyle, starter } from '../services/style-setup.js';
import { ensureStyleStarterItems } from '../services/style-starter-ensure.js';

vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: async () => ({
    accounts: [{ id: 'a' }],
    allowedAccountIds: ['a'],
    canSeeUnassigned: false,
  }),
  canAccessAllLineAccounts: async (_db: unknown, _s: unknown, ids: string[]) =>
    ids.every((id) => id === 'a'),
}));
vi.mock('../lib/webhook-endpoint.js', () => ({
  expectedWebhookUrl: () => 'https://worker.example.com/webhook',
  fetchWebhookEndpoint: async () => ({ expectedUrl: '', actualUrl: null, active: true, status: 'matched' }),
}));

let sql: ReturnType<typeof createTestD1>,
  app: Hono<Env>,
  actor: Env['Variables']['staff'];
const base = '/api/dashboard/style';
const ensurePath = base + '/starter-items/ensure?account_id=a';
const hqPath = (style: string) => '/api/hq/style-starter-sets/' + style;

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
      DEPLOY_ENV: 'test',
      WORKER_URL: 'https://worker.example.com',
    } as unknown as Env['Bindings'],
  );
  return { status: r.status, body: (await r.json()) as any };
}
const count = (table: string, where = "line_account_id='a'") =>
  (sql.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const version = () =>
  (sql.raw.prepare("SELECT version FROM account_styles WHERE line_account_id='a'").get() as { version: number }).version;
const starterRows = () =>
  sql.raw.prepare("SELECT item_key,kind,target_id FROM style_starter_items WHERE line_account_id='a' ORDER BY item_key").all() as Array<{ item_key: string; kind: string; target_id: string }>;
const friendAddDrafts = (rule: string) =>
  (sql.raw.prepare("SELECT COUNT(*) n FROM friend_add_rule_versions WHERE rule_id=? AND status='draft'").get(rule) as { n: number }).n;
/** 受け皿の下書きが残っている時、入れ直しで入る物（友だち追加の決まりは既にあるので入らない）。 */
const withoutFriendAdd = (items: Array<{ key: string; kind: string }>) => items.filter((i) => i.kind !== 'friend_add_rule');
const allAnswers = {
  image: { mode: 'configured', value: 'simple' },
  booking: { mode: 'configured', value: true },
  reminders: { mode: 'configured', value: true },
  content: { mode: 'configured', value: true },
};

/** 自動で送る物が全部止まっているか。入れ直しでも同じ物差しで見る。 */
function expectEverythingStopped() {
  for (const row of starterRows()) {
    if (row.kind === 'automation')
      expect(sql.raw.prepare('SELECT status FROM automation_definitions WHERE id=?').get(row.target_id)).toEqual({ status: 'draft' });
    if (row.kind === 'reminder')
      expect(sql.raw.prepare('SELECT is_active,lifecycle_status FROM reminders WHERE id=?').get(row.target_id)).toEqual({ is_active: 0, lifecycle_status: 'draft' });
    if (row.kind === 'booking_menu')
      expect(sql.raw.prepare('SELECT is_active FROM menus WHERE id=?').get(row.target_id)).toEqual({ is_active: 0 });
    if (row.kind === 'rich_menu')
      expect(sql.raw.prepare('SELECT status FROM rich_menu_groups WHERE id=?').get(row.target_id)).toEqual({ status: 'draft' });
    if (row.kind === 'friend_add_rule') {
      // ごあいさつは下書きの版にだけ入り、今送っている版は何も送らない形のまま。
      const current = sql.raw
        .prepare('SELECT v.definition_snapshot FROM friend_add_rules r JOIN friend_add_rule_versions v ON v.id=r.current_version_id WHERE r.id=?')
        .get(row.target_id) as { definition_snapshot: string };
      expect(JSON.parse(current.definition_snapshot).messageText ?? '').toBe('');
      expect(friendAddDrafts(row.target_id)).toBe(1);
    }
  }
}

beforeEach(async () => {
  sql = createTestD1({ foreignKeys: true, now: () => new Date() });
  sql.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','本部');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret,created_at) VALUES('a','t','a','店A','fixture','fixture','2026-10-15T10:00:00.000'),('b','t','b','店B','fixture','fixture','2026-10-15T10:00:00.000');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','店長','owner','fixture','t');`);
  actor = { id: 'owner', name: '店長', tenantId: 't', role: 'owner', readOnly: false } as Env['Variables']['staff'];
  app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', actor);
    await next();
  });
  app.route('/', styles);
  app.route('/', gettingStarted);
});
afterEach(() => {
  vi.restoreAllMocks();
  sql.raw.close();
});

describe('新しいアカウントの初期セット', () => {
  test('1. スタイルの保存で組の数ちょうど入り、自動で送る物は全部止まっている', async () => {
    const r = await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'salon', answers: allAnswers });
    expect(r.status).toBe(200);
    const set = await starter(sql.db, 't', 'salon');
    const inserted = r.body.data.inserted.map((i: any) => i.key).sort();
    expect(inserted).toEqual(set.definition.items.map((i) => i.key).sort());
    expect(r.body.data.skipped).toEqual([]);
    expect(starterRows().map((row) => row.item_key)).toEqual(inserted);
    expect(new Set(starterRows().map((row) => row.kind))).toEqual(new Set(set.definition.items.map((i) => i.kind)));
    expect(starterRows().some((row) => row.kind === 'friend_add_rule')).toBe(true);
    expectEverythingStopped();
    // 同じスタイルでもう一度保存しても増えない。
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 1, style: 'salon', answers: allAnswers })).status).toBe(200);
    expect(starterRows().map((row) => row.item_key)).toEqual(inserted);
  });

  test('1b. 飲食のオートメーションも下書きで入る', async () => {
    const r = await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'restaurant', answers: allAnswers });
    expect(r.status).toBe(200);
    expect(starterRows().some((row) => row.kind === 'automation')).toBe(true);
    expectEverythingStopped();
  });
});

describe('入れ直しの口', () => {
  async function salonWithoutItems() {
    await initializeAccountStyle(sql.db, 'a', 't', 'owner');
    await request(base + '?account_id=a', 'PUT', { expectedVersion: 1, style: 'salon', answers: allAnswers });
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a'");
    return version();
  }

  test('2. 2回呼んでも2回目は何も入れず、行も版も増えない', async () => {
    const v = await salonWithoutItems();
    const first = await request(ensurePath, 'POST', { expectedVersion: v });
    expect(first.status).toBe(200);
    const set = await starter(sql.db, 't', 'salon');
    expect(first.body.data).toMatchObject({ existing: 0, starterSet: { id: 'musubo:salon', version: 1 } });
    // 最初の保存で足した受け皿の下書きは残っているので、上書きせず理由つきで飛ばす。2つ目の下書きも作らない。
    expect(first.body.data.skipped).toEqual([{ key: 'friend-add-welcome', reason: 'already_exists' }]);
    expect(friendAddDrafts('friend-add-rule-first_time-a')).toBe(1);
    expect(first.body.data.inserted.map((i: any) => i.key).sort()).toEqual(withoutFriendAdd(set.definition.items).map((i) => i.key).sort());
    expect(Object.keys(first.body.data.inserted[0]).sort()).toEqual(['key', 'kind']);
    expectEverythingStopped();
    const rows = starterRows();
    const templates = count('templates');
    const second = await request(ensurePath, 'POST', { expectedVersion: v });
    expect(second.status).toBe(200);
    expect(second.body.data.inserted).toEqual([]);
    expect(second.body.data.existing).toBe(rows.length);
    expect(second.body.data.skipped.every((s: any) => s.reason === 'already_exists')).toBe(true);
    expect(starterRows()).toEqual(rows);
    expect(count('templates')).toBe(templates);
    expect(version()).toBe(v);
  });

  test('2b. 店が編集した見本は上書きしない', async () => {
    const v = await salonWithoutItems();
    await request(ensurePath, 'POST', { expectedVersion: v });
    const welcome = starterRows().find((row) => row.item_key === 'welcome')!;
    sql.raw.prepare("UPDATE templates SET name='店で編集した名前' WHERE id=?").run(welcome.target_id);
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a' AND item_key='menu'");
    const r = await request(ensurePath, 'POST', { expectedVersion: v });
    expect(r.body.data.inserted.map((i: any) => i.key)).toEqual(['menu']);
    expect(sql.raw.prepare('SELECT name FROM templates WHERE id=?').get(welcome.target_id)).toEqual({ name: '店で編集した名前' });
  });

  test('3. 統括の配りと同時に流しても、組の数ちょうどで半分だけ入らない', async () => {
    const item = (key: string) => ({ key, kind: 'template', name: 'ごあいさつ ' + key, text: '本文 ' + key });
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部の見本', definition: { items: [item('hq-1')] } })).status).toBe(200);
    await initializeAccountStyle(sql.db, 'a', 't', 'owner', 'salon');
    expect(starterRows().map((row) => row.item_key)).toEqual(['hq-1']);
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 1, name: '本部の見本', definition: { items: [item('hq-1'), item('hq-2'), item('hq-3')] } })).status).toBe(200);
    const plan = await request(hqPath('salon') + '/preflight', 'POST', { expectedVersion: 2, target: { accountIds: ['a'] } });
    const results = await Promise.all([
      request(ensurePath, 'POST', { expectedVersion: version() }),
      request(hqPath('salon') + '/distribute', 'POST', { expectedVersion: 2, target: { accountIds: ['a'] }, token: plan.body.data.token, confirmed: true }),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(starterRows().map((row) => row.item_key)).toEqual(['hq-1', 'hq-2', 'hq-3']);
    // 入らなかった側の見本の本体も残らない（行の無いテンプレートを作らない）。
    expect(count('templates')).toBe(3);
  });

  test('4. 呼ぶ前に版が上がっていたら409で1行も入れない', async () => {
    const v = await salonWithoutItems();
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: v, styleMode: 'later' })).status).toBe(200);
    const templates = count('templates');
    const r = await request(ensurePath, 'POST', { expectedVersion: v });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('version_conflict');
    expect(starterRows()).toEqual([]);
    expect(count('templates')).toBe(templates);
    expect((await request(ensurePath, 'POST', {})).status).toBe(409);
  });

  test('4b. 読んだ後・書く前に版が変わっても batch ごと取り消す', async () => {
    const v = await salonWithoutItems();
    const templates = count('templates');
    const racing = {
      prepare: (q: string) => sql.db.prepare(q),
      batch: async (statements: D1PreparedStatement[]) => {
        sql.raw.exec("UPDATE account_styles SET version=version+1 WHERE line_account_id='a'");
        return sql.db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(ensureStyleStarterItems(racing, 'a', 't', 'owner', { expectedVersion: v })).rejects.toMatchObject({ code: 'version_conflict', status: 409 });
    expect(starterRows()).toEqual([]);
    expect(count('templates')).toBe(templates);
  });

  test('5. 統括が「自動で入れない」にしている組は入れず、理由を返す', async () => {
    const item = { key: 'hq-1', kind: 'template', name: 'ごあいさつ', text: '本文' };
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部の見本', definition: { items: [item] } })).status).toBe(200);
    sql.raw.exec("UPDATE style_starter_sets SET auto_insert=0 WHERE style='salon'");
    await initializeAccountStyle(sql.db, 'a', 't', 'owner', 'salon');
    expect(starterRows()).toEqual([]);
    const r = await request(ensurePath, 'POST', { expectedVersion: version() });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ inserted: [], skipped: [{ key: 'hq-1', reason: 'auto_insert_off' }] });
    expect(starterRows()).toEqual([]);
  });

  test('6. 答えが「あとで」の項目と、そのスタイルに無い予約メニューは理由つきで飛ばす', async () => {
    const saved = await request(base + '?account_id=a', 'PUT', {
      expectedVersion: 0,
      style: 'salon',
      answers: { ...allAnswers, reminders: { mode: 'later' } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.skipped).toEqual([
      { key: 'reminder-day-before', reason: 'answer_later' },
      { key: 'reminder-today', reason: 'answer_later' },
      { key: 'reminder-thanks', reason: 'answer_later' },
    ]);
    const again = await request(ensurePath, 'POST', { expectedVersion: version() });
    expect(again.body.data.inserted).toEqual([]);
    expect(again.body.data.skipped.filter((s: any) => s.reason === 'answer_later').map((s: any) => s.key)).toEqual(['reminder-day-before', 'reminder-today', 'reminder-thanks']);

    sql.raw.prepare(`INSERT INTO style_starter_sets(id,tenant_id,style,name,definition_json,updated_at) VALUES('rset','t','restaurant','飲食の見本',?,'now')`)
      .run(JSON.stringify({ items: [{ key: 'seat-menu', kind: 'booking_menu', feature: 'booking', name: '席の予約' }] }));
    const restaurant = await request(base + '?account_id=a', 'PUT', { expectedVersion: version(), style: 'restaurant', answers: allAnswers });
    expect(restaurant.status).toBe(200);
    expect(restaurant.body.data.skipped).toContainEqual({ key: 'seat-menu', reason: 'not_for_style' });
  });

  test('6b. スタイルを選んでいない（あとで）時は何も入れず、全部を「あとで」で返す', async () => {
    await initializeAccountStyle(sql.db, 'a', 't', 'owner');
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 1, styleMode: 'later' })).status).toBe(200);
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a'");
    const r = await request(ensurePath, 'POST', { expectedVersion: version() });
    expect(r.status).toBe(200);
    expect(r.body.data.inserted).toEqual([]);
    expect(r.body.data.skipped.length).toBeGreaterThan(0);
    expect(r.body.data.skipped.every((s: any) => s.reason === 'answer_later')).toBe(true);
  });

  test('7. 見えない店は404、閲覧のみ・スタッフは403、スタイルが無い店は409', async () => {
    await initializeAccountStyle(sql.db, 'a', 't', 'owner');
    const v = version();
    expect((await request(base + '/starter-items/ensure?account_id=b', 'POST', { expectedVersion: 1 })).status).toBe(404);
    actor = { ...actor, readOnly: true };
    expect((await request(ensurePath, 'POST', { expectedVersion: v })).status).toBe(403);
    actor = { ...actor, readOnly: false, role: 'staff' };
    expect((await request(ensurePath, 'POST', { expectedVersion: v })).status).toBe(403);
    actor = { ...actor, role: 'admin' };
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a'");
    expect((await request(ensurePath, 'POST', { expectedVersion: v })).status).toBe(200);
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a'; DELETE FROM account_styles WHERE line_account_id='a'");
    expect((await request(ensurePath, 'POST', { expectedVersion: 0 })).body.code).toBe('select_style_first');
  });
});

describe('はじめにやることの読む口', () => {
  const snapshot = () => [
    ...['style_starter_items', 'templates', 'account_styles', 'style_change_logs'].map((t) => count(t)),
    count('friend_add_rule_versions', '1=1'),
  ];

  test('8. スタイルはあるが見本が0件なら applied=false。読むだけで行が増えない', async () => {
    await initializeAccountStyle(sql.db, 'a', 't', 'owner');
    await request(base + '?account_id=a', 'PUT', { expectedVersion: 1, style: 'salon', answers: allAnswers });
    const set = await starter(sql.db, 't', 'salon');
    let r = await request('/api/getting-started?account_id=a&version=v8');
    expect(r.body.data.starter).toEqual({ applied: true, count: set.definition.items.length, missing: 0 });
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a'");
    const before = snapshot();
    r = await request('/api/getting-started?account_id=a&version=v8');
    expect(r.status).toBe(200);
    expect(r.body.data.starter).toEqual({ applied: false, count: 0, missing: withoutFriendAdd(set.definition.items).length });
    expect(snapshot()).toEqual(before);
    // 入れ直しで入る数と、読む口の「足りない数」が一致する。
    const ensured = await request(ensurePath, 'POST', { expectedVersion: version() });
    expect(ensured.body.data.inserted).toHaveLength(withoutFriendAdd(set.definition.items).length);
    r = await request('/api/getting-started?account_id=a&version=v8');
    expect(r.body.data.starter).toMatchObject({ applied: true, missing: 0 });
  });

  test('8b. スタイルの無い店とアカウントを選んでいない時は null', async () => {
    let r = await request('/api/getting-started?account_id=a');
    expect(r.body.data).toMatchObject({ starter: null, firstRun: { startedAt: '2026-10-15T10:00:00.000+09:00', styleAt: null, starterAt: null, followAt: null, firstMessageAt: null, minutes: null } });
    r = await request('/api/getting-started');
    expect(r.body.data).toMatchObject({ starter: null, firstRun: null });
  });

  test('9. 5地点の時刻を日本時間で返し、取り込みの友だちは友だち追加に数えない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T01:02:00Z'));
    await initializeAccountStyle(sql.db, 'a', 't', 'owner', 'salon');
    vi.useRealTimers();
    // 取り込みで作られた友だち（follow の記録が無い）は数えない。
    sql.raw.exec(`INSERT INTO friends(id,line_user_id,line_account_id,display_name,created_at) VALUES('imported','Uimp','a','取り込み','2026-10-15T10:01:00.000');
      INSERT INTO friends(id,line_user_id,line_account_id,display_name,created_at) VALUES('owner-phone','Uown','a','オーナー','2026-10-15T10:05:00.000');
      INSERT INTO line_webhook_events(webhook_event_id,line_account_id,event_type,status,received_at) VALUES
        ('e-failed','a','follow','failed','2026-10-15T10:04:00.000'),
        ('e-other','b','follow','succeeded','2026-10-15T10:03:00.000'),
        ('e-msg','a','message','succeeded','2026-10-15T10:03:30.000'),
        ('e-follow','a','follow','succeeded','2026-10-15T10:05:00.000');
      INSERT INTO messages_log(id,friend_id,direction,message_type,content,source,line_account_id,created_at) VALUES
        ('m-test','owner-phone','outgoing','text','テスト','test','a','2026-10-15T10:05:10.000'),
        ('m-first','owner-phone','outgoing','text','ようこそ','friend_add_routing','a','2026-10-15T10:06:01.000+09:00');`);
    const r = await request('/api/getting-started?account_id=a');
    expect(r.body.data.firstRun).toEqual({
      doneSeenAt: null, doneSeenTracked: true,
      startedAt: '2026-10-15T10:00:00.000+09:00',
      styleAt: '2026-10-15T10:02:00.000+09:00',
      starterAt: '2026-10-15T10:02:00.000+09:00',
      followAt: '2026-10-15T10:05:00.000+09:00',
      firstMessageAt: '2026-10-15T10:06:01.000+09:00',
      minutes: 7,
    });
    const steps = r.body.data.steps.find((s: any) => s.key === 'firstMessage');
    expect(steps.state).toBe('done');
  });
});

describe('最初の1通の完了表示', () => {
  test('選択アカウントごとに一度だけ表示済みを保存する', async () => {
    const missing = await request('/api/getting-started?account_id=a');
    expect(missing.body.data.firstRun).toMatchObject({ doneSeenAt: null, doneSeenTracked: false });
    expect((await request('/api/getting-started/first-run-done-seen?account_id=a', 'POST')).body.data).toEqual({ doneSeenAt: null, tracked: false });
    expect(count('account_styles')).toBe(0);
    await initializeAccountStyle(sql.db, 'a', 't', 'owner');
    expect((await request('/api/getting-started?account_id=a')).body.data.firstRun).toMatchObject({ doneSeenAt: null, doneSeenTracked: true });
    const first = await request('/api/getting-started/first-run-done-seen?account_id=a', 'POST');
    expect(first.status).toBe(200);
    expect(first.body.data.doneSeenAt).toBeTruthy();
    expect(first.body.data.tracked).toBe(true);
    sql.raw.prepare('UPDATE account_styles SET first_run_done_seen_at=? WHERE line_account_id=?').run('2026-01-01T10:00:00.000', 'a');
    const again = await request('/api/getting-started/first-run-done-seen?account_id=a', 'POST');
    expect(again.body.data.doneSeenAt).toBe('2026-01-01T10:00:00.000+09:00');
    expect((await request('/api/getting-started?account_id=a')).body.data.firstRun.doneSeenAt).toBe(again.body.data.doneSeenAt);
    expect((await request('/api/getting-started/first-run-done-seen?account_id=b', 'POST')).status).toBe(404);
  });
});
