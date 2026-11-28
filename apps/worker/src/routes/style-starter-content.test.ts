import { afterEach, beforeEach, expect, test } from 'vitest';
import { ACCOUNT_STYLES, DEFAULT_TENANT_ID, type SetupAnswer } from '@line-crm/shared';
import { publishFriendAddRule } from '@line-crm/db';

import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { initializeAccountStyle, profile, readDefinition, saveProfile, standardStarter } from '../services/style-setup.js';
import { styleMenuButtons } from '../services/style-menu-buttons.js';
import { selectPublishedFriendAddRule } from '../features/friends/friend-add-routing-select-published-friend-add-rule.js';

let f: ReturnType<typeof createTestD1>;
beforeEach(() => {
  f = createTestD1();
  f.raw.pragma('foreign_keys=OFF');
  f.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id,tenant_id) VALUES('a','a','a','secret-token','secret','liff-a',?)").run(DEFAULT_TENANT_ID);
  f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','担当','owner','key',?)").run(DEFAULT_TENANT_ID);
});
afterEach(() => { f.raw.close(); });

const versions = () => f.raw.prepare(
  "SELECT v.status,v.definition_snapshot FROM friend_add_rule_versions v JOIN friend_add_rules r ON r.id=v.rule_id WHERE r.line_account_id='a' AND r.friend_kind='first_time' AND r.is_unknown_route_fallback=1 ORDER BY v.version_number",
).all() as Array<{ status: string; definition_snapshot: string }>;
const starterRows = () => f.raw.prepare("SELECT item_key,kind,target_id,is_sample FROM style_starter_items WHERE line_account_id='a' AND kind='friend_add_rule'").all() as Array<{ item_key: string; kind: string; target_id: string; is_sample: number }>;
const published = () => selectPublishedFriendAddRule(f.db, { accountId: 'a', friendId: 'friend', kind: 'first_time', entryRouteId: null, now: new Date() });

const EXPECTED_KEYS: Record<string, string[]> = {
  standard: ['welcome', 'friend-add-welcome', 'menu', 'segment-tags', 'friend-add-scenario', 'dashboard'],
  ec: ['welcome', 'friend-add-welcome', 'menu', 'segment-tags', 'friend-add-scenario', 'dashboard'],
  restaurant: ['welcome', 'friend-add-welcome', 'menu', 'reminder-thanks', 'segment-tags', 'friend-add-scenario', 'dashboard'],
  salon: ['welcome', 'friend-add-welcome', 'menu', 'booking', 'reminder-day-before', 'reminder-today', 'reminder-thanks', 'segment-tags', 'friend-add-scenario', 'dashboard'],
  consult: ['welcome', 'friend-add-welcome', 'menu', 'booking', 'reminder-day-before', 'reminder-today', 'reminder-thanks', 'segment-tags', 'friend-add-scenario', 'dashboard'],
  lesson: ['welcome', 'friend-add-welcome', 'menu', 'reminder-day-before', 'reminder-today', 'reminder-thanks', 'segment-tags', 'friend-add-scenario', 'dashboard'],
};

test.each(ACCOUNT_STYLES)('%s の初期セットは、ごあいさつにつないだ友だち追加の決まりを 1 つだけ持つ', (style) => {
  const items = standardStarter(style).items;
  const existingKinds=items.filter(item=>item.kind!=='form');
  expect(existingKinds.slice(0, EXPECTED_KEYS[style]!.length).map((i) => i.key)).toEqual(EXPECTED_KEYS[style]);
  expect(items.length).toBeLessThanOrEqual(30);
  const rules = items.filter((i) => i.kind === 'friend_add_rule');
  expect(rules).toHaveLength(1);
  const welcome = items.find((i) => i.key === 'welcome')!;
  expect(rules[0]).toMatchObject({ key: 'friend-add-welcome', templateKey: 'welcome', text: welcome.text });
  expect(() => readDefinition(standardStarter(style), style)).not.toThrow();
});

