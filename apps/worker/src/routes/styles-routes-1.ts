import { savedStyleMenuPreview } from '../services/style-menu-preview.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { starterCatalogRuntime } from './style-starter-runtime.js';
import { styleEcSummary } from './style-ec-summary.js';
import { styleMenuButtons } from '../services/style-menu-buttons.js';
import {styleTemplateSamples} from './style-template-samples-api.js';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import {
  paymentBadges,
  paymentSummary,
  paymentSummaryInWindow,
} from '../features/booking/booking-payment-admin/index.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { accountFeatureIsEnabled } from '../services/feature-enforcement.js';
import { restaurantEffectivelyEnabledForAccount } from '../services/tenant-features.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { Hono, type Context } from 'hono';

import type { Env } from '../worker-env.js';
import { hasPendingStyleSelection } from '../services/style-profile.js';

import { hasStaffPermission, requireRole } from '../middleware/role-guard.js';
import {
  dashboardPresentation,
  readMetricIds,
  StyleError,
  checkStyle,
  defaultCards,
  features,
  profile,
  profileAnswers,
  questionsForStyle,
  readCards,
  saveProfile,
  initializeAccountStyle,
  starter,
  styleWarnings,
} from '../services/style-setup.js';
import { styleSnapshot, styleWindow } from '../services/style-analytics.js';
import { styleSchedule } from '../services/style-schedule.js';
import { templateSamples } from '../services/style-template-samples.js';

import {
  base,
  hq,
  account,
  json,
  edit,
  text,
  oneOf,
  version,
  staffFilter,
  bookingAudience,
} from './styles-common.js';
export const styles = new Hono<Env>();
styles.route('/', styleEcSummary);

async function accountForStyle(c: Context<Env>) {
  const id = await account(c);
  if (c.req.query('registration') !== '1') return id;
  edit(c);
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (scope.isAccountScoped) throw new StyleError('forbidden', 403);
  const row = await c.env.DB.prepare(
    'SELECT is_active, archived_at, created_by_staff_id FROM line_accounts WHERE id = ?',
  ).bind(id).first<{ is_active: number; archived_at: string | null; created_by_staff_id: string | null }>();
  if (!row || row.archived_at || (row.created_by_staff_id && row.created_by_staff_id !== c.get('staff').id)) {
    throw new StyleError('not_found', 404);
  }
  if (!row.is_active) throw new StyleError('LINE_ACCOUNT_INACTIVE', 409);
  return id;
}

styles.get(base, async (c) => {
  const id = await accountForStyle(c),
    p = await profile(c.env.DB, id),
    style = p?.style ?? 'standard';
  return c.json({
    success: true,
    data: {
      style,
      styleSelected: !!p?.selected_at && p.selection_mode === 'configured',
      metricsCustomized: p?.metrics_json != null,
      shouldPromptStyleSelection: hasPendingStyleSelection(p),
      styleMode: p?.selection_mode ?? 'later',
      version: p?.version ?? 0,
      answers: profileAnswers(p),
      settings: JSON.parse(p?.settings_json ?? '{}'),
      ...dashboardPresentation(
        style,
        p?.cards_json ? JSON.parse(p.cards_json) : defaultCards(style),
        p?.metrics_json ? JSON.parse(p.metrics_json) : null,
      ),
      questions: questionsForStyle(style).map((key) => ({
        key,
        ...(features[key] ? { changeAt: features[key] } : {}),
        canChangeLater: true,
        recommended: key === 'payment' ? false : true,
        modes: ['configured', 'later', 'manual'],
      })),
      warnings: await styleWarnings(c.env.DB, id),
    },
  });
});

styles.put(base, async (c) => {
  edit(c);
  const id = await accountForStyle(c);
  const body = await json(c);
  if (body.retryRegistrationInitialization === true) {
    if (c.req.query('registration') !== '1' || body.expectedVersion !== 0)
      throw new StyleError('invalid_request', 400);
    const row = await c.env.DB.prepare('SELECT tenant_id FROM line_accounts WHERE id=?').bind(id).first<{ tenant_id: string | null }>();
    if (!row) throw new StyleError('not_found', 404);
    return c.json({ success: true, data: await initializeAccountStyle(
      c.env.DB, id, row.tenant_id ?? DEFAULT_TENANT_ID, c.get('staff').id,
      body.style === undefined || body.style === null ? undefined : checkStyle(body.style), starterCatalogRuntime(c),
    ) });
  }
  return c.json({
    success: true,
    data: await saveProfile(
      c.env.DB,
      id,
      c.get('staff').tenantId ?? null,
      c.get('staff').id,
      body,
      {
        images: c.env.IMAGES,
        catalogRuntime: starterCatalogRuntime(c),
        provisionRestaurantWorkspace: restaurantTestEnabled(c.env),
      },
    ),
  });
});

styles.get(base + '/warnings', async (c) =>
  c.json({
    success: true,
    data: await styleWarnings(c.env.DB, await account(c)),
  }),
);

