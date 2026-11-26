import PostalMime from 'postal-mime';
import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import { parserFor } from './parsers/index.js';
import { type ParsedReservationEmail } from './parsers/types.js';
import {
  DEFAULT_STAY_MINUTES,
  commitReservationEmailAtomically,
  holdInboundReservationEmail,
  loadStoreMediaEmailImportSnapshot,
  nextBusinessDayHoldExpiry,
  quarantineReservationEmailAtomically,
  type RestaurantMediaRow,
} from './restaurant-media-email-import.js';

export { DEFAULT_STAY_MINUTES, nextBusinessDayHoldExpiry, type RestaurantMediaRow };

const MAX_PARSE_BYTES = 2 * 1024 * 1024;

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

export type ProcessStoredEmailResult = {
  outcome: 'processed' | 'held' | 'quarantined' | 'retry_later' | 'skipped';
};

async function settleFailedParse(
  input: ProcessInput,
  options: { mode: 'live' | 'resume'; observedVersion?: number; claimToken?: string; now: Date; transient?: boolean },
  payload: Record<string, unknown>,
  reason: string,
): Promise<ProcessStoredEmailResult> {
  const db = dbFor(input.env, input.storeId);
  if (options.mode === 'resume' && options.transient) {
    const released = await db
      .prepare(`UPDATE rt_held_reservation_emails
        SET state = 'held', claim_token = NULL, claim_expires_at = NULL, last_error = ?, updated_at = datetime('now')
        WHERE inbound_email_id = ? AND state = 'processing' AND claim_token = ?
          AND claim_expires_at IS NOT NULL AND datetime(claim_expires_at) > datetime(?)`)
      .bind(reason, input.inboundEmailId, options.claimToken ?? '', options.now.toISOString())
      .run();
    return { outcome: released.meta.changes ? 'retry_later' : 'skipped' };
  }

  return { outcome: await quarantineReservationEmailAtomically({ ...input, ...options, payload, reason }) };
}

export async function processStoredRestaurantEmail(
  input: ProcessInput,
  options: { mode?: 'live' | 'resume'; claimToken?: string; now?: Date; beforeCommitHook?: () => Promise<void> } = {},
): Promise<ProcessStoredEmailResult> {
  const mode = options.mode ?? 'live';
  const now = options.now ?? new Date();
  const db = dbFor(input.env, input.storeId);
  let observedVersion = 0;

  if (mode === 'live') {
    const observed = await loadStoreMediaEmailImportSnapshot(db, input.storeId, input.media.id);
    if (!observed.enabled) {
      await holdInboundReservationEmail(db, {
        inboundEmailId: input.inboundEmailId,
        storeId: input.storeId,
        mediaId: input.media.id,
        syncEventId: input.eventId,
        mediaCode: input.media.code,
        now,
      });
      return { outcome: 'held' };
    }
    observedVersion = observed.version;
  }

  const parser = parserFor(input.media.parser_key);
  if (!parser) {
    return settleFailedParse(
      input,
      { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date() },
      { media: input.media.code, parserKey: input.media.parser_key },
      'unprocessed:parser_not_found',
    );
  }

  let object: R2ObjectBody | null;
  try {
    if (!input.env.RAW_MAIL) throw new Error('RAW_MAIL binding is not configured');
    object = await input.env.RAW_MAIL.get(input.objectKey);
  } catch (error) {
    return settleFailedParse(
      input,
      { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date(), transient: true },
      { media: input.media.code, objectKey: input.objectKey },
      'unprocessed:raw_mail_read_failed',
    );
  }
  if (!object) {
    return settleFailedParse(
      input,
      { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date() },
      { media: input.media.code, objectKey: input.objectKey },
      'unprocessed:raw_mail_missing',
    );
  }
  if (object.size > MAX_PARSE_BYTES) {
    await object.body.cancel('reservation_email_parse_size_limit');
    return settleFailedParse(
      input,
      { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date() },
      { media: input.media.code, objectKey: input.objectKey, rawSize: object.size },
      'unprocessed:parse_size_limit',
    );
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
      return settleFailedParse(
        input,
        { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date() },
        { media: input.media.code, kind: parsed.kind, parserVersion: parser.version },
        `unprocessed:${validation.reason}`,
      );
    }

    if (options.beforeCommitHook) {
      await options.beforeCommitHook();
    }

    const committed = await commitReservationEmailAtomically({
      env: input.env,
      storeId: input.storeId,
      inboundEmailId: input.inboundEmailId,
      eventId: input.eventId,
      media: input.media,
      parsed,
      parserVersion: parser.version,
      mode,
      observedVersion,
      claimToken: options.claimToken,
      now: options.now ?? new Date(),
    });
    return { outcome: committed };
  } catch (error) {
    return settleFailedParse(
      input,
      { mode, observedVersion, claimToken: options.claimToken, now: options.now ?? new Date() },
      { media: input.media.code, parserVersion: parser.version },
      'unprocessed:parse_failed',
    );
  }
}
