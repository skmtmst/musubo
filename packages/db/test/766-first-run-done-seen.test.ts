import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('marks only existing accounts with a qualifying delivered message as seen', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE account_styles(line_account_id TEXT PRIMARY KEY);
      CREATE TABLE messages_log(line_account_id TEXT, direction TEXT, source TEXT, scenario_step_id TEXT);
      INSERT INTO account_styles VALUES ('a'),('b'),('c'),('d');
      INSERT INTO messages_log VALUES ('a','outgoing','friend_add_routing',NULL),
        ('b','outgoing','other','step'),('c','incoming','friend_add_routing',NULL),
        ('d','outgoing','other',NULL);`);
    db.exec(readFileSync(new URL('../migrations/766_first_run_done_seen.sql', import.meta.url), 'utf8'));
    const rows = db.prepare('SELECT line_account_id,first_run_done_seen_at AS seen FROM account_styles ORDER BY line_account_id').all() as Array<{seen: string | null}>;
    expect(rows[0].seen).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(rows[1].seen).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(rows[2].seen).toBeNull();
    expect(rows[3].seen).toBeNull();
  } finally { db.close(); }
});