styles.get(base + '/starter-set', async (c) => {
  const id = await account(c);
  const style = checkStyle(c.req.query('style'));
  const p = await profile(c.env.DB, id);
  const answers = profileAnswers(p);
  const set = await starter(c.env.DB, c.get('staff').tenantId ?? null, style, c.req.query('initialMenu') === 'true' || answers.image?.value === 'simple');
  let preview = await Promise.all(set.definition.items.filter(item=>item.kind==='rich_menu').map(async item=>{
    const saved=c.req.query('initialMenu')==='true'?null:await savedStyleMenuPreview(c.env.DB,id,style,item);
    return saved??{key:item.key,initialMenu:item.initialMenu,buttons:await styleMenuButtons(c.env.DB,id,style,item,answers)};
  }));
  if(answers.image?.value==='existing'&&answers.image.resourceId)preview=preview.filter(menu=>'targetId' in menu&&menu.targetId===answers.image.resourceId);
  return c.json({ success: true, data: { ...set, preview } });
});
styles.route('/',styleTemplateSamples);



styles.get(base + '/resources', requireRole('owner', 'admin'), async (c) => {
  const id = await account(c);
  const resources: Array<{ id: string; name: string; kind: string }> = [];
  for (const [kind, table, column] of [
    ['template', 'templates', 'line_account_id'],
    ['rich_menu', 'rich_menu_groups', 'account_id'],
    ['automation', 'automation_definitions', 'line_account_id'],
    ['reminder', 'reminders', 'line_account_id'],
    ['booking_menu', 'menus', 'line_account_id'],
  ] as const) {
    const rows = (
      await c.env.DB.prepare(
        `SELECT id,name FROM ${table} WHERE ${column}=? ORDER BY name LIMIT 500`,
      )
        .bind(id)
        .all<{ id: string; name: string }>()
    ).results;
    const enriched = await withStyleSampleMetadata(c.env.DB, rows, kind);
    resources.push(
      ...enriched.map((r) => ({
        ...r,
        kind,
        key: r.sampleKey,
        setId: r.starterSetId,
        setVersion: r.starterSetVersion,
      })),
    );
  }
  const images = (
    await c.env.DB.prepare(
      `SELECT p.id,p.name FROM rich_menu_pages p JOIN rich_menu_groups g ON g.id=p.group_id WHERE g.account_id=? AND p.image_r2_key IS NOT NULL LIMIT 500`,
    )
      .bind(id)
      .all<{ id: string; name: string }>()
  ).results;
  resources.push(
    ...images.map((r) => ({
      ...r,
      kind: 'image',
    })),
  );
  return c.json({ success: true, data: { items: resources } });
});

