export { CalendarConnectionMissingError, getStaffCalendarConnection, clientForConnection, verifyStaffCalendarConnection } from './calendar-connection.js';
import { CalendarConnectionMissingError, getStaffCalendarConnection, clientForConnection, verifyStaffCalendarConnection } from './calendar-connection.js';
export type { StaffCalendarConnection } from './calendar-connection.js';
import type { StaffCalendarConnection } from './calendar-connection.js';
import { logger } from '@line-crm/shared/server';
import { BookingExternalCircuits } from './booking-external-circuits.js';
import { API_RETRY_WAIT } from '../../lib/external-call/index.js';
import { type Outcome } from '../../lib/external-call/types.js';
import { runBookingExternalStep, reconcileBookingExternalStep } from './booking-external-step.js';
import { calendarDirectionEnabled } from './calendar-switch-state.js';
import { readCalendarBusy } from './calendar-busy-read.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { GoogleCalendarClient, GoogleCalendarWriteError, type BusyInterval } from '../../services/google-calendar.js';
import {
  getGoogleServiceAccountToken,
  type GoogleServiceAccountCredentials,
} from '../../services/google-service-account.js';
import {
  findBookingOperation,
  finishBookingOperation,
  queueBookingOperation,
} from './booking-operation-runs.js';
import { getWorkflowStep, activeTenantLineAccountSql, accountFeatureOffExclusionSql } from '@line-crm/db';
import { featureJobCanRun, createFeatureJobGate } from '../../services/feature-enforcement.js';

export async function getStaffGoogleBusy(
  db: D1Database,
  credentials: GoogleServiceAccountCredentials,
  input: { lineAccountId: string; staffId: string; timeMin: string; timeMax: string; fresh?:boolean },
): Promise<BusyInterval[] | null> {
  return readCalendarBusy(db,credentials,input);
}

interface CalendarCreateSnapshot {
  calendarId: string;
  connectionId: string;
  version: number;
  event: { id: string; summary: string; description: string; start: string; end: string };
}
export class CalendarResultUnknownError extends Error {
  constructor() { super('delivery_unknown'); this.name = 'CalendarResultUnknownError'; }
}

/** 古い版の作成不明も、先に同じ接続先への読取りで照合する。新規POSTは出さない。 */
async function reconcileUnknownCalendarCreates(db: D1Database, credentials: GoogleServiceAccountCredentials,
  bookingId: string, accountId: string): Promise<boolean> {
  const rows = await db.prepare(`SELECT step_key,input_json FROM workflow_steps WHERE scope_id=?
    AND process_kind='booking_calendar_create' AND subject_id=? AND status='unknown'`)
    .bind(`line:${accountId}`,bookingId).all<{step_key:string;input_json:string}>();
  for(const row of rows.results ?? []) {
    const saved=JSON.parse(row.input_json) as {snapshot:CalendarCreateSnapshot};
    const connection=await db.prepare(`SELECT id,calendar_id,auth_type,access_token FROM google_calendar_connections
      WHERE id=? AND calendar_id=? AND line_account_id=? AND is_active=1`)
      .bind(saved.snapshot.connectionId,saved.snapshot.calendarId,accountId).first<StaffCalendarConnection>();
    if(!connection)return false;
    const client=await clientForConnection(connection,credentials,{db,accountId});
    const evidence=await reconcileBookingExternalStep<CalendarCreateSnapshot,{eventId:string;calendarId:string}>(db,
      {scopeId:`line:${accountId}`,processKind:'booking_calendar_create',subjectId:bookingId,stepKey:row.step_key},async snap=>{
        const event=await client.getEvent(snap.event.id);
        if(!event||event.id!==snap.event.id||event.summary!==snap.event.summary||event.description!==snap.event.description
          ||Date.parse(event.start?.dateTime??'')!==Date.parse(snap.event.start)
          ||Date.parse(event.end?.dateTime??'')!==Date.parse(snap.event.end))return {verified:false};
        return {verified:true,value:{eventId:snap.event.id,calendarId:snap.calendarId}};
      });
    if(!evidence)return false;
  }
  return true;
}

