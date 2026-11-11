import {styleMeetUpdates} from './style-meet-updates.js';
import { validateReminderDraft } from '../services/reminder-draft.js';
import {
  resourceTables,
  resourceSnapshot,
} from '../services/style-starter-resource.js';
import {
  automationRevisionToken,
  publishAutomationDraft,
} from '../features/automations/automation-drafts/index.js';

import { Hono, type Context } from 'hono';
import { starter } from '../services/style-starter-set.js';

import {
  getReminderDraftVersion,
  parseReminderVersionSettings,
  publishReminderDraftVersion,
  createBookingAvailabilityException,
} from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { hasStaffPermission } from '../middleware/role-guard.js';
import { StyleError, profile } from '../services/style-setup.js';

import { validRestaurantDate } from '../services/restaurant-booking.js';
import { accountOpeningHours, openingDay } from '../services/account-opening-hours.js';
import { base, account, json, edit, text, oneOf } from './styles-common.js';
export const styles = new Hono<Env>();

/** タグの見本はタグの表に行を持たないので、見本の名前を今の初期セットの組から読む。 */
async function heldTagSet(c: Context<Env>, a: string, key: string) {
  const p = await profile(c.env.DB, a);
  if (!p) return null;
  try {
    const set = await starter(c.env.DB, c.get('staff')?.tenantId ?? null, p.style);
    return set.definition.items.find((i) => i.key === key && i.kind === 'tag_set') ?? null;
  } catch (error) {
    // 統括の組が読めない形でも、一覧そのものは返す。
    if (error instanceof StyleError) return null;
    throw error;
  }
}

// 空きの例外設定を使い、既存予約を取り消さない。
styles.post(base + '/closures', async (c) => {
  edit(c, 'booking.settings');
  const a = await account(c),
    b = await json(c);
  const date = text(b.date, 10),
    target = oneOf(b.target, ['store', 'staff']);
  if (!date || !validRestaurantDate(date)) throw new StyleError('invalid_date');
  const start = text(b.startTime, 5),
    end = text(b.endTime, 5),
    allDay = b.allDay === true;
  if (
    !allDay &&
    (!start ||
      !end ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) ||
      start >= end)
  )
    throw new StyleError('invalid_time');
  const scopeId = target === 'staff' ? text(b.staffId, 100) : null;
  if (target === 'staff' && !scopeId) throw new StyleError('staff_required');
  let open: Array<{ start: string; end: string }> = [];
  if (!allDay) {
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    if (target === 'store') {
      const google = openingDay(await accountOpeningHours(c.env.DB, a), date);
      open = google ?? (
        await c.env.DB.prepare(
          `SELECT h.start_time start,h.end_time end FROM booking_business_hours h JOIN booking_settings s ON s.id=h.booking_settings_id WHERE s.line_account_id=? AND h.weekday=?`,
        )
          .bind(a, weekday)
          .all<{ start: string; end: string }>()
      ).results;
    } else {
      const shifts = (
        await c.env.DB.prepare(
          `SELECT sh.start_time start,sh.end_time end FROM staff_shifts sh JOIN staff s ON s.id=sh.staff_id WHERE s.line_account_id=? AND s.id=? AND sh.work_date=?`,
        )
          .bind(a, scopeId, date)
          .all<{ start: string; end: string }>()
      ).results;
      open = shifts.length
        ? shifts
        : (
            await c.env.DB.prepare(
              `SELECT r.start_time start,r.end_time end FROM staff_availability_rules r JOIN staff s ON s.id=r.staff_id WHERE s.line_account_id=? AND s.id=? AND r.weekday=? AND r.is_active=1`,
            )
              .bind(a, scopeId, weekday)
              .all<{ start: string; end: string }>()
          ).results;
    }
    const existing = (
      await c.env.DB.prepare(
        "SELECT scope_kind,scope_id,kind,hours_json FROM booking_availability_exceptions WHERE line_account_id=? AND date_from<=? AND date_to>=? AND (scope_kind='store' OR (scope_kind=? AND scope_id IS ?)) ORDER BY created_at,id",
      )
        .bind(a, date, date, target, scopeId)
        .all<{
          kind: string;
          hours_json: string;
          scope_kind: string;
          scope_id: string | null;
        }>()
    ).results;
    if (existing.length)
      throw new StyleError('existing_exception_use_edit', 409);
    if (!open.length) throw new StyleError('working_hours_unconfigured', 422);
    open = open.flatMap((i) => {
      if (i.end <= start! || i.start >= end!) return [i];
      return [
        ...(i.start < start! ? [{ start: i.start, end: start! }] : []),
        ...(i.end > end! ? [{ start: end!, end: i.end }] : []),
      ];
    });
  }
  const item = await createBookingAvailabilityException(c.env.DB, {
    lineAccountId: a,
    scopeKind: target as 'store' | 'staff',
    scopeId,
    dateFrom: date,
    dateTo: date,
    kind: allDay || !open.length ? 'closed' : 'custom_hours',
    intervals: allDay ? [] : open,
    reason: text(b.reason),
  });
  if (!item) throw new StyleError('scope_not_found', 404);
  return c.json(
    {
      success: true,
      data: { exception: item, existingReservationsCancelled: false },
    },
    201,
  );
});
styles.route('/',styleMeetUpdates);


