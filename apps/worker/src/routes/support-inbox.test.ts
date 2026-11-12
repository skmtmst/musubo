import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { extractContactFormReceipt, paginateSupportInboxItems, supportInbox } from './support-inbox.js';

describe('paginateSupportInboxItems', () => {
  it('5件表示で6件目を2ページ目に出す', () => {
    expect(paginateSupportInboxItems(['1', '2', '3', '4', '5', '6'], 5, 5)).toEqual(['6']);
  });
});

describe('extractContactFormReceipt', () => {
  it('extracts the customer and only the submitted inquiry from the legacy receipt', () => {
    const result = extractContactFormReceipt(`※本メールは自動配信メールです。

見本 141 様

お名前：見本 141 (ヤマダ タロウ) 様
メールアドレス：customer@example.com
お問い合わせ内容：

フォーム統合テスト
ECサイトのお問い合わせフォームから送信しています。`);

    expect(result).toEqual({
      customerEmail: 'customer@example.com',
      customerName: '見本 141',
      inquiry: 'フォーム統合テスト\nECサイトのお問い合わせフォームから送信しています。',
    });
  });

  it('removes the footer from the current receipt', () => {
    const result = extractContactFormReceipt(`お名前：見本 143 様
メールアドレス：hanako@example.com

お問い合わせ内容：
商品の保存方法を教えてください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

本メールは自動配信のため返信できません。`);

    expect(result.inquiry).toBe('商品の保存方法を教えてください。');
  });
});

describe('support inbox assignee contract', () => {
  it.each([
    ['staff', false, [], 'all', 403],
    ['owner', true, [], 'all', 403],
    ['owner', false, [], 'accounts', 404],
  ] as const)('操作者の権限と共有受信箱の範囲を確かめる', async (role, readOnly, permissionKeys, accountScope, status) => {
    const db = createTestD1();
    try {
      db.raw.prepare("INSERT INTO staff_members (id, name, api_key, role, account_scope) VALUES ('caller', '担当', 'caller-key', ?, ?)").run(role, accountScope);
      const app = new Hono<Env>();
      app.use('*', async (c, next) => { c.set('staff', { id: 'caller', name: '担当', role, readOnly, permissionKeys: [...permissionKeys] }); await next(); });
      app.route('/', supportInbox);
      const response = await app.request('/api/support/email/threads/thread/assignee', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId: null }) }, { DB: db.db } as Env['Bindings']);
      expect(response.status).toBe(status);
    } finally { db.raw.close(); }
  });

  it.each([
    ['active-staff', 200, 'active-staff', 2],
    ['inactive-staff', 400, null, 1],
    ['foreign-staff', 400, null, 1],
    ['no-permission', 400, null, 1],
    ['readonly-staff', 400, null, 1],
    ['customer-only', 400, null, 1],
    ['unknown', 400, null, 1],
  ] as const)('担当を%sへ変更したとき、有効な担当者だけを保存する', async (staffId, status, assigned, revision) => {
    const db = createTestD1();
    try {
      db.raw.exec(`
        INSERT INTO tenants (id, name) VALUES ('outside', '別会社');
        INSERT INTO staff_members (id, name, api_key, role, is_active) VALUES
          ('owner', '管理者', 'fixture-owner', 'owner', 1),
          ('active-staff', '有効な担当者', 'fixture-active', 'staff', 1),
          ('inactive-staff', '無効な担当者', 'fixture-inactive', 'staff', 0),
          ('foreign-staff', '別会社', 'fixture-foreign', 'owner', 1),
          ('no-permission', '権限なし', 'fixture-no-permission', 'staff', 1),
          ('readonly-staff', '閲覧のみ', 'fixture-readonly', 'staff', 1);
        UPDATE staff_members SET permission_keys='["/chats"]' WHERE id IN ('active-staff', 'readonly-staff');
        UPDATE staff_members SET tenant_id='outside' WHERE id='foreign-staff';
        UPDATE staff_members SET access_level='read_only' WHERE id='readonly-staff';
        INSERT INTO users (id, display_name) VALUES ('customer-only', '顧客');
        INSERT INTO support_email_threads
          (id, customer_email, subject, normalized_subject, status, revision, last_message_at, last_incoming_at, created_at, updated_at)
        VALUES ('thread', 'customer@example.test', '相談', '相談', 'unread', 1,
          '2026-10-22', '2026-10-22', '2026-10-22', '2026-10-22');
      `);
      const app = new Hono<Env>();
      app.use('*', async (c, next) => {
        c.set('staff', { id: 'owner', name: '管理者', role: 'owner', readOnly: false });
        await next();
      });
      app.route('/', supportInbox);
      const response = await app.request('/api/support/email/threads/thread/assignee', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ staffId, revision: 1 }),
      }, { DB: db.db } as Env['Bindings']);

      expect(response.status).toBe(status);
      expect(db.raw.prepare('SELECT assigned_staff_id, revision FROM support_email_threads WHERE id = ?')
        .get('thread')).toEqual({ assigned_staff_id: assigned, revision });
      if (status === 400) {
        expect(await response.json()).toMatchObject({ success: false, error: '担当者が見つかりません' });
      }
    } finally {
      db.raw.close();
    }
  });
});