/** 外部作成の前に日時・対象・固定IDを保存する。不明時はGET照合のみで再開する。 */
export async function syncConfirmedBookingToGoogle(
  db: D1Database, credentials: GoogleServiceAccountCredentials, bookingId: string, recoveryEventId?: string,
): Promise<{ synced: boolean; eventId?: string; calendarId?: string }> {
  const row = await db.prepare(`SELECT b.line_account_id,b.staff_id,b.lock_version,b.starts_at,b.ends_at,
    b.customer_note,b.external_event_id,b.external_calendar_id,
    COALESCE(f.display_name,bc.display_name) AS customer_name,m.name AS menu_name,
    s.display_name AS staff_name,gc.id,gc.calendar_id,gc.auth_type,gc.access_token
    FROM bookings b LEFT JOIN friends f ON f.id=b.friend_id
    LEFT JOIN booking_customers bc ON bc.id=b.booking_customer_id
    JOIN menus m ON m.id=b.menu_id JOIN staff s ON s.id=b.staff_id
    LEFT JOIN google_calendar_connections gc ON gc.line_account_id=b.line_account_id AND gc.staff_id=b.staff_id AND gc.is_active=1
    WHERE b.id=? AND b.status='confirmed'`).bind(bookingId).first<{
      line_account_id: string; staff_id: string; lock_version: number; starts_at: string; ends_at: string;
      customer_note: string | null; external_event_id: string | null; external_calendar_id: string | null;
      customer_name: string | null; menu_name: string; staff_name: string;
      id: string | null; calendar_id: string | null; auth_type: string | null; access_token: string | null;
    }>();
  if (!row || !await calendarDirectionEnabled(db, row.line_account_id, row.staff_id, 'write')
    || !row.id || !row.calendar_id || !row.auth_type) return { synced: false };
  if (!await reconcileUnknownCalendarCreates(db,credentials,bookingId,row.line_account_id)) throw new CalendarResultUnknownError();
  const storedCreate = await getWorkflowStep(db,{scopeId:`line:${row.line_account_id}`,processKind:'booking_calendar_create',subjectId:bookingId,stepKey:`create:v${row.lock_version}`});
  const storedSnapshot = storedCreate?.input_json ? (JSON.parse(storedCreate.input_json) as {snapshot:CalendarCreateSnapshot}).snapshot : null;
  const eventId = storedSnapshot?.event.id ?? recoveryEventId ?? `lh${Array.from(new TextEncoder().encode(`${bookingId}:v${row.lock_version}`)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  // 旧予定を勝手に別の操作へ付け替えない。変更時の削除は専用の段を通す。
  if (row.external_event_id && row.external_event_id !== eventId) return { synced: false };
  const ref = { scopeId: `line:${row.line_account_id}`, processKind: 'booking_calendar_create', subjectId: bookingId, stepKey: `create:v${row.lock_version}` };
  const client = await clientForConnection({ id: row.id, calendar_id: row.calendar_id, auth_type: row.auth_type, access_token: row.access_token }, credentials,{db,accountId:row.line_account_id});
  const snapshot: CalendarCreateSnapshot = { calendarId: row.calendar_id, connectionId: row.id, version: row.lock_version,
    event: { id: eventId, summary: `${row.menu_name}｜${row.customer_name ?? '予約'}`,
      description: `musubo予約（担当: ${row.staff_name}）\n予約ID: ${bookingId}`,
      start: row.starts_at, end: row.ends_at } };
  const reconciled = await reconcileBookingExternalStep<CalendarCreateSnapshot, { eventId: string; calendarId: string }>(db, ref,
    async saved => {
      // 認証済みの同じcalendarへのGETだけ。404・違う内容は確認できないので停止を保つ。
      if (saved.calendarId !== row.calendar_id || saved.connectionId !== row.id) return { verified: false };
      const existing = await client.getEvent(saved.event.id);
      if (!existing || existing.id !== saved.event.id || existing.summary !== saved.event.summary
        || existing.description !== saved.event.description
        || Date.parse(existing.start?.dateTime ?? '') !== Date.parse(saved.event.start)
        || Date.parse(existing.end?.dateTime ?? '') !== Date.parse(saved.event.end)) return { verified: false };
      return { verified: true, value: { eventId: saved.event.id, calendarId: saved.calendarId } };
    });
  if (reconciled) return { synced: true, ...reconciled };
  const now = Date.now();
  const outcome = await runBookingExternalStep(db, {
    ref, snapshot, legacyUnknown:!storedCreate&&row.external_event_id!==null,initialAttempts:!storedCreate&&row.external_event_id!==null?1:0,
    identity: { scope: { accountId: row.line_account_id, storeId: row.line_account_id,
      destination: 'google_calendar', connectionId: row.id }, operationId: `${bookingId}:calendar:v${row.lock_version}`,
      idempotencyKey: eventId, snapshotId: `${bookingId}:v${row.lock_version}`, effect: 'write' },
    policy: { category: 'api', maxAttempts: 1, timeoutMs: 10_000, deadlineAt: now + 86_400_000, wait: API_RETRY_WAIT },
    authorize: async saved => !!await db.prepare(`SELECT 1 ok FROM bookings b
      WHERE b.id=? AND b.line_account_id=? AND b.status='confirmed' AND b.lock_version=?
        AND (b.external_event_id IS NULL OR b.external_event_id=?)
        AND ${activeTenantLineAccountSql('b.line_account_id')}`).bind(bookingId, row.line_account_id, saved.version, saved.event.id).first()
      && await calendarDirectionEnabled(db, row.line_account_id, row.staff_id, 'write')
      && await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking calendar create' }),
    execute: async (signal, saved) => {
      try {
        const created = await client.createEvent(saved.event, signal);
        return created.eventId === saved.event.id ? { kind: 'success', value: { eventId: created.eventId, calendarId: saved.calendarId } }
          : { kind: 'unknown', reason: 'invalid_response' };
      } catch (error) { return calendarWriteFailure(error); }
    },
    statements: next => next.phase === 'started' ? [
      db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM bookings WHERE id=? AND line_account_id=?
        AND status='confirmed' AND lock_version=? AND (external_event_id IS NULL OR external_event_id=?))
        THEN 'true' ELSE 'booking_calendar_obsolete' END)`).bind(bookingId, row.line_account_id, row.lock_version, eventId),
      db.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, external_event_id=?,external_calendar_id=? WHERE id=? AND line_account_id=? AND lock_version=?`)
        .bind(eventId, row.calendar_id, bookingId, row.line_account_id, row.lock_version),
    ] : [],
  });
  if (outcome.kind === 'success') return { synced: true, ...outcome.value };
  if (outcome.kind === 'succeeded') return { synced: true, eventId, calendarId: row.calendar_id };
  if (outcome.kind === 'unknown') {
    if(!storedCreate&&row.external_event_id!==null&&await reconcileUnknownCalendarCreates(db,credentials,bookingId,row.line_account_id))return {synced:true,eventId,calendarId:row.calendar_id};
    throw new CalendarResultUnknownError();
  }
  throw new Error('calendar_create_stopped');
}

function calendarWriteFailure(error: unknown): Exclude<Outcome<never>, { kind: 'success' }> {
  if (error instanceof GoogleCalendarWriteError && error.status >= 400 && error.status < 500
    && ![408,409,429].includes(error.status)) return { kind: 'permanent', reason: 'http', status: error.status };
  return { kind: 'unknown', reason: 'network' };
}

/**
 * 取消時の Calendar 削除を台帳駆動で1回だけ確実に行う。
 *
 * 安定キー (`<bookingId>:google-calendar:delete`) で台帳行を1行に保つ。
 * - ずみ (succeeded/skipped) なら外部へ触らず返す (二重削除なし)。
 * - 消す物が無ければ skipped で閉じる (外部へ出ない)。
 * - 一時失敗は retry_wait で残し、次の取消再試行で同じ鍵で再実行する。
 * - 外部成功→台帳失敗の間は queued のまま残るため、再実行は相手先の
 *   410 (削除ずみ) を成功として回収する (deleteEvent が吸収する)。
 * 投げない (取消処理を壊さない)。DB自体が使えないときだけ投げる。
 */
/**
 * Calendar 削除の台帳の安定キー。取消の再送・cron が同じ1行に集まる。
 * キーの作り方はここだけに置く (route 側の先行登録と実行側でずらさない)。
 */
export function calendarDeleteIdempotencyKey(bookingId: string): string {
  return `${bookingId}:google-calendar:delete`;
}

/**
 * fence 成功後に台帳行を残す。
 *
 * 実行側 (runCalendarDeleteOperation) の作成・検索が初期 DB 失敗すると
 * retry_wait を返すだけで行が残らず、cron が回収できない。行さえあれば
 * 再送・cron のどちらでも拾えるため、取消フローはここで失敗を落とさず
 * 投げる (呼び出し側の取消再試行で回復できる)。INSERT OR IGNORE のため
 * 二重登録にならない。schema 変更は要らない。
 * 状態更新の直後ではなく fence 成功後に置く: 巻き戻した 409 の後に
 * queued 行が残ると cron が確定ずみの予定を消してしまう。
 */
export async function enqueueCalendarDeleteOperation(
  db: D1Database,
  input: { bookingId: string; lineAccountId: string },
): Promise<string> {
  return queueBookingOperation(db, {
    bookingId: input.bookingId,
    lineAccountId: input.lineAccountId,
    kind: 'google_calendar',
    idempotencyKey: calendarDeleteIdempotencyKey(input.bookingId),
    result: { direction: 'delete' },
  });
}

export async function runCalendarDeleteOperation(
  db: D1Database,
  input: {
    bookingId: string;
    lineAccountId: string;
    now?: Date;
    remove: () => Promise<void>;
  },
): Promise<'succeeded' | 'skipped' | 'retry_wait'> {
  const now = (input.now ?? new Date()).toISOString();
  const idempotencyKey = calendarDeleteIdempotencyKey(input.bookingId);
  try {
    const existing = await findBookingOperation(db, {
      lineAccountId: input.lineAccountId,
      idempotencyKey,
    });
    if (existing && (existing.status === 'succeeded' || existing.status === 'skipped')) {
      return existing.status;
    }
    const operationId = existing?.id ?? await queueBookingOperation(db, {
      bookingId: input.bookingId,
      lineAccountId: input.lineAccountId,
      kind: 'google_calendar',
      idempotencyKey,
      result: { direction: 'delete' },
    });
    const booking = await db.prepare(
      `SELECT external_event_id, status FROM bookings WHERE id = ?`,
    ).bind(input.bookingId).first<{ external_event_id: string | null; status: string | null }>();
    if (!booking?.external_event_id) {
      await finishBookingOperation(db, {
        id: operationId,
        status: 'skipped',
        completedAt: now,
        result: { direction: 'delete', reason: 'no_external_event' },
      });
      return 'skipped';
    }
    // 実行の直前に予約の状態を再確認する。409 で巻き戻した確定ずみの予約や、
    // 残留した古い queued 行の予定を消さない (原子的無効化の受け皿)。
    if (booking.status !== 'cancelled' && booking.status !== 'expired') {
      await finishBookingOperation(db, {
        id: operationId,
        status: 'skipped',
        completedAt: now,
        result: { direction: 'delete', reason: 'booking_not_cancelled' },
      });
      return 'skipped';
    }
    try {
      await input.remove();
    } catch (error) {
      await finishBookingOperation(db, {
        id: operationId,
        status: 'retry_wait',
        completedAt: now,
        errorCode: error instanceof CalendarResultUnknownError ? 'delivery_unknown' : error instanceof CalendarConnectionMissingError ? 'calendar_connection_missing' : 'calendar_delete_failed',
        result: { direction: 'delete' },
      });
      logger.error("services_booking_calendar_sync_failed");
      return 'retry_wait';
    }
    await finishBookingOperation(db, {
      id: operationId,
      status: 'succeeded',
      completedAt: now,
      result: { direction: 'delete' },
    });
    return 'succeeded';
  } catch (error) {
    logger.error("services_booking_calendar_sync_failed");
    return 'retry_wait';
  }
}

/**
 * 初回 200 の後に残った Calendar 削除を cron で自動回収する。
 *
 * 安定キーで1行のため二重実行にならず、相手先の 410 を成功として回収する。
 * 取得は opened_at の原子的な更新で行う (lease)。処理中に止まった worker
 * の行は opened_at が古くなれば再取得する。status は queued/retry_wait の
 * ままのため、スキーマ変更は要らない。
 */
export async function processPendingCalendarDeleteOperations(
  db: D1Database,
  input: {
    now?: Date;
    limit?: number;
    /** lease切れとみなす分数。未指定なら 10。 */
    staleAfterMinutes?: number;
    remove: (bookingId: string, lineAccountId: string) => Promise<void>;
  },
): Promise<{ processed: number; succeeded: number; retrying: number; skipped: number }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const staleCutoff = new Date(
    now.getTime() - (input.staleAfterMinutes ?? 10) * 60_000,
  ).toISOString();
  const limit = input.limit ?? 20;
  /*
   * 予約機能がオフのアカウントは claim もしない。
   *
   * claim してから判定すると opened_at を書き換えてしまい、オフ中でも
   * 状態が動く。候補を読むだけの SELECT を先に置き、機能が動いている
   * アカウントの行だけを claim する。オフの行は opened_at も status も
   * 変えず、Google Calendar も呼ばない。skipped 監査だけ残し、
   * 再オン後の tick でそのまま拾い直す。
   *
   * オフ判定は LIMIT を数える前に SQL で行う。読んでから弾くと、
   * オフの古い行が上限ぶん先頭を占めたままになり、後ろに並ぶ
   * 動作中アカウントの行が永久に処理されない。
   */
  const dueWhere = `kind = 'google_calendar'
        AND json_extract(result_json, '$.direction') = 'delete'
        AND status IN ('queued', 'retry_wait')
        AND (opened_at IS NULL OR opened_at < ?)`;
  const bookingOff = accountFeatureOffExclusionSql('booking_operation_runs.line_account_id', 'booking');
  const candidates = await db.prepare(
    `SELECT id, booking_id, line_account_id FROM booking_operation_runs
      WHERE ${dueWhere}
        AND NOT ${bookingOff}
      ORDER BY updated_at ASC LIMIT ?`,
  ).bind(staleCutoff, limit).all<{ id: string; booking_id: string; line_account_id: string }>();
  const result = { processed: 0, succeeded: 0, retrying: 0, skipped: 0 };
  const gate = createFeatureJobGate();
  /*
   * 止めた事実は監査に残す。行は読むだけで、状態は一切変えない。
   * 監査は日・アカウント・機能・job で1件にまとまるため、
   * アカウントごとに1行だけ読めば足りる。
   */
  const offOwners = await db.prepare(
    `SELECT DISTINCT line_account_id FROM booking_operation_runs
      WHERE ${dueWhere}
        AND ${bookingOff}
      ORDER BY line_account_id LIMIT ?`,
  ).bind(staleCutoff, limit).all<{ line_account_id: string }>();
  for (const owner of offOwners.results ?? []) {
    await gate.canRun(db, owner.line_account_id, 'booking', 'booking calendar delete retry');
  }
  const runnableIds: string[] = [];
  for (const candidate of candidates.results ?? []) {
    // カタログ既定や設定の壊れ方に備え、claim 前にもう一度だけ確かめる。
    if (await gate.canRun(db, candidate.line_account_id, 'booking', 'booking calendar delete retry')) {
      runnableIds.push(candidate.id);
    }
  }
  if (runnableIds.length === 0) return result;
  // claim 条件は候補と同じ述語を残す。別 worker が先に取った行は
  // ここで 0 行になり、二重に外部を呼ばない。
  const claimed = await db.prepare(
    `UPDATE booking_operation_runs SET opened_at = ?, updated_at = ?
      WHERE id IN (${sqlIdSet(runnableIds).sql})
        AND ${dueWhere}
        AND NOT ${bookingOff}
      RETURNING id, booking_id, line_account_id`,
  ).bind(nowIso, nowIso, ...(runnableIds.length ? sqlIdSet(runnableIds).binds : []), staleCutoff)
    .all<{ id: string; booking_id: string; line_account_id: string }>();
  for (const op of claimed.results ?? []) {
    result.processed++;
    const outcome = await runCalendarDeleteOperation(db, {
      bookingId: op.booking_id,
      lineAccountId: op.line_account_id,
      now,
      remove: () => input.remove(op.booking_id, op.line_account_id),
    });
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'skipped') result.skipped++;
    else result.retrying++;
  }
  return result;
}

/**
 * 予約内容変更・手動再試行の Google 同期キー。
 * 予約の版（lock_version）ごとに1行。同じ版への再送は同じ行に集まり、
 * 実行は「現在の予約状態をカレンダーへ反映する」だけなので冪等。
 */
export function calendarSyncIdempotencyKey(bookingId: string, lockVersion: number): string {
  return `${bookingId}:google-calendar:sync:v${lockVersion}`;
}

/** 削除も固定した相手IDで記録する。不明時はGETで「もう無い」ことだけを確認する。 */
export async function deleteBookingCalendarEvent(db: D1Database, input: {
  bookingId: string; lineAccountId: string; calendarId: string; eventId: string; connectionId: string;
  client: GoogleCalendarClient;
}): Promise<void> {
  const current = await db.prepare('SELECT lock_version,status FROM bookings WHERE id=? AND line_account_id=?')
    .bind(input.bookingId,input.lineAccountId).first<{lock_version:number;status:string}>();
  if (!current) throw new Error('calendar_booking_missing');
  const ref = {scopeId:`line:${input.lineAccountId}`,processKind:'booking_calendar_delete',subjectId:input.bookingId,
    stepKey:`delete:${input.calendarId}:${input.eventId}:v${current.lock_version}`};
  const snapshot={calendarId:input.calendarId,eventId:input.eventId,version:current.lock_version,status:current.status};
  const past=await db.prepare(`SELECT step_key,status FROM workflow_steps WHERE scope_id=? AND process_kind='booking_calendar_delete'
    AND subject_id=? AND json_extract(input_json,'$.snapshot.calendarId')=? AND json_extract(input_json,'$.snapshot.eventId')=?`)
    .bind(ref.scopeId,input.bookingId,input.calendarId,input.eventId).all<{step_key:string;status:string}>();
  for(const previous of past.results??[]) {
    if(previous.status==='succeeded')return;
    if(previous.status==='unknown') {
      const evidence=await reconcileBookingExternalStep<typeof snapshot,{deleted:true}>(db,{...ref,stepKey:previous.step_key},async saved=>
        await input.client.getEvent(saved.eventId)===null?{verified:true,value:{deleted:true}}:{verified:false});
      if(evidence)return;
      throw new CalendarResultUnknownError();
    }
  }
  const restored=await reconcileBookingExternalStep<typeof snapshot,{deleted:true}>(db,ref,async saved=>{
    if(saved.calendarId!==input.calendarId||saved.eventId!==input.eventId)return {verified:false};
    return await input.client.getEvent(saved.eventId)===null?{verified:true,value:{deleted:true}}:{verified:false};
  });
  if(restored)return;
  const now=Date.now();
  const outcome=await runBookingExternalStep(db,{
    ref,snapshot,
    identity:{scope:{accountId:input.lineAccountId,storeId:input.lineAccountId,destination:'google_calendar',connectionId:input.connectionId},
      operationId:`${input.bookingId}:delete:${input.eventId}`,snapshotId:input.eventId,idempotencyKey:input.eventId,effect:'write'},
    policy:{category:'api',maxAttempts:1,timeoutMs:10_000,deadlineAt:now+86_400_000,wait:API_RETRY_WAIT},
    authorize:async saved=>!!await db.prepare(`SELECT 1 ok FROM bookings b WHERE b.id=? AND b.line_account_id=?
      AND b.lock_version=? AND b.status=? AND b.external_event_id=? AND b.external_calendar_id=?
      AND ${activeTenantLineAccountSql('b.line_account_id')}`)
      .bind(input.bookingId,input.lineAccountId,saved.version,saved.status,saved.eventId,saved.calendarId).first()
      && await featureJobCanRun(db,{accountId:input.lineAccountId,featureId:'booking',job:'booking calendar delete'}),
    execute:async(signal,saved)=>{try{await input.client.deleteEvent(saved.eventId,signal);return {kind:'success',value:{deleted:true}};}
      catch(error){return calendarWriteFailure(error);}},
    statements:next=>next.phase==='started'?[db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM bookings
      WHERE id=? AND line_account_id=? AND lock_version=? AND status=? AND external_event_id=? AND external_calendar_id=?)
      THEN 'true' ELSE 'booking_calendar_delete_obsolete' END)`)
      .bind(input.bookingId,input.lineAccountId,current.lock_version,current.status,input.eventId,input.calendarId)]:[],
  });
  if(outcome.kind==='success'||outcome.kind==='succeeded')return;
  if(outcome.kind==='unknown')throw new CalendarResultUnknownError();
  throw new Error('calendar_delete_stopped');
}

