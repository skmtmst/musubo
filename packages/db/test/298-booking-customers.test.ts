import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBookingCustomer,
  normalizeBookingCustomerPhone,
  getBookingCustomer,
  searchBookingCustomers,
} from '../src/booking/customers.js';
import { asD1 } from './d1-test-helper.js';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const benignReplayError = /duplicate column name|already exists/i;

function replayBefore298(sqlite: Database.Database): void {
  sqlite.exec(readFileSync(join(process.cwd(), 'schema.sql'), 'utf8'));
  const files = readdirSync(join(process.cwd(), 'migrations'))
    .filter((file) => file.endsWith('.sql') && Number(file.split('_')[0]) < 298)
    .sort();
  for (const file of files) {
    const statements = readFileSync(join(process.cwd(), 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        sqlite.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!benignReplayError.test(message)) throw error;
      }
    }
  }
}

describe('298 booking customers', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a','channel-a','A店','token','secret'),
             ('account-b','channel-b','B店','token','secret');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  it('電話番号を暗号化して保存し、同じアカウントだけ名前・電話で検索できる', async () => {
    await createBookingCustomer(db, {
      id: 'customer-a',
      lineAccountId: 'account-a',
      displayName: '見本 143',
      phone: '090-0000-5678',
      petName: 'ポチ',
      email: 'hanako@example.test',
      encryptionKey: KEY,
    });
    await createBookingCustomer(db, {
      id: 'customer-b',
      lineAccountId: 'account-b',
      displayName: '見本 143',
      phone: '090-0000-0000',
      encryptionKey: KEY,
    });

    const stored = sqlite.prepare(
      `SELECT phone_encrypted, email_encrypted FROM booking_customers WHERE id = 'customer-a'`,
    ).get() as { phone_encrypted: string; email_encrypted: string };
    expect(stored.phone_encrypted).not.toContain('09000005678');
    expect(stored.email_encrypted).not.toContain('hanako@example.test');

    await expect(searchBookingCustomers(db, {
      lineAccountId: 'account-a',
      query: '090-0000-5678',
      encryptionKey: KEY,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'customer-a', phone_last4: '5678', is_line_linked: false }),
    ]);
    await expect(searchBookingCustomers(db, {
      lineAccountId: 'account-a',
      query: '143',
      encryptionKey: KEY,
    })).resolves.toHaveLength(1);
  });

  it('詳細だけで連絡先を復号し、別アカウントからは参照できない', async () => {
    await createBookingCustomer(db, {
      id: 'customer-a',
      lineAccountId: 'account-a',
      displayName: '見本 143',
      phone: '090-0000-5678',
      email: 'hanako@example.test',
      encryptionKey: KEY,
    });

    await expect(getBookingCustomer(db, 'customer-a', 'account-a', KEY)).resolves.toMatchObject({
      phone: '09000005678',
      email: 'hanako@example.test',
    });
    await expect(getBookingCustomer(db, 'customer-a', 'account-b', KEY)).resolves.toBeNull();
  });

  it('LINE友だちがなくてもbooking_customer_idで予約を保存できる', () => {
    sqlite.exec(`
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('staff-a','account-a','担当A','担当A');
      INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
      VALUES ('menu-a','account-a','相談',60,5000);
      INSERT INTO booking_customers (
        id, line_account_id, display_name, phone_normalized_hash,
        phone_encrypted, phone_last4
      ) VALUES ('customer-a','account-a','見本 143','hash','cipher','5678');
      INSERT INTO bookings (
        id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
        starts_at, ends_at, block_ends_at, status, price_at_booking,
        requested_at, source, created_by_staff_id,
        notification_policy_snapshot
      ) VALUES (
        'booking-a','account-a',NULL,'customer-a','staff-a','menu-a',
        '2030-01-01T01:00:00.000Z','2030-01-01T02:00:00.000Z',
        '2030-01-01T02:00:00.000Z','confirmed',5000,
        '2026-09-07T00:00:00.000Z','phone','staff-a',
        '{"send_line_confirmation":false}'
      );
    `);
    expect(sqlite.prepare(
      `SELECT friend_id, booking_customer_id, source FROM bookings WHERE id = 'booking-a'`,
    ).get()).toEqual({
      friend_id: null,
      booking_customer_id: 'customer-a',
      source: 'phone',
    });
  });

  it('既存予約のリマインドを失わず、外部キー有効のまま移行できる', () => {
    const legacy = new Database(':memory:');
    try {
      replayBefore298(legacy);
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('legacy-account','legacy-channel','旧店舗','token','secret');
        INSERT INTO friends (id, line_user_id, line_account_id)
        VALUES ('legacy-friend','U-legacy','legacy-account');
        INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('legacy-staff','legacy-account','担当','担当');
        INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price)
        VALUES ('legacy-menu','legacy-account','相談',60,5000);
        INSERT INTO bookings (
          id, line_account_id, friend_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at
        ) VALUES (
          'legacy-booking','legacy-account','legacy-friend','legacy-staff','legacy-menu',
          '2030-01-01T01:00:00.000Z','2030-01-01T02:00:00.000Z',
          '2030-01-01T02:00:00.000Z','confirmed',5000,'2026-09-07T00:00:00.000Z'
        );
        INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at)
        VALUES ('legacy-reminder','legacy-booking','day_before','2029-12-31T01:00:00.000Z');
      `);

      const migration = readFileSync(
        join(process.cwd(), 'migrations', '298_booking_customers.sql'),
        'utf8',
      );
      legacy.exec(`BEGIN;\n${migration}\nCOMMIT;`);

      expect(legacy.prepare(
        `SELECT booking_id, kind FROM booking_reminders WHERE id = 'legacy-reminder'`,
      ).get()).toEqual({ booking_id: 'legacy-booking', kind: 'day_before' });
      expect(legacy.pragma('foreign_key_check')).toEqual([]);
    } finally {
      legacy.close();
    }
  });
});

describe('予約顧客の国内電話の境界', () => {
  it('全角と区切りを数字だけにそろえる', () => {
    expect(normalizeBookingCustomerPhone('（０９０）００００－５６７８')).toBe('09000005678');
    expect(normalizeBookingCustomerPhone('03 0000 5678')).toBe('0300005678');
  });
  it.each(['1234567890','090123456','090123456789','+819012345678','090abc12345678',''])('不正な番号%sを保存しない', phone => {
    expect(() => normalizeBookingCustomerPhone(phone)).toThrow('booking_customer_phone_invalid');
  });
});
