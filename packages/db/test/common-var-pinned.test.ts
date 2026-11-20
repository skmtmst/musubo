import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1 } from './d1-test-helper.js';
import { resolvePinnedCommonVarAt } from '../src/common-vars/pinned.js';

describe('固定版の送信時の確認', () => {
  it('固定した版の値を読み、現在の停止・期限切れ・他アカウントを拒む', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','c','A','t','s');
      INSERT INTO common_vars (id,line_account_id,name,var_key,type,value,version,expiry_behavior,fallback_value) VALUES ('v','a','営業時間','hours','text','新しい値',2,'fallback','代替');
      INSERT INTO common_vars (id,line_account_id,name,var_key,type,value) VALUES ('v2','a','電話','store_phone','text','123');
      INSERT INTO common_var_versions (id,common_var_id,version_no,name,value,change_reason) VALUES ('old','v',1,'営業時間','固定した値','変更前'), ('blank','v2',1,'電話','  ','変更前');`);
    const db = asD1(raw);
    const read = () => resolvePinnedCommonVarAt(db, 'a', 'v', 'old', '2026-11-20T00:00:00Z');
    expect(await read()).toEqual({ ok: true, value: '固定した値', version: 1 });
    expect(await resolvePinnedCommonVarAt(db, 'other', 'v', 'old', '2026-11-20T00:00:00Z')).toEqual({ ok: false, reason: 'missing' });
    expect(await resolvePinnedCommonVarAt(db, 'a', 'v', 'missing', '2026-11-20T00:00:00Z')).toEqual({ ok: false, reason: 'missing' });
    expect(await resolvePinnedCommonVarAt(db, 'a', 'v', 'blank', '2026-11-20T00:00:00Z')).toEqual({ ok: false, reason: 'missing' });
    expect(await resolvePinnedCommonVarAt(db, 'a', 'v2', 'blank', '2026-11-20T00:00:00Z')).toEqual({ ok: false, reason: 'missing' });
    raw.prepare("UPDATE common_vars SET status = 'stopped' WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'stopped' });
    raw.prepare("UPDATE common_vars SET status = 'active', valid_until = '2026-11-20T00:00:00Z' WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'expired' });
    raw.prepare("UPDATE common_vars SET status = 'draft', valid_until = NULL WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'draft' });
    raw.prepare("UPDATE common_vars SET status = 'active', valid_from = '2026-11-21T00:00:00Z' WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'not_started' });
    raw.prepare("UPDATE common_vars SET valid_from = 'invalid' WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'invalid_window' });
    raw.prepare("UPDATE common_vars SET valid_from = NULL, archived_at = '2026-11-19T00:00:00Z' WHERE id = 'v'").run();
    expect(await read()).toEqual({ ok: false, reason: 'missing' });
    raw.close();
  });
});