/**
 * 外部カレンダー上の既存イベントを消す。
 * 接続の探索は「イベントを作ったカレンダー」基準にする。担当変更後は
 * bookings.staff_id が新しい担当を指すため、staff 基準の JOIN では
 * 旧カレンダーの接続を見つけられず、旧担当の予定が消せない。
 */
async function deleteExternalCalendarEvent(
  db: D1Database,
  credentials: GoogleServiceAccountCredentials,
  input: { bookingId: string; lineAccountId: string; externalCalendarId: string; externalEventId: string },
): Promise<'deleted' | 'connection_missing'> {
  const connection = await db.prepare(
    `SELECT id, calendar_id, auth_type, access_token
       FROM google_calendar_connections
      WHERE line_account_id = ? AND calendar_id = ? AND is_active = 1
      LIMIT 1`,
  ).bind(input.lineAccountId, input.externalCalendarId)
    .first<{ id: string; calendar_id: string; auth_type: string; access_token: string | null }>();
  if (!connection) return 'connection_missing';
  const client = await clientForConnection(connection, credentials,{db,accountId:input.lineAccountId});
  await deleteBookingCalendarEvent(db, { bookingId: input.bookingId, lineAccountId: input.lineAccountId,
    calendarId: input.externalCalendarId, eventId: input.externalEventId, connectionId: connection.id, client });
  return 'deleted';
}

