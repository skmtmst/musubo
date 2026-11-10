import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { activateMusuboPricingCondition, createMusuboPricingCondition, createRegistrationApplication } from '@line-crm/db';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ sendPlainMail: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string }) => {}) }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.sendPlainMail }));
const { opsApplications } = await import('./ops-applications.js');

let database: SqliteD1;
const master: AuthenticatedStaff = { id: 'ops-master', name: '運営担当', role: 'owner', readOnly: false, tenantId: null };
const viewer: AuthenticatedStaff = { ...master, readOnly: true };
const tenantOwner: AuthenticatedStaff = { ...master, id: 'tenant-owner', tenantId: 'other-tenant' };

function app(staff: AuthenticatedStaff) {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', opsApplications);
  return hono;
}

function environment(): Env['Bindings'] {
  return { DB: database.db, ADMIN_PUBLIC_URL: 'https://admin.example.com' } as Env['Bindings'];
}

function post(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(async () => {
  database = createTestD1();
  mail.sendPlainMail.mockClear();
  database.raw.prepare("INSERT INTO staff_members (id, name, role, api_key) VALUES ('ops-master', '運営担当', 'owner', 'fixture-key')").run();
  database.raw.prepare("INSERT INTO platform_admins (staff_id, is_active) VALUES ('ops-master', 1)").run();
  await createRegistrationApplication(database.db, { companyName: '申込会社', contactName: '山田', email: 'applicant@example.com', phone: '03-1234-5678', referralSource: 'SNS', ipHash: 'ip', deviceMarker: null });
});

describe('申込承認の運営 API', () => {
  it('運営のみ閲覧でき、閲覧専用は変更できない', async () => {
    const list = await app(master).request('/api/ops/applications', {}, environment());
    expect(list.status).toBe(200);
    const id = ((await list.json()) as { data: Array<{ id: string }> }).data[0].id;
    expect((await app(tenantOwner).request('/api/ops/applications', {}, environment())).status).toBe(403);
    expect((await app(viewer).request(`/api/ops/applications/${id}/contact`, post({ note: '電話済み' }), environment())).status).toBe(403);
  });

  it('連絡記録がある申込だけ承認し、招待メールを送れる', async () => {
    const id = (database.raw.prepare('SELECT id FROM registration_applications').get() as { id: string }).id;
    const endpoint = `/api/ops/applications/${id}`;
    expect((await app(master).request(`${endpoint}/approve`, post({}), environment())).status).toBe(409);
    expect((await app(master).request(`${endpoint}/contact`, post({ note: '' }), environment())).status).toBe(400);
    expect((await app(master).request(`${endpoint}/contact`, post({ note: '電話で申込内容を確認済み' }), environment())).status).toBe(200);
    const approved = await app(master).request(`${endpoint}/approve`, post({}), environment());
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ data: { mailSent: true, application: { status: 'approved' } } });
    const saved = database.raw.prepare('SELECT pricing_snapshot_json FROM registration_applications WHERE id=?')
      .get(id) as { pricing_snapshot_json: string };
    expect(JSON.parse(saved.pricing_snapshot_json)).toMatchObject({
      sourceConditionId: 'normal', trialPeriod: { unit: 'days', value: 30 }, lineBasicDiscountPercent: 0,
    });
    expect(mail.sendPlainMail).toHaveBeenCalledTimes(1);
    const message = mail.sendPlainMail.mock.calls[0]?.[1] as { body: string } | undefined;
    expect(message?.body).toContain('/register/complete?token=');
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM auth_email_tokens WHERE application_id = ?').get(id)).toEqual({ n: 1 });
    expect((await app(master).request(`${endpoint}/approve`, post({}), environment())).status).toBe(409);
    expect((await app(master).request(`${endpoint}/resend-invite`, post({}), environment())).status).toBe(200);
    expect(mail.sendPlainMail).toHaveBeenCalledTimes(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM auth_email_tokens WHERE application_id = ? AND consumed_at IS NULL').get(id)).toEqual({ n: 1 });
  });

  it('特別条件は承認する会社と期限を照合してから固定する', async () => {
    const id = (database.raw.prepare('SELECT id FROM registration_applications').get() as { id: string }).id;
    await app(master).request(`/api/ops/applications/${id}/contact`, post({ note: '本人確認済み' }), environment());
    const definition = {
      id: 'partner-v1', version: 1, internalName: '特約店', status: 'inactive' as const,
      trialPeriod: { unit: 'months' as const, value: 3 }, lineBasicDiscountPercent: 50,
      discountEndsOn: null, approvalUseUntil: '2999-12-31', allowedCompanyName: '別会社',
      schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
    };
    await createMusuboPricingCondition(database.db, {
      conditionKey: 'partner', definition, codeDigest: null, validFrom: null,
      createdBy: master.id,
    });
    await activateMusuboPricingCondition(database.db, definition.id);
    expect((await app(master).request(`/api/ops/applications/${id}/approve`,
      post({ conditionId: definition.id }), environment())).status).toBe(409);
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
    database.raw.prepare('UPDATE registration_applications SET company_name=? WHERE id=?').run('別会社', id);
    const approved = await app(master).request(`/api/ops/applications/${id}/approve`,
      post({ conditionId: definition.id }), environment());
    expect(approved.status).toBe(200);
    const saved = database.raw.prepare('SELECT pricing_snapshot_json FROM registration_applications WHERE id=?')
      .get(id) as { pricing_snapshot_json: string };
    expect(JSON.parse(saved.pricing_snapshot_json)).toMatchObject({
      sourceConditionId: definition.id, sourceVersion: 1,
      trialPeriod: { unit: 'months', value: 3 }, lineBasicDiscountPercent: 50,
    });
  });
});