styles.get(base + '/starter-items', async (c) => {
  const a = await account(c);
  const staff = c.get('staff');
  const includeContents = Boolean(staff && !staff.readOnly && (['owner', 'admin'].includes(staff.role) || staff.hqRole === 'operator'));
  const rows = (
    await c.env.DB.prepare(
      'SELECT * FROM style_starter_items WHERE line_account_id=? ORDER BY applied_at,item_key',
    )
      .bind(a)
      .all<Record<string, unknown>>()
  ).results;
  const items = [];
  for (const item of rows) {
    let status: unknown = null,
      draftRevision: string | null = null;
    let blockedConfirmation =
      item.kind === 'automation' && item.item_key === 'reminder';
    if (item.kind === 'automation') {
      const row = await c.env.DB.prepare(
        `SELECT d.status,d.current_draft_version_id,v.trigger_type,v.trigger_config,v.condition_config,v.action_config FROM automation_definitions d LEFT JOIN automation_versions v ON v.id=d.current_draft_version_id WHERE d.id=? AND d.line_account_id=?`,
      )
        .bind(item.target_id, a)
        .first<{
          status: string;
          current_draft_version_id: string | null;
          trigger_type: string;
          trigger_config: string;
          condition_config: string;
          action_config: string;
        }>();
      status = row?.status ?? 'missing';
      blockedConfirmation =
        blockedConfirmation || row?.trigger_type === 'calendar_booked';
      if (includeContents && row?.current_draft_version_id)
        draftRevision = await automationRevisionToken(
          row.current_draft_version_id,
          row,
        );
    } else if(item.kind==='form') {
      status=(await c.env.DB.prepare(`SELECT CASE WHEN is_active=1 AND current_published_version_id IS NOT NULL THEN 'active' ELSE 'draft' END status FROM forms f WHERE id=? AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=f.id AND a.line_account_id=?) AND f.status!='archived'`).bind(item.target_id,a).first<{status:string}>())?.status??'missing';
    } else if (item.kind === 'reminder') {
      const row = await c.env.DB.prepare(
        'SELECT lifecycle_status status,current_draft_version_id FROM reminders WHERE id=? AND line_account_id=?',
      )
        .bind(item.target_id, a)
        .first<{ status: string; current_draft_version_id: string | null }>();
      status = row?.status ?? 'missing';
      draftRevision = row?.current_draft_version_id ?? null;
    } else if (item.kind === 'booking_menu')
      status = (
        await c.env.DB.prepare(
          'SELECT is_active FROM menus WHERE id=? AND line_account_id=?',
        )
          .bind(item.target_id, a)
          .first<{ is_active: number }>()
      )?.is_active
        ? 'active'
        : 'stopped';
    else if (item.kind === 'rich_menu')
      status =
        (
          await c.env.DB.prepare(
            'SELECT status FROM rich_menu_groups WHERE id=? AND account_id=?',
          )
            .bind(item.target_id, a)
            .first<{ status: string }>()
        )?.status ?? 'missing';
    else if (item.kind === 'scenario')
      status =
        (
          await c.env.DB.prepare(
            'SELECT is_active FROM scenarios WHERE id=? AND line_account_id=?',
          )
            .bind(item.target_id, a)
            .first<{ is_active: number }>()
        )?.is_active
          ? 'active'
          : 'stopped';
    else if (item.kind === 'tag_set') status = 'held';
    else if (item.kind === 'friend_add_rule')
      // 受け皿に下書きがある間は「下書き」。公開は友だち追加の画面の確認窓からだけ。
      status =
        (
          await c.env.DB.prepare(
            "SELECT CASE WHEN EXISTS(SELECT 1 FROM friend_add_rule_versions v WHERE v.rule_id=r.id AND v.status='draft') THEN 'draft' ELSE r.status END status FROM friend_add_rules r WHERE r.id=? AND r.line_account_id=?",
          )
            .bind(item.target_id, a)
            .first<{ status: string }>()
        )?.status ?? 'missing';
    const requiresActivation = ['automation', 'reminder', 'booking_menu', 'rich_menu', 'friend_add_rule', 'tag_set', 'scenario'].includes(String(item.kind)) && !blockedConfirmation;
    const activationAllowed = !blockedConfirmation && !['form', 'friend_add_rule', 'tag_set', 'scenario'].includes(String(item.kind));
    const table = resourceTables[String(item.kind)];
    const resource = item.kind==='form' ? await c.env.DB.prepare('SELECT f.name FROM forms f JOIN form_accounts a ON a.form_id=f.id WHERE f.id=? AND a.line_account_id=?').bind(item.target_id,a).first<{name:string}>() : table
      ? await c.env.DB.prepare(
          `SELECT name FROM ${table.table} WHERE id=? AND ${table.account}=?`,
        )
          .bind(item.target_id, a)
          .first<{ name: string }>()
      : null;
    if (!includeContents) {
      // 本文の権限を持たない人には、進み具合に必要なメタ情報だけを返す。
      items.push({
        target_id: item.target_id,
        kind: item.kind,
        key: item.item_key,
        name: resource?.name ?? (item.kind === 'tag_set' ? (await heldTagSet(c, a, String(item.item_key)))?.name ?? null : null),
        is_sample: item.is_sample,
        isSample: !!item.is_sample,
        status,
        draftRevision: null,
        requiresActivation,
        activationAllowed,
      });
      continue;
    }
    const definition =
      item.kind === 'rich_menu'
        ? {
            buttons: (
              await c.env.DB.prepare(
                `SELECT a.label,a.action_type actionType,a.action_data actionData FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id WHERE p.group_id=? AND p.group_id IN(SELECT id FROM rich_menu_groups WHERE account_id=?) ORDER BY p.order_index,a.bounds_y,a.bounds_x`,
              )
                .bind(item.target_id, a)
                .all()
            ).results,
          }
        : item.kind === 'reminder'
          ? {
              steps: (
                await c.env.DB.prepare(
                  `SELECT s.offset_minutes offsetMinutes,s.offset_days offsetDays,s.send_at_time sendAtTime,s.message_content text FROM reminder_version_steps s JOIN reminders r ON r.current_draft_version_id=s.reminder_version_id WHERE r.id=? AND r.line_account_id=? ORDER BY s.position`,
                )
                  .bind(item.target_id, a)
                  .all()
              ).results,
            }
          : item.kind === 'scenario'
            ? {
                steps: (
                  await c.env.DB.prepare(
                    `SELECT s.delay_minutes delayMinutes,s.message_content text FROM scenario_steps s JOIN scenarios r ON r.id=s.scenario_id WHERE r.id=? AND r.line_account_id=? ORDER BY s.step_order`,
                  )
                    .bind(item.target_id, a)
                    .all()
                ).results,
              }
            : item.kind === 'tag_set'
              ? { tags: (await heldTagSet(c, a, String(item.item_key)))?.tags ?? [] }
              : null;
    items.push({
      ...item,
      definition,
      key: item.item_key,
      name: resource?.name ?? (item.kind === 'tag_set' ? (await heldTagSet(c, a, String(item.item_key)))?.name ?? null : null),
      isSample: !!item.is_sample,
      setId: item.set_id,
      setVersion: item.set_version,
      pendingUpdate: item.pending_update
        ? JSON.parse(String(item.pending_update))
        : null,
      requiresActivation,
      // ごあいさつの公開・タグにする・シナリオを動かすは［まとめて動かす］に混ぜない。
      activationAllowed,
      href: item.kind==='form' ? `/form-submissions/edit?id=${encodeURIComponent(String(item.target_id))}&tab=basic` : item.kind === 'reminder' ? '/reminders' : item.kind === 'friend_add_rule' ? '/friend-add-settings' : item.kind === 'scenario' ? '/scenarios' : item.kind === 'tag_set' ? '/tags' : undefined,
      currentSnapshot: await resourceSnapshot(
        c.env.DB,
        a,
        String(item.kind),
        String(item.target_id),
      ),
      status,
      draftRevision,
    });
  }
  return c.json({ success: true, data: { items } });
});

