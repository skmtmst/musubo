import { jstNow } from './utils.js';

export type RegistrationApplicationStatus = 'pending' | 'contacted' | 'approved' | 'rejected' | 'activated';

export interface RegistrationApplication {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  referral_source: string;
  status: RegistrationApplicationStatus;
  contact_note: string | null;
  contacted_by: string | null;
  contacted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  invite_sent_at: string | null;
  tenant_id: string | null;
  ip_hash: string | null;
  device_marker: string | null;
  pricing_condition_id: string | null;
  pricing_snapshot_json: string | null;
  created_at: string;
  updated_at: string;
}

export async function createRegistrationApplication(db: D1Database, input: {
  companyName: string; contactName: string; email: string; phone: string;
  referralSource: string; ipHash: string; deviceMarker: string | null;
}): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`INSERT OR IGNORE INTO registration_applications
    (id, company_name, contact_name, email, phone, referral_source, ip_hash, device_marker, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.companyName, input.contactName, input.email,
      input.phone, input.referralSource, input.ipHash, input.deviceMarker, now, now).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getRegistrationApplication(db: D1Database, id: string): Promise<RegistrationApplication | null> {
  return db.prepare('SELECT * FROM registration_applications WHERE id = ?')
    .bind(id).first<RegistrationApplication>();
}

export async function getRegistrationApplicationByEmail(db: D1Database, email: string): Promise<RegistrationApplication | null> {
  return db.prepare(`SELECT * FROM registration_applications WHERE lower(email) = lower(?) AND status <> 'rejected'
    ORDER BY created_at DESC LIMIT 1`).bind(email).first<RegistrationApplication>();
}

export async function listRegistrationApplications(db: D1Database): Promise<RegistrationApplication[]> {
  const result = await db.prepare(`SELECT * FROM registration_applications ORDER BY created_at DESC LIMIT 500`)
    .all<RegistrationApplication>();
  return result.results ?? [];
}

export async function markRegistrationApplicationContacted(db: D1Database, id: string, actorId: string, note: string): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`UPDATE registration_applications SET status = 'contacted', contact_note = ?,
    contacted_by = ?, contacted_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'contacted')`)
    .bind(note, actorId, now, now, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markRegistrationApplicationApproved(db: D1Database, id: string, actorId: string): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`UPDATE registration_applications SET status = 'approved',
    approved_by = ?, approved_at = ?, updated_at = ?
    WHERE id = ? AND status = 'contacted' AND contact_note IS NOT NULL AND length(trim(contact_note)) > 0`)
    .bind(actorId, now, now, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markRegistrationApplicationInviteSent(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db.prepare(`UPDATE registration_applications SET invite_sent_at = ?, updated_at = ?
    WHERE id = ? AND status = 'approved'`).bind(now, now, id).run();
}

export async function markRegistrationApplicationActivated(db: D1Database, id: string, tenantId: string): Promise<boolean> {
  const now = jstNow();
  const result = await db.prepare(`UPDATE registration_applications SET status = 'activated', tenant_id = ?, updated_at = ?
    WHERE id = ? AND status = 'approved'`).bind(tenantId, now, id).run();
  return (result.meta?.changes ?? 0) > 0;
}
