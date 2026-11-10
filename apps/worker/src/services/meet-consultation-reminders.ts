import { jstCalendar as japanCalendar } from '@line-crm/shared';
export type { MeetReminderKind, RegisterMeetConsultationInput, MeetReminderSchedule } from './meet-reminder-types.js';
import type { MeetReminderKind, RegisterMeetConsultationInput, MeetReminderSchedule } from './meet-reminder-types.js';
import { persistMeetGeneration } from './meet-notification-generations.js';
import { logger } from '@line-crm/shared/server';
import { deliverBookingLine, BookingLineDeliveryIncomplete } from '../features/booking/booking-line-delivery/index.js';
import type { HarnessProxyDispatch } from './line-proxy-send.js';
import { pushViaHarnessProxy } from './line-proxy-send.js';
import {
  activeTenantLineAccountSql,
  isOperationCapabilityStopped,
  resolveLineCredential,
  type V6WriteGuard,
} from '@line-crm/db';

import { stoppedTenantLineAccountSql } from './tenant-runtime-status.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { cancelByTrigger, enrollByTrigger, reconcileV6ToStartsAt } from './reminder-trigger.js';

export interface CancelMeetConsultationOptions {
  failOnSendInFlight?: boolean;
  /** 行が見た版と違うときは何も変えず false (古い補償が勝者を消さない)。無いときは従来どおり無条件。 */
  expectedBookingId?: string | null;
  expectedBookingVersion?: number | null;
}

export interface MeetReminderDeliveryOptions {
  now: Date;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
}

interface MeetConsultationRow {
  id: string;
  external_event_id: string;
  friend_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  meet_url: string;
  status: 'confirmed' | 'cancelled' | 'completed';
  booking_id: string | null;
  booking_version: number | null;
  schedule_revision: number;
}

