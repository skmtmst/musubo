import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createFriendField,
  getFriendFieldMap,
  setFriendFieldValue,
  validateFriendFieldValue,
} from '../src/friend-fields.js';
import {
  createFieldMigrationPreview,
  executeFieldMigration,
  queueFieldMigration,
} from '../src/field-migrations.js';
import { asD1 } from './d1-test-helper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const field = (type: string, options_json: string | null = null) => ({ type, options_json });

describe('validateFriendFieldValue', () => {
  it('空は消す扱いにする', () => {
    expect(validateFriendFieldValue(field('number'), null)).toEqual({ ok: true, value: null });
    expect(validateFriendFieldValue(field('number'), undefined)).toEqual({ ok: true, value: null });
    expect(validateFriendFieldValue(field('text'), '')).toEqual({ ok: true, value: null });
    expect(validateFriendFieldValue(field('text'), '   ')).toEqual({ ok: true, value: null });
  });

  it('text・textareaは前後の空白を落とし長さを見る', () => {
    expect(validateFriendFieldValue(field('text'), '  ポチ  ')).toEqual({ ok: true, value: 'ポチ' });
    expect(validateFriendFieldValue(field('text'), 'x'.repeat(201)).ok).toBe(false);
    expect(validateFriendFieldValue(field('textarea'), 'x'.repeat(2000)).ok).toBe(true);
    expect(validateFriendFieldValue(field('textarea'), 'x'.repeat(2001)).ok).toBe(false);
    expect(validateFriendFieldValue(field('text'), { a: 1 }).ok).toBe(false);
  });

  it('numberは区切りを外して正規化し、数でないものは止める', () => {
    expect(validateFriendFieldValue(field('number'), '1,000')).toEqual({ ok: true, value: '1000' });
    expect(validateFriendFieldValue(field('number'), 5)).toEqual({ ok: true, value: '5' });
    expect(validateFriendFieldValue(field('number'), '-3.5')).toEqual({ ok: true, value: '-3.5' });
    for (const bad of ['たくさん', 'NaN', 'Infinity', '-Infinity', '0x10', '1e5', true, {}, []]) {
      expect(validateFriendFieldValue(field('number'), bad).ok).toBe(false);
    }
  });

  it('dateはYYYY-MM-DDの存在する日だけ通す', () => {
    expect(validateFriendFieldValue(field('date'), '2026-09-01')).toEqual({ ok: true, value: '2026-09-01' });
    for (const bad of ['2026/9/1', '2026-9-1', '2026-02-30', '昨日', '2026-13-01', 20260901]) {
      expect(validateFriendFieldValue(field('date'), bad).ok).toBe(false);
    }
  });

  it('datetimeは読める日時をISOへ直す', () => {
    const checked = validateFriendFieldValue(field('datetime'), '2026-09-01T10:00:00+09:00');
    expect(checked).toEqual({ ok: true, value: '2026-09-01T01:00:00.000Z' });
    expect(validateFriendFieldValue(field('datetime'), 'いつか').ok).toBe(false);
  });

  it('checkboxは1・0へ直す', () => {
    expect(validateFriendFieldValue(field('checkbox'), true)).toEqual({ ok: true, value: '1' });
    expect(validateFriendFieldValue(field('checkbox'), '0')).toEqual({ ok: true, value: '0' });
    expect(validateFriendFieldValue(field('checkbox'), 'はい').ok).toBe(false);
  });

  it('selectは表示名でも受けてIDへ直し、選択肢外は止める', () => {
    const options = JSON.stringify([{ id: 'opt-1', label: '柴犬' }, { id: 'opt-2', label: '猫' }]);
    expect(validateFriendFieldValue(field('select', options), '柴犬')).toEqual({ ok: true, value: 'opt-1' });
    expect(validateFriendFieldValue(field('select', options), 'opt-2')).toEqual({ ok: true, value: 'opt-2' });
    expect(validateFriendFieldValue(field('select', options), 'ドラゴン').ok).toBe(false);
    // 文字列持ちの選択肢も受け付ける。
    const legacy = JSON.stringify(['柴犬', '猫']);
    expect(validateFriendFieldValue(field('select', legacy), '猫')).toEqual({ ok: true, value: '猫' });
  });

  it('multi_selectは配列・JSON・単体を受けてIDの配列へ直す', () => {
    const options = JSON.stringify([{ id: 'opt-1', label: '柴犬' }, { id: 'opt-2', label: '猫' }]);
    expect(validateFriendFieldValue(field('multi_select', options), ['柴犬', 'opt-2']))
      .toEqual({ ok: true, value: '["opt-1","opt-2"]' });
    expect(validateFriendFieldValue(field('multi_select', options), '["opt-2"]'))
      .toEqual({ ok: true, value: '["opt-2"]' });
    expect(validateFriendFieldValue(field('multi_select', options), '柴犬'))
      .toEqual({ ok: true, value: '["opt-1"]' });
    expect(validateFriendFieldValue(field('multi_select', options), [])).toEqual({ ok: true, value: null });
    expect(validateFriendFieldValue(field('multi_select', options), ['ドラゴン']).ok).toBe(false);
    expect(validateFriendFieldValue(field('multi_select', options), 5).ok).toBe(false);
  });

  it('未知の種類は無条件通過させず止める', () => {
    expect(validateFriendFieldValue({ type: 'mystery', options_json: null }, '値').ok).toBe(false);
    expect(validateFriendFieldValue({ type: '', options_json: null }, '値').ok).toBe(false);
    expect(validateFriendFieldValue({ type: 'mystery', options_json: null }, null).ok).toBe(false);
  });

  it('email・tel・urlは形を見て、メールは小文字へ直す', () => {
    expect(validateFriendFieldValue(field('email'), 'Taro@Example.COM'))
      .toEqual({ ok: true, value: 'taro@example.com' });
    expect(validateFriendFieldValue(field('email'), 'not-an-email').ok).toBe(false);
    expect(validateFriendFieldValue(field('tel'), '090-0000-5678')).toEqual({ ok: true, value: '090-0000-5678' });
    expect(validateFriendFieldValue(field('tel'), '123').ok).toBe(false);
    expect(validateFriendFieldValue(field('url'), 'https://example.jp/a')).toEqual({ ok: true, value: 'https://example.jp/a' });
    expect(validateFriendFieldValue(field('url'), 'ftp://example.jp').ok).toBe(false);
  });
});

