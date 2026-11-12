import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { sqlIdSet } from '@line-crm/db/id-queries';
import {
  activeTenantLineAccountSql,
  isOperationCapabilityStopped,
  resolveLineCredential,
  jstNow,
} from '@line-crm/db';
import { stoppedTenantLineAccountSql } from '../../services/tenant-runtime-status.js';
import {
  featureJobCanRun,
} from '../../services/feature-enforcement.js';

import { pushViaHarnessProxy, type HarnessProxyDispatch } from '../../services/line-proxy-send.js';
import { buildWebinarUrl } from './webinar-reminders.js';
import {
  classifyExternalDeliveryError,
  EXTERNAL_DELIVERY_MAX_ATTEMPTS,
  externalDeliveryRetryAt,
} from '../../services/external-delivery-retry.js';

const JST_SECONDS = 9 * 60 * 60;

// cron内のlineProxyも同じD1呼び出し予算を使う。実Proxy（初回チャット作成・
// waitUntilの送信履歴を含む）では20件で301 queries。上限1000を使い切らず、
// 他のcron処理・失敗記録の余地を残す。残りは次tickで拾い、停止は毎件読み直す。
// https://developers.cloudflare.com/d1/platform/limits/
const WEBINAR_NOTIFICATION_TICK_LIMIT = 20;

export type WebinarNotificationKind =
  | 'day_before'
  | 'hour_before'
  | 'session_start'
  | 'missed'
  | 'completed';

export type WebinarNotificationSettings = {
  webinarId: string;
  version: number;
  registrationEnabled: boolean;
  dayBeforeEnabled: boolean;
  dayBeforeTime: string;
  hourBeforeEnabled: boolean;
  hourBeforeMinutes: number;
  startEnabled: boolean;
  missedEnabled: boolean;
  missedTime: string;
  /** 見逃し配信の期限（開催からの日数。1〜30、既定7）。N。 */
  missedWindowDays: number;
  completedEnabled: boolean;
  updatedAt: string;
};

export type WebinarNotificationSettingsInput = Omit<
  WebinarNotificationSettings,
  'webinarId' | 'version' | 'updatedAt' | 'missedWindowDays'
> & {
  missedWindowDays?: number;
};

type SettingsRow = {
  webinar_id: string;
  version: number;
  registration_enabled: number;
  day_before_enabled: number;
  day_before_time_minutes: number;
  hour_before_enabled: number;
  hour_before_minutes: number;
  start_enabled: number;
  missed_enabled: number;
  missed_time_minutes: number;
  missed_window_days: number | null;
  completed_enabled: number;
  updated_at: string;
};

type RegistrationRow = {
  id: string;
  webinar_id: string;
  friend_id: string;
  session_start_at: number;
  notified_at: string | null;
  status: 'active' | 'cancelled';
  cancelled_at: string | null;
  created_at: string;
};

type DueJobRow = {
  id: string;
  webinar_id: string;
  registration_id: string;
  friend_id: string;
  session_start_at: number;
  kind: WebinarNotificationKind;
  status: 'queued' | 'retry_wait' | 'claimed';
  attempt_count: number;
  line_retry_key: string;
  title: string;
  slug: string;
  duration_seconds: number;
  account_id: string | null;
  line_user_id: string;
  is_following: number;
  line_account_id: string | null;
  channel_access_token: string | null;
  channel_access_token_encrypted: string | null;
  line_account_active: number | null;
  liff_id: string | null;
  viewed: number;
  missed_window_days: number | null;
};

export type WebinarNotificationDeliveryOptions = {
  now?: Date;
  proxyBaseUrl: string;
  defaultAccessToken: string;
  defaultLiffId: string | null;
  proxyDispatch?: HarnessProxyDispatch;
  expectedRecipientToken?: string;
  confirmationId?: string;
};

type WebinarNotificationTestTarget = {
  id: string;
  line_user_id: string;
  is_following: number;
  display_name: string | null;
};

export class WebinarTestRecipientsChanged extends Error {
  readonly code = 'WEBINAR_TEST_RECIPIENT_CHANGED';
  constructor(public current: {count:number|null;recipients:Array<{id:string;displayName:string|null}>}) {
    super('テスト宛先が変わりました。もう一度確認してください');
  }
}