interface DueMeetReminderRow {
  id: string;
  consultation_id: string;
  kind: MeetReminderKind;
  retry_count: number;
  last_error: string | null;
  title: string;
  starts_at: string;
  meet_url: string;
  line_user_id: string;
  line_account_id: string;
  channel_access_token: string;
  channel_access_token_encrypted: string | null;
  /** pushする候補の写し。認証・送信awaitの後の再確認はこの写しと一致させる。 */
  snapshot_booking_id: string | null;
  snapshot_booking_version: number | null;
  snapshot_friend_id: string;
  snapshot_schedule_revision: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_RETRY = 3;
const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(?:[/?#].*)?$/i;

// 結び付き予約の生存条件 (due選択と送信直前再確認で同一にする)。
// 版なし旧相談は従来どおり通す。日時は正規化比較する。

const LINKED_BOOKING_ALIVE_SQL = `(
  c.booking_id IS NULL
  OR EXISTS (
    SELECT 1 FROM bookings live_booking
    WHERE live_booking.id = c.booking_id
      AND live_booking.line_account_id = (
        SELECT f.line_account_id FROM friends f WHERE f.id = c.friend_id
      )
      AND live_booking.friend_id = c.friend_id
      AND live_booking.status IN ('requested','confirmed')
      AND live_booking.lock_version = c.booking_version
      AND datetime(live_booking.starts_at) = datetime(c.starts_at)
  )
)`;


// due読取時の候補写しと一致させる条件。相談と予約が両方新版へ進むと
// 現在同士の一致だけでは旧行の日時・URL・宛先で送れるため、写しとの
// 一致も求める。認証await・送信awaitの後の再確認に付ける。
// push呼出しとの間に await は挟まない (呼出し自体の間の取消は残差)。
function candidateSnapshotSql(): string {
  return `AND c.schedule_revision=? AND (c.booking_id = ? OR (c.booking_id IS NULL AND ? IS NULL))
      AND (c.booking_version = ? OR (c.booking_version IS NULL AND ? IS NULL))
      AND datetime(c.starts_at) = datetime(?)
      AND c.friend_id = ?`;
}

function candidateSnapshotBinds(row: DueMeetReminderRow): unknown[] {
  return [
    row.snapshot_schedule_revision??0,
    row.snapshot_booking_id,
    row.snapshot_booking_id,
    row.snapshot_booking_version,
    row.snapshot_booking_version,
    row.starts_at,
    row.snapshot_friend_id,
  ];
}

// 更新対象は読み取った世代そのもの。同じ相談の新しい世代へは触れない。
function snapshotGuardExists(): string {
  return `AND EXISTS (
    SELECT 1 FROM meet_consultation_notification_runs snap
     WHERE snap.consultation_id = ? AND snap.id=meet_consultation_notification_runs.id AND snap.schedule_revision=?
       AND (snap.booking_id = ? OR (snap.booking_id IS NULL AND ? IS NULL))
       AND (snap.booking_version = ? OR (snap.booking_version IS NULL AND ? IS NULL))
       AND datetime(snap.starts_at) = datetime(?)
       AND snap.friend_id = ?
  )`;
}

function snapshotGuardBinds(row: DueMeetReminderRow): unknown[] {
  return [row.consultation_id, ...candidateSnapshotBinds(row)];
}

function normalizeDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid ISO datetime`);
  return date;
}

export function calculateMeetReminderSchedule(
  startsAt: string,
  now: Date,
): MeetReminderSchedule[] {
  const start = normalizeDate(startsAt, 'startsAt');
  const startMs = start.getTime();
  const nowMs = now.getTime();
  if (startMs <= nowMs) return [];

  const schedules: MeetReminderSchedule[] = [];
  const untilStart = startMs - nowMs;

  // 24時間以内に確定した予定は、前日通知を次のcronで即時送信する。
  // 開始1時間以内なら同時に2通送らず、1時間前通知だけにまとめる。
  if (untilStart > HOUR_MS) {
    schedules.push({
      kind: 'day_before',
      scheduledAt: new Date(Math.max(startMs - DAY_MS, nowMs)).toISOString(),
    });
  }
  schedules.push({
    kind: 'hour_before',
    scheduledAt: new Date(Math.max(startMs - HOUR_MS, nowMs)).toISOString(),
  });
  return schedules;
}

export function renderMeetReminderText(_kind: MeetReminderKind, startsAt: string, meetUrl: string): string {
  const start = normalizeDate(startsAt, 'startsAt');
  const jst = japanCalendar(start);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const iso = jst.toISOString();
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const time = iso.slice(11, 16);
  const dateLabel = `${month}月${day}日（${weekdays[jst.getUTCDay()]}）${time}`;
  // 通知種別は送信予定であり、実際の配信日や残り時間を保証しない。
  // 当日登録・日跨ぎ・遅延でも誤案内しないよう、JSTの日時を直接伝える。
  const lead = `${dateLabel}から`;

  return `【個別相談リマインド】\n${lead}、Google Meetで個別相談を予定しています。\n\nお時間になりましたら、こちらからご参加ください。\n${meetUrl}\n\nよろしくお願いいたします！`;
}

export async function registerMeetConsultation(
  db: D1Database,
  input: RegisterMeetConsultationInput,
  now = new Date(),
): Promise<{ id: string; reminders: MeetReminderSchedule[]; updated: boolean }> {
  if (!input.externalEventId.trim()) throw new Error('externalEventId is required');
  if (!input.friendId.trim()) throw new Error('friendId is required');
  if (!input.title.trim()) throw new Error('title is required');
  if (!MEET_URL_RE.test(input.meetUrl)) throw new Error('meetUrl must be a Google Meet URL');

  const start = normalizeDate(input.startsAt, 'startsAt');
  const end = normalizeDate(input.endsAt, 'endsAt');
  if (end.getTime() <= start.getTime()) throw new Error('endsAt must be after startsAt');
  if (start.getTime() <= now.getTime()) throw new Error('startsAt must be in the future');

  const friend = await db
    .prepare('SELECT id, line_account_id,line_user_id FROM friends WHERE id = ? AND is_following = 1')
    .bind(input.friendId)
    .first<{ id: string; line_account_id: string | null;line_user_id:string }>();
  if (!friend) throw new Error('friend not found or not following');
  // 登録は店舗境界の中でだけ行う。所属不明では書かずに落とす。
  if (!friend.line_account_id) throw new Error('friend line account unknown');

  const existing = await db
    .prepare('SELECT * FROM meet_consultations WHERE external_event_id = ?')
    .bind(input.externalEventId)
    .first<MeetConsultationRow>();
  const normalizedStart=start.toISOString(), normalizedEnd=end.toISOString();
  const schedules=calculateMeetReminderSchedule(normalizedStart,now);
  const incomingVersion=input.bookingVersion??null;
  if(existing?.booking_version!=null && incomingVersion!==null && incomingVersion<existing.booking_version)
    return {id:existing.id,reminders:schedules,updated:false};
  const generation=await persistMeetGeneration(db,{...input,startsAt:normalizedStart,endsAt:normalizedEnd},
    {line_account_id:friend.line_account_id,line_user_id:friend.line_user_id},existing,schedules,now.toISOString());
  const consultationId=generation.id,writtenBookingId=input.bookingId??null;
  if(!generation.updated)return {id:consultationId,reminders:schedules,updated:false};
  // 共有 操作の直前の版の再確認。子の書込み後・各共有呼出しの前に
  // 勝者が上書きしていたら、その共有呼出しを出さず stale で終える。
  // 行と子は勝者の full pass がそろえるため、敗者は何も直さない。
  // 共有層に版条件を持てないため、確認→呼出しの窓は残差として記録する。
  const stillMine = async (): Promise<boolean> => {
    const current = await db
      .prepare('SELECT booking_id, booking_version, schedule_revision FROM meet_consultations WHERE id = ?')
      .bind(consultationId)
      .first<{ booking_id: string | null; booking_version: number | null; schedule_revision: number }>();
    return (
      !!current &&
      current.booking_id === writtenBookingId &&
      current.booking_version === incomingVersion && current.schedule_revision === generation.revision
    );
  };
  const staleResult = { id: consultationId, reminders: schedules, updated: false };

  // 個別相談の日程変更・再送を へ連動する。
  // 予約ルール (booking) を個別相談にも使い、sourceKind='meet' で追跡する。
  // 旧起点ではなく現在の開始時刻へ直す。途中失敗後の再送でも回復でき、
  // 友だち変更で旧友だちへ残った行もここで止める (新 friend だけ active)。
  // 移行前の行は個別相談が作っていないので探さない (同時刻の別予約へ触れない)。
  const v6Base = {
    triggerType: 'booking' as const,
    sourceKind: 'meet',
    sourceId: consultationId,
    sourceEventId: input.externalEventId,
    friendId: input.friendId,
    lineAccountId: friend.line_account_id,
    allowLegacyFallback: false,
  };
  const oldFriendId = existing?.friend_id ?? null;
  const friendChanged = oldFriendId !== null && oldFriendId !== input.friendId;
  // 新 friend 側にこの相談の active 行があるか。再送の判定に使う。
  // 初回も再送も 登録に失敗した再送では、相談行だけ新 friend へ進み
  // (friendChanged=false)、旧取消を先にすると新旧どちらの通知も消える。
  const newActive = await db.prepare(
    `SELECT COUNT(*) AS c FROM friend_reminders
      WHERE status = 'active' AND source_kind = 'meet' AND friend_id = ?
        AND (source_id = ? OR source_event_id = ?)`,
  ).bind(input.friendId, consultationId, input.externalEventId).first<{ c: number }>();
  // 新規成功後に旧取消: 新 friend 側の行が無いときは登録を先に行い、
  // 失敗は投げる (旧行に触る前に終えるため旧通知が残り、再送で回復できる)。
  // 共有 書込みにも版ガードを付ける。確認→呼出しの間に勝者が動いても
  // 共有側の各文が 0 件になり、新版の通知予定を変えない。ガードで止まった
  // 書込みは後の stillMine で stale にまとめる。
  const v6Guard = meetWriteGuard(
    consultationId, writtenBookingId, incomingVersion, null, true, generation.revision,
  );
  const mustEnrollFirst = friendChanged || (oldFriendId !== null && (newActive?.c ?? 0) === 0);
  if (mustEnrollFirst) {
    // 新側の日付ずれだけ先に直す (旧側には触れない)。無いときは何もしない。
    if (!(await stillMine())) return staleResult;
    await reconcileV6ToStartsAt(db, {
      triggerType: v6Base.triggerType,
      sourceKind: v6Base.sourceKind,
      sourceId: v6Base.sourceId,
      sourceEventId: v6Base.sourceEventId,
      friendId: v6Base.friendId,
      startsAtIso: normalizedStart,
      leaveOtherFriends: true,
      writeGuard: v6Guard,
    });
    if (!(await stillMine())) return staleResult;
    try {
      await enrollByTrigger(db, {
        ...v6Base,
        startsAtIso: normalizedStart,
        writeGuard: v6Guard,
      });
    } catch (error) {
      // ガードで止まった敗者は stale で終える (他は投げる)。
      if (!(error instanceof Error) || error.message !== 'V6_WRITE_GUARDED') throw error;
      return staleResult;
    }
  }
  if (!(await stillMine())) return staleResult;
  await reconcileV6ToStartsAt(db, {
    triggerType: v6Base.triggerType,
    sourceKind: v6Base.sourceKind,
    sourceId: v6Base.sourceId,
    sourceEventId: v6Base.sourceEventId,
    friendId: v6Base.friendId,
    startsAtIso: normalizedStart,
    writeGuard: v6Guard,
  });
  if (!mustEnrollFirst) {
    if (!(await stillMine())) return staleResult;
    // 登録失敗で相談登録自体を壊さない。二重登録は enroll 側で吸収する。
    // ガードで止まったときは V6_WRITE_GUARDED が飛ぶが、後の stillMine 相当として
    // ここでは吸収し、最後の再確認にまとめる (敗者は stale で終える)。
    await enrollByTrigger(db, {
      ...v6Base,
      startsAtIso: normalizedStart,
      writeGuard: v6Guard,
    }).catch((error) => {
      if (error instanceof Error && error.message === 'V6_WRITE_GUARDED') return;

      logger.error("meet_reminders.enroll_scenario_failed");
    });
  }
  // phase の後の最終確認。共有呼出しの間に勝者が動いていたら stale。
  if (!(await stillMine())) return staleResult;

  return { id: consultationId, reminders: schedules, updated: true };
}

/**
 * 共有 書込みへ渡す版ガードを組み立てる。親の版 (と登録なら confirmed、
 * 取消なら操作 uuid) が動いていたら共有側の各文は 0 件になる。
 */
function meetWriteGuard(
  consultationId: string,
  bookingId: string | null,
  bookingVersion: number | null,
  claimId: string | null,
  requireConfirmed: boolean,
  scheduleRevision?: number,
): V6WriteGuard {
  const conds = ['GuardMC.id = ?'];
  const binds: unknown[] = [consultationId];
  conds.push('(GuardMC.booking_id = ? OR (GuardMC.booking_id IS NULL AND ? IS NULL))');
  binds.push(bookingId, bookingId);
  conds.push('(GuardMC.booking_version = ? OR (GuardMC.booking_version IS NULL AND ? IS NULL))');
  binds.push(bookingVersion, bookingVersion);
  if(scheduleRevision!==undefined){conds.push('GuardMC.schedule_revision=?');binds.push(scheduleRevision);}
  if (requireConfirmed) conds.push(`GuardMC.status = 'confirmed'`);
  if (claimId !== null) {
    conds.push('GuardMC.cancel_claim_id = ?');
    binds.push(claimId);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM meet_consultations GuardMC WHERE ${conds.join(' AND ')})`,
    binds,
  };
}

/**
 * Meet相談の送信可否。共有送信路（reminder-delivery）から使う。
 * 版なし旧相談は従来どおり通す。結び付き予約の本人・状態・版・日時が
 * 一致しない古い版は送らない。相談行自体が confirmed でないときも送らない。
 */
export async function isMeetConsultationSendable(
  db: D1Database,
  consultationId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM meet_consultations c
        WHERE c.id = ? AND c.status = 'confirmed' AND ${LINKED_BOOKING_ALIVE_SQL}`,
    )
    .bind(consultationId)
    .first<{ ok: number }>();
  return !!row;
}

/** 送信の最終権利と結び付ける送信候補の写し。本文解決の前に読む。 */
export interface MeetSendCandidate {
  scheduleRevision?: number;
  bookingId: string | null;
  bookingVersion: number | null;
  startsAt: string;
  friendId: string;
}

export async function readMeetSendCandidate(
  db: D1Database,
  consultationId: string,
): Promise<MeetSendCandidate | null> {
  const row = await db
    .prepare(
      `SELECT booking_id, booking_version, starts_at, friend_id, schedule_revision
         FROM meet_consultations WHERE id = ?`,
    )
    .bind(consultationId)
    .first<{
      booking_id: string | null;
      booking_version: number | null;
      starts_at: string;
      friend_id: string;
      schedule_revision:number;
    }>();
  if (!row) return null;
  return {
    scheduleRevision:row.schedule_revision,
    bookingId: row.booking_id ?? null,
    bookingVersion: row.booking_version ?? null,
    startsAt: row.starts_at,
    friendId: row.friend_id,
  };
}

/**
 * 送信候補の写しが最終送信権の時点で今も有効か。結び付き予約の生存と
 * 写し一致を同一文で確かめる。新版が勝てば false になり、勝者の通知を残す。
 */
/**
 * 最終送信権の確定。認証・本文解決・beforePush・停止確認の待機を全て
 * 終えた後、送信権の行と候補の版を同じUPDATE文で結び直す。この後は
 * push呼出しまでawaitを置かない (呼出し自体の間の取消は残差)。
 * 戻り値: 'ok' 送ってよい / 'stale' 旧候補 (呼出し側が実行行を取り消す) /
 * 'stolen' 貸出が別処理へ移った (行に触らず見送る)。
 */
export async function assertFinalMeetSendRight(
  db: D1Database,
  input: {
    runId: string;
    friendReminderId: string;
    expectedTargetDate: string;
    ownedLeases: string[];
    candidate: MeetSendCandidate | null;
    leaseExpiresAt: string;
    nowIso: string;
  },
): Promise<'ok' | 'stale' | 'stolen'> {
  if (!input.candidate || input.ownedLeases.length === 0) return 'stale';
  const leaseList = input.ownedLeases.map(() => '?').join(',');
  const refreshed = await db
    .prepare(
      `UPDATE reminder_delivery_runs
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND status = 'claimed'
          AND lease_expires_at IN (${leaseList})
          AND EXISTS (
            SELECT 1 FROM friend_reminders fr
             WHERE fr.id = ?
               AND fr.status = 'active'
               AND fr.target_date = ?
          )
          AND EXISTS (
            SELECT 1 FROM meet_consultations c
             WHERE c.id = (
                 SELECT fr2.source_id FROM friend_reminders fr2 WHERE fr2.id = ?
               )
               AND c.status = 'confirmed'
               AND ${LINKED_BOOKING_ALIVE_SQL}
               ${candidateSnapshotSql()}
          )`,
    )
    .bind(
      input.leaseExpiresAt,
      input.nowIso,
      input.runId,
      ...input.ownedLeases,
      input.friendReminderId,
      input.expectedTargetDate,
      input.friendReminderId,
      input.candidate.scheduleRevision??0,
      input.candidate.bookingId,
      input.candidate.bookingId,
      input.candidate.bookingVersion,
      input.candidate.bookingVersion,
      input.candidate.startsAt,
      input.candidate.friendId,
    )
    .run();
  if ((refreshed.meta?.changes ?? 0) === 1) return 'ok';
  // 0件のとき、貸出が自分のままなら旧候補。別処理へ移っていたら触らない。
  const mine = await db
    .prepare(
      `SELECT status, lease_expires_at FROM reminder_delivery_runs WHERE id = ?`,
    )
    .bind(input.runId)
    .first<{ status: string; lease_expires_at: string | null }>();
  if (
    mine?.status === 'claimed' &&
    mine.lease_expires_at !== null &&
    input.ownedLeases.includes(mine.lease_expires_at)
  ) {
    return 'stale';
  }
  return 'stolen';
}

export async function isMeetSendCandidateCurrent(
  db: D1Database,
  consultationId: string,
  candidate: MeetSendCandidate | null,
): Promise<boolean> {
  if (!candidate) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM meet_consultations c
        WHERE c.id = ? AND c.status = 'confirmed'
          AND ${LINKED_BOOKING_ALIVE_SQL}
          AND (c.booking_id = ? OR (c.booking_id IS NULL AND ? IS NULL))
          AND (c.booking_version = ? OR (c.booking_version IS NULL AND ? IS NULL))
          AND datetime(c.starts_at) = datetime(?)
          AND c.friend_id = ? AND c.schedule_revision=?`,
    )
    .bind(
      consultationId,
      candidate.bookingId,
      candidate.bookingId,
      candidate.bookingVersion,
      candidate.bookingVersion,
      candidate.startsAt,
      candidate.friendId,candidate.scheduleRevision??0,
    )
    .first<{ ok: number }>();
  return !!row;
}