test('友だち追加の決まりの定義は、ごあいさつの文が無い・2 つある・存在しない文を指すと通らない', () => {
  const base = standardStarter('salon');
  const rule = base.items.find((i) => i.kind === 'friend_add_rule')!;
  expect(() => readDefinition({ items: [...base.items.filter((i) => i !== rule), { ...rule, text: ' ' }] }, 'salon')).toThrow('invalid_starter_set');
  expect(() => readDefinition({ items: [...base.items, { ...rule, key: 'friend-add-2' }] }, 'salon')).toThrow('invalid_starter_set');
  expect(() => readDefinition({ items: [...base.items.filter((i) => i !== rule), { ...rule, templateKey: 'missing' }] }, 'salon')).toThrow('invalid_starter_set');
});

test.each(ACCOUNT_STYLES)('%s：スタイルを選ぶと受け皿に下書きだけが入り、公開するまで 1 通も送られない', async (style) => {
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', style);
  const welcome = standardStarter(style).items.find((i) => i.key === 'welcome')!.text;
  const rows = versions();
  expect(rows.map((r) => r.status)).toEqual(['published', 'draft']);
  expect(JSON.parse(rows[0]!.definition_snapshot)).toMatchObject({ messageType: 'scenario', messageText: '' });
  expect(JSON.parse(rows[1]!.definition_snapshot)).toMatchObject({ messageType: 'text', messageText: welcome, timing: 'immediate', routeIds: [] });
  expect(starterRows()).toEqual([{ item_key: 'friend-add-welcome', kind: 'friend_add_rule', target_id: `friend-add-rule-first_time-a`, is_sample: 1 }]);
  // 友だち追加が来ても、選ばれるのは今の公開版（何も送らない形）だけ。
  const selection = await published();
  expect(selection.selected?.definition).toMatchObject({ messageType: 'scenario', messageText: '' });
  expect(f.raw.prepare('SELECT COUNT(*) n FROM messages_log').get()).toEqual({ n: 0 });
  // 公開は確認（テストの成功）を通さないと進まない。
  await expect(publishFriendAddRule(f.db, { lineAccountId: 'a', ruleId: 'friend-add-rule-first_time-a', staffId: 'owner', idempotencyKey: 'k1' })).rejects.toThrow('FRIEND_ADD_RULE_DRAFT_NOT_TESTED');
  expect((await published()).selected?.definition.messageText).toBe('');
  f.raw.prepare("UPDATE friend_add_rule_versions SET last_test_status='succeeded' WHERE status='draft'").run();
  await publishFriendAddRule(f.db, { lineAccountId: 'a', ruleId: 'friend-add-rule-first_time-a', staffId: 'owner', idempotencyKey: 'k2' });
  expect((await published()).selected?.definition).toMatchObject({ messageType: 'text', messageText: welcome });
});

test.each(ACCOUNT_STYLES)('%s：保存し直しても・スタイルを変えても、ごあいさつの下書きは二重に入らない', async (style) => {
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', style);
  const first = versions();
  for (const next of [style, ...ACCOUNT_STYLES.filter((s) => s !== style)]) {
    const current = await profile(f.db, 'a');
    await saveProfile(f.db, 'a', DEFAULT_TENANT_ID, 'owner', { expectedVersion: current!.version, style: next });
  }
  expect(versions()).toEqual(first);
  expect(starterRows()).toHaveLength(1);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM friend_add_rules WHERE line_account_id='a' AND friend_kind='first_time' AND is_unknown_route_fallback=1").get()).toEqual({ n: 1 });
});

const fallback = (definition: string) => f.raw.exec(`INSERT INTO friend_add_rules(id,line_account_id,friend_kind,name,priority,is_unknown_route_fallback,status,current_version_id) VALUES('mine','a','first_time','経路が分からなかった人',9999,1,'published','mine-v1');
  INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status) VALUES('mine-v1','mine',1,'${definition}','published');`);

test('受け皿を店が設定済み（シナリオあり）の時は、ごあいさつの下書きを足さない', async () => {
  fallback('{"routeIds":[],"scenarioId":"s1","messageType":"scenario","messageText":"","timing":"scenario","actions":[]}');
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', 'salon');
  expect(versions().map((v) => v.status)).toEqual(['published']);
  expect(starterRows()).toEqual([]);
});

test('受け皿に店の下書きが既にある時は、店の下書きを上書きしない', async () => {
  fallback('{"routeIds":[],"scenarioId":null,"messageType":"scenario","messageText":"","timing":"scenario","actions":[]}');
  f.raw.exec(`INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status) VALUES('mine-v2','mine',2,'{"messageType":"text","messageText":"店の下書き"}','draft');`);
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', 'salon');
  expect(versions().map((v) => [v.status, JSON.parse(v.definition_snapshot).messageText])).toEqual([['published', ''], ['draft', '店の下書き']]);
  expect(starterRows()).toEqual([]);
});

