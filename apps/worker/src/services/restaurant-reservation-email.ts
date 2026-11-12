import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { reconcileRestaurantInventory } from './restaurant-inventory-rules.js';
import PostalMime from 'postal-mime';
import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import { parserFor } from './parsers/index.js';
import { type ParsedReservationEmail } from './parsers/types.js';

const MAX_PARSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_STAY_MINUTES = 120;
const DEFAULT_HOLD_END_HOUR = 23;

export type RestaurantMediaRow = {
  id: string;
  code: 'retty' | 'gurunavi' | 'tabelog' | 'hotpepper';
  name: string;
  parser_key: string;
};

type ProcessInput = {
  env: Env['Bindings'];
  storeId: string;
  inboundEmailId: string;
  eventId: string;
  objectKey: string;
  media: RestaurantMediaRow;
  fallbackSubject: string;
  fallbackDate: string | null;
};

type ValidationResult = { valid: true } | { valid: false; reason: string };

export async function findRestaurantMediaBySender(
  env: Env['Bindings'],
  sender: string,
  storeId?: string | null,
): Promise<RestaurantMediaRow | null> {
  const normalized = sender.trim().toLowerCase();
  if (!normalized) return null;
  return dbFor(env, storeId).prepare(`SELECT m.id, m.code, m.name, m.parser_key
    FROM rt_media m, json_each(m.sender_addresses) sender
    WHERE m.is_active = 1 AND lower(CAST(sender.value AS TEXT)) = ?
    LIMIT 1`).bind(normalized).first<RestaurantMediaRow>();
}

