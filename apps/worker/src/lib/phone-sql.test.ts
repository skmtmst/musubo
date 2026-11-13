import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { normalizePhone } from '@line-crm/shared';
import { normalizedPhoneSql } from './phone-sql.js';

it('保存済みの全角・区切り・空白を、検索でも共通関数と同じ数字へ整える', () => {
  const db = new Database(':memory:');
  try {
    const statement = db.prepare(`SELECT ${normalizedPhoneSql} AS phone FROM (SELECT ? AS customer_phone)`);
    for (const input of ['０９０－００００－５６７８', '(03) 0000-5678', '090\t0000\n5678', '090\u00a00000\u20095678', '090ー0000―5678', '⓪⑨⓪⓪⓪⓪⓪⑤⑥⑦⑧', '𝟘𝟡𝟘𝟘𝟘𝟘𝟘𝟝𝟞𝟟𝟠']) {
      expect(statement.get(input)).toEqual({ phone: normalizePhone(input) });
    }
  } finally {
    db.close();
  }
});
