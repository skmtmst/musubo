import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { ACCOUNT_STYLES } from '@line-crm/shared';
import { getFriendAddScenarioIds } from '@line-crm/db';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { styles } from './styles.js';
import { gettingStarted } from './getting-started.js';
import { profile, readDefinition, saveProfile, standardStarter, starter } from '../services/style-setup.js';
import { resourceSnapshot } from '../services/style-starter-resource.js';

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
    { DB: sql.db, DEPLOY_ENV: 'test', WORKER_URL: 'https://worker.example.com' } as unknown as Env['Bindings'],
  );
  return { status: r.status, body: (await r.json()) as any };
}
const count = (table: string, where = "line_account_id='a'") =>
  (sql.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const row = (key: string) =>
  sql.raw.prepare("SELECT kind,target_id,is_sample FROM style_starter_items WHERE line_account_id='a' AND item_key=?").get(key) as
    | { kind: string; target_id: string; is_sample: number }
    | undefined;
const accountVersion = () =>
  (sql.raw.prepare("SELECT version FROM account_styles WHERE line_account_id='a'").get() as { version: number }).version;
const step = (steps: Array<{ key: string; state: string }>, key: string) => steps.find((s) => s.key === key)!.state;
const allAnswers = {
  booking: { mode: 'configured', value: true },
  reminders: { mode: 'configured', value: true },
  content: { mode: 'configured', value: true },
};

beforeEach(() => {
  sql = createTestD1({ foreignKeys: true, now: () => new Date() });
  sql.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','本部');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret,created_at) VALUES('a','t','a','店A','fixture','fixture','2026-10-15T10:00:00.000');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','店長','owner','fixture','t'),('admin2','本部2','admin','fixture2','t');`);
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

test('初期セットのフォームは現役の編集画面を開く', async () => {
  const saved = await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'configured', value: 'simple' } } });
  expect(saved.status).toBe(200);
  const items = (await request(base + '/starter-items?account_id=a')).body.data.items as any[];
  const forms = items.filter((item) => item.kind === 'form');
  expect(forms.length).toBeGreaterThan(0);
  for (const item of forms) expect(item.href).toBe(`/form-submissions/edit?id=${encodeURIComponent(item.target_id)}&tab=basic`);
});

describe('③分け方のタグ・⑤シナリオの見本', () => {
  test('初期セットは長い見本名も付けてシナリオを作る', async () => {
    const name = '長い見本'.repeat(16);
    const initial = standardStarter('salon');
    const definition = { ...initial, items: initial.items.map(item => item.kind === 'scenario' ? { ...item, name } : item) };
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', autoInsert: true, definition })).status).toBe(200);
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'salon', answers: allAnswers })).status).toBe(200);
    const scenario = row('friend-add-scenario')!;
    expect(sql.raw.prepare('SELECT name FROM scenarios WHERE id=?').get(scenario.target_id)).toEqual({ name: '【見本】' + name });
  });
  test.each(ACCOUNT_STYLES)('%s の初期セットはタグの見本とシナリオの見本を 1 つずつ持つ', (style) => {
    const items = standardStarter(style).items;
    expect(items.filter((i) => i.kind === 'tag_set')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'scenario')).toHaveLength(1);
    const tags = items.find((i) => i.kind === 'tag_set')!.tags!;
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(items.find((i) => i.kind === 'scenario')!.steps!.every((s) => s.text.trim() && s.delayMinutes > 0)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(30);
    expect(() => readDefinition(standardStarter(style), style)).not.toThrow();
  });

  test('見本の定義は、名前が無い・重なる・2 組ある・通数が無いと通らない', () => {
    const set = standardStarter('salon');
    const tags = set.items.find((i) => i.kind === 'tag_set')!;
    const scenario = set.items.find((i) => i.kind === 'scenario')!;
    const others = set.items.filter((i) => i !== tags && i !== scenario);
    const check = (items: typeof set.items) => () => readDefinition({ items }, 'salon');
    expect(check([...others, { ...tags, tags: [] }, scenario])).toThrow('invalid_starter_set');
    expect(check([...others, { ...tags, tags: [{ name: '常連' }, { name: '常連' }] }, scenario])).toThrow('invalid_starter_set');
    expect(check([...others, { ...tags, tags: undefined }, scenario])).toThrow('invalid_starter_set');
    expect(check([...others, tags, { ...tags, key: 'segment-tags-2' }, scenario])).toThrow('invalid_starter_set');
    expect(check([...others, tags, { ...scenario, steps: [] }])).toThrow('invalid_starter_set');
    expect(check([...others, tags, { ...scenario, steps: [{ delayMinutes: 60, text: ' ' }] }])).toThrow('invalid_starter_set');
    expect(check([...others, tags, { ...scenario, feature: 'booking' }])).toThrow('invalid_starter_set');
  });

  test.each(ACCOUNT_STYLES)('%s：スタイルを選ぶと止めた状態で入り、だれにも届かず、③⑤は済みにならない', async (style) => {
    const r = await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style, answers: allAnswers });
    expect(r.status).toBe(200);
    expect(r.body.data.inserted.filter((i: any) => ['tag_set', 'scenario'].includes(i.kind)).map((i: any) => [i.key, i.requiresActivation])).toEqual([
      ['segment-tags', true],
      ['friend-add-scenario', true],
    ]);
    // タグの見本は行だけ。本物のタグは作らないので、同じ名前のタグも店が作れる。
    expect(row('segment-tags')).toEqual({ kind: 'tag_set', target_id: 'starter-tag-set:segment-tags', is_sample: 1 });
    expect(count('tags')).toBe(0);
    // シナリオの見本は止めた下書き。きっかけも友だち追加の決まりへのつながりも無い。
    const scenario = row('friend-add-scenario')!;
    expect(sql.raw.prepare('SELECT name,trigger_type,is_active,current_published_version_id FROM scenarios WHERE id=?').get(scenario.target_id)).toEqual({
      name: '【見本】友だち追加のあとのご案内',
      trigger_type: 'manual',
      is_active: 0,
      current_published_version_id: null,
    });
    expect(count('scenario_steps', `scenario_id='${scenario.target_id}'`)).toBe(2);
    expect(count('scenario_triggers', `scenario_id='${scenario.target_id}'`)).toBe(0);
    expect(await getFriendAddScenarioIds(sql.db)).toEqual([]);
    const rules = sql.raw.prepare("SELECT definition_snapshot FROM friend_add_rule_versions").all() as Array<{ definition_snapshot: string }>;
    expect(rules.some((v) => v.definition_snapshot.includes(scenario.target_id))).toBe(false);
    expect(count('friend_scenarios', '1=1')).toBe(0);
    expect(count('messages_log', '1=1')).toBe(0);
    const started = await request('/api/getting-started?account_id=a');
    expect(step(started.body.data.steps, 'attributes')).toBe('todo');
    expect(step(started.body.data.steps, 'scenario')).not.toBe('done');
    // 一覧の口は止めた状態として返し、［まとめて動かす］には混ぜない。
    const list = (await request(base + '/starter-items?account_id=a')).body.data.items as any[];
    const tagItem = list.find((i) => i.key === 'segment-tags');
    expect(tagItem).toMatchObject({ status: 'held', activationAllowed: false, requiresActivation: true, name: '分け方のタグの見本', href: '/tags' });
    expect(tagItem.definition.tags).toEqual(standardStarter(style).items.find((i) => i.kind === 'tag_set')!.tags);
    const scenarioItem = list.find((i) => i.key === 'friend-add-scenario');
    expect(scenarioItem).toMatchObject({ status: 'stopped', activationAllowed: false, name: '【見本】友だち追加のあとのご案内', href: '/scenarios' });
    expect(scenarioItem.definition.steps).toHaveLength(2);
    expect((await request(base + '/activate?account_id=a', 'POST', { confirmed: true, items: [{ id: scenario.target_id, kind: 'scenario' }] })).status).toBe(400);
  });

  test.each(ACCOUNT_STYLES)('%s：保存し直しても・スタイルを順に変えても、見本は二重に入らない', async (style) => {
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style, answers: allAnswers })).status).toBe(200);
    for (const next of [style, ...ACCOUNT_STYLES.filter((s) => s !== style)]) {
      const current = await profile(sql.db, 'a');
      await saveProfile(sql.db, 'a', 't', 'owner', { expectedVersion: current!.version, style: next, answers: allAnswers });
    }
    expect(count('scenarios')).toBe(1);
    expect(count('style_starter_items', "line_account_id='a' AND kind IN('tag_set','scenario')")).toBe(2);
    expect(count('tags')).toBe(0);
  });

  test('入れ直しの口と読む口は同じ判定：消えた見本だけを数え、入れ直すと 0 に戻る', async () => {
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'restaurant', answers: allAnswers })).status).toBe(200);
    const read = async () => (await request('/api/getting-started?account_id=a')).body.data.starter;
    expect((await read()).missing).toBe(0);
    const scenarioId = row('friend-add-scenario')!.target_id;
    sql.raw.exec("DELETE FROM style_starter_items WHERE line_account_id='a' AND item_key IN('segment-tags','friend-add-scenario')");
    expect((await read()).missing).toBe(2);
    const ensured = await request(ensurePath, 'POST', { expectedVersion: accountVersion() });
    expect(ensured.status).toBe(200);
    expect(ensured.body.data.inserted).toEqual([
      { key: 'segment-tags', kind: 'tag_set' },
      { key: 'friend-add-scenario', kind: 'scenario' },
    ]);
    expect((await read()).missing).toBe(0);
    const again = await request(ensurePath, 'POST', { expectedVersion: accountVersion() });
    expect(again.body.data.inserted).toEqual([]);
    expect(count('tags')).toBe(0);
    // 入れ直しで入る見本も止めたまま。元の見本は店の物として残る。
    expect(sql.raw.prepare("SELECT COUNT(*) n FROM scenarios WHERE line_account_id='a' AND is_active=0").get()).toEqual({ n: 2 });
    expect(row('friend-add-scenario')!.target_id).not.toBe(scenarioId);
  });

  test('店が動かした・書き換えたシナリオは「手を加えた」と読まれ、配りで上書きされない', async () => {
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'salon', answers: allAnswers })).status).toBe(200);
    const scenario = row('friend-add-scenario')!;
    const recorded = () =>
      (sql.raw.prepare("SELECT source_snapshot FROM style_starter_items WHERE line_account_id='a' AND item_key='friend-add-scenario'").get() as { source_snapshot: string }).source_snapshot;
    expect(await resourceSnapshot(sql.db, 'a', 'scenario', scenario.target_id)).toBe(recorded());
    sql.raw.prepare("UPDATE scenario_steps SET message_content='店で書き換えた' WHERE scenario_id=? AND step_order=0").run(scenario.target_id);
    expect(await resourceSnapshot(sql.db, 'a', 'scenario', scenario.target_id)).not.toBe(recorded());
    // 統括が組を変えて配っても、書き換えたシナリオは知らせだけで中身は残る。
    const set = await starter(sql.db, 't', 'salon');
    const changed = set.definition.items.map((i) => (i.kind === 'scenario' ? { ...i, steps: [{ delayMinutes: 60, text: '本部の新しい文' }] } : i));
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: changed } })).status).toBe(200);
    const plan = await request(hqPath('salon') + '/preflight', 'POST', { expectedVersion: 1, target: { accountIds: ['a'] } });
    expect(plan.status).toBe(200);
    const done = await request(hqPath('salon') + '/distribute', 'POST', { expectedVersion: 1, target: { accountIds: ['a'] }, token: plan.body.data.token, confirmed: true });
    expect(done.status).toBe(200);
    expect(done.body.data.items.find((i: any) => i.key === 'friend-add-scenario').action).toBe('pending');
    expect(sql.raw.prepare('SELECT message_content FROM scenario_steps WHERE scenario_id=? AND step_order=0').get(scenario.target_id)).toEqual({ message_content: '店で書き換えた' });
    expect(sql.raw.prepare('SELECT is_active FROM scenarios WHERE id=?').get(scenario.target_id)).toEqual({ is_active: 0 });
  });

  test('手を加えていないシナリオは、配りで止めたまま新しい文に替わる', async () => {
    expect((await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'salon', answers: allAnswers })).status).toBe(200);
    const scenario = row('friend-add-scenario')!;
    const set = await starter(sql.db, 't', 'salon');
    const changed = set.definition.items.map((i) => (i.kind === 'scenario' ? { ...i, steps: [{ delayMinutes: 60, text: '本部の新しい文' }] } : i));
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: changed } })).status).toBe(200);
    const plan = await request(hqPath('salon') + '/preflight', 'POST', { expectedVersion: 1, target: { accountIds: ['a'] } });
    const done = await request(hqPath('salon') + '/distribute', 'POST', { expectedVersion: 1, target: { accountIds: ['a'] }, token: plan.body.data.token, confirmed: true });
    expect(done.status).toBe(200);
    expect(done.body.data.items.find((i: any) => i.key === 'friend-add-scenario').action).toBe('overwritten');
    expect(sql.raw.prepare('SELECT step_order,delay_minutes,message_content FROM scenario_steps WHERE scenario_id=?').all(scenario.target_id)).toEqual([
      { step_order: 0, delay_minutes: 60, message_content: '本部の新しい文' },
    ]);
    expect(sql.raw.prepare('SELECT is_active FROM scenarios WHERE id=?').get(scenario.target_id)).toEqual({ is_active: 0 });
    expect(count('friend_scenarios', '1=1')).toBe(0);
  });
});

describe('統括の［標準を読む］［標準に戻す］', () => {
  const item = (key: string) => ({ key, kind: 'template', name: 'ごあいさつ ' + key, text: '本文 ' + key });
  const sets = () =>
    sql.raw.prepare("SELECT id,version,archived_at IS NOT NULL archived,definition_json,auto_insert FROM style_starter_sets WHERE tenant_id='t' AND style='salon' ORDER BY archived_at IS NULL, version").all() as Array<{
      id: string; version: number; archived: number; definition_json: string; auto_insert: number;
    }>;

  test('標準を読む口は musubo の標準の中身を返し、統括の組には左右されない', async () => {
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: [item('hq-1')] } })).status).toBe(200);
    const r = await request(hqPath('salon') + '/default');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ style: 'salon', id: 'musubo:salon', version: 1, definition: JSON.parse(JSON.stringify(standardStarter('salon'))) });
    expect((await request(hqPath('wrong') + '/default')).status).toBe(400);
  });

  test('標準に戻すと前の版を止めた写しで残し、組の ID と自動で入れる設定は変えない', async () => {
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', autoInsert: false, definition: { items: [item('hq-1')] } })).status).toBe(200);
    const before = sets()[0]!;
    expect((await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1 })).status).toBe(400);
    const r = await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: before.id, version: 2, reset: true, autoInsert: false });
    const [previous, current] = sets();
    expect(previous).toMatchObject({ id: r.body.data.previousId, version: 1, archived: 1, definition_json: before.definition_json });
    expect(current).toMatchObject({ id: before.id, version: 2, archived: 0, auto_insert: 0 });
    expect(JSON.parse(current!.definition_json)).toEqual(JSON.parse(JSON.stringify(standardStarter('salon'))));
    // 一覧と店が使う組は新しい版だけ。止めた写しは出ない。
    const list = (await request('/api/hq/style-starter-sets')).body.data as any[];
    expect(list.map((s) => [s.id, s.version])).toEqual([[before.id, 2]]);
    expect((await starter(sql.db, 't', 'salon')).version).toBe(2);
  });

  test('読んだ後にほかの人が保存していたら 409 で、上書きも写しも作らない', async () => {
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: [item('hq-1')] } })).status).toBe(200);
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 1, name: '本部', definition: { items: [item('hq-2')] } })).status).toBe(200);
    const before = sets();
    const r = await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1, confirmed: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('version_conflict');
    expect(sets()).toEqual(before);
  });

  test('同時に戻しても、1 回だけ戻り写しも 1 つ', async () => {
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: [item('hq-1')] } })).status).toBe(200);
    const results = await Promise.all([1, 2].map(() => request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1, confirmed: true })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sets().map((s) => [s.version, s.archived])).toEqual([[1, 1], [2, 0]]);
  });

  test('自分の組が無い統括は何も変えずに返す', async () => {
    const r = await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 0, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: null, version: 0, reset: false, previousId: null });
    expect(sets()).toEqual([]);
  });

  test('戻すのは統括の持ち主・管理者だけ。閲覧のみ・担当者・店だけの人は 403', async () => {
    expect((await request(hqPath('salon'), 'PUT', { expectedVersion: 0, name: '本部', definition: { items: [item('hq-1')] } })).status).toBe(200);
    for (const who of [
      { ...actor, readOnly: true },
      { ...actor, id: 'staff1', role: 'staff' },
    ] as Array<Env['Variables']['staff']>) {
      actor = who;
      expect((await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1, confirmed: true })).status).toBe(403);
    }
    actor = { id: 'scoped', name: '店だけ', tenantId: 't', role: 'admin', readOnly: false } as Env['Variables']['staff'];
    sql.raw.exec("INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope) VALUES('scoped','店だけ','admin','fixture3','t','accounts')");
    expect((await request(hqPath('salon') + '/reset', 'POST', { expectedVersion: 1, confirmed: true })).status).toBe(403);
    expect(sets().map((s) => s.version)).toEqual([1]);
  });
});


describe('初期セットの本文とメタ情報の境界', () => {
  const prepare = async () => {
    const saved = await request(base + '?account_id=a', 'PUT', { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'configured', value: 'simple' } } });
    expect(saved.status).toBe(200);
    sql.raw.prepare("UPDATE style_starter_items SET pending_update=? WHERE line_account_id='a'").run(JSON.stringify({ privateBody: '機能本文の目印' }));
  };
  test.each([
    { role: 'staff', readOnly: false },
    { role: 'staff', readOnly: true },
    { role: 'admin', readOnly: true },
    { role: 'owner', readOnly: true },
  ] as const)('$role / readOnly=$readOnly には本文を一切返さない', async identity => {
    await prepare(); actor = { ...actor, ...identity };
    const writesBefore = sql.raw.prepare('SELECT total_changes() n').get();
    const response = await request(base + '/starter-items?account_id=a');
    expect(response.status).toBe(200);
    const items = response.body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const fields = ['target_id', 'kind', 'key', 'name', 'is_sample', 'isSample', 'status', 'draftRevision', 'requiresActivation', 'activationAllowed'].sort();
    for (const item of items) { expect(Object.keys(item).sort()).toEqual(fields); expect(item.draftRevision).toBeNull(); }
    expect(sql.raw.prepare('SELECT total_changes() n').get()).toEqual(writesBefore);
    expect(items.some(item => item.name && item.target_id && item.kind && item.status)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('機能本文の目印');
    expect((await request(base + '/starter-items?account_id=b')).status).toBe(404);
    expect((await request(base + '/activate?account_id=a', 'POST', { confirmed: true, items: [] })).status).toBe(403);
  });
  test.each(['owner', 'admin'] as const)('%s の本文は従来どおり返す', async role => {
    await prepare(); actor = { ...actor, role };
    const response = await request(base + '/starter-items?account_id=a');
    expect(response.status).toBe(200);
    const items = response.body.data.items as Array<Record<string, unknown>>;
    expect(items.every(item => 'currentSnapshot' in item && 'definition' in item && 'pending_update' in item && 'pendingUpdate' in item)).toBe(true);
    expect(items.some(item => item.currentSnapshot !== null)).toBe(true);
    expect(JSON.stringify(response.body)).toContain('機能本文の目印');
  });
});
