import { readRestaurantCustomerReservationForm,RestaurantReservationFormError } from '../services/restaurant-reservation-form.js';
import { restaurantReservationAnswerError } from '@line-crm/shared';
import { liffBookingJson, liffBookingInputError } from './liff-booking-response.js';
import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { normalizePhone } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { identity } from './restaurant-customer-identity.js';
import { restaurantSeatCapacity } from '../services/restaurant-seat-capacity.js';
import { referralCandidates } from '../services/restaurant-referrals.js';
import { collectInputs, parseLayout, normalizeBookingValue } from '@line-crm/shared';
import { respondToRestaurantConfirmation, type RestaurantConfirmationResponse } from '../services/restaurant-confirmations.js';
import { processRestaurantEvents } from '../services/restaurant-events.js';
import { processScenarioSourceJobs } from '../features/scenarios/scenario-source-jobs/index.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import {
  DEFAULT_TENANT_ID,
  activeTenantLineAccountSql,
  getBookingAdminSettings,
} from '@line-crm/db';
import type { RestaurantCustomerHoldInput, RestaurantCustomerConfirmInput } from '@line-crm/shared';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { dbFor } from '../services/db-router.js';
import { tzDateStr } from '../services/availability.js';
import {
  customerAvailability,
  customerCourse,
  customerBooking,
  validCustomerDetails,
  customerDetailValue,
  processRestaurantCustomerNotices,
  type CustomerStore,
  type CustomerReservationRow,
} from '../services/restaurant-customer-booking.js';
import { reconcileRestaurantInventory } from '../services/restaurant-inventory-rules.js';
import { processBookingWaitlists } from '../services/waitlist-tick.js';
import { isAccountFeatureEnabled } from '@line-crm/db';
export const restaurantCustomerBooking = new Hono<Env>();
restaurantCustomerBooking.onError((e, c) => {
  if(String(e).includes('RESTAURANT_FORM_CHANGED'))return liffBookingJson(c,{success:false,error:'reservation_form_changed'},409);
  if(e instanceof RestaurantReservationFormError)return liffBookingJson(c,{success:false,error:'reservation_form_unavailable'},503);
  if (/RESTAURANT_CAPACITY_CHANGED|customer_table_conflict|customer_duplicate_booking|customer_line_capacity|restaurant_table_conflict|closure_conflict|UNIQUE constraint/.test(String(e))) {
    return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
  }
  throw new UnexpectedRouteError(c, { success: false, error: 'booking_failed' });
});
restaurantCustomerBooking.use('/api/liff/restaurant/*', async (c, next) => {
  if (!restaurantTestEnabled(c.env))
    return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
  c.header('Cache-Control', 'no-store');
  await next();
});
async function storeFor(
  c: Context<Env>,
  accountId: string,
  storeId: unknown,
): Promise<CustomerStore | null> {
  if (typeof storeId !== 'string') return null;
  return dbFor(c.env, storeId)
    .prepare(
      `SELECT s.id,s.name,s.timezone,s.line_account_id,COALESCE(a.tenant_id,?) tenant_id FROM rt_stores s JOIN line_accounts a ON a.id=s.line_account_id WHERE s.id=? AND s.line_account_id=? AND s.status='active'`,
    )
    .bind(DEFAULT_TENANT_ID, storeId, accountId)
    .first<CustomerStore>();
}
async function finish(c: Context<Env>, store: CustomerStore) {
  // 保存を先に確定する。通知失敗で確定予約を二度作らない。媒体作業は既存の台帳に作る。
  try {
    await reconcileRestaurantInventory(c.env, store.id);
    await processBookingWaitlists(c.env, store.line_account_id);
    await processRestaurantEvents(c.env, store.id);
    await processScenarioSourceJobs(c.env);
    await processRestaurantCustomerNotices(c.env, store.id);
  } catch {
    logger.error("restaurant_booking.send_customer_notice_failed");
  }
}
restaurantCustomerBooking.get('/api/liff/restaurant/link/:token', async (c) => {
  const self = await identity(c);
  if (self instanceof Response) return self;
  const store = await dbFor(c.env)
    .prepare(
      `SELECT s.id,s.name,s.timezone FROM rt_reservation_links l JOIN rt_stores s ON s.id=l.store_id WHERE l.token=? AND s.line_account_id=? AND s.status='active'`,
    )
    .bind(c.req.param('token'), self.accountId)
    .first<{id:string;name:string;timezone:string}>();
  if(!store)return liffBookingJson(c,{success:false,error:'not_found'},404);
  const {form:reservationForm}=await readRestaurantCustomerReservationForm(dbFor(c.env,store.id),store.id,self.accountId);
  return liffBookingJson(c,{success:true,data:{...store,reservationForm}});
});
restaurantCustomerBooking.get(
  '/api/liff/restaurant/availability',
  async (c) => {
    const self = await identity(c);
    if (self instanceof Response) return self;
    const store = await storeFor(c, self.accountId, c.req.query('storeId'));
    if (!store) return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
    const result = await customerAvailability(
      dbFor(c.env, store.id),
      store,
      c.req.query('date') ?? '',
      Number(c.req.query('guestCount')),
      undefined,
      c.req.query('courseId'),
    );
    return result
      ? liffBookingJson(c, { success: true, data: result.data })
      : liffBookingJson(c,
          { success: false, error: 'invalid_date_or_unconfigured_hours' },
          400,
        );
  },
);
restaurantCustomerBooking.post('/api/liff/restaurant/holds', inputJsonBoundary(), async (c) => {
  const self = await identity(c);
  if (self instanceof Response) return self;
  const body = await c.req
    .json<RestaurantCustomerHoldInput>()
    .catch(() => null);
  if (
    !body ||
    !validCustomerDetails(body) ||
    typeof body.startsAt !== 'string' ||
    !Number.isFinite(Date.parse(body.startsAt)) ||
    !Number.isInteger(body.guestCount) ||
    body.guestCount < 1 ||
    body.guestCount > 100 ||
    typeof body.requestId !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId)
  )
    return liffBookingInputError(c, { success: false, error: 'invalid_hold' }, 400, ["note","customerPhone","startsAt","guestCount","requestId"]);
  const store = await storeFor(c, self.accountId, body.storeId);
  if (!store) return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
  const db = dbFor(c.env, store.id),
    startsAt = new Date(body.startsAt).toISOString();
  const course = await customerCourse(db, store.id, body.courseId);
  if (course === undefined) return liffBookingInputError(c,{success:false,error:'invalid_course'},400,['courseId']);
  const old = await db
    .prepare(
      'SELECT *, (SELECT seat_type FROM rt_tables t WHERE t.id=rt_reservations.table_id AND t.store_id=rt_reservations.store_id) AS seat_type, (SELECT name FROM rt_menu_items m WHERE m.id=rt_reservations.course_id AND m.store_id=rt_reservations.store_id) AS course_name FROM rt_reservations WHERE store_id=? AND line_uid=? AND customer_request_id=?',
    )
    .bind(store.id, self.uid, body.requestId)
    .first<CustomerReservationRow>();
  if (old) {
    if (
      old.note !== customerDetailValue(body.note) ||
      (body.customerName!==undefined&&old.customer_name!==customerDetailValue(body.customerName)) ||
      (body.allergyNote!==undefined&&old.allergy_note!==customerDetailValue(body.allergyNote)) ||
      (normalizePhone(old.customer_phone ?? '') || null) !== (normalizePhone(body.customerPhone ?? '') || null) ||
      old.starts_at !== startsAt ||
      old.guest_count !== body.guestCount ||
      (old.course_id ?? null) !== (body.courseId || null) ||
      old.status === 'cancelled' ||
      (old.status === 'pending' && !old.hold_expires_at)
    )
      return liffBookingJson(c, { success: false, error: 'request_conflict' }, 409);
    if(old.status!=='pending'||Date.parse(old.hold_expires_at!)>Date.now())return liffBookingJson(c, { success: true, data: customerBooking(old) });
  }
  const result = await customerAvailability(
      db,
      store,
      tzDateStr(store.timezone, new Date(startsAt)),
      body.guestCount,
      undefined,
      body.courseId,
    ),
    slot = result?.data.slots.find(
      (s) => s.startsAt === startsAt && s.available,
    );
  if (!result || !slot)
    return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
  const capacity = await restaurantSeatCapacity(db, store.id, startsAt, slot.endsAt, old?.id);
  const assignedTable = capacity.select({ startsAt, endsAt: slot.endsAt, guestCount: body.guestCount });
  if (!assignedTable) return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
  const id = crypto.randomUUID(), tableId = capacity.settings.enabled ? assignedTable.id : null;
  const expires = new Date(
    Math.min(Date.now() + result.holdMinutes * 60000, Date.parse(startsAt)),
  ).toISOString();
  if(old){
    const [,refreshed]=await capacity.commit([db.prepare(`UPDATE rt_reservations SET starts_at=?,ends_at=?,table_id=?,hold_expires_at=?,customer_version=customer_version+1,updated_at=datetime('now') WHERE id=? AND customer_version=? AND status='pending' AND julianday(hold_expires_at)<=julianday('now') AND EXISTS(SELECT 1 FROM rt_opening_hours_settings WHERE store_id=? AND version=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_menu_items WHERE id=? AND store_id=? AND status='active' AND kind='course' AND duration_minutes=?)) AND EXISTS(SELECT 1 FROM rt_tables WHERE id=? AND store_id=? AND is_active=1)`).bind(startsAt,slot.endsAt,tableId,expires,old.id,old.customer_version,store.id,result.hoursVersion,body.courseId||null,body.courseId||null,store.id,course?.durationMinutes??null,assignedTable.id,store.id)]);
    if(!refreshed.meta.changes)return liffBookingJson(c, {success:false,error:'version_conflict'},409);
    const row=await db.prepare('SELECT *,NULL seat_type FROM rt_reservations WHERE id=?').bind(old.id).first<CustomerReservationRow>();
    return liffBookingJson(c, {success:true,data:customerBooking(row!)});
  }
  // 営業時間を読んだ版と同じときだけ作る。席・本人・残枠はDBトリガーでも守る。
  await capacity.commit([db
    .prepare(
      `INSERT INTO rt_reservations(id,store_id,source,external_id,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,hold_expires_at,customer_request_id,note,customer_phone,course_id,allergy_note) SELECT ?,?,'line',?,?,?,?,?,?,?,'pending',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM rt_opening_hours_settings WHERE store_id=? AND version=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_menu_items WHERE id=? AND store_id=? AND status='active' AND kind='course' AND duration_minutes=?)) AND EXISTS(SELECT 1 FROM rt_tables WHERE id=? AND store_id=? AND is_active=1)`,
    )
    .bind(
      id,
      store.id,
      `customer:${id}`,
      customerDetailValue(body.customerName)??self.friendName,
      self.uid,
      body.guestCount,
      startsAt,
      slot.endsAt,
      tableId,
      expires,
      body.requestId,
      customerDetailValue(body.note),
      (normalizePhone(body.customerPhone ?? '') || null),
      body.courseId || null,
      customerDetailValue(body.allergyNote),
      store.id,
      result.hoursVersion,
      body.courseId || null, body.courseId || null, store.id, course?.durationMinutes ?? null,
      assignedTable.id, store.id,
    )]);
  const saved = await db
    .prepare('SELECT *, (SELECT seat_type FROM rt_tables t WHERE t.id=rt_reservations.table_id AND t.store_id=rt_reservations.store_id) AS seat_type, (SELECT name FROM rt_menu_items m WHERE m.id=rt_reservations.course_id AND m.store_id=rt_reservations.store_id) AS course_name FROM rt_reservations WHERE id=?')
    .bind(id)
    .first<CustomerReservationRow>();
  if (!saved) return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
  return liffBookingJson(c, { success: true, data: customerBooking(saved) }, 201);
});
restaurantCustomerBooking.get(
  '/api/liff/restaurant/reservations',
  async (c) => {
    const self = await identity(c);
    if (self instanceof Response) return self;
    const store = await storeFor(c, self.accountId, c.req.query('storeId'));
    if (!store) return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
    const rows = (
      await dbFor(c.env, store.id)
        .prepare(
          'SELECT *, (SELECT seat_type FROM rt_tables t WHERE t.id=rt_reservations.table_id AND t.store_id=rt_reservations.store_id) AS seat_type, (SELECT name FROM rt_menu_items m WHERE m.id=rt_reservations.course_id AND m.store_id=rt_reservations.store_id) AS course_name FROM rt_reservations WHERE store_id=? AND line_uid=? ORDER BY starts_at DESC LIMIT 100',
        )
        .bind(store.id, self.uid)
        .all<CustomerReservationRow>()
    ).results;
    return liffBookingJson(c, { success: true, data: rows.map(customerBooking) });
  },
);
function acceptReferral(db:D1Database,referralId:string,storeId:string,reservationId:string,uid:string,version:number) {
  return db.prepare(`UPDATE rt_reservation_referrals SET accepted_at=COALESCE(accepted_at,datetime('now')) WHERE id=? AND target_store_id=?
    AND EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND store_id=? AND line_uid=? AND customer_version=? AND status='confirmed')
    AND EXISTS(SELECT 1 FROM rt_store_group_members m JOIN rt_store_group_members n ON n.group_id=m.group_id JOIN rt_stores s ON s.id=m.store_id JOIN rt_stores t ON t.id=n.store_id JOIN rt_store_groups g ON g.id=m.group_id WHERE m.store_id=source_store_id AND n.store_id=target_store_id AND m.referral_enabled=1 AND n.referral_enabled=1 AND s.organization_id=t.organization_id AND s.organization_id=g.organization_id)`)
    .bind(referralId,storeId,reservationId,storeId,uid,version);
}
for (const action of ['confirm', 'cancel', 'reschedule'] as const) {
  restaurantCustomerBooking.post(
    `/api/liff/restaurant/reservations/:id/${action}`,
    async (c) => {
      const self = await identity(c);
      if (self instanceof Response) return self;
      const b = await c.req
        .json<RestaurantCustomerConfirmInput & {startsAt?: string; guestCount?: number; courseId?: string | null}>()
        .catch(() => null);
      if (
        !b ||
        !Number.isSafeInteger(b.expectedVersion) ||
        b.expectedVersion < 1
      )
        return liffBookingInputError(c, { success: false, error: 'expected_version_required' }, 400, ["expectedVersion"]);
      if (action === 'confirm' && !validCustomerDetails(b)) return liffBookingInputError(c, {success:false,error:'invalid_customer_details'}, 400, ["note","customerPhone","customerName","allergyNote"]);
      const db = dbFor(c.env),
        row = await db
          .prepare(
            `SELECT r.*, (SELECT seat_type FROM rt_tables t WHERE t.id=r.table_id AND t.store_id=r.store_id) AS seat_type, (SELECT name FROM rt_menu_items m WHERE m.id=r.course_id AND m.store_id=r.store_id) AS course_name FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=? AND r.line_uid=? AND s.line_account_id=? AND s.status='active' AND r.customer_request_id IS NOT NULL`,
          )
          .bind(c.req.param('id'), self.uid, self.accountId)
          .first<CustomerReservationRow>();
      if (!row) return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
      const store = (await storeFor(c, self.accountId, row.store_id))!;
      if (
        (action === 'confirm' && row.status === 'confirmed') ||
        (action === 'cancel' && row.status === 'cancelled')
      ) {
        if (action === 'confirm' && ((b.note !== undefined && customerDetailValue(b.note)!==row.note) || (b.customerPhone !== undefined && (normalizePhone(b.customerPhone ?? '') || null)!==(normalizePhone(row.customer_phone ?? '') || null)) || (b.customerName!==undefined&&customerDetailValue(b.customerName)!==row.customer_name) || (b.allergyNote!==undefined&&customerDetailValue(b.allergyNote)!==row.allergy_note))) return liffBookingJson(c, {success:false,error:'request_conflict'},409);
        if(action==='confirm' && typeof b.referralId==='string') await acceptReferral(db,b.referralId,store.id,row.id,self.uid,row.customer_version).run();
        await finish(c, store);
        return liffBookingJson(c, { success: true, data: customerBooking(row) });
      }
      const formSnapshot=action==='confirm'?await readRestaurantCustomerReservationForm(db,store.id,self.accountId):null;
      const form=formSnapshot?.form;
      if(form){
        if((b.expectedFormVersion??0)!==form.version)return liffBookingJson(c,{success:false,error:'reservation_form_changed'},409);
        const problem=restaurantReservationAnswerError(form.definition,{customerName:b.customerName===undefined?row.customer_name:b.customerName,customerPhone:b.customerPhone===undefined?row.customer_phone:b.customerPhone,allergyNote:b.allergyNote===undefined?row.allergy_note:b.allergyNote,note:b.note===undefined?row.note:b.note});
        if(problem)return liffBookingInputError(c,{success:false,error:'invalid_reservation_answers',message:problem},400,['customerName','customerPhone','allergyNote','note']);
      }
      if (row.customer_version !== b.expectedVersion)
        return liffBookingJson(c, { success: false, error: 'version_conflict' }, 409);
      if (
        action === 'confirm' &&
        (row.status !== 'pending' ||
          !row.hold_expires_at ||
          Date.parse(row.hold_expires_at) <= Date.now())
      )
        return liffBookingJson(c, { success: false, error: 'hold_expired' }, 409);
      if (
        action !== 'confirm' &&
        !['pending', 'confirmed'].includes(row.status)
      )
        return liffBookingJson(c, { success: false, error: 'state_conflict' }, 409);
      const settings = await getBookingAdminSettings(db, self.accountId);
      if (!settings) return liffBookingJson(c, { success: false, error: 'not_found' }, 404);
      if (
        action !== 'confirm' &&
        Date.now() >=
          Date.parse(row.starts_at) -
            settings.cancelDeadlineMinutesBefore * 60000
      )
        return liffBookingJson(c, { success: false, error: 'self_deadline_passed' }, 403);
      let starts = row.starts_at,
        ends = row.ends_at,
        table = row.table_id,
        seatType = row.seat_type,
        count = row.guest_count,
        courseId = row.course_id ?? null,
        hoursVersion: number | null = null;
      if (action === 'reschedule') {
        if (
          row.status !== 'confirmed' ||
          typeof b.startsAt !== 'string' ||
          !Number.isFinite(Date.parse(b.startsAt)) ||
          !Number.isInteger(b.guestCount) ||
          !b.guestCount ||
          b.guestCount < 1 ||
          b.guestCount > 100
        )
          return liffBookingInputError(c, { success: false, error: 'invalid_change' }, 400, ["startsAt","guestCount"]);
        courseId = b.courseId === undefined ? courseId : b.courseId;
        starts = new Date(b.startsAt).toISOString();
        count = b.guestCount;
        const available = await customerAvailability(
            db,
            store,
            tzDateStr(store.timezone, new Date(starts)),
            count,
            row.id,
            courseId,
          ),
          slot = available?.data.slots.find(
            (s) => s.startsAt === starts && s.available,
          );
        if (!slot || !available)
          return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
        ends = slot.endsAt;
        hoursVersion = available.hoursVersion;
      }
      const capacity = action === 'cancel' ? null : await restaurantSeatCapacity(db, store.id, starts, ends, row.id);
      if (capacity) {
        const free = capacity.select({ startsAt: starts, endsAt: ends, guestCount: count, tableId: action === 'confirm' ? table : null });
        if (!free) return liffBookingJson(c, { success: false, error: 'slot_conflict' }, 409);
        if (action === 'reschedule') { table = capacity.settings.enabled ? free.id : null; seatType = table ? free.seatType ?? null : null; }
      }
      if(action==='confirm'){
        const available=await customerAvailability(db,store,tzDateStr(store.timezone,new Date(starts)),count,row.id,courseId);
        if(!available?.data.slots.some(s=>s.startsAt===starts && s.available && s.endsAt===ends))return liffBookingJson(c, {success:false,error:'slot_conflict'},409);
        hoursVersion=available.hoursVersion;
      }
      const next = {
        ...row,
        note: action === 'confirm' && b.note !== undefined ? customerDetailValue(b.note) : row.note,
        customer_name:action==='confirm'&&b.customerName!==undefined?customerDetailValue(b.customerName)!:row.customer_name,
        allergy_note:action==='confirm'&&b.allergyNote!==undefined?customerDetailValue(b.allergyNote):row.allergy_note,
        customer_phone: action === 'confirm' && b.customerPhone !== undefined ? (normalizePhone(b.customerPhone ?? '') || null) : row.customer_phone,
        status: action === 'cancel' ? 'cancelled' : 'confirmed',
        starts_at: starts,
        ends_at: ends,
        table_id: table,
        seat_type: seatType,
        guest_count: count,
        course_id: courseId,
        customer_version: row.customer_version + 1,
        hold_expires_at: null,
      };
      const results = await (capacity?.commit ?? db.batch.bind(db))([
        ...(formSnapshot?[formSnapshot.guard]:[]),
        db
          .prepare(
            `UPDATE rt_reservations SET status=?,starts_at=?,ends_at=?,table_id=?,guest_count=?,note=?,customer_phone=?,customer_name=?,allergy_note=?,course_id=?,dining_snapshot_json=json_set(CASE WHEN course_id IS NOT ? THEN json_set(COALESCE(dining_snapshot_json,'{}'),'$.courseId',?,'$.courseAllergens',json(COALESCE((SELECT allergens_json FROM rt_menu_items WHERE id=? AND store_id=?),'[]'))) ELSE COALESCE(dining_snapshot_json,'{}') END,'$.allergy',?),customer_version=customer_version+1,hold_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND line_uid=? AND customer_version=? AND status=? AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_opening_hours_settings WHERE store_id=? AND version=?)) AND (?<>'confirm' OR julianday(hold_expires_at)>julianday('now')) AND (?='cancel' OR ? IS NULL OR EXISTS(SELECT 1 FROM rt_menu_items WHERE id=? AND store_id=? AND status='active' AND kind='course' AND duration_minutes=?))`,
          )
          .bind(
            next.status,
            starts,
            ends,
            table,
            count,
            next.note,
            next.customer_phone,
            next.customer_name,next.allergy_note,
            courseId, courseId, courseId, courseId, store.id,next.allergy_note,
            row.id,
            self.uid,
            b.expectedVersion,
            row.status,
            hoursVersion,
            store.id,
            hoursVersion,
            action,
            action, courseId, courseId, store.id, Math.round((Date.parse(ends)-Date.parse(starts))/60000),
          ),
        // UPDATEが0件なら別の版への通知は作らない。
        db
          .prepare(
            `INSERT OR IGNORE INTO rt_customer_notice_outbox(id,store_id,reservation_id,customer_version,line_uid,message,retry_key) SELECT ?,?,?,?,?,?,? WHERE changes()=1`,
          )
          .bind(
            `restaurant-customer:${row.id}:${next.customer_version}`,
            store.id,
            row.id,
            next.customer_version,
            self.uid,
            action === 'cancel'
              ? `${store.name}の予約を取り消しました。`
              : `${store.name}の予約を${action === 'confirm' ? '確定' : '変更'}しました。\n${new Intl.DateTimeFormat('ja-JP', { timeZone: store.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(starts))}\n${count}名\n変更・取り消しはLINEの予約ページから行えます。`,
            crypto.randomUUID(),
          ),
        ...(action==='confirm' && typeof b.referralId==='string' ? [acceptReferral(db,b.referralId,store.id,row.id,self.uid,next.customer_version)] : []),
      ]).catch(async error=>{
        if(formSnapshot&&!await formSnapshot.isCurrent())throw new Error('RESTAURANT_FORM_CHANGED');
        throw error;
      });
      if (!results[(form?1:0)+(capacity?1:0)]!.meta.changes)
        return liffBookingJson(c, { success: false, error: 'version_conflict' }, 409);
      await finish(c, store);
      const saved=await db.prepare('SELECT *,NULL seat_type,(SELECT name FROM rt_menu_items WHERE id=rt_reservations.course_id) course_name FROM rt_reservations WHERE id=?').bind(next.id).first<CustomerReservationRow>();
      return liffBookingJson(c, { success: true, data: customerBooking({...saved!,seat_type:seatType}) });
    },
  );
}

