import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const migration = readFileSync(`${root}migrations/382_tags_account_name_scope.sql`, 'utf8');
const bootstrap = readFileSync(`${root}bootstrap.sql`, 'utf8');
// The generated bootstrap already contains 382 after regeneration. Reintroduce only
// its old UNIQUE(name) constraint to exercise a populated pre-migration database.
const legacy = bootstrap.replace(/CREATE TABLE (?:"tags"|tags) \([\s\S]*?\);/, table =>
  table.replace(/name\s+TEXT(?: UNIQUE)? NOT NULL/, 'name TEXT UNIQUE NOT NULL'))
  .replace(/CREATE UNIQUE INDEX idx_tags_legacy_name[^;]+;/, '')
  .replace(/CREATE UNIQUE INDEX idx_tags_legacy_normalized_name[^;]+;/, '')
  .replace(/CREATE UNIQUE INDEX idx_tags_account_exact_name[^;]+;/, '')
  // 617 の分類先の追加は 382 より後。382 の時点の表の形で番兵を試す。
  .replace(/CREATE TABLE affiliate_offers [\s\S]*?;/, table => table.replace(/, folder_id TEXT REFERENCES folders\(id\) ON DELETE SET NULL/, ''))
  .replace(/CREATE INDEX idx_affiliate_offers_folder[^;]+;/, '')
  .replace(/CREATE TRIGGER affiliate_offers_folder_(?:insert|update)[\s\S]*?END;/g, '')
  // 765 も分類先の列を参照するため、617 より前の姿には存在しない。
  .replace(/CREATE TRIGGER folder_membership_affiliate_offers_(?:insert|update|delete)[\s\S]*?END;/g, '');
const referenceColumns = [
  ['affiliate_offers', 'tag_id', 'NO ACTION'],
  ['broadcasts', 'target_tag_id', 'SET NULL'],
  ['entry_routes', 'tag_id', 'SET NULL'],
  ['forms', 'on_submit_tag_id', 'SET NULL'],
  ['friend_tag_side_effect_runs', 'tag_id', 'CASCADE'],
  ['friend_tags', 'tag_id', 'CASCADE'],
  ['menus', 'auto_tag_id', 'SET NULL'],
  ['nen_columns', 'completion_tag_id', 'SET NULL'],
  ['nen_columns', 'target_tag_id', 'SET NULL'],
  ['reminders', 'target_tag_id', 'SET NULL'],
  ['scenario_steps', 'on_reach_tag_id', 'SET NULL'],
  ['scenario_triggers', 'tag_id', 'CASCADE'],
  ['scenarios', 'trigger_tag_id', 'SET NULL'],
  ['tracked_links', 'tag_id', 'SET NULL'],
];