/**
 * 「現在の予約状態」を Google カレンダーへ反映する台帳駆動の同期。
 *
 * - confirmed: 既存イベントがあれば消してから、今の担当のカレンダーへ作り直す
 *   （delete+create。担当変更のカレンダー移動と日時・メニュー変更を同じ形で処理）。
 * - cancelled/expired: 外部イベントを消す。
 * - それ以外の状態（requested 等）は触らず skipped。
 *
 * 台帳キーは lock_version ごと。外部反映の失敗で予約本体は巻き戻さず、
 * retry_wait を残して手動再試行・次回実行で回復する。
 */
export async function runBookingGoogleSync(
  db: D1Database,
  input: {
    bookingId: string;
    lineAccountId: string;
    credentials: GoogleServiceAccountCredentials;
    now?: Date;
    /** 既存の台帳行を再利用するときの行ID（手動再試行で失敗行を仕上げる）。 */
    operationId?: string;
  },
): Promise<'succeeded' | 'skipped' | 'retry_wait' | 'not_applicable'> {
  const now = (input.now ?? new Date()).toISOString();
  const booking = await db.prepare(
    `SELECT id, status, staff_id, external_event_id, external_calendar_id, lock_version
       FROM bookings WHERE id = ? AND line_account_id = ?`,
  ).bind(input.bookingId, input.lineAccountId)
    .first<{
      id: string;
      status: string;
      staff_id: string;
      external_event_id: string | null;
      external_calendar_id: string | null;
      lock_version: number;
    }>();
  if (!booking) return 'not_applicable';
  if (!await reconcileUnknownCalendarCreates(db,input.credentials,booking.id,input.lineAccountId)) return 'retry_wait';
  const idempotencyKey = calendarSyncIdempotencyKey(booking.id, Number(booking.lock_version ?? 0));
  const operationId = input.operationId ?? await queueBookingOperation(db, {
    bookingId: booking.id,
    lineAccountId: input.lineAccountId,
    kind: 'google_calendar',
    idempotencyKey,
    result: { direction: 'sync' },
  });
  if(booking.status==='confirmed'&&!await calendarDirectionEnabled(db,input.lineAccountId,booking.staff_id,'write')) {await finishBookingOperation(db,{id:operationId,status:'skipped',completedAt:now,result:{direction:'sync',reason:'calendar_write_disabled'}});return 'skipped';}
  // 成功ずみの同版は外部へ再実行しない。同日時再送の delete/create・UUID再採番を止める。
  // 失敗 (retry_wait 等) だけが回復対象。
  if (!input.operationId) {
    const existing = await findBookingOperation(db, {
      lineAccountId: input.lineAccountId,
      idempotencyKey,
    });
    if (existing && existing.status === 'succeeded') return 'succeeded';
  }
  try {
    if (booking.status === 'cancelled' || booking.status === 'expired') {
      if (booking.external_event_id && booking.external_calendar_id) {
        const deleted = await deleteExternalCalendarEvent(db, input.credentials, {
          bookingId: booking.id, lineAccountId: input.lineAccountId,
          externalCalendarId: booking.external_calendar_id,
          externalEventId: booking.external_event_id,
        });
        if (deleted === 'connection_missing') {
          // 実際には消せていない。成功にせず予定IDを保持したまま回復待ちに
          // 残し、再接続後の再試行・cron で消せる状態にする。
          await finishBookingOperation(db, {
            id: operationId, status: 'retry_wait', completedAt: now,
            errorCode: 'calendar_connection_missing',
            result: { direction: 'delete', reason: 'connection_missing' },
          });
          return 'retry_wait';
        }
      }
      await db.prepare(
        `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, external_event_id = NULL, external_calendar_id = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
          WHERE id = ? AND line_account_id=? AND lock_version=? AND external_event_id IS ?`,
      ).bind(booking.id,input.lineAccountId,booking.lock_version,booking.external_event_id).run();
      await finishBookingOperation(db, {
        id: operationId, status: 'succeeded', completedAt: now,
        result: { direction: 'delete' },
      });
      return 'succeeded';
    }
    if (booking.status !== 'confirmed') {
      await finishBookingOperation(db, {
        id: operationId, status: 'skipped', completedAt: now,
        result: { direction: 'sync', reason: 'booking_not_confirmed' },
      });
      return 'skipped';
    }
    // 同版の作成が確認済みなら、要約行の保存失敗や並行敗者のために消し直さない。
    const createdCheckpoint=await getWorkflowStep(db,{scopeId:`line:${input.lineAccountId}`,processKind:'booking_calendar_create',subjectId:booking.id,stepKey:`create:v${booking.lock_version}`});
    if(createdCheckpoint?.status==='succeeded'&&createdCheckpoint.input_json) {
      const saved=(JSON.parse(createdCheckpoint.input_json) as {snapshot:CalendarCreateSnapshot}).snapshot;
      if(saved.event.id===booking.external_event_id&&saved.calendarId===booking.external_calendar_id) {
        await finishBookingOperation(db,{id:operationId,status:'succeeded',completedAt:now,result:{direction:'sync',calendarSync:'synced',eventId:saved.event.id}});
        return 'succeeded';
      }
    }
    // confirmed: 旧イベントを消してから作り直す。
    if (booking.external_event_id && booking.external_calendar_id) {
      const deleted = await deleteExternalCalendarEvent(db, input.credentials, {
        bookingId: booking.id, lineAccountId: input.lineAccountId,
        externalCalendarId: booking.external_calendar_id,
        externalEventId: booking.external_event_id,
      });
      if (deleted === 'connection_missing') {
        // 旧予定を消せる接続が無いまま作り直すと、旧予定を追う術を失ったまま
        // 新しい予定が増える。旧IDを保持して回復待ちに残す。
        await finishBookingOperation(db, {
          id: operationId, status: 'retry_wait', completedAt: now,
          errorCode: 'calendar_connection_missing',
          result: { direction: 'sync', reason: 'connection_missing' },
        });
        return 'retry_wait';
      }
      await db.prepare(
        `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, external_event_id = NULL, external_calendar_id = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
          WHERE id = ? AND line_account_id=? AND lock_version=? AND external_event_id IS ?`,
      ).bind(booking.id,input.lineAccountId,booking.lock_version,booking.external_event_id).run();
    }
    const version=await db.prepare('SELECT lock_version FROM bookings WHERE id=? AND line_account_id=?').bind(booking.id,input.lineAccountId).first<{lock_version:number}>();
    if(version?.lock_version!==booking.lock_version){
      await finishBookingOperation(db,{id:operationId,status:'skipped',completedAt:now,result:{direction:'sync',reason:'booking_changed'}});
      return 'skipped';
    }
    const synced = await syncConfirmedBookingToGoogle(db, input.credentials, booking.id);
    await finishBookingOperation(db, {
      id: operationId,
      status: synced.synced ? 'succeeded' : 'skipped',
      completedAt: now,
      result: {
        direction: 'sync',
        calendarSync: synced.synced ? 'synced' : 'not_configured',
        eventId: synced.eventId ?? null,
      },
    });
    return synced.synced ? 'succeeded' : 'skipped';
  } catch (error) {
    await finishBookingOperation(db, {
      id: operationId,
      status: 'retry_wait',
      completedAt: now,
      errorCode: error instanceof CalendarResultUnknownError ? 'delivery_unknown' : 'calendar_sync_failed',
      result: { direction: 'sync' },
    }).catch(() => undefined);
    logger.error("services_booking_calendar_sync_failed");
    return 'retry_wait';
  }
}