export async function webinarTestRecipientPreview(db:D1Database, accountId:string) {
  const setting=await db.prepare(`SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'`).bind(accountId).first<{value:string}>();
  let ids:unknown;
  try { ids=setting?JSON.parse(setting.value):[]; } catch { throw new Error('invalid_test_recipients'); }
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')) throw new Error('invalid_test_recipients');
  if(!ids.length) throw new Error('no_test_recipients');
  const set=sqlIdSet(ids);
  const targets=(await db.prepare(`SELECT id,line_user_id,is_following,display_name FROM friends WHERE line_account_id=? AND id IN (${set.sql})`).bind(accountId,...set.binds).all<WebinarNotificationTestTarget>()).results
    .filter(target=>target.is_following).sort((a,b)=>a.id.localeCompare(b.id));
  const bytes=new TextEncoder().encode(JSON.stringify([accountId,targets.map(target=>[target.id,target.line_user_id])]));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const token=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {targets,token,count:targets.length,recipients:targets.map(target=>({id:target.id,displayName:target.display_name}))};
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function jstDayAt(sessionStartAt: number, dayOffset: number, minutes: number): number {
  const local = japanCalendar(new Date((sessionStartAt) * 1000));
  return Math.floor(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + dayOffset,
    Math.floor(minutes / 60),
    minutes % 60,
  ) / 1000) - JST_SECONDS;
}

export function calculateWebinarNotificationSchedule(
  sessionStartAt: number,
  input: Pick<
    WebinarNotificationSettingsInput,
    | 'dayBeforeEnabled'
    | 'dayBeforeTime'
    | 'hourBeforeEnabled'
    | 'hourBeforeMinutes'
    | 'startEnabled'
    | 'missedEnabled'
    | 'missedTime'
  >,
  nowEpoch = Math.floor(Date.now() / 1000),
): Array<{ kind: Exclude<WebinarNotificationKind, 'completed'>; scheduledAt: number }> {
  const jobs: Array<{ kind: Exclude<WebinarNotificationKind, 'completed'>; scheduledAt: number }> = [];
  const dayBeforeTime = parseTime(input.dayBeforeTime);
  const missedTime = parseTime(input.missedTime);
  if (input.dayBeforeEnabled && dayBeforeTime !== null && sessionStartAt > nowEpoch) {
    jobs.push({ kind: 'day_before', scheduledAt: Math.max(nowEpoch, jstDayAt(sessionStartAt, -1, dayBeforeTime)) });
  }
  if (input.hourBeforeEnabled && sessionStartAt > nowEpoch) {
    jobs.push({
      kind: 'hour_before',
      scheduledAt: Math.max(nowEpoch, sessionStartAt - input.hourBeforeMinutes * 60),
    });
  }
  if (input.startEnabled && sessionStartAt > nowEpoch) {
    jobs.push({ kind: 'session_start', scheduledAt: sessionStartAt });
  }
  if (input.missedEnabled && missedTime !== null) {
    jobs.push({ kind: 'missed', scheduledAt: Math.max(nowEpoch, jstDayAt(sessionStartAt, 1, missedTime)) });
  }
  return jobs;
}

function serializeSettings(row: SettingsRow): WebinarNotificationSettings {
  return {
    webinarId: row.webinar_id,
    version: row.version,
    registrationEnabled: Boolean(row.registration_enabled),
    dayBeforeEnabled: Boolean(row.day_before_enabled),
    dayBeforeTime: formatTime(row.day_before_time_minutes),
    hourBeforeEnabled: Boolean(row.hour_before_enabled),
    hourBeforeMinutes: row.hour_before_minutes,
    startEnabled: Boolean(row.start_enabled),
    missedEnabled: Boolean(row.missed_enabled),
    missedTime: formatTime(row.missed_time_minutes),
    missedWindowDays: row.missed_window_days ?? 7,
    completedEnabled: Boolean(row.completed_enabled),
    updatedAt: row.updated_at,
  };
}

export async function getWebinarNotificationSettings(
  db: D1Database,
  webinarId: string,
): Promise<WebinarNotificationSettings | null> {
  const row = await db.prepare(
    'SELECT * FROM webinar_notification_settings WHERE webinar_id = ?',
  ).bind(webinarId).first<SettingsRow>();
  return row ? serializeSettings(row) : null;
}