test('受け皿が作られた時のまま（移行で作られた ID）なら、その受け皿に下書きを足す', async () => {
  fallback('{"routeIds":[],"scenarioId":null,"messageType":"scenario","messageText":"","timing":"scenario","actions":[]}');
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', 'salon');
  expect(versions().map((v) => v.status)).toEqual(['published', 'draft']);
  expect(starterRows()).toMatchObject([{ target_id: 'mine' }]);
});

test('飲食の4面は同じ店の予約履歴と料理メニューへつなぎ、未設定でも並びを保つ', async () => {
  const item = standardStarter('restaurant').items.find((i) => i.kind === 'rich_menu')!;
  expect(item.buttons!.map((b) => b.label)).toEqual(['予約する','予約の確認と変更','メニュー','アクセス']);
  f.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','統括');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店','s','a');
    INSERT INTO rt_reservation_links(store_id,token) VALUES('store','tok');`);
  const answers:Record<string,SetupAnswer>={image:{mode:'configured',value:'simple'}};
  await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:0,style:'restaurant',answers});
  const buttons=await styleMenuButtons(f.db,'a','restaurant',item,answers);
  expect(buttons).toHaveLength(4);
  expect(buttons[0]).toMatchObject({intent:'form',actionType:'uri'});
  expect(new URL(buttons[0]!.actionData).searchParams.get('page')).toBe('form');
  expect(new URL(buttons[0]!.actionData).searchParams.get('id')).toBe(buttons[0]!.formId);
  expect(buttons[1]!.actionData).toBe('https://liff.line.me/liff-a/?page=restaurant&token=tok&view=mine');
  expect(buttons[2]).toMatchObject({
    actionData: 'https://liff.line.me/liff-a/?page=restaurant-menu&token=tok',
    intent: 'url',
    formId: null,
    ready: true,
  });
  expect(buttons[3]!.actionData).toContain('/information/');
  expect(standardStarter('restaurant').items.some(item => item.key === 'initial-restaurant-menu')).toBe(false);
  expect(f.raw.prepare("SELECT 1 FROM style_starter_items WHERE item_key='initial-restaurant-menu'").get()).toBeUndefined();
  f.raw.exec('DELETE FROM rt_reservation_links');
  const pending=await styleMenuButtons(f.db,'a','restaurant',item,answers);
  expect(pending.map(button=>button.label)).toEqual(buttons.map(button=>button.label));
  expect(pending[1]).toMatchObject({actionData:'',ready:false});
  expect(pending[2]).toMatchObject({actionData:'',ready:false});
});

test('旧い飲食の初期セットを読めても、料理メニュー用の回答フォームは作成しない', () => {
  const definition = standardStarter('restaurant');
  const legacyItem = { key: 'initial-restaurant-menu', kind: 'form', name: 'メニュー', formTarget: 'menu' };
  const parsed = readDefinition({ ...definition, items: [...definition.items, legacyItem] }, 'restaurant');
  expect(parsed.items.some(item => item.key === legacyItem.key)).toBe(false);
  expect(standardStarter('salon').items.some(item => item.key === 'initial-salon-menu')).toBe(true);
});

test('スタイルを後で選ぶ店は、選択後にも初期セットを重複なく受け取る', async () => {
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner');
  const pending = await profile(f.db, 'a');
  expect(pending!.selection_mode).toBe('later');
  await saveProfile(f.db, 'a', DEFAULT_TENANT_ID, 'owner', { expectedVersion: pending!.version, style: 'salon', answers: { booking: { mode: 'configured', value: true } } });
  const selected = await profile(f.db, 'a');
  expect(selected!.selection_mode).toBe('configured');
  const items = f.raw.prepare("SELECT item_key FROM style_starter_items WHERE line_account_id='a' ORDER BY item_key").all() as Array<{item_key:string}>;
  expect(items.some(item => item.item_key === 'booking')).toBe(true);
  expect(new Set(items.map(item => item.item_key)).size).toBe(items.length);
  expect(starterRows()).toHaveLength(1);
});