restaurantCustomerBooking.post('/api/liff/restaurant/confirmations/:requestId/respond',inputJsonBoundary(),async c=>{
 const self=await identity(c);if(self instanceof Response)return self;
 const b=await c.req.json<{expectedVersion?:number;response?:RestaurantConfirmationResponse}>().catch(()=>null);
 if(!b||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1||!['going','change_requested','cancel'].includes(b.response??''))return liffBookingInputError(c,{success:false,error:'invalid_confirmation_response'},400,['expectedVersion','response']);
 const db=dbFor(c.env);const f=await db.prepare('SELECT id FROM friends WHERE line_account_id=? AND line_user_id=? AND is_following=1').bind(self.accountId,self.uid).first<{id:string}>();
 if(!f)return liffBookingJson(c, {success:false,error:'not_found'},404);
 const result=await respondToRestaurantConfirmation(db,{requestId:c.req.param('requestId'),friendId:f.id,accountId:self.accountId,expectedVersion:b.expectedVersion!,response:b.response!});
 if(!result.ok)return liffBookingJson(c, {success:false,error:result.error},result.status);
 const target=await db.prepare('SELECT r.store_id FROM rt_reservation_confirmations c JOIN rt_reservations r ON r.id=c.reservation_id WHERE c.request_id=?').bind(c.req.param('requestId')).first<{store_id:string}>();
 if(target){const store=await storeFor(c,self.accountId,target.store_id);if(store)await finish(c,store);}
 return liffBookingJson(c, {success:true,data:result});
});