styles.put(base + '/cards', async (c) => {
  edit(c);
  const id = await account(c),
    p = await profile(c.env.DB, id);
  if (!p) throw new StyleError('select_style_first', 409);
  const b = await json(c);
  version(b.expectedVersion, p.version);
  const cards =
    b.cards === undefined
      ? p.cards_json
        ? readCards(JSON.parse(p.cards_json), p.style)
        : defaultCards(p.style)
      : readCards(b.cards, p.style);
  const metrics =
    b.metricIds === undefined
      ? p.metrics_json
        ? JSON.parse(p.metrics_json)
        : null
      : readMetricIds(b.metricIds);
  const result = await c.env.DB.prepare(
    'UPDATE account_styles SET cards_json=?,metrics_json=?,version=version+1,updated_at=?,updated_by=? WHERE line_account_id=? AND version=?',
  )
    .bind(
      JSON.stringify(cards),
      metrics === null ? null : JSON.stringify(metrics),
      new Date().toISOString(),
      c.get('staff').id,
      id,
      p.version,
    )
    .run();
  if (!result.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({
    success: true,
    data: {
      ...dashboardPresentation(p.style, cards, metrics),
      metricsCustomized: metrics !== null,
      version: p.version + 1,
    },
  });
});

styles.delete(base + '/cards', async (c) => {
  edit(c);
  const id = await account(c),
    p = await profile(c.env.DB, id),
    b = await json(c);
  if (!p) throw new StyleError('select_style_first', 409);
  version(b.expectedVersion, p.version);
  const r = await c.env.DB.prepare(
    'UPDATE account_styles SET cards_json=NULL,metrics_json=NULL,version=version+1 WHERE line_account_id=? AND version=?',
  )
    .bind(id, p.version)
    .run();
  if (!r.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({
    success: true,
    data: {
      ...dashboardPresentation(p.style, defaultCards(p.style), null),
      metricsCustomized: false,
      version: p.version + 1,
    },
  });
});

for (const path of [
  '/summary',
  '/analytics',
  '/bookings',
  '/people',
  '/schedule',
])
  styles.get(base + path, async (c) => {
    const id = await account(c),
      p = await profile(c.env.DB, id),
      style = checkStyle(c.req.query('style') ?? p?.style);
    if (style === 'standard' || style === 'ec')
      throw new StyleError('industry_required');
    if (
      style === 'restaurant' &&
      !(await restaurantEffectivelyEnabledForAccount(c, id))
    )
      throw new StyleError('not_found', 404);
    if (
      style !== 'restaurant' &&
      !(await accountFeatureIsEnabled(
        c.env.DB,
        id,
        style === 'lesson' ? 'events' : 'booking',
      ))
    )
      throw new StyleError('feature_disabled', 403);
    const permission =
      style === 'restaurant'
        ? '/restaurant-test/reservations'
        : style === 'lesson'
          ? '/events'
          : '/booking/bookings';
    if (!hasStaffPermission(c, permission))
      throw new StyleError('forbidden', 403);
    const staffId = await staffFilter(c, id, style);
    const kinds: import('@line-crm/shared').StyleBooking['kind'][] = [];
    if (
      hasStaffPermission(c, '/booking/bookings') &&
      (await accountFeatureIsEnabled(c.env.DB, id, 'booking'))
    )
      kinds.push('booking', 'meet');
    if (
      hasStaffPermission(c, '/events') &&
      (await accountFeatureIsEnabled(c.env.DB, id, 'events'))
    )
      kinds.push('event');
    if (
      (await restaurantEffectivelyEnabledForAccount(c, id)) &&
      hasStaffPermission(c, '/restaurant-test/reservations')
    )
      kinds.push('restaurant');
    let ownMeetStaffId: string | undefined;
    if (c.get('staff').role === 'staff' && kinds.includes('meet')) {
      const own = await c.env.DB.prepare(
        'SELECT id FROM staff WHERE line_account_id=? AND staff_member_id=? AND is_active=1',
      )
        .bind(id, c.get('staff').id)
        .first<{ id: string }>();
      if (own) ownMeetStaffId = own.id;
      else kinds.splice(kinds.indexOf('meet'), 1);
    }
    const bookingAccess = { kinds, ownMeetStaffId };
    if (path === '/schedule') {
      const data = await styleSchedule(
        c.env.DB,
        id,
        { style, ...(await styleWindow(c.env.DB, id, c.req.query())) },
        c.req.query(),
        staffId,
        {
          email: c.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          privateKey: c.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        },
        bookingAccess,
      );
      const badges = hasStaffPermission(c, '/booking/bookings')
        ? await paymentBadges(
            c.env.DB,
            id,
            data.entries.flatMap((e) =>
              e.booking?.kind === 'booking' ? [e.booking.id] : [],
            ),
          )
        : new Map();
      data.entries = data.entries.map((e) => ({
        ...e,
        booking: e.booking
          ? {
              ...e.booking,
              payment:
                e.booking.kind === 'booking'
                  ? (badges.get(e.booking.id) ?? null)
                  : null,
            }
          : null,
      }));
      return c.json({ success: true, data });
    }
    const data = await styleSnapshot(
      c.env.DB,
      id,
      style,
      c.req.query(),
      staffId,
      Date.now(),
      bookingAccess,
    );
    const badges = hasStaffPermission(c, '/booking/bookings')
      ? await paymentBadges(
          c.env.DB,
          id,
          [...data.items, ...data.newBookings]
            .filter((r) => r.kind === 'booking')
            .map((r) => r.id),
        )
      : new Map();
    data.items = data.items.map((r) => ({
      ...r,
      payment: r.kind === 'booking' ? (badges.get(r.id) ?? null) : null,
    }));
    data.newBookings = data.newBookings.map((r) => ({
      ...r,
      payment: r.kind === 'booking' ? (badges.get(r.id) ?? null) : null,
    }));
    const payments = hasStaffPermission(c, '/booking/bookings')
      ? {
          status: 'available',
          ...(path === '/analytics'
            ? { ...(await paymentSummaryInWindow(c.env.DB, id, data, staffId)), period: { from: data.from, to: data.to, timeZone: data.timeZone, dateBasis: 'payment' } }
            : await paymentSummary(c.env.DB, id, new Date(), 'today', staffId)),
          source: '/api/booking/admin/payments',
        }
      : { status: 'forbidden' };
    return c.json({ success: true, data: { ...data, payments } });
  });

styles.post(base + '/results/:id/audiences', async (c) => {
  edit(c);
  const id = await account(c);
  return c.json(
    {
      success: true,
      data: await bookingAudience(
        c,
        c.req.param('id') ?? '',
        await json(c),
        id,
      ),
    },
    201,
  );
});

styles.patch(base + '/menus/:id', async (c) => {
  edit(c, '/booking/menus');
  const a = await account(c),
    b = await json(c);
  const r = await c.env.DB.prepare(
    'SELECT version FROM menus WHERE id=? AND line_account_id=?',
  )
    .bind(c.req.param('id'), a)
    .first<{ version: number }>();
  if (!r) throw new StyleError('not_found', 404);
  version(b.expectedVersion, r.version);
  const mode = oneOf(b.meetingMode, ['online', 'in_person', 'customer_choice']);
  const result = await c.env.DB.prepare(
    'UPDATE menus SET meeting_mode=?,meeting_location=?,version=version+1 WHERE id=? AND line_account_id=? AND version=?',
  )
    .bind(mode, text(b.location), c.req.param('id'), a, r.version)
    .run();
  if (!result.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({
    success: true,
    data: {
      version: r.version + 1,
      meetingMode: mode,
      location: text(b.location),
    },
  });
});