export function validateParsedReservationEmail(
  parsed: ParsedReservationEmail,
  sourceText: string,
  now = new Date(),
): ValidationResult {
  if (parsed.validationError) return { valid: false, reason: parsed.validationError };
  if (parsed.kind === 'unknown') return { valid: false, reason: 'kind_unknown' };
  if (parsed.kind === 'notice') return { valid: true };
  if (parsed.kind === 'digest') {
    if (!parsed.targetDate) return { valid: false, reason: 'digest_target_date_missing' };
    if (!Number.isSafeInteger(parsed.reportedCount) || (parsed.reportedCount ?? -1) < 0) {
      return { valid: false, reason: 'digest_count_invalid' };
    }
    return { valid: true };
  }

  if (!parsed.externalId) return { valid: false, reason: 'reservation_id_missing' };
  if (!sourceText.includes(parsed.externalId)) return { valid: false, reason: 'reservation_id_not_in_source' };
  if (!parsed.startsAt || !/^\d{4}-\d{2}-\d{2}T/.test(parsed.startsAt)) {
    return { valid: false, reason: 'visit_datetime_or_year_missing' };
  }
  const startsAt = new Date(parsed.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { valid: false, reason: 'visit_datetime_invalid' };
  const lower = new Date(now);
  lower.setUTCFullYear(lower.getUTCFullYear() - 2);
  const upper = new Date(now);
  upper.setUTCFullYear(upper.getUTCFullYear() + 2);
  if (startsAt < lower || startsAt > upper) return { valid: false, reason: 'visit_datetime_out_of_range' };
  if (!Number.isSafeInteger(parsed.guestCount) || (parsed.guestCount ?? 0) < 1 || (parsed.guestCount ?? 0) > 100) {
    return { valid: false, reason: 'guest_count_invalid' };
  }
  if (!parsed.sourceUpdatedAt || Number.isNaN(new Date(parsed.sourceUpdatedAt).getTime())) {
    return { valid: false, reason: 'source_updated_at_missing' };
  }
  return { valid: true };
}

function holdEndHour(env: Env['Bindings']): number {
  const parsed = Number(env.RESTAURANT_REQUEST_HOLD_END_HOUR);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_HOLD_END_HOUR;
}

export function nextBusinessDayHoldExpiry(startsFrom: string, endHour = DEFAULT_HOLD_END_HOUR): string {
  const source = new Date(startsFrom);
  const jstDate = japanCalendar(source);
  let year = jstDate.getUTCFullYear();
  let month = jstDate.getUTCMonth();
  let day = jstDate.getUTCDate();
  do {
    const candidate = new Date(Date.UTC(year, month, day + 1));
    year = candidate.getUTCFullYear();
    month = candidate.getUTCMonth();
    day = candidate.getUTCDate();
  } while ([0, 6].includes(new Date(Date.UTC(year, month, day)).getUTCDay()));
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:59:59+09:00`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function markEvent(
  env: Env['Bindings'],
  storeId: string,
  eventId: string,
  status: 'processed' | 'failed',
  payload: Record<string, unknown>,
  errorMessage: string | null,
): Promise<void> {
  await dbFor(env, storeId).prepare(`UPDATE rt_sync_events
    SET status = ?, payload_json = json_patch(payload_json, ?), error_message = ?, processed_at = datetime('now')
    WHERE id = ?`).bind(status, JSON.stringify(payload), errorMessage, eventId).run();
  await dbFor(env, storeId).prepare(`UPDATE rt_inbound_emails SET status = ?, quarantine_reason = ?
    WHERE store_id = ? AND message_id = (SELECT external_event_id FROM rt_sync_events WHERE id = ? AND provider = 'email')`)
    .bind(status === 'failed' ? 'quarantined' : 'received', errorMessage, storeId, eventId).run();
}

function endAt(startsAt: string, stayMinutes: number): string {
  return new Date(new Date(startsAt).getTime() + stayMinutes * 60_000).toISOString();
}

async function upsertReservation(
  input: ProcessInput,
  parsed: ParsedReservationEmail,
  parserVersion: string,
): Promise<'inserted_or_updated' | 'stale_ignored'> {
  const stayMinutes = parsed.stayMinutes ?? DEFAULT_STAY_MINUTES;
  const holdExpiresAt = parsed.kind === 'request'
    ? nextBusinessDayHoldExpiry(parsed.sourceUpdatedAt!, holdEndHour(input.env))
    : null;
  const status = parsed.kind === 'confirmed' ? 'confirmed' : parsed.kind === 'request' ? 'pending' : 'cancelled';
  const note = parsed.courseName ? `媒体コース: ${parsed.courseName}` : null;
  const result = await dbFor(input.env, input.storeId).prepare(`INSERT INTO rt_reservations
    (id, store_id, source, external_id, customer_name, customer_phone, guest_count,
     starts_at, ends_at, status, note, source_updated_at, media_id, hold_expires_at,
     cancel_reason, stay_minutes, media_store_code, table_label, inbound_email_id,
     parser_key, parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, source, external_id) DO UPDATE SET confirmation_revision = rt_reservations.confirmation_revision + 1,
      customer_name = excluded.customer_name,
      customer_phone = excluded.customer_phone,
      guest_count = excluded.guest_count,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      status = excluded.status,
      note = excluded.note,
      source_updated_at = excluded.source_updated_at,
      media_id = excluded.media_id,
      hold_expires_at = excluded.hold_expires_at,
      cancel_reason = excluded.cancel_reason,
      stay_minutes = excluded.stay_minutes,
      media_store_code = excluded.media_store_code,
      table_label = excluded.table_label,
      inbound_email_id = excluded.inbound_email_id,
      parser_key = excluded.parser_key,
      parser_version = excluded.parser_version,
      updated_at = datetime('now')
    WHERE excluded.source_updated_at >= COALESCE(rt_reservations.source_updated_at, '')`).bind(
      crypto.randomUUID(), input.storeId, input.media.code, parsed.externalId,
      parsed.customerName ?? '(氏名未取得)', parsed.customerPhone ?? null, parsed.guestCount,
      parsed.startsAt, endAt(parsed.startsAt!, stayMinutes), status, note, parsed.sourceUpdatedAt,
      input.media.id, holdExpiresAt, parsed.cancelReason ?? null, stayMinutes,
      parsed.mediaStoreCode ?? null, parsed.tableLabel ?? null, input.inboundEmailId,
      input.media.parser_key, parserVersion,
    ).run();
  if(result.meta.changes) await reconcileRestaurantInventory(input.env,input.storeId);
  return result.meta.changes ? 'inserted_or_updated' : 'stale_ignored';
}

async function recordDigest(input: ProcessInput, parsed: ParsedReservationEmail): Promise<void> {
  await dbFor(input.env, input.storeId).prepare(`INSERT INTO rt_email_digests
    (id, store_id, media_id, target_date, reported_count, inbound_email_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(inbound_email_id) DO NOTHING`).bind(
      crypto.randomUUID(), input.storeId, input.media.id, parsed.targetDate,
      parsed.reportedCount, input.inboundEmailId,
    ).run();
}

export async function processStoredRestaurantEmail(input: ProcessInput): Promise<void> {
  const parser = parserFor(input.media.parser_key);
  if (!parser) {
    await markEvent(input.env, input.storeId, input.eventId, 'failed', {
      media: input.media.code, parserKey: input.media.parser_key,
    }, 'unprocessed:parser_not_found');
    return;
  }

  let object: R2ObjectBody | null;
  try {
    if (!input.env.RAW_MAIL) throw new Error('RAW_MAIL binding is not configured');
    object = await input.env.RAW_MAIL.get(input.objectKey);
  } catch (error) {
    await markEvent(input.env, input.storeId, input.eventId, 'failed', {
      media: input.media.code, objectKey: input.objectKey,
    }, `unprocessed:raw_mail_read_failed:${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!object) {
    await markEvent(input.env, input.storeId, input.eventId, 'failed', {
      media: input.media.code, objectKey: input.objectKey,
    }, 'unprocessed:raw_mail_missing');
    return;
  }
  if (object.size > MAX_PARSE_BYTES) {
    await object.body.cancel('reservation_email_parse_size_limit');
    await markEvent(input.env, input.storeId, input.eventId, 'failed', {
      media: input.media.code, objectKey: input.objectKey, rawSize: object.size,
    }, 'unprocessed:parse_size_limit');
    return;
  }

  try {
    const mail = await PostalMime.parse(object.body, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: 20,
      maxHeadersSize: 256 * 1024,
    });
    const subject = mail.subject || input.fallbackSubject;
    const body = mail.text || (mail.html ? htmlToText(mail.html) : '');
    const parsed = parser.parse({
      subject,
      body,
      dateHeader: mail.date || input.fallbackDate,
    });
    const sourceText = `${subject}\n${body}`;
    const validation = validateParsedReservationEmail(parsed, sourceText);
    if (!validation.valid) {
      await markEvent(input.env, input.storeId, input.eventId, 'failed', {
        media: input.media.code, kind: parsed.kind, parserVersion: parser.version,
      }, `unprocessed:${validation.reason}`);
      return;
    }

    if (parsed.kind === 'digest') {
      await recordDigest(input, parsed);
    } else if (parsed.kind !== 'notice') {
      const outcome = await upsertReservation(input, parsed, parser.version);
      await markEvent(input.env, input.storeId, input.eventId, 'processed', {
        media: input.media.code, kind: parsed.kind, parserVersion: parser.version, outcome,
      }, null);
      return;
    }
    await markEvent(input.env, input.storeId, input.eventId, 'processed', {
      media: input.media.code, kind: parsed.kind, parserVersion: parser.version,
    }, null);
  } catch (error) {
    await markEvent(input.env, input.storeId, input.eventId, 'failed', {
      media: input.media.code, parserVersion: parser.version,
    }, `unprocessed:parse_failed:${error instanceof Error ? error.message : String(error)}`);
  }
}
