import { liffBookingJson } from '../liff-booking-response.js';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { bookingAddons } from '../../features/booking/booking-addons/index.js';
import { menuAudience } from '../../features/booking/booking-audience/index.js';
import { featureReadiness, StyleError } from '../../services/style-setup.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { normalizeLiffDateView } from '@line-crm/db';
import { getAvailability } from '../../services/availability.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '../../features/booking/booking-types/index.js';
import { resolveSelfBookingCaller, resolveAccountIdFromLiff, verifyCallerLineUserId, resolveFriendId } from './identity.js';
import { googleCredentials } from './availability.js';
import { bookingPhoto } from '../../features/booking/booking-photos/index.js';

export function registerLiffCatalog(booking: Hono<Env>): void {


booking.get('/api/liff/booking/style-readiness', async c => {
  const caller=await resolveSelfBookingCaller(c);if(!caller.ok)return liffBookingJson(c, {error:caller.error},caller.status);
  try{return liffBookingJson(c, {success:true,data:await featureReadiness(c.env.DB,caller.accountId,c.req.query('feature')??'')});}catch(e){if(e instanceof StyleError)return liffBookingJson(c, {error:e.code},e.status);throw e;}
});

booking.post('/api/liff/booking/page-views', inputJsonBoundary(), async c => {
  const caller=await resolveSelfBookingCaller(c);
  if(!caller.ok)return liffBookingJson(c, {error:caller.error},caller.status);
  const body=await c.req.json<{menuId?:unknown;entryPoint?:unknown}>().catch(()=>null);
  if(!body||(body.menuId!==undefined&&typeof body.menuId!=='string')||(body.entryPoint!==undefined&&(typeof body.entryPoint!=='string'||body.entryPoint.length>100)))return liffBookingJson(c, {error:'invalid_page_view'},400);
  if(body.menuId&&!await c.env.DB.prepare('SELECT id FROM menus WHERE id=? AND line_account_id=? AND is_active=1').bind(body.menuId,caller.accountId).first())return liffBookingJson(c, {error:'menu_not_found'},404);
  await c.env.DB.prepare('INSERT INTO booking_page_views(id,line_account_id,menu_id,friend_id,entry_point,viewed_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),caller.accountId,body.menuId??null,caller.friendId,body.entryPoint??null,new Date().toISOString()).run();
  return liffBookingJson(c, {success:true},201);
});

booking.get('/api/liff/booking/menus', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  const rows = await c.env.DB
    .prepare(
      `SELECT id, name, category_label, description,
              duration_minutes, buffer_after_minutes,
              base_price, price_mode, sort_order,audience_mode,audience_tag_ids_json,addon_menu_ids_json,max_party_size,addon_only,customer_recurring_enabled,recurring_freqs_json,recurring_max_count,
              cancel_deadline_hours_before, intake_question, photo_media_id,
              COALESCE((SELECT mode FROM booking_payment_menu_settings WHERE menu_id = menus.id AND line_account_id = menus.line_account_id),
                (SELECT mode FROM booking_payment_configs WHERE line_account_id = menus.line_account_id),'none') AS payment_mode
         FROM menus
        WHERE line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC`,
    )
    .bind(accountId)
    .all();
  const user=await verifyCallerLineUserId(c);
  const friend=user?await resolveFriendId(c,user,accountId):null;
  const visible=[];
  for(const row of rows.results as Array<{id:string;addon_only:number}>)if(!row.addon_only&&(await menuAudience(c.env.DB,accountId,row.id,friend)).visible)visible.push(row);
  return liffBookingJson(c, { menus: visible.map(row => ({ ...row,
    photo_url: bookingPhoto(c.env.WORKER_URL || new URL(c.req.url).origin, (row as { photo_media_id?: string }).photo_media_id)?.url ?? null,
  })) });
});

booking.get('/api/liff/booking/menus/:id/addons',async(c)=>{
 const a=await resolveAccountIdFromLiff(c);if(!a)return liffBookingJson(c, {error:'unknown_liff'},404);
 const user=await verifyCallerLineUserId(c),f=user?await resolveFriendId(c,user,a):null;
 if(!(await menuAudience(c.env.DB,a,c.req.param('id'),f)).visible)return liffBookingJson(c, {error:'menu_not_available'},403);
 const row=await c.env.DB.prepare('SELECT addon_menu_ids_json FROM menus WHERE id=? AND line_account_id=?').bind(c.req.param('id'),a).first<{addon_menu_ids_json:string}>();
 const ids=JSON.parse(row?.addon_menu_ids_json??'[]') as string[],out=[];for(const id of ids){try{out.push(...await bookingAddons(c.env.DB,a,c.req.param('id'),[id],f));}catch{/* 停止した追加メニューは候補に出さない。 */}}
 return liffBookingJson(c, {success:true,data:out});
});

booking.get('/api/liff/booking/menus/:id/staff', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  const menuId = c.req.param('id');
  const rows = await c.env.DB
    .prepare(
      `SELECT s.id, s.display_name, s.role, s.profile_image_url, s.bio,
              s.is_designation_optional,s.nomination_fee,s.photo_media_id,
              COALESCE(sm.override_price, m.base_price) AS price,
              m.price_mode,
              COALESCE(sm.override_duration_minutes, m.duration_minutes) AS duration_minutes
         FROM staff s
         INNER JOIN staff_menus sm ON sm.staff_id = s.id AND sm.menu_id = ?2 AND sm.is_offered = 1
         INNER JOIN menus m ON m.id = ?2
        WHERE s.line_account_id = ?1 AND s.is_active = 1 AND s.deleted_at IS NULL
        ORDER BY s.is_designation_optional DESC, s.sort_order ASC, s.id ASC`,
    )
    .bind(accountId, menuId)
    .all();
  return liffBookingJson(c, { staff: rows.results.map(row => ({ ...(row as Record<string, unknown>),
    photo_url: bookingPhoto(c.env.WORKER_URL || new URL(c.req.url).origin, (row as { photo_media_id?: string }).photo_media_id)?.url ?? null,
  })) });
});

