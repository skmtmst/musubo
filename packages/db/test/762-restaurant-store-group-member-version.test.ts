import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('既存の案内設定を変えず版1を追加する', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rt_store_group_members (group_id TEXT NOT NULL, store_id TEXT NOT NULL, referral_enabled INTEGER NOT NULL DEFAULT 0, max_distance REAL NOT NULL DEFAULT 5, PRIMARY KEY (group_id, store_id));
      INSERT INTO rt_store_group_members VALUES ('g','a',1,12.5), ('g','b',0,3);`);
    db.exec(readFileSync(new URL('../migrations/762_restaurant_store_group_member_version.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT * FROM rt_store_group_members ORDER BY store_id').all()).toEqual([
      { group_id: 'g', store_id: 'a', referral_enabled: 1, max_distance: 12.5, version: 1 },
      { group_id: 'g', store_id: 'b', referral_enabled: 0, max_distance: 3, version: 1 },
    ]);
    db.exec("INSERT INTO rt_store_group_members (group_id,store_id) VALUES ('g','c')");
    expect(db.prepare("SELECT version FROM rt_store_group_members WHERE store_id='c'").get()).toEqual({ version: 1 });
  } finally { db.close(); }
});
