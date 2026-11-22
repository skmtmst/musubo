/** 削除後の旧 Stripe ID を復元できない形で照合する。 */
export type PurgedPaymentIdentifierKind = 'customer' | 'subscription';

export async function hashPurgedPaymentIdentifier(secret: string | undefined, kind: PurgedPaymentIdentifierKind, id: string): Promise<string | null> {
  if (!secret) return null;
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('musubo:purged-payment-identifiers'),info:encoder.encode('v1')}, material, {name:'HMAC',hash:'SHA-256',length:256}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${kind}:${id}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2,'0')).join('');
}

/** 鍵を替えたことだけを判別し、古い鍵が無い場合は照合しない。 */
export async function purgedPaymentIdentifierKeyVersion(secret: string | undefined): Promise<string | null> {
  return hashPurgedPaymentIdentifier(secret, 'customer', '__key_version_v1__');
}

/** 日本時間の YYYY-MM-DD を渡す。最終決済日（無ければ削除日）から1年3か月の翌日を起点に10年。 */
export function purgedPaymentIdentifierExpiry(lastPaymentDate: string | null, purgedDate: string): string {
  const value = lastPaymentDate ?? purgedDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_payment_retention_date');
  const [year,month,day] = value.split('-').map(Number);
  const original = new Date(Date.UTC(year,month-1,day));
  if (original.getUTCFullYear() !== year || original.getUTCMonth() !== month-1 || original.getUTCDate() !== day) throw new Error('invalid_payment_retention_date');
  const lastDay = new Date(Date.UTC(year+1,month-1+4,0)).getUTCDate();
  const base = new Date(Date.UTC(year+1,month-1+3,Math.min(day,lastDay)+1));
  base.setUTCFullYear(base.getUTCFullYear()+10);
  return base.toISOString();
}

export async function storePurgedPaymentIdentifierHash(db: D1Database, input: {
  tenantId:string; kind:PurgedPaymentIdentifierKind; digest:string; keyVersion:string; expiresAt:string; now:string;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.digest) || !/^[a-f0-9]{64}$/.test(input.keyVersion) || !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('invalid_payment_identifier_hash');
  await db.prepare(`INSERT INTO stripe_events(id,stripe_event_id,event_type,processed_at,tenant_id,review_reason,identifier_hash,identifier_kind,identifier_expires_at,identifier_key_version)
    VALUES (?,?, 'internal.retained_hmac',?,?,'identifier_hash',?,?,?,?)
    ON CONFLICT(stripe_event_id) DO UPDATE SET identifier_expires_at=MAX(stripe_events.identifier_expires_at,excluded.identifier_expires_at)`)
    .bind(crypto.randomUUID(),`internal_purge_hash:${input.tenantId}:${input.kind}:${input.digest}`,input.now,input.tenantId,input.digest,input.kind,input.expiresAt,input.keyVersion).run();
}

export async function findPurgedPaymentIdentifierHash(db: D1Database, kind: PurgedPaymentIdentifierKind, digest: string, keyVersion: string, now: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT tenant_id FROM stripe_events WHERE review_reason='identifier_hash'
    AND identifier_kind=? AND identifier_hash=? AND identifier_key_version=? AND julianday(identifier_expires_at)>julianday(?) AND tenant_id IS NOT NULL`)
    .bind(kind,digest,keyVersion,now).all<{tenant_id:string}>();
  return rows.results.map(row=>row.tenant_id);
}

export async function deleteExpiredPurgedPaymentIdentifierHashes(db: D1Database, now: string): Promise<number> {
  const result=await db.prepare(`DELETE FROM stripe_events WHERE rowid IN (
    SELECT rowid FROM stripe_events WHERE review_reason='identifier_hash'
      AND identifier_expires_at IS NOT NULL AND julianday(identifier_expires_at)<=julianday(?) LIMIT 200)`).bind(now).run();
  return Number(result.meta.changes ?? 0);
}

/** Refuse to guess when any retained identifier was hashed using an unavailable key. */
export async function matchPurgedPaymentIdentifiers(db:D1Database, secret:string|undefined,
  input:{customer:string|null;subscription:string|null;now:string}):Promise<string|null> {
  const versions=await db.prepare(`SELECT DISTINCT identifier_key_version AS version FROM stripe_events
    WHERE review_reason='identifier_hash' AND julianday(identifier_expires_at)>julianday(?)`).bind(input.now).all<{version:string|null}>();
  const version=await purgedPaymentIdentifierKeyVersion(secret);
  if (versions.results.some(row=>!version || row.version!==version)) throw new Error('purged_payment_key_unavailable');
  if (!version) return null;
  const tenants=new Set<string>();
  for (const kind of ['customer','subscription'] as const) {
    const id=input[kind];
    if (!id) continue;
    const hash=await hashPurgedPaymentIdentifier(secret,kind,id);
    if (!hash) throw new Error('purged_payment_key_unavailable');
    for (const tenant of await findPurgedPaymentIdentifierHash(db,kind,hash,version,input.now)) tenants.add(tenant);
  }
  if (tenants.size>1) throw new Error('purged_payment_ambiguous_match');
  return [...tenants][0] ?? null;
}