function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(legacy);
  // 652 は 382 より後。SQLのCASEとENDを切らず、後年の4つの参照元だけを外す。
  for (const trigger of ['style_bookings_stage','style_meet_consultations_stage','style_membership_insert','style_membership_update'])
    db.exec(`DROP TRIGGER ${trigger}`);
  // 541 が 382 より後に tag_update_requests（tags への外部キー付き）を作った。
  // 移行前の姿を再現するこの器には含めない。残すと 382 自身の番兵
  // （参照数=14・未知の参照があれば中止）が正しく止めてしまう。
  db.exec('DROP TABLE IF EXISTS tag_update_requests');
  // 717/721 are later than 382; their rank-to-tag reference must not enter the historical 14-reference fixture.
  db.exec('DROP TABLE member_rank_notices; DROP TABLE member_ranks; DROP TABLE member_rank_tiers');
  for (let i = 1; i <= 3; i++) insert(db, 'line_accounts', {
    id: `account-${i}`, channel_id: `fixture-channel-${i}`, name: `店舗${i}`,
    channel_access_token: 'fixture', channel_secret: 'fixture',
  });
  insert(db, 'mileage_programs', { id: 'default', code: 'fixture', name: '試験', created_at: 'old', updated_at: 'old' });
  insert(db, 'friends', { id: 'friend-1', line_user_id: 'synthetic-friend-1', line_account_id: 'account-1' });
  insert(db, 'friends', { id: 'friend-2', line_user_id: 'synthetic-friend-2', line_account_id: 'account-1' });
  insert(db, 'folders', { id: 'folder-1', kind: 'tag', name: '分類', account_id: 'account-1' });
  insert(db, 'tag_groups', { id: 'group-1', name: '旧分類', created_at: 'old-created', updated_at: 'old-updated' });
  insert(db, 'recipes', { id: 'recipe-1', name: '試験', purpose: '試験', creates_summary: '試験', created_at: 'old', updated_at: 'old' });
  insert(db, 'recipe_clone_runs', { id: 'clone-1', recipe_id: 'recipe-1', recipe_version: 1, line_account_id: 'account-1', idempotency_key: 'fixture', request_fingerprint: 'fixture', created_at: 'old' });
  insert(db, 'tags', {
    id: 'tag-1', name: '既存タグ', color: '#ABCDEF', mileage_reward: 123, referral_mileage_reward: 45,
    mileage_multiplier_bps: 12000, mileage_multiplier_priority: 9, created_at: '2025-01-01',
    group_id: 'group-1', folder_id: 'folder-1', is_starred: 1, display_order: 17,
    line_account_id: 'account-1', description: '既存説明', normalized_name: '既存タグ',
    manual_assignment_allowed: 0, reapply_policy: 'every_time', linked_enabled: 1,
    status: 'active', version: 12, created_by: 'synthetic-author', updated_by: 'synthetic-editor',
    updated_at: '2026-09-01', created_from_recipe_id: 'recipe-1', recipe_clone_run_id: 'clone-1',
  });
  insert(db, 'tags', { id: 'tag-2', name: '整理済み', status: 'archived', line_account_id: null, normalized_name: null });
  insert(db, 'scenarios', { id: 'scenario-1', name: '試験', trigger_type: 'tag_added', trigger_tag_id: 'tag-1' });
  insert(db, 'affiliate_offers', { id: 'offer-1', name: '試験', created_at: 'old', tag_id: 'tag-1' });
  insert(db, 'broadcasts', { id: 'broadcast-1', title: '試験', message_type: 'text', message_content: 'synthetic', target_tag_id: 'tag-1' });
  insert(db, 'entry_routes', { id: 'route-1', ref_code: 'fixture', name: '試験', tag_id: 'tag-1' });
  insert(db, 'forms', { id: 'form-1', name: '試験', on_submit_tag_id: 'tag-1', content_revision: 11 });
  insert(db, 'menus', { id: 'menu-1', line_account_id: 'account-1', name: '試験', duration_minutes: 30, base_price: 1234, auto_tag_id: 'tag-1' });
  insert(db, 'nen_columns', { id: 'column-1', slug: 'fixture', title: '試験', article_url: 'https://example.invalid/', created_at: 'old', updated_at: 'old', target_tag_id: 'tag-1', completion_tag_id: 'tag-2' });
  insert(db, 'reminders', { id: 'reminder-1', name: '試験', target_tag_id: 'tag-1' });
  insert(db, 'scenario_steps', { id: 'step-1', scenario_id: 'scenario-1', step_order: 1, message_type: 'text', message_content: 'synthetic', on_reach_tag_id: 'tag-1' });
  insert(db, 'scenario_triggers', { id: 'trigger-1', scenario_id: 'scenario-1', kind: 'tag_added', tag_id: 'tag-1' });
  insert(db, 'scenario_triggers', { id: 'trigger-2', scenario_id: 'scenario-1', kind: 'tag_added', tag_id: 'tag-2', created_at: 'preserved-trigger-time' });
  insert(db, 'scenario_triggers', { id: 'trigger-tag-null', scenario_id: 'scenario-1', kind: 'tag_added', tag_id: null });
  insert(db, 'scenario_triggers', { id: 'trigger-null', scenario_id: 'scenario-1', kind: 'friend_add', tag_id: null });
  insert(db, 'tracked_links', { id: 'link-1', name: '試験', original_url: 'https://example.invalid/', tag_id: 'tag-1' });
  insert(db, 'tracked_links', { id: null, name: 'NULL id 1', original_url: 'https://example.invalid/1', tag_id: 'tag-1' });
  insert(db, 'tracked_links', { id: null, name: 'NULL id 2', original_url: 'https://example.invalid/2', tag_id: 'tag-2' });
  for (const friend of ['friend-1', 'friend-2']) {
    insert(db, 'friend_tags', { friend_id: friend, tag_id: 'tag-1', assigned_at: `assigned-${friend}` });
    insert(db, 'friend_tag_side_effect_runs', { friend_id: friend, tag_id: 'tag-1', step_key: 'event_tag_change', assigned_at: 'assigned', status: 'completed', attempt_count: 2, last_error: null, last_attempt_at: 'attempted', created_at: 'old-created', updated_at: 'old-updated' });
  }
  return db;
}