styles.post(base + '/activate', async (c) => {
  edit(c);
  const a = await account(c),
    b = await json(c);
  if (
    b.confirmed !== true ||
    !Array.isArray(b.items) ||
    !b.items.length ||
    b.items.length > 30
  )
    throw new StyleError('confirmation_required');
  const seen = new Set<string>();
  for (const item of b.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      seen.has(item.id) ||
      !['automation', 'reminder', 'booking_menu'].includes(item.kind)
    )
      throw new StyleError('invalid_activation');
    seen.add(item.id);
    if (
      !(await c.env.DB.prepare(
        'SELECT 1 FROM style_starter_items WHERE line_account_id=? AND target_id=? AND kind=? AND is_sample=1',
      )
        .bind(a, item.id, item.kind)
        .first())
    )
      throw new StyleError('not_found', 404);
  }
  const items = [];
  for (const item of b.items) {
    try {
      const legacy = await c.env.DB.prepare(
        `SELECT item_key FROM style_starter_items WHERE line_account_id=? AND target_id=? AND kind='automation' AND (item_key='reminder' OR EXISTS(SELECT 1 FROM automation_definitions d JOIN automation_versions v ON v.id=d.current_draft_version_id WHERE d.id=style_starter_items.target_id AND d.line_account_id=style_starter_items.line_account_id AND v.trigger_type='calendar_booked'))`,
      )
        .bind(a, item.id)
        .first();
      if (legacy)
        throw new StyleError('duplicate_confirmation_automation', 422);
      if (item.kind === 'reminder') {
        if (!hasStaffPermission(c, '/reminders'))
          throw new StyleError('forbidden', 403);
        const p = await profile(c.env.DB, a),
          answer = JSON.parse(p?.answers_json ?? '{}').reminders;
        if (
          p?.selection_mode !== 'configured' ||
          answer?.mode !== 'configured' ||
          answer.value === false
        )
          throw new StyleError('feature_unconfigured', 422);
        const r = await c.env.DB.prepare(
          'SELECT current_draft_version_id FROM reminders WHERE id=? AND line_account_id=? AND deleted_at IS NULL',
        )
          .bind(item.id, a)
          .first<{ current_draft_version_id: string }>();
        if (!r || r.current_draft_version_id !== item.expectedDraftVersionId)
          throw new StyleError('version_conflict', 409);
        const draft = await getReminderDraftVersion(c.env.DB, item.id);
        if (!draft) throw new StyleError('version_conflict', 409);
        const validation = await validateReminderDraft(
          c.env.DB,
          parseReminderVersionSettings(draft),
          draft,
        );
        if (!validation.valid)
          throw new StyleError(
            draft.last_test_status !== 'succeeded'
              ? 'test_required'
              : 'reminder_configuration_required',
            422,
          );
        const published = await publishReminderDraftVersion(
          c.env.DB,
          item.id,
          c.get('staff').id,
        );
        items.push({ id: item.id, success: true, status: published.status });
      } else if (item.kind === 'automation') {
        if (!hasStaffPermission(c, '/automations'))
          throw new StyleError('forbidden', 403);
        const p = await profile(c.env.DB, a);
        const answer = JSON.parse(p?.answers_json ?? '{}').reminders;
        if (
          p?.selection_mode !== 'configured' ||
          answer?.mode !== 'configured' ||
          answer.value === false
        )
          throw new StyleError('feature_unconfigured', 422);
        const activated = await publishAutomationDraft(c.env.DB, {
          id: item.id,
          lineAccountId: a,
          expectedDraftVersionId: item.expectedDraftVersionId,
          activate: true,
          expectedStatus: 'draft',
        });
        items.push({ id: item.id, success: true, status: activated.status });
      } else {
        const setup = await profile(c.env.DB, a);
        const answer = JSON.parse(setup?.answers_json ?? '{}').booking;
        if (
          setup?.selection_mode !== 'configured' ||
          answer?.mode !== 'configured' ||
          answer.value === false
        )
          throw new StyleError('feature_unconfigured', 422);
        if (!hasStaffPermission(c, '/booking/menus'))
          throw new StyleError('forbidden', 403);
        const r = await c.env.DB.prepare(
          'UPDATE menus SET is_active=1,version=version+1 WHERE id=? AND line_account_id=? AND version=?',
        )
          .bind(item.id, a, item.expectedVersion)
          .run();
        if (!r.meta.changes) throw new StyleError('version_conflict', 409);
        items.push({ id: item.id, success: true, status: 'active' });
      }
    } catch (e) {
      items.push({
        id: item.id,
        success: false,
        code:
          e instanceof StyleError
            ? e.code
            : String(e).includes('REMINDER_DRAFT_NOT_TESTED')
              ? 'test_required'
              : 'activation_failed',
      });
    }
  }
  return c.json({
    success: true,
    data: { complete: items.every((i) => i.success), items },
  });
});