async function enqueueJobsForRegistration(
  db: D1Database,
  registration: RegistrationRow,
  settings: WebinarNotificationSettings,
  nowEpoch: number,
): Promise<number> {
  const schedule = calculateWebinarNotificationSchedule(registration.session_start_at, settings, nowEpoch);
  const now = jstNow();
  let queued = 0;
  for (const item of schedule) {
    const result = await db.prepare(
      `INSERT INTO webinar_notification_jobs
         (id, webinar_id, registration_id, friend_id, session_start_at,
          settings_version, kind, scheduled_at, status, attempt_count,
          next_retry_at, line_retry_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
       ON CONFLICT(registration_id, settings_version, kind) DO UPDATE SET
         scheduled_at=excluded.scheduled_at,
         status='queued',
         attempt_count=0,
         next_retry_at=excluded.next_retry_at,
         lease_expires_at=NULL,
         line_retry_key=excluded.line_retry_key,
         line_request_id=NULL,
         cancelled_at=NULL,
         last_error_code=NULL,
         last_error_message=NULL,
         updated_at=excluded.updated_at
       WHERE webinar_notification_jobs.status='cancelled'`,
    ).bind(
      crypto.randomUUID(),
      registration.webinar_id,
      registration.id,
      registration.friend_id,
      registration.session_start_at,
      settings.version,
      item.kind,
      item.scheduledAt,
      item.scheduledAt,
      crypto.randomUUID(),
      now,
      now,
    ).run();
    queued += result.meta.changes ?? 0;
  }
  return queued;
}

export async function saveWebinarNotificationSettings(
  db: D1Database,
  webinarId: string,
  input: WebinarNotificationSettingsInput,
  now = new Date(),
): Promise<{ settings: WebinarNotificationSettings; queued: number; cancelled: number }> {
  const dayBeforeMinutes = parseTime(input.dayBeforeTime);
  const missedMinutes = parseTime(input.missedTime);
  if (dayBeforeMinutes === null || missedMinutes === null) throw new Error('invalid_time');
  if (!Number.isInteger(input.hourBeforeMinutes) || input.hourBeforeMinutes < 1 || input.hourBeforeMinutes > 10080) {
    throw new Error('invalid_hour_before');
  }
  const previous = await getWebinarNotificationSettings(db, webinarId);
  // N: 見逃し配信の期限（開催からの日数）。省略時は従来の設定を残し、無ければ7日。
  const missedWindowDays = input.missedWindowDays ?? previous?.missedWindowDays ?? 7;
  if (!Number.isInteger(missedWindowDays) || missedWindowDays < 1 || missedWindowDays > 30) {
    throw new Error('invalid_missed_window');
  }
  const version = (previous?.version ?? 0) + 1;
  const nowIso = now.toISOString();
  await db.prepare(
    `INSERT INTO webinar_notification_settings
       (webinar_id, version, registration_enabled, day_before_enabled,
        day_before_time_minutes, hour_before_enabled, hour_before_minutes,
        start_enabled, missed_enabled, missed_time_minutes, missed_window_days,
        completed_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(webinar_id) DO UPDATE SET
       version=excluded.version,
       registration_enabled=excluded.registration_enabled,
       day_before_enabled=excluded.day_before_enabled,
       day_before_time_minutes=excluded.day_before_time_minutes,
       hour_before_enabled=excluded.hour_before_enabled,
       hour_before_minutes=excluded.hour_before_minutes,
       start_enabled=excluded.start_enabled,
       missed_enabled=excluded.missed_enabled,
       missed_time_minutes=excluded.missed_time_minutes,
       missed_window_days=excluded.missed_window_days,
       completed_enabled=excluded.completed_enabled,
       updated_at=excluded.updated_at`,
  ).bind(
    webinarId,
    version,
    input.registrationEnabled ? 1 : 0,
    input.dayBeforeEnabled ? 1 : 0,
    dayBeforeMinutes,
    input.hourBeforeEnabled ? 1 : 0,
    input.hourBeforeMinutes,
    input.startEnabled ? 1 : 0,
    input.missedEnabled ? 1 : 0,
    missedMinutes,
    missedWindowDays,
    input.completedEnabled ? 1 : 0,
    nowIso,
    nowIso,
  ).run();

  const cancelledResult = await db.prepare(
    `UPDATE webinar_notification_jobs
        SET status='cancelled', cancelled_at=?, updated_at=?
      WHERE webinar_id=? AND status IN ('queued','retry_wait')`,
  ).bind(nowIso, nowIso, webinarId).run();
  const settings = (await getWebinarNotificationSettings(db, webinarId))!;
  const registrations = await db.prepare(
    `SELECT * FROM webinar_registrations
      WHERE webinar_id=? AND status='active' AND session_start_at > ?
      ORDER BY session_start_at ASC`,
  ).bind(webinarId, Math.floor(now.getTime() / 1000)).all<RegistrationRow>();
  let queued = 0;
  for (const registration of registrations.results ?? []) {
    queued += await enqueueJobsForRegistration(
      db,
      registration,
      settings,
      Math.floor(now.getTime() / 1000),
    );
  }
  return { settings, queued, cancelled: cancelledResult.meta.changes ?? 0 };
}