/**
 * 台帳駆動の Calendar 削除で呼ぶ「外部予定を消す」処理。
 *
 * 接続の探索は「イベントを作ったカレンダー」基準にする (担当変更で
 * bookings.staff_id が変わっても旧カレンダーの接続を見つけられる)。
 * 消す対象があるのに接続が無い・無効なときは静かに返さず
 * CalendarConnectionMissingError を投げる。呼び出し側の台帳が
 * retry_wait に残り、再接続後の取消再送・cron で削除を再試行できる。
 */
export async function removeBookingFromGoogle(
  db: D1Database,
  credentials: GoogleServiceAccountCredentials,
  bookingId: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT b.line_account_id,b.external_event_id, b.external_calendar_id,
              gc.id, gc.auth_type, gc.access_token
         FROM bookings b
         LEFT JOIN google_calendar_connections gc
           ON gc.calendar_id = b.external_calendar_id
          AND gc.line_account_id = b.line_account_id
          AND gc.is_active = 1
        WHERE b.id = ?`,
    )
    .bind(bookingId)
    .first<{
      line_account_id: string;
      external_event_id: string | null;
      external_calendar_id: string | null;
      id: string | null;
      auth_type: string | null;
      access_token: string | null;
    }>();
  if (!row?.external_event_id || !row.external_calendar_id) return;
  if (!await reconcileUnknownCalendarCreates(db,credentials,bookingId,row.line_account_id)) throw new CalendarResultUnknownError();
  if (!row.id || !row.auth_type) throw new CalendarConnectionMissingError();
  const client = await clientForConnection({
    id: row.id,
    calendar_id: row.external_calendar_id,
    auth_type: row.auth_type,
    access_token: row.access_token,
  }, credentials,{db,accountId:row.line_account_id});
  await deleteBookingCalendarEvent(db, { bookingId, lineAccountId: row.line_account_id,
    calendarId: row.external_calendar_id, eventId: row.external_event_id, connectionId: row.id, client });
}