function contents(db: Database.Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

function migrate(db: Database.Database) { db.transaction(() => db.exec(migration))(); }

describe('382: タグ名の一意性を店舗単位へ移す', () => {
  test('D1のauthorizerが拒否するpragmaテーブル値関数を一切使わない', () => {
    const executableSql = migration.replace(/--.*$/gm, '');
    // pragma_table_info / pragma_foreign_key_list / pragma_foreign_key_check
    // などの `pragma_*(...)` 形式は引数が固定でも SQLITE_AUTH で拒否される。
    // 文形式の `PRAGMA defer_foreign_keys` だけが許される。
    expect(executableSql).not.toMatch(/\bpragma_\w+\s*\(/i);
    expect(executableSql).not.toMatch(/\bpragma\s+foreign_key_check\b/i);
  });

  test('実schemaの全14参照を列挙し、CASCADE対象にさらに子参照がないことを確認', () => {
    const db = setup();
    try {
      const actual: string[][] = [];
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
        for (const fk of db.pragma(`foreign_key_list("${name}")`) as { table: string; from: string; on_delete: string }[]) {
          if (fk.table === 'tags') actual.push([name, fk.from, fk.on_delete]);
          expect(['friend_tags', 'friend_tag_side_effect_runs', 'scenario_triggers']).not.toContain(fk.table);
        }
      }
      expect(actual.sort()).toEqual([...referenceColumns].sort());
    } finally { db.close(); }
  });

  test('全既存行・全列・NULL・CASCADE行・索引・列定義を保持し外部キー違反なし', () => {
    const db = setup();
    try {
      const before = contents(db);
      const columns = db.pragma('table_info(tags)');
      const indexes = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='tags' AND sql IS NOT NULL ORDER BY name").all();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const triggerRows = db.prepare('SELECT rowid,* FROM scenario_triggers ORDER BY rowid').all();
      migrate(db);
      expect(db.prepare('SELECT rowid,* FROM scenario_triggers ORDER BY rowid').all()).toEqual(triggerRows);
      expect(contents(db)).toEqual(before);
      expect(db.pragma('table_info(tags)')).toEqual(columns);
      expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='tags' AND sql IS NOT NULL AND name NOT IN ('idx_tags_legacy_name','idx_tags_legacy_normalized_name','idx_tags_account_exact_name') ORDER BY name").all()).toEqual(indexes);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  test('同一scenarioの複数tag_added条件をNULLに集約せず全行・行IDを保持する', () => {
    const db = setup();
    try {
      const before = db.prepare('SELECT rowid,* FROM scenario_triggers ORDER BY rowid').all();
      expect(() => db.exec('UPDATE scenario_triggers SET tag_id=NULL WHERE tag_id IS NOT NULL')).toThrow(/UNIQUE/);
      expect(db.prepare('SELECT rowid,* FROM scenario_triggers ORDER BY rowid').all()).toEqual(before);
      migrate(db);
      expect(db.prepare('SELECT rowid,* FROM scenario_triggers ORDER BY rowid').all()).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  test('CASCADE退避対象に未知の子テーブルがあれば削除前に止める', () => {
    const db = setup();
    try {
      db.exec("CREATE TABLE future_trigger_child(id TEXT, trigger_id TEXT REFERENCES scenario_triggers(id) ON DELETE CASCADE); INSERT INTO future_trigger_child VALUES ('child','trigger-1')");
      const before = contents(db);
      expect(() => migrate(db)).toThrow();
      expect(contents(db)).toEqual(before);
    } finally { db.close(); }
  });

  test('移行前は店舗が異なっても失敗し、移行後は3店舗同名成功・同一店舗重複拒否', () => {
    const db = setup();
    try {
      expect(() => insert(db, 'tags', { id: 'old-conflict', name: '既存タグ', line_account_id: 'account-2' })).toThrow(/UNIQUE/);
      migrate(db);
      for (let i = 1; i <= 3; i++) insert(db, 'tags', { id: `new-${i}`, name: '同名タグ', normalized_name: '同名タグ', line_account_id: `account-${i}` });
      expect(db.prepare("SELECT count(*) n FROM tags WHERE name='同名タグ'").get()).toEqual({ n: 3 });
      expect(() => insert(db, 'tags', { id: 'conflict', name: ' 同名タグ ', normalized_name: '同名タグ', line_account_id: 'account-1' })).toThrow(/UNIQUE/);
      expect(() => insert(db, 'tags', { id: 'legacy-duplicate', name: '整理済み' })).toThrow(/UNIQUE/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  test('旧店舗タグのNULL正規化名を保持しつつ同店舗の完全同名だけを拒否する', () => {
    const db = setup();
    try {
      insert(db, 'tags', { id: 'old-scoped-null', name: '旧店舗タグ', line_account_id: 'account-1', normalized_name: null });
      migrate(db);
      expect(db.prepare("SELECT normalized_name FROM tags WHERE id='old-scoped-null'").get()).toEqual({ normalized_name: null });
      for (const normalized of [null, '旧店舗タグ']) {
        expect(() => insert(db, 'tags', { id: `duplicate-${normalized ?? 'null'}`, name: '旧店舗タグ', line_account_id: 'account-1', normalized_name: normalized })).toThrow(/UNIQUE/);
      }
      insert(db, 'tags', { id: 'other-account-name', name: '旧店舗タグ', line_account_id: 'account-2', normalized_name: '旧店舗タグ' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  test('新しい未所属タグは正規化名の同時競合をDBでも拒否する', () => {
    const db = setup();
    try {
      migrate(db);
      insert(db, 'tags', { id: 'global-a', name: 'ＶＩＰ　会員', line_account_id: null, normalized_name: 'vip 会員' });
      expect(() => insert(db, 'tags', { id: 'global-b', name: 'vip 会員', line_account_id: null, normalized_name: 'vip 会員' })).toThrow(/UNIQUE/);
    } finally { db.close(); }
  });

  test('途中復元失敗でタグ・付与・全参照・schemaを丸ごと戻す', () => {
    const db = setup();
    try {
      const before = contents(db);
      const broken = migration.replace('INSERT INTO friend_tags SELECT * FROM migration_382_friend_tags_backup;', "INSERT INTO friend_tags SELECT friend_id, tag_id, NULL FROM migration_382_friend_tags_backup;");
      expect(() => db.transaction(() => db.exec(broken))()).toThrow();
      expect(contents(db)).toEqual(before);
      expect(() => insert(db, 'tags', { id: 'legacy-conflict', name: '既存タグ' })).toThrow(/UNIQUE/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  test('未知の追加参照がある場合はデータ退避より前に中止する', () => {
    const db = setup();
    try {
      db.exec('CREATE TABLE future_tag_ref(id TEXT, tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE)');
      const before = contents(db);
      expect(() => migrate(db)).toThrow();
      expect(contents(db)).toEqual(before);
    } finally { db.close(); }
  });
});
