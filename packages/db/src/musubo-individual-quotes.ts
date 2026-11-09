import {
  individualQuoteAccess, musuboIndividualQuotePrice,
  type MusuboIndividualQuote,
} from '@line-crm/shared';
import { jstNow } from './utils.js';

export interface MusuboIndividualQuoteRecord {
  id: string;
  application_id: string;
  tenant_id: string | null;
  revision: number;
  status: 'draft' | 'sending' | 'sent' | 'accepted' | 'superseded' | 'expired';
  final_prices_json: string;
  customer_summary_json: string;
  expires_at: string;
  created_by: string;
  created_at: string;
  send_claimed_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  superseded_at: string | null;
}

export function musuboQuoteFromRecord(row: MusuboIndividualQuoteRecord): MusuboIndividualQuote {
  const quote = JSON.parse(row.final_prices_json) as MusuboIndividualQuote;
  return { ...quote, quoteNumber: row.id, expiresAt: row.expires_at,
    acceptedAt: row.accepted_at, supersededAt: row.superseded_at };
}

export async function getMusuboIndividualQuote(db: D1Database, id: string): Promise<MusuboIndividualQuoteRecord | null> {
  return db.prepare('SELECT * FROM musubo_individual_quotes WHERE id=?').bind(id).first<MusuboIndividualQuoteRecord>();
}

export async function getTenantMusuboIndividualQuote(db: D1Database, tenantId: string, id: string): Promise<MusuboIndividualQuoteRecord | null> {
  return db.prepare('SELECT * FROM musubo_individual_quotes WHERE id=? AND tenant_id=?')
    .bind(id, tenantId).first<MusuboIndividualQuoteRecord>();
}

export async function getLatestTenantMusuboIndividualQuote(db: D1Database, tenantId: string): Promise<MusuboIndividualQuoteRecord | null> {
  return db.prepare(`SELECT * FROM musubo_individual_quotes
    WHERE tenant_id=? AND status IN ('sent','accepted')
    ORDER BY sent_at DESC, revision DESC LIMIT 1`).bind(tenantId).first<MusuboIndividualQuoteRecord>();
}

export async function listMusuboIndividualQuotesForApplication(db: D1Database, applicationId: string): Promise<MusuboIndividualQuoteRecord[]> {
  const rows = await db.prepare(`SELECT * FROM musubo_individual_quotes WHERE application_id=?
    ORDER BY revision DESC LIMIT 50`).bind(applicationId).all<MusuboIndividualQuoteRecord>();
  return rows.results ?? [];
}