export async function cancelMeetConsultation(
  db: D1Database,
  externalEventId: string,
  now = new Date(),
  options?: CancelMeetConsultationOptions,
): Promise<boolean> {
  const consultation = await db
    .prepare(
      `SELECT c.id, c.friend_id, c.starts_at, c.status, c.booking_id, c.booking_version, c.schedule_revision,
              f.line_account_id
         FROM meet_consultations c
         LEFT JOIN friends f ON f.id = c.friend_id
        WHERE c.external_event_id = ?`,
    )
    .bind(externalEventId)
    .first<{
      id: string;
      friend_id: string;
      starts_at: string;
      status: 'confirmed' | 'cancelled' | 'completed';
      booking_id: string | null;
      booking_version: number | null;
      schedule_revision: number;
      line_account_id: string | null;
    }>();
  if (!consultation) return false;
  // 版フェンス: 期待と違う版の行は古い補償の対象外。何も変えず false。
  // (同じ予定IDの後発の勝者を敗者が取り消せない)。期待なしは従来どおり無条件。
  if (
    options?.expectedBookingVersion !== undefined &&
    options.expectedBookingVersion !== consultation.booking_version
  ) {
    return false;
  }
  if (
    options?.expectedBookingId !== undefined &&
    options.expectedBookingId !== consultation.booking_id
  ) {
    return false;
  }
  const nowIso = now.toISOString();
  // 行の確定と操作所有権の主張を同じ文で勝ち取る。SELECT 後に勝者が
  // 上書きしていたら 0 件になり、・通知には触らず false (敗者は何も壊さない)。
  // 同版の別操作も uuid が違うため、後で戻すときに区別できる。
  const claimId = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE meet_consultations SET confirmation_revision = confirmation_revision + 1, status='cancelled', cancel_claim_id=?, updated_at=?
        WHERE id=?
          AND (booking_version = ? OR (booking_version IS NULL AND ? IS NULL))
          AND (booking_id = ? OR (booking_id IS NULL AND ? IS NULL)) AND schedule_revision=?`,
    )
    .bind(
      claimId,
      nowIso,
      consultation.id,
      consultation.booking_version,
      consultation.booking_version,
      consultation.booking_id,
      consultation.booking_id,consultation.schedule_revision,
    )
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return false;
  // の前の版＋操作の再確認。claim から の間に勝者が上書きしていたら、
  // ・子には触らず false (敗者は何も壊さない)。行は勝者のものが残る。
  // 同版の別操作の claim 上書きも uuid で検出する。
  const beforeV6 = await db
    .prepare(
      'SELECT booking_id, booking_version, cancel_claim_id FROM meet_consultations WHERE id = ?',
    )
    .bind(consultation.id)
    .first<{ booking_id: string | null; booking_version: number | null; cancel_claim_id: string | null }>();
  if (
    !beforeV6 ||
    beforeV6.booking_id !== consultation.booking_id ||
    beforeV6.booking_version !== consultation.booking_version ||
    beforeV6.cancel_claim_id !== claimId
  ) {
    return false;
  }
  // の未送信予定だけを止める。送信済み履歴は残す。
  // 再送は active が無いため 0 件で返す。移行前の行は探さない。
  // 共有取消にも版＋操作ガードを付け、前確認→呼出しの間に勝者が動いても
  // 共有側の各文が 0 件になり、新版の通知予定を変えない。
  const cancelGuard = meetWriteGuard(
    consultation.id,
    consultation.booking_id,
    consultation.booking_version,
    claimId,
    false,consultation.schedule_revision,
  );
  try {
    await cancelByTrigger(db, {
      triggerType: 'booking',
      sourceKind: 'meet',
      sourceId: consultation.id,
      sourceEventId: externalEventId,
      friendId: consultation.friend_id,
      startsAtIso: consultation.starts_at,
      lineAccountId: consultation.line_account_id,
      cancelReason: `meet_cancel:${externalEventId}:by:admin`,
      allowLegacyFallback: false,
      failOnSendInFlight: options?.failOnSendInFlight,
      writeGuard: cancelGuard,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
      // 409 では行の確定も戻す (自分の操作 uuid のときだけ。主張も消す)。
      // 同版の別操作が上書きずみなら 0 件になり、後発の cancelled を残す。
      // 再送で回復できる。
      await db
        .prepare(
          `UPDATE meet_consultations SET confirmation_revision = confirmation_revision + 1, status=?, cancel_claim_id=NULL, updated_at=?
            WHERE id=? AND status='cancelled' AND cancel_claim_id=?`,
        )
        .bind(consultation.status, nowIso, consultation.id, claimId)
        .run();
    }
    throw error;
  }
  // の後の最終確認。共有呼出しの間に勝者が動いていたら false。
  // 書けた分は正当な接頭辞 (版が自分の間に通った文だけ) として残す。
  const afterV6 = await db
    .prepare(
      'SELECT booking_id, booking_version, cancel_claim_id FROM meet_consultations WHERE id = ?',
    )
    .bind(consultation.id)
    .first<{ booking_id: string | null; booking_version: number | null; cancel_claim_id: string | null }>();
  if (
    !afterV6 ||
    afterV6.booking_id !== consultation.booking_id ||
    afterV6.booking_version !== consultation.booking_version ||
    afterV6.cancel_claim_id !== claimId
  ) {
    return false;
  }
  // 子の取消も親の版＋操作と結び付ける。の間に勝者が来ていたら 0 件になり、
  // 勝者の未来通知を残す。同版の別操作の claim 上書きもここで止まる。
  await db
    .prepare(
      `UPDATE meet_consultation_notification_runs
          SET status='cancelled', updated_at=?
        WHERE consultation_id=? AND status IN ('pending','failed')
          AND EXISTS (
            SELECT 1 FROM meet_consultations guard
             WHERE guard.id = ?
               AND (guard.booking_id = ? OR (guard.booking_id IS NULL AND ? IS NULL))
               AND (guard.booking_version = ? OR (guard.booking_version IS NULL AND ? IS NULL))
               AND guard.cancel_claim_id = ?
          )`,
    )
    .bind(
      nowIso,
      consultation.id,
      consultation.id,
      consultation.booking_id,
      consultation.booking_id,
      consultation.booking_version,
      consultation.booking_version,
      claimId,
    )
    .run();
  return true;
}

export async function processDueMeetConsultationReminders(
  db: D1Database,
  options: MeetReminderDeliveryOptions,
): Promise<{ sent: number; failed: number }> {
  const nowIso = options.now.toISOString();
  await db.prepare(
    `UPDATE meet_consultation_notification_runs
        SET status='cancelled', last_error='tenant_suspended', updated_at=?
      WHERE status IN ('pending','failed')
        AND scheduled_at <= ?
        AND EXISTS (
          SELECT 1
            FROM meet_consultations stopped_consultation
            JOIN friends stopped_friend ON stopped_friend.id=stopped_consultation.friend_id
           WHERE stopped_consultation.id=meet_consultation_notification_runs.consultation_id
             AND ${stoppedTenantLineAccountSql('stopped_friend.line_account_id')}
        )`,
  ).bind(nowIso, nowIso).run();
  const due = await db
    .prepare(
      `SELECT r.id, r.consultation_id, r.kind, r.retry_count, r.last_error,
              c.title, c.starts_at, c.meet_url,
              r.schedule_revision AS snapshot_schedule_revision,
              c.booking_id AS snapshot_booking_id,
              c.booking_version AS snapshot_booking_version,
              c.friend_id AS snapshot_friend_id,
              f.line_user_id, f.line_account_id, la.channel_access_token,
              la.channel_access_token_encrypted
         FROM meet_consultation_notification_runs r
         INNER JOIN meet_consultations c ON c.id = r.consultation_id
         INNER JOIN friends f ON f.id = c.friend_id
         INNER JOIN line_accounts la ON la.id = f.line_account_id
        WHERE r.status IN ('pending','failed')
          AND r.retry_count < ?
          AND r.scheduled_at <= ?
          AND c.status = 'confirmed' AND r.schedule_revision=c.schedule_revision
          AND r.friend_id=c.friend_id AND r.recipient_id=f.line_user_id AND r.line_account_id=f.line_account_id
          AND julianday(r.starts_at)=julianday(c.starts_at) AND r.meet_url=c.meet_url
          AND c.starts_at > ?
          AND f.is_following = 1
          AND la.is_active = 1
          AND ${activeTenantLineAccountSql('f.line_account_id')}
          AND NOT EXISTS (
            SELECT 1 FROM bookings dead_booking
            WHERE dead_booking.external_event_id = c.external_event_id
              AND dead_booking.line_account_id = f.line_account_id
              AND dead_booking.status IN ('cancelled','expired')
          )
          AND ${LINKED_BOOKING_ALIVE_SQL}
        ORDER BY r.scheduled_at ASC
        LIMIT 100`,
    )
    .bind(MAX_RETRY, nowIso, nowIso)
    .all<DueMeetReminderRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    // 機能オフ中は送らずpendingのまま残す。再オンで再開する。
    if (row.line_account_id && !await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'meet consultation reminders' })) {
      continue;
    }
    // 緊急停止 : reminder_dispatch が止まっている統括は行に触れず
    // pending のまま残す。復旧すれば次の cron が拾う。
    if (await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')) {
      continue;
    }
    // 取消と配信の競合対策: 送る直前に相談の状態を確かめ、取消済みなら送らない。
    // 結び付く予約の版・日時・本人・状態も due 選択と同一条件で確かめる。
    // さらに due 時の候補写しとも一致させる (両方新版へ進んだ旧行は送らない)。
    const live = await db
      .prepare(
        `SELECT c.status AS status FROM meet_consultations c
          WHERE c.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM bookings dead_booking
              WHERE dead_booking.external_event_id = c.external_event_id
                AND dead_booking.status IN ('cancelled','expired')
            )
            AND ${LINKED_BOOKING_ALIVE_SQL}
            ${candidateSnapshotSql()}`,
      )
      .bind(row.consultation_id, ...candidateSnapshotBinds(row))
      .first<{ status: string }>();
    if (!live || live.status !== 'confirmed') {
      // 候補写しと違う旧行は整理する。新版へ再利用ずみなら 0 件で残す。
      await db
        .prepare(
          `UPDATE meet_consultation_notification_runs
              SET status='cancelled', updated_at=?
            WHERE id=? AND status IN ('pending','failed','cancelled')
              ${snapshotGuardExists()}`,
        )
        .bind(nowIso, row.id, ...snapshotGuardBinds(row))
        .run();
      continue;
    }
    let deliveryPrepared = false;
    try {
      const text = renderMeetReminderText(row.kind, row.starts_at, row.meet_url);
      const accessToken = await resolveLineCredential(
        row.channel_access_token_encrypted,
        row.channel_access_token,
        { lineAccountId: row.line_account_id, field: 'channel_access_token' },
      );
      // 取消と送信の競合対策: push の直前にもう一度だけ確かめる。
      // この後 push まで待たない (間に取消が入る余地を残さない)。
      // 版・日時・本人・状態は due 選択と同一条件で結び付ける。
      // 認証await中の更新も含め、候補写しと違う旧行はここで止める。
      const liveBeforePush = await db
        .prepare(
          `SELECT c.status AS status FROM meet_consultations c
            WHERE c.id = ?
              AND NOT EXISTS (
                SELECT 1 FROM bookings dead_booking
                WHERE dead_booking.external_event_id = c.external_event_id
                  AND dead_booking.status IN ('cancelled','expired')
              )
              AND ${LINKED_BOOKING_ALIVE_SQL}
              ${candidateSnapshotSql()}`,
        )
        .bind(row.consultation_id, ...candidateSnapshotBinds(row))
        .first<{ status: string }>();
      if (!liveBeforePush || liveBeforePush.status !== 'confirmed') {
        // 候補写しと違う旧行は整理する。新版へ再利用ずみなら 0 件で残す。
        await db
          .prepare(
            `UPDATE meet_consultation_notification_runs
                SET status='cancelled', updated_at=?
              WHERE id=? AND status IN ('pending','failed')
                ${snapshotGuardExists()}`,
          )
          .bind(nowIso, row.id, ...snapshotGuardBinds(row))
          .run();
        continue;
      }
      deliveryPrepared = true;
      await deliverBookingLine(db, {
        accountId: row.line_account_id, operationId: `meet-reminder:${row.id}`,
        retryKey: row.id, snapshot: { to: row.line_user_id, text, startsAt: row.starts_at,
          bookingId: row.snapshot_booking_id, version: row.snapshot_booking_version, friendId: row.snapshot_friend_id },
        deadlineAt: Date.parse(row.starts_at), maxAttempts: MAX_RETRY, initialAttempts: row.retry_count,
        legacyUnknown: row.retry_count > 0 && row.last_error !== 'notification_preflight_failed',
        now: () => options.now.getTime(),
        authorize: async saved => saved.startsAt === row.starts_at && saved.friendId === row.snapshot_friend_id
          && !await isOperationCapabilityStopped(db,row.line_account_id,'reminder_dispatch')
          && !!await db.prepare(`SELECT 1 ok FROM meet_consultations c WHERE c.id=? AND c.status='confirmed'
            AND ${LINKED_BOOKING_ALIVE_SQL} ${candidateSnapshotSql()}
            AND EXISTS(SELECT 1 FROM friends live_friend WHERE live_friend.id=c.friend_id
              AND live_friend.line_account_id=? AND live_friend.line_user_id=? AND live_friend.is_following=1
              AND ${activeTenantLineAccountSql('live_friend.line_account_id')})`)
            .bind(row.consultation_id,...candidateSnapshotBinds(row),row.line_account_id,saved.to).first(),
        send: (_signal, saved, key) => pushViaHarnessProxy(options.proxyBaseUrl, accessToken, saved.to,
          [{ type: 'text', text: saved.text }], key, options.proxyDispatch, 'reminder_dispatch'),
        statements: next => next.phase === 'started' ? [db.prepare(`SELECT json(CASE WHEN EXISTS(
          SELECT 1 FROM meet_consultations c WHERE c.id=? AND c.status='confirmed'
            AND ${LINKED_BOOKING_ALIVE_SQL} ${candidateSnapshotSql()}
            AND EXISTS(SELECT 1 FROM friends live_friend WHERE live_friend.id=c.friend_id AND live_friend.line_account_id=?
              AND live_friend.line_user_id=? AND live_friend.is_following=1 AND ${activeTenantLineAccountSql('live_friend.line_account_id')}))
          THEN 'true' ELSE 'meet_reminder_obsolete' END)`)
          .bind(row.consultation_id,...candidateSnapshotBinds(row),row.line_account_id,row.line_user_id),db.prepare("UPDATE meet_consultation_notification_runs SET call_state='started',updated_at=? WHERE id=?").bind(nowIso,row.id)]
          : next.phase === 'succeeded' ? [db.prepare(`UPDATE meet_consultation_notification_runs
              SET status='sent',sent_at=?,last_error=NULL,call_state='succeeded',result_json='{"accepted":true}',updated_at=?
              WHERE id=? AND status IN ('pending','failed','cancelled') ${snapshotGuardExists()}`)
            .bind(nowIso,nowIso,row.id,...snapshotGuardBinds(row))] : [],
      });
      // 外部が受理した事実は元の世代へ残す。変更後の新しい世代には触らない。
      const marked = await db
        .prepare(
          `UPDATE meet_consultation_notification_runs
              SET status='sent', sent_at=?, last_error=NULL, updated_at=?
            WHERE id=? AND status IN ('pending','failed','cancelled')
              ${snapshotGuardExists()}`,
        )
        .bind(nowIso, nowIso, row.id, ...snapshotGuardBinds(row))
        .run();
      sent++;
      // push と確定の間に取消が確定したときは送り直さず、追跡用に記録する。
      if (Number(marked.meta?.changes ?? 0) !== 1) {
        // 共通checkpointと同じ取引ですでにsentなら通常の完了。
        const saved = await db.prepare('SELECT status FROM meet_consultation_notification_runs WHERE id=?')
          .bind(row.id).first<{status:string}>();
        if (saved?.status !== 'sent') logger.error("meet_reminders.confirm_cancelled_delivery_failed");
      }
    } catch (error) {
      // 送信前に遮断された分を結果不明や上限到達にしない。次のcronで同じ段を拾う。
      if (error instanceof BookingLineDeliveryIncomplete && error.beforeSend) continue;
      const retryCount = deliveryPrepared ? MAX_RETRY : row.retry_count + 1;
      // 失敗の確定も新版へ再利用された行に触れない (候補写しと同一文で結ぶ)。
      // 新版が勝てば 0 件になり、勝者の pending を残す。試行数は数える。
      await db
        .prepare(
          `UPDATE meet_consultation_notification_runs
              SET status='failed',call_state=?, retry_count=?, last_error=?, updated_at=?
            WHERE id=?
              ${snapshotGuardExists()}`,
        )
        .bind(
          deliveryPrepared?'unknown':'ready',retryCount,
          deliveryPrepared ? 'delivery_unknown' : 'notification_preflight_failed',
          nowIso,
          row.id,
          ...snapshotGuardBinds(row),
        )
        .run();
      failed++;
    }
  }
  return { sent, failed };
}
