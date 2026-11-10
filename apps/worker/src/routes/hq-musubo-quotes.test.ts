import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  claimMusuboIndividualQuoteSend, createMusuboIndividualQuoteDraft,
  createRegistrationApplication, markMusuboIndividualQuoteSent,
} from '@line-crm/db';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { hqMusuboQuotes } from './hq-musubo-quotes.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const owner: AuthenticatedStaff = {
  id: 'owner', name: '契約者', role: 'owner', readOnly: false, tenantId: tenant,
};
let fixture: SqliteD1;

function app(staff: AuthenticatedStaff) {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  hono.route('/', hqMusuboQuotes);
  return hono;
}

function environment(): Env['Bindings'] {
  return { DB: fixture.db } as Env['Bindings'];
}

beforeEach(() => { fixture = createTestD1(); });

async function sentQuote(): Promise<string> {
  await createRegistrationApplication(fixture.db, {
    companyName: '見積もり会社', contactName: '担当者', email: 'owner@example.test',
    phone: '03-1234-5678', referralSource: 'other', ipHash: 'ip', deviceMarker: null,
  });
  const row = fixture.raw.prepare('SELECT id FROM registration_applications').get() as { id: string };
  fixture.raw.prepare('UPDATE registration_applications SET status=?,tenant_id=? WHERE id=?')
    .run('activated', tenant, row.id);
  const quote = await createMusuboIndividualQuoteDraft(fixture.db, {
    applicationId: row.id, actorId: 'operator',
    proposed: {
      expiresAt: '2027-12-31T23:59:59+09:00', interval: 'month', plannedLineCount: 11,
      plannedFriendCountExcludingBlocked: 2800, plannedLinkedAccountsByLine: [],
      trialPeriod: { unit: 'days', value: 30 },
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
        eleventhAndLaterLineYen: 6000, friendAllowanceForElevenOrMore: 50000 },
      finalAnnualLineChargeYen: null,
    },
  });
  expect(quote).not.toBeNull();
  expect(await claimMusuboIndividualQuoteSend(fixture.db, quote!.id)).toBe(true);
  expect(await markMusuboIndividualQuoteSent(fixture.db, quote!.id)).toBe(true);
  return quote!.id;
}

describe('tenant-scoped individual quote acceptance', () => {
  it('shows the issued quote and accepts it once', async () => {
    const id = await sentQuote();
    const url = `/api/hq/onboarding/quotes/${id}`;
    const read = await app(owner).request(url, {}, environment());
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { access: 'available', cardRegistrationAvailable: false } });
    const accepted = await app(owner).request(`${url}/accept`, { method: 'POST' }, environment());
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ data: { accepted: true, quote: { quoteNumber: id } } });
    expect((await app(owner).request(`${url}/accept`, { method: 'POST' }, environment())).status).toBe(200);
    expect(fixture.raw.prepare('SELECT status,accepted_by FROM musubo_individual_quotes WHERE id=?').get(id))
      .toEqual({ status: 'accepted', accepted_by: owner.id });
  });

  it('does not reveal a quote to another tenant or a staff member without account authority', async () => {
    const id = await sentQuote();
    const path = `/api/hq/onboarding/quotes/${id}`;
    const other = { ...owner, tenantId: 'other-tenant' };
    expect((await app(other).request(path, {}, environment())).status).toBe(404);
    expect((await app(other).request(`${path}/accept`, { method: 'POST' }, environment())).status).toBe(404);
    const staff = { ...owner, role: 'staff' as const };
    expect((await app(staff).request(path, {}, environment())).status).toBe(403);
  });
});