/** A draft is created from the application, never from a customer supplied company or quote number. */
export async function createMusuboIndividualQuoteDraft(db: D1Database, input: {
  applicationId: string;
  actorId: string;
  proposed: Omit<MusuboIndividualQuote, 'quoteNumber' | 'companyName' | 'issuedAt' | 'acceptedAt' | 'supersededAt'>;
  now?: string;
}): Promise<MusuboIndividualQuoteRecord | null> {
  const application = await db.prepare(`SELECT id,company_name,tenant_id FROM registration_applications
    WHERE id=? AND status IN ('approved','activated')`).bind(input.applicationId)
    .first<{ id: string; company_name: string; tenant_id: string | null }>();
  if (!application || !input.actorId.trim()) return null;
  const now = input.now ?? jstNow();
  const latest = await db.prepare(`SELECT MAX(revision) AS revision FROM musubo_individual_quotes
    WHERE application_id=?`).bind(application.id).first<{ revision: number | null }>();
  const revision = (latest?.revision ?? 0) + 1;
  const quoteNumber = `M-${now.slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const quote: MusuboIndividualQuote = {
    ...input.proposed, quoteNumber, companyName: application.company_name,
    issuedAt: now, acceptedAt: null, supersededAt: null,
  };
  const price = musuboIndividualQuotePrice(quote);
  if (individualQuoteAccess(quote, now) !== 'available') throw new RangeError('Quote expiry must be in the future');
  const result = await db.prepare(`INSERT OR IGNORE INTO musubo_individual_quotes
    (id,application_id,tenant_id,revision,status,final_prices_json,customer_summary_json,
     expires_at,created_by,created_at)
    VALUES (?,?,?,?,'draft',?,?,?,?,?)`)
    .bind(quoteNumber, application.id, application.tenant_id, revision,
      JSON.stringify(quote), JSON.stringify(price), quote.expiresAt, input.actorId, now).run();
  return (result.meta?.changes ?? 0) === 1 ? getMusuboIndividualQuote(db, quoteNumber) : null;
}

/** The preview can be revised until sending starts; all later changes require reissue. */
export async function updateMusuboIndividualQuoteDraft(db: D1Database, input: {
  id: string;
  actorId: string;
  proposed: MusuboIndividualQuote;
  now?: string;
}): Promise<boolean> {
  const current = await getMusuboIndividualQuote(db, input.id);
  if (!current || current.status !== 'draft' || current.created_by !== input.actorId) return false;
  const previous = musuboQuoteFromRecord(current);
  const quote = { ...input.proposed,
    quoteNumber: current.id, companyName: previous.companyName, issuedAt: previous.issuedAt,
    acceptedAt: null, supersededAt: null };
  const now = input.now ?? jstNow();
  const price = musuboIndividualQuotePrice(quote);
  if (individualQuoteAccess(quote, now) !== 'available') return false;
  const result = await db.prepare(`UPDATE musubo_individual_quotes
    SET final_prices_json=?,customer_summary_json=?,expires_at=?
    WHERE id=? AND status='draft' AND created_by=?`)
    .bind(JSON.stringify(quote), JSON.stringify(price), quote.expiresAt, current.id, input.actorId).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Claim before external mail sending; an uncertain result remains 'sending' for operator review. */
export async function claimMusuboIndividualQuoteSend(db: D1Database, id: string, now = jstNow()): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`UPDATE musubo_individual_quotes
      SET status='sending',send_claimed_at=? WHERE id=? AND status='draft'
        AND tenant_id IS NOT NULL AND julianday(expires_at)>julianday(?)
        AND NOT EXISTS (SELECT 1 FROM musubo_individual_quotes accepted
          WHERE accepted.application_id=musubo_individual_quotes.application_id
            AND accepted.status='accepted')`).bind(now, id, now),
    db.prepare(`UPDATE musubo_individual_quotes SET status='superseded',superseded_at=?
      WHERE application_id=(SELECT application_id FROM musubo_individual_quotes WHERE id=?)
        AND id<>? AND status IN ('draft','sent') AND accepted_at IS NULL
        AND EXISTS (SELECT 1 FROM musubo_individual_quotes latest
          WHERE latest.id=? AND latest.status='sending' AND latest.send_claimed_at=?)`)
      .bind(now, id, id, id, now),
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1;
}

export async function markMusuboIndividualQuoteSent(db: D1Database, id: string, now = jstNow()): Promise<boolean> {
  const result = await db.prepare(`UPDATE musubo_individual_quotes SET status='sent',sent_at=?
    WHERE id=? AND status='sending'`).bind(now, id).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Acceptance is guarded in SQLite to handle simultaneous requests and expiry exactly once. */
export async function acceptTenantMusuboIndividualQuote(db: D1Database, input: {
  tenantId: string;
  quoteId: string;
  actorId: string;
  now?: string;
}): Promise<MusuboIndividualQuoteRecord | null> {
  const now = input.now ?? jstNow();
  const result = await db.prepare(`UPDATE musubo_individual_quotes SET status='accepted',accepted_at=?,accepted_by=?
    WHERE id=? AND tenant_id=? AND status='sent' AND accepted_at IS NULL
      AND sent_at IS NOT NULL AND julianday(sent_at)<=julianday(?)
      AND julianday(expires_at)>=julianday(?)`)
    .bind(now, input.actorId, input.quoteId, input.tenantId, now, now).run();
  return (result.meta?.changes ?? 0) === 1
    ? getTenantMusuboIndividualQuote(db, input.tenantId, input.quoteId) : null;
}

export async function supersedeMusuboIndividualQuote(db: D1Database, id: string, now = jstNow()): Promise<boolean> {
  const result = await db.prepare(`UPDATE musubo_individual_quotes SET status='superseded',superseded_at=?
    WHERE id=? AND status IN ('draft','sent') AND accepted_at IS NULL`)
    .bind(now, id).run();
  return (result.meta?.changes ?? 0) === 1;
}
