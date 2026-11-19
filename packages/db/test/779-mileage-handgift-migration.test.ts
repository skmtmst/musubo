import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const bootstrap = readFileSync(new URL('bootstrap.sql', root), 'utf8');
const migration = readFileSync(new URL('migrations/779_mileage_handgift.sql', root), 'utf8');

describe('779 手渡し景品の移行', () => {
  it('空の DB に外部キーを有効にして適用できる', () => {
    const db = new Database(':memory:');
    try {
      db.exec(bootstrap);
      db.pragma('foreign_keys = ON');
      db.transaction(() => db.exec(migration))();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'mileage_handgift_rewards'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'mileage_handgifts'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = '_779_backup_mileage_rewards'").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it('既存の公開済み景品と版を保ち、手渡しの印を一意に保存する', () => {
    const db = new Database(':memory:');
    try {
      db.exec(bootstrap);
      db.pragma('foreign_keys = ON');
      db.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('a','a','a','s','t');
        INSERT INTO mileage_programs(id,code,name,created_at,updated_at) VALUES('default','default','d','x','x');
        INSERT INTO mileage_rewards(id,line_account_id,name,reward_kind) VALUES('r','a','r','tag');
        INSERT INTO mileage_reward_versions(id,reward_id,version_number,required_miles,status) VALUES('v','r',1,10,'published');
        UPDATE mileage_rewards SET current_published_version_id='v' WHERE id='r';`);
      db.transaction(() => db.exec(migration))();
      db.prepare("INSERT INTO mileage_handgift_rewards(reward_id) VALUES('r')").run();
      expect(() => db.prepare("INSERT INTO mileage_handgift_rewards(reward_id) VALUES('r')").run()).toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT reward_kind, current_published_version_id FROM mileage_rewards WHERE id='r'").get()).toEqual({ reward_kind: 'tag', current_published_version_id: 'v' });
      expect(() => db.prepare("DELETE FROM mileage_reward_versions WHERE id='v'").run()).toThrow();
    } finally { db.close(); }
  });
});