booking.get('/api/liff/booking/availability', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  const menuId = c.req.query('menu_id');
  const staffId = c.req.query('staff_id') || undefined;
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!menuId || !from || !to) {
    return liffBookingJson(c, { error: 'missing_params' }, 400);
  }
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  if ((toD.getTime() - fromD.getTime()) / 86400_000 > 28) {
    return liffBookingJson(c, { error: 'range_too_wide' }, 400);
  }
  let addonIds:unknown;try{addonIds=c.req.query('addon_ids')?JSON.parse(c.req.query('addon_ids')!):undefined;}catch{return liffBookingJson(c, {error:'invalid_addons'},400);}
  const user=addonIds?await verifyCallerLineUserId(c):null,friend=user?await resolveFriendId(c,user,accountId):null;
  const addons=await bookingAddons(c.env.DB,accountId,menuId,addonIds,friend);
  // お客さまの画面の空き確認では、店舗共通の受付締切・受付期間を
  // メニューの個別指定が無いときの既定値として使う。
  const result = await getAvailability(c.env.DB, {
    lineAccountId: accountId,
    additionalDurationMinutes:addons.reduce((n,a)=>n+a.duration_minutes,0),
    menuId,
    staffId,
    from,
    to,
    now: new Date(),
    minLeadTimeMinutes: DEFAULT_ACCOUNT_SETTINGS.min_lead_time_minutes,
    applyStoreRules: true,
    googleCredentials: googleCredentials(c.env),
  });
  return liffBookingJson(c, result);
});

// LIFF 予約「日時を選ぶ」段の最初の形と受付期間を返す読み口。
// 空き枠そのものは /availability を期間指定で呼ぶ（月の分は28日ずつ）。
// liffId で店舗が決まる既存の LIFF 口と同じ構え：不明な liffId は 404、
// 他店舗の設定は読めない。migration 前の行は既定値（list・60日）を返す。
booking.get('/api/liff/booking/settings', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  // SELECT * で読む。liff_date_view 列が無い migration 前の DB でも
  // 既定値を返せるよう、列名の指定はしない。
  const row = await c.env.DB
    .prepare(`SELECT * FROM booking_settings WHERE line_account_id = ?`)
    .bind(accountId)
    .first<Record<string, unknown>>();
  const windowDays = Number(row?.booking_window_days);
  return liffBookingJson(c, {
    liff_date_view: normalizeLiffDateView(row?.liff_date_view),
    booking_window_days:
      Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 365 ? windowDays : 60,
    // 予約のルール「お店が承認してから確定する」。automatic だけ承認なし確定。
    approval_mode: row?.approval_mode === 'automatic' ? 'automatic' : 'manual',
    cancel_deadline_minutes_before: Number(row?.cancel_deadline_minutes_before ?? 1440),
  });
});
}