export async function registerWebinarSession(
  db: D1Database,
  webinarId: string,
  friendId: string,
  sessionStartAt: number,
  now = new Date(),
): Promise<{ registration: RegistrationRow; created: boolean; rescheduled: boolean }> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const nowIso = now.toISOString();
  const registrationId = crypto.randomUUID();
  const oldRegistrations = `SELECT id FROM webinar_registrations
    WHERE webinar_id=? AND friend_id=? AND status='active' AND session_start_at>? AND session_start_at!=?`;
  let results: D1Result[];
  try {
    results = await db.batch([
      // 同じ申込が既にある場合は満席でも再送できる。それ以外は原子的に枠を確認する。
      db.prepare(`SELECT json(CASE WHEN
        EXISTS (SELECT 1 FROM webinar_registrations WHERE webinar_id=? AND friend_id=? AND session_start_at=? AND status='active')
        OR NOT EXISTS (SELECT 1 FROM webinar_sessions WHERE webinar_id=? AND session_start_at=?
          AND (state='closed' OR (capacity IS NOT NULL AND reserved_count>=capacity)))
        THEN '{}' ELSE 'session_full' END)`).bind(webinarId, friendId, sessionStartAt, webinarId, sessionStartAt),
      db.prepare(`UPDATE webinar_sessions SET reserved_count=reserved_count+1,
          state=CASE WHEN reserved_count+1>=capacity THEN 'full' ELSE 'open' END, updated_at=?
        WHERE webinar_id=? AND session_start_at=? AND capacity IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM webinar_registrations
            WHERE webinar_id=? AND friend_id=? AND session_start_at=? AND status='active')`)
        .bind(nowIso, webinarId, sessionStartAt, webinarId, friendId, sessionStartAt),
      db.prepare(`UPDATE webinar_sessions SET
          reserved_count=MAX(0,reserved_count-(SELECT COUNT(*) FROM webinar_registrations r
            WHERE r.webinar_id=webinar_sessions.webinar_id AND r.session_start_at=webinar_sessions.session_start_at
              AND r.friend_id=? AND r.status='active' AND r.session_start_at>? AND r.session_start_at!=?)),
          state=CASE WHEN state='closed' THEN 'closed' ELSE 'open' END, updated_at=?
        WHERE webinar_id=? AND session_start_at IN (SELECT session_start_at FROM webinar_registrations
          WHERE webinar_id=? AND friend_id=? AND status='active' AND session_start_at>? AND session_start_at!=?)`)
        .bind(friendId, nowEpoch, sessionStartAt, nowIso, webinarId, webinarId, friendId, nowEpoch, sessionStartAt),
      db.prepare(`UPDATE webinar_notification_jobs SET status='cancelled',cancelled_at=?,updated_at=?
        WHERE registration_id IN (${oldRegistrations}) AND status IN ('queued','retry_wait')`)
        .bind(nowIso, nowIso, webinarId, friendId, nowEpoch, sessionStartAt),
      db.prepare(`UPDATE webinar_registrations SET status='cancelled',cancelled_at=? WHERE id IN (${oldRegistrations})`)
        .bind(nowIso, webinarId, friendId, nowEpoch, sessionStartAt),
      db.prepare(`INSERT INTO webinar_registrations
        (id,webinar_id,friend_id,session_start_at,notified_at,created_at,status,cancelled_at)
        VALUES (?,?,?,?,NULL,?,'active',NULL)
        ON CONFLICT(webinar_id,friend_id,session_start_at) DO UPDATE SET
          status='active',cancelled_at=NULL,notified_at=NULL
        WHERE webinar_registrations.status!='active'`)
        .bind(registrationId, webinarId, friendId, sessionStartAt, nowIso),
    ]);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) throw new Error('session_full');
    throw error;
  }
  const registration = await db.prepare(`SELECT * FROM webinar_registrations
    WHERE webinar_id=? AND friend_id=? AND session_start_at=? AND status='active'`)
    .bind(webinarId, friendId, sessionStartAt).first<RegistrationRow>();
  if (!registration) throw new Error('webinar_registration_not_saved');
  // 同じ申込の再送でも、保存済みで未作成の通知だけを補う。
  const settings = await getWebinarNotificationSettings(db, webinarId);
  if (settings) await enqueueJobsForRegistration(db, registration, settings, nowEpoch);
  return { registration, created: Number(results[5].meta?.changes ?? 0) === 1,
    rescheduled: Number(results[4].meta?.changes ?? 0) > 0 };
}