describe('正規化値の後段利用（N-042 結合）', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db = asD1(sqlite);

    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-1', 'channel-1', '本店', 'token', 'secret');
      INSERT INTO friends (id, line_user_id, line_account_id)
      VALUES ('friend-1', 'U001', 'account-1');
      INSERT INTO friend_fields (id, name, field_key, type, options_json)
      VALUES
        ('field-num', '頭数', 'head_count', 'number', NULL),
        ('field-sel', '犬種', 'breed', 'select',
         '[{"id":"opt-1","label":"柴犬"},{"id":"opt-2","label":"猫"}]'),
        ('field-multi', '好み', 'tastes', 'multi_select',
         '[{"id":"opt-1","label":"柴"},{"id":"opt-2","label":"猫"}]');
    `);
  });

  it('差し込みは正規化値から表示名を返す', async () => {
    const num = validateFriendFieldValue({ type: 'number', options_json: null }, '1,000');
    const sel = validateFriendFieldValue(
      { type: 'select', options_json: '[{"id":"opt-1","label":"柴犬"}]' }, '柴犬');
    const multi = validateFriendFieldValue(
      { type: 'multi_select', options_json: '[{"id":"opt-1","label":"柴"},{"id":"opt-2","label":"猫"}]' },
      ['柴', 'opt-2']);
    if (!num.ok || !sel.ok || !multi.ok) throw new Error('validation failed in test setup');
    await setFriendFieldValue(db, { friendId: 'friend-1', fieldId: 'field-num', value: num.value, updatedBy: 'u-1' });
    await setFriendFieldValue(db, { friendId: 'friend-1', fieldId: 'field-sel', value: sel.value, updatedBy: 'u-1' });
    await setFriendFieldValue(db, { friendId: 'friend-1', fieldId: 'field-multi', value: multi.value, updatedBy: 'u-1' });

    const map = await getFriendFieldMap(db, 'friend-1');
    expect(map.head_count).toBe('1000');
    expect(map.breed).toBe('柴犬');
    expect(map.tastes).toBe('柴、猫');
  });

  it('配信条件の数値比較は正規化値に一致し、不正値は検証で止まる', async () => {
    // 絞り込み配信は CAST(value AS REAL) で比べる。不正値('たくさん'など)は
    // 0として扱われるため、検証で保存させないことが条件の正しさに直結する。
    expect(validateFriendFieldValue({ type: 'number', options_json: null }, 'たくさん').ok).toBe(false);
    const checked = validateFriendFieldValue({ type: 'number', options_json: null }, '1,000');
    if (!checked.ok) throw new Error('validation failed in test setup');
    await setFriendFieldValue(db, { friendId: 'friend-1', fieldId: 'field-num', value: checked.value, updatedBy: 'u-1' });

    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM friend_field_values
                WHERE friend_id = ? AND field_id = ? AND CAST(value AS REAL) >= ?`)
      .bind('friend-1', 'field-num', 500)
      .first<{ c: number }>();
    expect(Number(row?.c)).toBe(1);
  });

  it('中央の口は項目定義があれば正規化して保存し、通らない値は例外で止める', async () => {
    await setFriendFieldValue(db, {
      friendId: 'friend-1', fieldId: 'field-num', value: '1,000', updatedBy: 'u-1',
      field: { type: 'number', options_json: null },
    });
    const stored = sqlite.prepare(
      `SELECT value FROM friend_field_values WHERE friend_id = 'friend-1' AND field_id = 'field-num'`,
    ).get() as { value: string };
    expect(stored).toEqual({ value: '1000' });

    await expect(setFriendFieldValue(db, {
      friendId: 'friend-1', fieldId: 'field-num', value: 'たくさん', updatedBy: 'u-1',
      field: { type: 'number', options_json: null },
    })).rejects.toThrow();
    // 失敗した書き込みは残さない。
    expect(sqlite.prepare(
      `SELECT value FROM friend_field_values WHERE friend_id = 'friend-1' AND field_id = 'field-num'`,
    ).get()).toEqual({ value: '1000' });
  });

  it('移行実行は変換済みでも検証を通し、通らない値は書かず失敗に倒す', async () => {
    sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES ('friend-2', 'U002', 'account-1')`).run();
    const source = await createFriendField(db, { name: '年齢（旧）', fieldKey: 'age_tamper_old', type: 'text' });
    const target = await createFriendField(db, { name: '年齢', fieldKey: 'age_tamper', type: 'number' });
    const scope = { tenantId: '00000000-0000-4000-8000-000000000001', lineAccountId: 'account-1' };
    await createFieldMigrationPreview(db, {
      runId: 'run-tamper', scope, sourceFieldId: source.id, targetFieldId: target.id,
      sourceVersion: 1, targetVersion: 1, previewTokenHash: 'tamper-token', snapshotHash: 'tamper-snapshot',
      expiresAt: '2999-01-01T00:00:00.000Z', usageTargets: [], createdBy: 'staff-1',
      items: [
        { friendId: 'friend-1', sourceValue: '12', convertedValue: '12', status: 'convertible', reason: null },
        // 事前確認後に書き換えられた想定。数値項目へ文字列は書かせない。
        { friendId: 'friend-2', sourceValue: 'xx', convertedValue: 'たくさん', status: 'convertible', reason: null },
      ],
    });
    expect(await queueFieldMigration(db, 'run-tamper', 'tamper-request')).toBe(true);
    await executeFieldMigration(db, 'run-tamper', 'number', 'staff-1');

    const rows = sqlite.prepare(
      `SELECT friend_id, value FROM friend_field_values WHERE field_id = ?`,
    ).all(target.id);
    expect(rows).toEqual([{ friend_id: 'friend-1', value: '12' }]);
    const items = sqlite.prepare(
      `SELECT status FROM field_migration_items WHERE run_id = 'run-tamper' ORDER BY source_value`,
    ).all() as Array<{ status: string }>;
    expect(items.map((item) => item.status).sort()).toEqual(['failed', 'succeeded']);
  });

  it('自動化の加算は正規化値を数として読める', async () => {
    // シナリオの加算・減算は Number(値) で読む。不正値は0とみなされるため、
    // 保存時に数値へ直っていることが計算の正しさに直結する。
    const checked = validateFriendFieldValue({ type: 'number', options_json: null }, '1,000');
    if (!checked.ok) throw new Error('validation failed in test setup');
    await setFriendFieldValue(db, { friendId: 'friend-1', fieldId: 'field-num', value: checked.value, updatedBy: 'u-1' });

    const current = await db
      .prepare(`SELECT value FROM friend_field_values WHERE friend_id = ? AND field_id = ?`)
      .bind('friend-1', 'field-num')
      .first<{ value: string | null }>();
    const base = Number(current?.value ?? 0);
    expect(Number.isFinite(base)).toBe(true);
    expect(base + 5).toBe(1005);
  });
});