restaurantCustomerBooking.get('/api/liff/restaurant/courses', async c => {
  const self=await identity(c); if(self instanceof Response)return self;
  const store=await storeFor(c,self.accountId,c.req.query('storeId')); if(!store)return liffBookingJson(c, {success:false,error:'not_found'},404);
  const db=dbFor(c.env,store.id);
  const rows=await db.prepare("SELECT id FROM rt_menu_items WHERE store_id=? AND kind='course' AND status='active' AND duration_minutes BETWEEN 1 AND 1440 ORDER BY price,id").bind(store.id).all<{id:string}>();
  return liffBookingJson(c, {success:true,timezone:store.timezone,data:await Promise.all(rows.results.map(r=>customerCourse(db,store.id,r.id)))});
});

restaurantCustomerBooking.get('/api/liff/restaurant/referrals',async c=>{
 const self=await identity(c);if(self instanceof Response)return self;
 const store=await storeFor(c,self.accountId,c.req.query('storeId'));if(!store)return liffBookingJson(c, {success:false,error:'not_found'},404);
 const date=c.req.query('date')??'',count=Number(c.req.query('guestCount')),starts=c.req.query('startsAt');
 const source=await customerAvailability(dbFor(c.env),store,date,count,undefined,c.req.query('courseId'));
 if(!source)return liffBookingJson(c, {success:false,error:'invalid_date_or_unconfigured_hours'},400);
 if(starts ? source.data.slots.some(s=>s.startsAt===starts&&s.available) : source.data.slots.some(s=>s.available))return liffBookingJson(c, {success:true,data:[]});
 return liffBookingJson(c, {success:true,data:await referralCandidates(dbFor(c.env),store,date,count,starts)});
});
restaurantCustomerBooking.post('/api/liff/restaurant/referrals',inputJsonBoundary(),async c=>{
 const self=await identity(c);if(self instanceof Response)return self;
 const b=await c.req.json<{storeId:string;targetStoreId:string;date:string;startsAt:string;guestCount:number;courseId?:string|null}>();
 if(!b || ![b.storeId,b.targetStoreId,b.date,b.startsAt].every(v=>typeof v==='string'&&v.length>0) || !Number.isFinite(Date.parse(b.startsAt)))return liffBookingInputError(c,{success:false,error:'invalid_referral'},400,['storeId','targetStoreId','date','startsAt']);
 const store=await storeFor(c,self.accountId,b.storeId);if(!store)return liffBookingJson(c, {success:false,error:'not_found'},404);
 const source=await customerAvailability(dbFor(c.env),store,b.date,b.guestCount,undefined,b.courseId);
 if(!source)return liffBookingJson(c, {success:false,error:'invalid_date_or_unconfigured_hours'},400);
 if(source.data.slots.some(s=>s.startsAt===b.startsAt&&s.available))return liffBookingJson(c, {success:false,error:'source_available'},409);
 const target=(await referralCandidates(dbFor(c.env),store,b.date,b.guestCount,b.startsAt)).find(r=>r.storeId===b.targetStoreId);
 if(!target)return liffBookingJson(c, {success:false,error:'referral_unavailable'},409);
 const id=crypto.randomUUID();
 await dbFor(c.env).prepare('INSERT INTO rt_reservation_referrals(id,source_store_id,target_store_id) VALUES(?,?,?)').bind(id,store.id,target.storeId).run();
 return liffBookingJson(c, {success:true,data:{bookingUrl:target.bookingUrl+'&referralId='+encodeURIComponent(id)}});
});
/** 保存済み回答の公開版だけから、既存の席予約の口へ渡す。回答の再送も台帳を増やさない。 */
restaurantCustomerBooking.post('/api/liff/restaurant/form-booking',inputJsonBoundary(),async c=>{
 const self=await identity(c);if(self instanceof Response)return self;
 const b=await c.req.json<{formId:string;blockId:string;submissionKey:string}>();
 if(!b || ![b.formId,b.blockId,b.submissionKey].every(v=>typeof v==='string' && v.length>0 && v.length<=200))return liffBookingInputError(c,{success:false,error:'invalid_form_booking'},400,['formId','blockId','submissionKey']);
 const db=dbFor(c.env);
 const saved=await db.prepare(`SELECT s.id,s.data,v.layout,v.fields FROM form_submit_claims q
 JOIN form_submissions s ON s.id=q.submission_id JOIN friends f ON f.id=s.friend_id
 JOIN form_versions v ON v.id=s.form_version_id AND v.form_id=s.form_id
 WHERE q.form_id=s.form_id AND q.status='completed' AND q.form_id=? AND q.idempotency_key=? AND q.line_account_id=? AND q.friend_id=f.id AND f.line_user_id=? AND f.line_account_id=? AND s.is_test=0`)
 .bind(b.formId,b.submissionKey,self.accountId,self.uid,self.accountId).first<{id:string;data:string;layout:string;fields:string}>();
 if(!saved)return liffBookingJson(c, {success:false,error:'saved_answer_required'},404);
 const block=collectInputs(parseLayout(saved.layout,saved.fields)).find(x=>x.id===b.blockId&&x.type==='booking');
 const picked=block ? normalizeBookingValue(JSON.parse(saved.data)[block.name]) : null;
 if(!block || block.booking?.kind!=='seats' || !picked || picked.kind!=='seats' || picked.storeId!==block.booking.storeId || (block.booking.courseId && picked.courseId!==block.booking.courseId))return liffBookingJson(c, {success:false,error:'invalid_booking_answer'},400);
 const store=await storeFor(c,self.accountId,picked.storeId);
 if(!store)return liffBookingJson(c, {success:false,error:'not_found'},404);
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(saved.id+':'+block.id));
 const requestId='form_'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
 const base=new URL(c.req.url);base.pathname='/api/liff/restaurant/holds';
 const headers={'Content-Type':'application/json',Authorization:c.req.header('Authorization')!};
 const old=await db.prepare('SELECT id,customer_version,status,hold_expires_at FROM rt_reservations WHERE store_id=? AND line_uid=? AND customer_request_id=?').bind(picked.storeId,self.uid,requestId).first<{id:string;customer_version:number;status:string;hold_expires_at:string|null}>();
 let holdId:string,version:number;
 if(old && (old.status!=='pending' || Date.parse(old.hold_expires_at??'')>Date.now())){
   if(old.status==='confirmed'||old.status==='cancelled'){
    const row=await db.prepare('SELECT *,NULL seat_type FROM rt_reservations WHERE id=?').bind(old.id).first<CustomerReservationRow>();
    return liffBookingJson(c, {success:true,data:customerBooking(row!)});
   }
   holdId=old.id;version=old.customer_version;
 }else{
   const held=await restaurantCustomerBooking.request(base.href,{method:'POST',headers,body:JSON.stringify({storeId:picked.storeId,courseId:picked.courseId,guestCount:picked.guestCount,startsAt:picked.startsAt,requestId})},c.env);
   if(!held.ok)return held;
   const result=await held.json() as {data:{id:string;version:number}};holdId=result.data.id;version=result.data.version;
 }
 base.pathname='/api/liff/restaurant/reservations/'+encodeURIComponent(holdId)+'/confirm';
 return restaurantCustomerBooking.request(base.href,{method:'POST',headers,body:JSON.stringify({expectedVersion:version})},c.env);
});