export async function enqueueWebinarCompletedNotification(
  db: D1Database,
  webinarId: string,
  friendId: string,
  sessionStartAt: number,
  now = new Date(),
): Promise<boolean> {
  const settings = await getWebinarNotificationSettings(db, webinarId);
  if (!settings?.completedEnabled) return false;
  const registration = await db.prepare(
    `SELECT * FROM webinar_registrations
      WHERE webinar_id=? AND friend_id=? AND session_start_at=? AND status='active'`,
  ).bind(webinarId, friendId, sessionStartAt).first<RegistrationRow>();
  if (!registration) return false;
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const nowIso = now.toISOString();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO webinar_notification_jobs
       (id, webinar_id, registration_id, friend_id, session_start_at,
        settings_version, kind, scheduled_at, status, attempt_count,
        next_retry_at, line_retry_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 'queued', 0, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    webinarId,
    registration.id,
    friendId,
    sessionStartAt,
    settings.version,
    nowEpoch,
    nowEpoch,
    crypto.randomUUID(),
    nowIso,
    nowIso,
  ).run();
  return (result.meta.changes ?? 0) > 0;
}

function formatJstDateTime(epochSeconds: number): string {
  const d = japanCalendar(new Date((epochSeconds) * 1000));
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${weekdays[d.getUTCDay()]}）${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function renderWebinarNotificationText(
  kind: WebinarNotificationKind,
  title: string,
  sessionStartAt: number,
  url: string,
): string {
  const when = formatJstDateTime(sessionStartAt);
  switch (kind) {
    case 'day_before':
      return `【明日のウェビナー】\n「${title}」は${when}からです。\n\n参加する回はこちらで確認できます👇\n${url}`;
    case 'hour_before':
      return `【開始前のご案内】\n「${title}」は${when}からです。\n\n専用の入場リンクはこちらです👇\n${url}`;
    case 'session_start':
      return `🔴 「${title}」が始まりました\n\nこちらから参加してください👇\n${url}`;
    case 'missed':
      return `「${title}」を見逃した方へ\n\n次の回を選び直せます。都合のよい時間はこちらからどうぞ👇\n${url}`;
    case 'completed':
      return `「${title}」をご視聴いただき、ありがとうございました。\n\nもう一度確認するときはこちらから開けます👇\n${url}`;
  }
}

export async function sendWebinarNotificationTest(
  db: D1Database,
  webinar: { id: string; accountId: string | null; title: string; slug: string },
  sessionStartAt: number,
  options: WebinarNotificationDeliveryOptions,
): Promise<{ sent: number; failed: number }> {
  if (!webinar.accountId) throw new Error('missing_line_account');
  const readRecipients=async()=>{
    try{return await webinarTestRecipientPreview(db,webinar.accountId!);}
    catch(error){
      if(options.expectedRecipientToken!==undefined&&error instanceof Error&&['invalid_test_recipients','no_test_recipients'].includes(error.message))throw new WebinarTestRecipientsChanged({count:null,recipients:[]});
      throw error;
    }
  };
  const targets = await readRecipients();
  if(options.expectedRecipientToken!==undefined&&targets.token!==options.expectedRecipientToken)throw new WebinarTestRecipientsChanged(targets);
  const account = await db.prepare(
    `SELECT channel_access_token, channel_access_token_encrypted, liff_id, is_active
       FROM line_accounts WHERE id=?`,
  ).bind(webinar.accountId).first<{
    channel_access_token: string | null;
    channel_access_token_encrypted: string | null;
    liff_id: string | null;
    is_active: number;
  }>();
  if (!account?.is_active) throw new Error('inactive_line_account');
  const liffId = account.liff_id ?? options.defaultLiffId;
  if (!liffId) throw new Error('missing_liff_id');
  const accessToken = await resolveLineCredential(
    account.channel_access_token_encrypted,
    account.channel_access_token ?? options.defaultAccessToken,
    { lineAccountId: webinar.accountId, field: 'channel_access_token' },
  );
  let sent = 0;
  let failed = 0;
  const latest=options.expectedRecipientToken===undefined?targets:await readRecipients();
  if(options.expectedRecipientToken!==undefined&&latest.token!==options.expectedRecipientToken)throw new WebinarTestRecipientsChanged(latest);
  if(options.confirmationId!==undefined){
    const claimed=await db.prepare(`INSERT OR IGNORE INTO operation_audit(id,target_kind,target_id,action) VALUES (?,'webinar',?,'notification_test_started')`)
      .bind(`webinar-test:${webinar.id}:${options.confirmationId}`,webinar.id).run();
    if(!claimed.meta.changes)throw new Error('webinar_test_already_started');
  }
  for (const target of latest.targets) {
    if (!target.is_following) continue;
    try {
      await pushViaHarnessProxy(
        options.proxyBaseUrl,
        accessToken,
        target.line_user_id,
        [{
          type: 'text',
          text: `【テスト送信】\n${renderWebinarNotificationText(
            'session_start',
            webinar.title,
            sessionStartAt,
            buildWebinarUrl(liffId, webinar.slug, sessionStartAt),
          )}`,
        }],
        crypto.randomUUID(),
        options.proxyDispatch,
        'reminder_dispatch',
      );
      sent++;
    } catch {
      failed++;
    }
  }
  if (sent === 0 && failed === 0) throw new Error('no_active_test_recipients');
  return { sent, failed };
}

export async function processWebinarNotificationJobs(
  db: D1Database,
  options: WebinarNotificationDeliveryOptions,
): Promise<{ sent: number; failed: number; skipped: number; heldByStop: number }> {
  const now = options.now ?? new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  await db.prepare(
    `UPDATE webinar_notification_jobs
        SET status='skipped', lease_expires_at=NULL,
            last_error_code='tenant_suspended',
            last_error_message='契約先が停止中のため送信しませんでした。',
            updated_at=?
      WHERE status IN ('queued','retry_wait','claimed')
        AND scheduled_at <= ?
        AND EXISTS (
          SELECT 1 FROM webinars stopped_webinar
           WHERE stopped_webinar.id=webinar_notification_jobs.webinar_id
             AND ${stoppedTenantLineAccountSql('stopped_webinar.account_id')}
        )`,
  ).bind(now.toISOString(), nowEpoch).run();
  const due = await db.prepare(
    `SELECT j.id, j.webinar_id, j.registration_id, j.friend_id,
            j.session_start_at, j.kind, j.status, j.attempt_count, j.line_retry_key,
            w.title, w.slug, w.duration_seconds, w.account_id,
            f.line_user_id, f.is_following, f.line_account_id,
            la.channel_access_token, la.channel_access_token_encrypted,
            la.is_active AS line_account_active, la.liff_id,
            EXISTS (
              SELECT 1 FROM webinar_viewers v
               WHERE v.webinar_id=j.webinar_id AND v.friend_id=j.friend_id
                 AND v.session_start_at=j.session_start_at
            ) AS viewed,
            s.missed_window_days AS missed_window_days
       FROM webinar_notification_jobs j
       JOIN webinar_notification_settings s
         ON s.webinar_id=j.webinar_id AND s.version=j.settings_version
       JOIN webinar_registrations r ON r.id=j.registration_id
       JOIN webinars w ON w.id=j.webinar_id
       JOIN friends f ON f.id=j.friend_id
       LEFT JOIN line_accounts la ON la.id=f.line_account_id
      WHERE (
          j.status IN ('queued','retry_wait')
          OR (j.status='claimed' AND COALESCE(j.lease_expires_at, 0) <= ?)
        )
        AND j.attempt_count < ?
        AND j.scheduled_at <= ?
        AND COALESCE(j.next_retry_at, j.scheduled_at) <= ?
        AND r.status='active'
        AND w.status='active'
        AND ${activeTenantLineAccountSql('w.account_id')}
      -- 停止中の先頭20件で他アカウントを塞がない。未停止を先に選び、
      -- その中では予定時刻順を維持する。停止行は書き換えず解除後に拾う。
      -- この判定は優先順位専用。送信許可には使わず、下の3点で読み直す。
      ORDER BY EXISTS (
        SELECT 1 FROM operation_control_sets control
         WHERE control.scope_key IN ('*', w.account_id)
           AND CASE
             WHEN control.states_json IS NULL OR control.states_json = '' THEN 0
             WHEN NOT json_valid(control.states_json)
               THEN COALESCE(control.active_incident_id, '') != ''
             WHEN json_type(control.states_json) = 'null'
               THEN COALESCE(control.active_incident_id, '') != ''
             ELSE json_extract(control.states_json, '$.reminder_dispatch') = 'stopped'
           END
      ) ASC, j.scheduled_at ASC, j.id ASC
      LIMIT ${WEBINAR_NOTIFICATION_TICK_LIMIT}`,
  ).bind(nowEpoch, EXTERNAL_DELIVERY_MAX_ATTEMPTS, nowEpoch, nowEpoch).all<DueJobRow>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let heldByStop = 0;
  for (const row of due.results ?? []) {
    if (!row.account_id || !await featureJobCanRun(db, {
      accountId: row.account_id,
      featureId: 'webinars',
      job: 'webinar-notifications',
      occurredAt: now.toISOString(),
    })) {
      skipped++;
      continue;
    }
    /*
     * 緊急停止は一時的な抑止なので、queued のまま次の tick に残す。
     * claim すると attempt_count が増え、skipped にすると再開も UNIQUE 制約による積み直しもできず、復旧後に届かなくなるため、停止中は行へ触れない。
     * 対象回の終了などで送る意味がなくなったジョブは、後続の notification_expired で期限切れとして処理する。
     */
    // 未停止の結果は使い回さない。1件の送信中にも緊急停止は切り替わる。
    if (await isOperationCapabilityStopped(db, row.account_id, 'reminder_dispatch')) {
      heldByStop++;
      continue;
    }
    const claimLeaseExpiresAt = nowEpoch + 300;
    const claimed = await db.prepare(
      `UPDATE webinar_notification_jobs
          SET status='claimed', attempt_count=attempt_count+1, lease_expires_at=?, updated_at=?
        WHERE id=? AND attempt_count=? AND (
          status IN ('queued','retry_wait')
          OR (status='claimed' AND COALESCE(lease_expires_at, 0) <= ?)
        )`,
    ).bind(claimLeaseExpiresAt, now.toISOString(), row.id, row.attempt_count, nowEpoch).run();
    if ((claimed.meta.changes ?? 0) === 0) continue;
    const holdClaimIfStopped = async (): Promise<boolean> => {
      if (!await isOperationCapabilityStopped(db, row.account_id, 'reminder_dispatch')) return false;
      // 自分が取得した世代とleaseだけを戻す。別workerによる再取得・取消は上書きしない。
      // retry_waitの再試行日時・理由を残し、期限切れclaimはqueuedへ戻して再取得可能にする。
      await db.prepare(
        `UPDATE webinar_notification_jobs
            SET status=?, attempt_count=attempt_count-1, lease_expires_at=NULL, updated_at=?
          WHERE id=? AND status='claimed' AND attempt_count=? AND lease_expires_at=?`,
      ).bind(
        row.status === 'retry_wait' ? 'retry_wait' : 'queued',
        now.toISOString(), row.id, row.attempt_count + 1, claimLeaseExpiresAt,
      ).run();
      heldByStop++;
      return true;
    };
    try {
      // 停止確認とclaimの間に切り替わった場合も、期限切れなどの確定処理へ進めない。
      if (await holdClaimIfStopped()) continue;
      const isMissedButViewed = row.kind === 'missed' && Boolean(row.viewed);
      // N: 見逃し配信は「する」を選んだ時だけ、期限つき。期限切れは送らない。
      const isMissedWindowExpired = row.kind === 'missed'
        && nowEpoch > row.session_start_at + (row.missed_window_days ?? 7) * 86400;
      const isLateReminder = ['day_before', 'hour_before', 'session_start'].includes(row.kind)
        && nowEpoch >= row.session_start_at + row.duration_seconds;
      const skip = isMissedButViewed
        ? { code: 'already_viewed', message: 'すでに視聴済みのため送信しませんでした。' }
        : isMissedWindowExpired
          ? { code: 'missed_window_expired', message: '見逃し配信の期限を過ぎたため送信しませんでした。' }
          : isLateReminder
          ? { code: 'notification_expired', message: '対象回が終了済みのため送信しませんでした。' }
          : !row.is_following
            ? { code: 'friend_not_following', message: 'ブロックまたは友だち解除のため送信しませんでした。' }
            : !row.line_account_id || row.line_account_id !== row.account_id
              ? { code: 'line_account_mismatch', message: '送信先とウェビナーのLINEアカウントが一致しないため送信しませんでした。' }
              : !row.line_account_active
                ? { code: 'line_account_inactive', message: 'LINEアカウントが停止中のため送信しませんでした。' }
                : null;
      if (
        skip
      ) {
        await db.prepare(
          `UPDATE webinar_notification_jobs
              SET status='skipped', lease_expires_at=NULL,
                  last_error_code=?, last_error_message=?, updated_at=?
            WHERE id=?`,
        ).bind(skip.code, skip.message, now.toISOString(), row.id).run();
        skipped++;
        continue;
      }
      const lineAccountId = row.line_account_id;
      if (!lineAccountId) continue;
      const liffId = row.liff_id ?? options.defaultLiffId;
      if (!liffId) throw new Error('missing_liff_id');
      const accessToken = await resolveLineCredential(
        row.channel_access_token_encrypted,
        row.channel_access_token ?? options.defaultAccessToken,
        { lineAccountId, field: 'channel_access_token' },
      );
      // 設定取得・復号を待っている間の停止も、外部送信の直前に読み直す。
      if (await holdClaimIfStopped()) continue;
      const response = await pushViaHarnessProxy(
        options.proxyBaseUrl,
        accessToken,
        row.line_user_id,
        [{
          type: 'text',
          text: renderWebinarNotificationText(
            row.kind,
            row.title,
            row.session_start_at,
            buildWebinarUrl(liffId, row.slug, row.session_start_at),
          ),
        }],
        row.line_retry_key,
        options.proxyDispatch,
        'reminder_dispatch',
      );
      await db.prepare(
        `UPDATE webinar_notification_jobs
            SET status='succeeded', sent_at=?, line_request_id=?, lease_expires_at=NULL,
                last_error_code=NULL, last_error_message=NULL, updated_at=?
          WHERE id=? AND status='claimed'`,
      ).bind(now.toISOString(), response.requestId, now.toISOString(), row.id).run();
      sent++;
    } catch (error) {
      const attempt = row.attempt_count + 1;
      const safe = classifyExternalDeliveryError(error, 'missing_liff_id');
      const retryAt = externalDeliveryRetryAt(error, attempt, now, safe.retryable);
      const exhausted = safe.retryable && !retryAt;
      await db.prepare(
        `UPDATE webinar_notification_jobs
            SET status=?, next_retry_at=?, lease_expires_at=NULL,
                last_error_code=?, last_error_message=?, updated_at=?
          WHERE id=? AND status='claimed'`,
      ).bind(
        retryAt ? 'retry_wait' : 'permanent_failed',
        retryAt ? Math.floor(retryAt.getTime() / 1000) : null,
        exhausted ? 'retry_exhausted' : safe.code,
        exhausted
          ? '自動再試行の上限に達しました。LINE連携を確認し、必要なら手動で再試行してください。'
          : safe.message,
        now.toISOString(),
        row.id,
      ).run();
      failed++;
    }
  }
  return { sent, failed, skipped, heldByStop };
}

/**
 * 見送った理由の表示名。
 *
 * 「見送り 5件」とだけ出しても、運用者は**何が起きたのか分かりません。**
 * 「視聴済みだから送らなかった」（正常）と「対象回が終了済みで落ちた」
 * （取り戻せない）は、取るべき行動がまったく違います。理由ごとに分けて
 * 出すために、この対応表を正本として持ちます。
 *
 * `operation_stopped` は  以降**新しく付きません**（緊急停止は行を
 * 確定させず `queued` のまま残すため）。ただし過去に付いた行が残って
 * いる可能性があるので、読む側からは外しません。
 */
const SKIP_REASON_LABELS: Record<string, string> = {
  already_viewed: 'すでに視聴済み',
  missed_window_expired: '見逃し配信の期限切れ',
  notification_expired: '対象回が終了済み',
  friend_not_following: 'ブロック・友だち解除',
  line_account_mismatch: 'LINEアカウントの不一致',
  line_account_inactive: 'LINEアカウントが停止中',
  operation_stopped: '緊急停止中（#745 より前の記録）',
};

export function webinarSkipReasonLabel(code: string | null): string {
  if (!code) return '理由の記録なし';
  return SKIP_REASON_LABELS[code] ?? code;
}

export interface WebinarSkipReasonCount {
  code: string | null;
  label: string;
  count: number;
}

export async function getWebinarNotificationOverview(
  db: D1Database,
  webinarId: string,
): Promise<{
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  skippedReasons: WebinarSkipReasonCount[];
  audience: { people: number; bookings: number; definition: 'active_registrations' };
}> {
  const [row, audience, reasons] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('queued','claimed','retry_wait') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status='permanent_failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
            SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM webinar_notification_jobs WHERE webinar_id=?`,
    ).bind(webinarId).first<Record<string, number | null>>(),
    db.prepare(
      `SELECT COUNT(DISTINCT friend_id) AS people, COUNT(*) AS bookings
         FROM webinar_registrations
        WHERE webinar_id=? AND status='active'`,
    ).bind(webinarId).first<{ people: number | null; bookings: number | null }>(),
    // 見送りの内訳。多い順に出して、いちばん件数の多い理由から目に入るようにする。
    db.prepare(
      `SELECT last_error_code AS code, COUNT(*) AS count
         FROM webinar_notification_jobs
        WHERE webinar_id=? AND status='skipped'
        GROUP BY last_error_code
        ORDER BY count DESC, code ASC`,
    ).bind(webinarId).all<{ code: string | null; count: number }>(),
  ]);
  return {
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    sent: row?.sent ?? 0,
    failed: row?.failed ?? 0,
    skipped: row?.skipped ?? 0,
    cancelled: row?.cancelled ?? 0,
    skippedReasons: (reasons.results ?? []).map((entry) => ({
      code: entry.code,
      label: webinarSkipReasonLabel(entry.code),
      count: Number(entry.count),
    })),
    audience: {
      people: audience?.people ?? 0,
      bookings: audience?.bookings ?? 0,
      definition: 'active_registrations',
    },
  };
}
