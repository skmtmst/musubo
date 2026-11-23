import { liffBookingJson } from './liff-booking-response.js';
import { logger } from '@line-crm/shared/server';
import { GapError } from '../services/gap-common.js';
import { EntitlementError } from '../features/booking/booking-entitlements/index.js';
import { outputAuditMiddleware } from '../middleware/output-audit.js';
import { evaluateBookingSyncNotices } from '../features/booking/booking-sync-rules/index.js';
import { processVisitStampQueue } from '../services/visit-stamps.js';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { processBookingWaitlists } from '../services/waitlist-tick.js';
import { notifyBookingConflicts } from '../features/booking/booking-channels/index.js';
import { resolveAccountIdFromLiff, resolveAccountIdAdmin } from './booking/identity.js';
import { registerLiffCatalog } from './booking/register-liff-catalog.js';
import { registerLiffCreate } from './booking/register-liff-create.js';
import { registerLiffChanges } from './booking/register-liff-changes.js';
import { registerLiffHistory } from './booking/register-liff-history.js';
import { registerCustomers } from './booking/register-customers.js';
import { registerSettings } from './booking/register-settings.js';
import { registerMenusRead } from './booking/register-menus-read.js';
import { registerMenusWrite } from './booking/register-menus-write.js';
import { registerMenusHq } from './booking/register-menus-hq.js';
import { registerCustomerContext } from './booking/register-customer-context.js';
import { registerWaitlistAdmin } from './booking/register-waitlist-admin.js';
import { registerWaitlistLiff } from './booking/register-waitlist-liff.js';
import { registerToday } from './booking/register-today.js';
import { registerDetail } from './booking/register-detail.js';
import { registerChangeActions } from './booking/register-change-actions.js';
import { registerCreate } from './booking/register-create.js';
import { registerStaff } from './booking/register-staff.js';
import { registerStaffAvailability } from './booking/register-staff-availability.js';
import { registerStaffBreaks } from './booking/register-staff-breaks.js';
import { registerStaffCalendar } from './booking/register-staff-calendar.js';
import { registerLedger } from './booking/register-ledger.js';
import { registerDecisions } from './booking/register-decisions.js';
import { registerSeatAvailability } from './booking/register-seat-availability.js';
import { registerBoard } from './booking/register-board.js';
import { registerPhotos } from './booking/register-photos.js';

const booking = new Hono<Env>();

booking.use('/api/booking/admin/bookings.csv', outputAuditMiddleware);

booking.use('/api/booking/*',async(c,next)=>{await next();if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.res.ok)await processVisitStampQueue(c.env);});

booking.onError((error,c)=>{if(error instanceof GapError||error instanceof EntitlementError)return (c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {error:error.code}, error.status) : c.json({error:error.code},error.status));if(/entitlement_month_change|entitlement_unavailable/.test(String(error)))return (c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {error:String(error).includes('entitlement_month_change')?'entitlement_month_change':'entitlement_unavailable'}, 409) : c.json({error:String(error).includes('entitlement_month_change')?'entitlement_month_change':'entitlement_unavailable'},409));if(/waitlist_hold_conflict|restaurant_table_conflict/.test(String(error)))return (c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {error:'slot_conflict'}, 409) : c.json({error:'slot_conflict'},409));throw error;});

booking.use('*',async(c,next)=>{await next();if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.res.status<400&&!(/\/waitlist$|\/seat-waitlist$/.test(c.req.path)&&c.req.method==='POST')){try{const accountId=c.req.path.startsWith('/api/liff/')?await resolveAccountIdFromLiff(c):await resolveAccountIdAdmin(c);if(accountId)await processBookingWaitlists(c.env,accountId);}catch{logger.error("booking.reconcile_waitlist_failed");}}});

booking.use('*', async (c, next) => {
  await next();
  const path = c.req.path;
  const mutation = (c.req.method === 'PUT' && path === '/api/booking/admin/sync-rules') || (c.req.method === 'POST' || c.req.method === 'PATCH') && (
    path === '/api/liff/booking/requests' || path === '/api/booking/admin/bookings'
    || /^\/api\/booking\/admin\/(bookings|requests|board)\/[^/]+(\/reassign)?$/.test(path));
  if (!mutation || c.res.status < 200 || c.res.status >= 300) return;
  try {
    const accountId = path.startsWith('/api/liff/') ? await resolveAccountIdFromLiff(c) : await resolveAccountIdAdmin(c);
    if (accountId) {
      await evaluateBookingSyncNotices(c.env,accountId);
      await notifyBookingConflicts(c.env.DB, accountId);
    }
  } catch {
    logger.warn("booking_conflict_notification_failed");
  }
});

booking.use('/api/booking/admin/*', async (c, next) => {
  const accountId = c.req.query('account_id');
  if (accountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ error: 'forbidden_account' }, 403);
  }
  return next();
});

registerLiffCatalog(booking);
registerPhotos(booking);

registerLiffCreate(booking);

registerLiffChanges(booking);

registerLiffHistory(booking);

registerCustomers(booking);

registerSettings(booking);

registerMenusRead(booking);

registerMenusWrite(booking);

registerMenusHq(booking);

registerCustomerContext(booking);

registerWaitlistAdmin(booking);

registerWaitlistLiff(booking);

registerToday(booking);

registerDetail(booking);

registerChangeActions(booking);

registerCreate(booking);

registerStaff(booking);

registerStaffAvailability(booking);

registerStaffBreaks(booking);

registerStaffCalendar(booking);

registerLedger(booking);

registerDecisions(booking);

registerSeatAvailability(booking);

registerBoard(booking);

export { jstDayWindowUtc } from './booking/availability.js';

export { resolveAccountIdFromLiff } from './booking/identity.js';

export { verifyCallerLineUserId } from './booking/identity.js';

export { resolveFriendId } from './booking/identity.js';

export default booking;
