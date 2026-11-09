import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createRegistrationApplication } from '@line-crm/db';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn(async (_env: unknown,
  _message: { to: string; subject: string; body: string; html?: string }) => {}) }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.send }));
const { opsIndividualQuotes } = await import('./ops-individual-quotes.js');

let fixture: SqliteD1;
const operator: AuthenticatedStaff = {
  id: 'ops-owner', name: '運営担当', role: 'owner', readOnly: false, tenantId: null,
};
const viewer: AuthenticatedStaff = { ...operator, readOnly: true };
const tenantStaff: AuthenticatedStaff = { ...operator, id: 'tenant-owner', tenantId: '00000000-0000-4000-8000-000000000001' };

function app(staff: AuthenticatedStaff) {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', opsIndividualQuotes);
  return hono;
}

const env = () => ({ DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' }) as Env['Bindings'];
const json = (body: unknown, method = 'POST') => ({ method,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  fixture = createTestD1();
  mail.send.mockReset();
  fixture.raw.prepare("INSERT INTO staff_members (id,name,role,api_key) VALUES ('ops-owner','運営担当','owner','fixture-key')").run();
  fixture.raw.prepare("INSERT INTO platform_admins (staff_id,is_active) VALUES ('ops-owner',1)").run();
  await createRegistrationApplication(fixture.db, {
    companyName: '見積もり会社', contactName: '担当者', email: 'owner@example.test',
    phone: '03-1234-5678', referralSource: 'other', ipHash: 'ip', deviceMarker: null,
  });
});

function appId(): string {
  return (fixture.raw.prepare('SELECT id FROM registration_applications').get() as { id: string }).id;
}

const proposed = {
  expiresAt: '2027-12-31T23:59:59+09:00', interval: 'month', plannedLineCount: 11,
  plannedFriendCountExcludingBlocked: 2800, plannedLinkedAccountsByLine: [],
  trialPeriod: { unit: 'days', value: 30 },
  finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
    eleventhAndLaterLineYen: 6000, friendAllowanceForElevenOrMore: 50000 },
  finalAnnualLineChargeYen: null,
};

describe('operations individual quote flow', () => {
  it('previews the saved draft, sends once, and invalidates an older unaccepted quote', async () => {
    const id = appId();
    const base = `/api/ops/applications/${id}/quotes`;
    fixture.raw.prepare('UPDATE registration_applications SET status=?,tenant_id=? WHERE id=?')
      .run('activated', tenantStaff.tenantId, id);
    const first = await app(operator).request(base, json({ proposed }), env());
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { data: { quote: { quoteNumber: string } } }).data.quote.quoteNumber;
    const preview = await app(operator).request(`${base}/${firstId}/mail-preview`, {}, env());
    expect(preview.status).toBe(200);
    const firstPreview = (await preview.json()) as { data: { to: string; kind: string; previewHash: string } };
    expect(firstPreview).toMatchObject({ data: { to: 'owner@example.test', kind: 'issued' } });
    expect((await app(operator).request(`${base}/${firstId}/send`, json({ previewHash: 'a'.repeat(64) }), env())).status).toBe(409);
    expect(mail.send).not.toHaveBeenCalled();
    const sent = await app(operator).request(`${base}/${firstId}/send`,
      json({ previewHash: firstPreview.data.previewHash }), env());
    expect(sent.status).toBe(200);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0]?.[1]).toMatchObject({
      to: 'owner@example.test', subject: '【musubo】個別見積もりのご案内',
    });
    expect((await app(operator).request(`${base}/${firstId}/send`,
      json({ previewHash: firstPreview.data.previewHash }), env())).status).toBe(409);

    const second = await app(operator).request(base, json({ proposed }), env());
    const secondId = ((await second.json()) as { data: { quote: { quoteNumber: string } } }).data.quote.quoteNumber;
    const secondPreview = (await (await app(operator).request(`${base}/${secondId}/mail-preview`, {}, env()))
      .json()) as { data: { previewHash: string } };
    expect((await app(operator).request(`${base}/${secondId}/send`,
      json({ previewHash: secondPreview.data.previewHash }), env())).status).toBe(200);
    expect(fixture.raw.prepare('SELECT status FROM musubo_individual_quotes WHERE id=?').get(firstId))
      .toEqual({ status: 'superseded' });
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it('requires an activated customer and an operations writer', async () => {
    const id = appId();
    const base = `/api/ops/applications/${id}/quotes`;
    expect((await app(tenantStaff).request(base, {}, env())).status).toBe(403);
    expect((await app(viewer).request(base, json({ proposed }), env())).status).toBe(403);
    fixture.raw.prepare('UPDATE registration_applications SET status=? WHERE id=?').run('approved', id);
    const draft = await app(operator).request(base, json({ proposed }), env());
    expect(draft.status).toBe(201);
    const quoteId = ((await draft.json()) as { data: { quote: { quoteNumber: string } } }).data.quote.quoteNumber;
    expect((await app(operator).request(`${base}/${quoteId}/mail-preview`, {}, env())).status).toBe(409);
    expect((await app(operator).request(`${base}/${quoteId}/send`,
      json({ previewHash: 'a'.repeat(64) }), env())).status).toBe(409);
    expect(mail.send).not.toHaveBeenCalled();
  });
});
