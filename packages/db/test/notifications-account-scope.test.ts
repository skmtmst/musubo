import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createNotificationRule,
  deleteNotificationRule,
  getActiveNotificationRulesByEvent,
  getNotificationRuleById,
  getNotificationRules,
  getNotifications,
  updateNotificationRule,
} from '../src/notifications.js';
import { asD1 } from './d1-test-helper.js';

function setup() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE notification_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, event_type TEXT NOT NULL,
      conditions TEXT NOT NULL DEFAULT '{}', channels TEXT NOT NULL DEFAULT '["dashboard"]',
      line_account_id TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, rule_id TEXT, event_type TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      metadata TEXT, line_account_id TEXT, category TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL
    );
    CREATE TABLE staff_members (id TEXT PRIMARY KEY, role TEXT, is_active INTEGER, invite_status TEXT);
    CREATE TABLE operator_notification_teams (id TEXT PRIMARY KEY, line_account_id TEXT, staff_ids TEXT, archived_at TEXT);
    INSERT INTO notification_rules
      (id, name, event_type, line_account_id, created_at, updated_at)
    VALUES
      ('rule-a', 'Aの予約', 'booking_created', 'account-a', '2026-08-28', '2026-08-28'),
      ('rule-b', 'Bの予約', 'booking_created', 'account-b', '2026-08-28', '2026-08-28'),
      ('legacy', '所属不明', 'booking_created', NULL, '2026-08-28', '2026-08-28');
    INSERT INTO notifications
      (id, event_type, title, body, channel, status, line_account_id, created_at)
    VALUES
      ('notice-a', 'booking_created', 'A', '内容', 'dashboard', 'failed', 'account-a', '2026-08-28'),
      ('notice-b', 'booking_created', 'B', '内容', 'dashboard', 'failed', 'account-b', '2026-08-28');
  `);
  return { sqlite, db: asD1(sqlite) };
}

describe('notification rule account scope', () => {
  it('never mixes rule, active-rule, or delivery reads across accounts', async () => {
    const { sqlite, db } = setup();
    expect((await getNotificationRules(db, 'account-a')).map((item) => item.id)).toEqual(['rule-a']);
    expect((await getActiveNotificationRulesByEvent(db, 'booking_created', 'account-a'))
      .map((item) => item.id)).toEqual(['rule-a']);
    expect((await getNotifications(db, { lineAccountId: 'account-a', status: 'failed', staffId:'staff-a' }))
      .map((item) => item.id)).toEqual(['notice-a']);
    expect(await getNotificationRuleById(db, 'rule-b', 'account-a')).toBeNull();
    sqlite.close();
  });

  it('creates, updates, and deletes only inside the selected account', async () => {
    const { sqlite, db } = setup();
    const created = await createNotificationRule(db, {
      lineAccountId: 'account-a', name: '回答受付', eventType: 'form_submitted',
    });
    expect(created.line_account_id).toBe('account-a');
    expect(created.is_active).toBe(0);

    await updateNotificationRule(db, 'rule-b', 'account-a', { name: '変更してはいけない' });
    expect(sqlite.prepare('SELECT name FROM notification_rules WHERE id = ?').get('rule-b'))
      .toEqual({ name: 'Bの予約' });

    await deleteNotificationRule(db, 'rule-b', 'account-a');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM notification_rules WHERE id = ?').get('rule-b'))
      .toEqual({ count: 1 });
    sqlite.close();
  });
});
