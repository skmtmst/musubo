import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { purgeTablesChildFirst, RETENTION_TABLES } from '../src/data-retention-tables.js';

describe('予約媒体ごとのメール取込設定と保留メール台帳', () => {
  it('店舗と媒体ごとの取込設定・一意の処理権・削除順序を満たす', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8'));

      db.exec(`
        INSERT OR IGNORE INTO rt_media (id, code, name, parser_key)
          VALUES ('media-hotpepper', 'hotpepper', 'ホットペッパーグルメ', 'hotpepper');
        INSERT INTO rt_organizations (id, account_id, name) VALUES ('org-1', 'acc-1', '確認組織');
        INSERT INTO rt_stores (id, organization_id, name, code) VALUES ('store-1', 'org-1', '渋谷店', 'S1');
        INSERT INTO rt_inbound_emails (id, message_id, store_id, r2_key, status, size_bytes)
          VALUES ('mail-1', '<m1@example.test>', 'store-1', 'restaurant-intake/store-1/m1.eml', 'stored', 128);
        INSERT INTO rt_sync_events (id, store_id, provider, external_event_id, payload_json, status)
          VALUES ('ev-1', 'store-1', 'email', '<m1@example.test>', '{"media":"hotpepper"}', 'received');
      `);

      db.prepare(`
        INSERT INTO rt_store_media_email_settings (store_id, media_id, updated_by)
        VALUES ('store-1', 'media-hotpepper', 'staff-1')
      `).run();
      expect(
        db.prepare(`SELECT enabled, version FROM rt_store_media_email_settings WHERE store_id = 'store-1' AND media_id = 'media-hotpepper'`).get(),
      ).toEqual({ enabled: 1, version: 1 });

      db.prepare(`
        INSERT INTO rt_held_reservation_emails (inbound_email_id, store_id, media_id, sync_event_id, state, claim_token, expires_at)
        VALUES ('mail-1', 'store-1', 'media-hotpepper', 'ev-1', 'held', 'claim-1', '2030-01-31T00:00:00.000Z')
      `).run();

      db.prepare(`UPDATE rt_held_reservation_emails SET state = 'expiring' WHERE inbound_email_id = 'mail-1'`).run();
      expect(() => db.prepare(`UPDATE rt_held_reservation_emails SET state = 'invalid_state' WHERE inbound_email_id = 'mail-1'`).run()).toThrow();
      const expiryIndex = db.pragma('index_info(idx_rt_held_reservation_emails_expiry)') as Array<{ name: string }>;
      expect(expiryIndex.map(column => column.name)).toEqual(['state', 'expires_at']);

      expect(RETENTION_TABLES.rt_store_media_email_settings?.category).toBe('purge');
      expect(RETENTION_TABLES.rt_held_reservation_emails?.category).toBe('purge');
      const order = purgeTablesChildFirst();
      expect(order.indexOf('rt_held_reservation_emails')).toBeLessThan(order.indexOf('rt_inbound_emails'));
      expect(order.indexOf('rt_held_reservation_emails')).toBeLessThan(order.indexOf('rt_sync_events'));
      expect(order.indexOf('rt_held_reservation_emails')).toBeLessThan(order.indexOf('rt_stores'));
      expect(order.indexOf('rt_store_media_email_settings')).toBeLessThan(order.indexOf('rt_stores'));
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
