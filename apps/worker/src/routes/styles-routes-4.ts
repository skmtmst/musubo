import {styleMeetUpdates} from './style-meet-updates.js';
import { validateReminderDraft } from '../services/reminder-draft.js';
import {
  resourceTables,
  snapshotSql,
} from '../services/style-starter-resource.js';
import {
  automationRevisionToken,
  publishAutomationDraft,
} from '../features/automations/automation-drafts/index.js';

import { Hono } from 'hono';
import { starter } from '../services/style-starter-set.js';
import { STARTER_ITEM_KINDS } from '../services/style-starter-definition.js';

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
  // All dynamic identifiers come from the fixed resource table map, not from a request.
  const names = Object.entries(resourceTables).map(([kind, table]) =>
    `WHEN '${kind}' THEN (SELECT name FROM ${table.table} WHERE id=i.target_id AND ${table.account}=i.line_account_id)`).join(' ');
  const snapshots = STARTER_ITEM_KINDS.map((kind) => {
    let index = 0;
    const expression = snapshotSql(kind).replace(/\?/g, () =>
      index++ === 0 && kind !== 'dashboard' ? 'i.target_id' : 'i.line_account_id');
    return `WHEN '${kind}' THEN ${expression}`;
  }).join(' ');
  const details = includeContents ? `,
    CASE i.kind ${snapshots} END AS _snapshot,
    CASE i.kind
      WHEN 'rich_menu' THEN (SELECT json_group_array(json_object('label',x.label,'actionType',x.actionType,'actionData',x.actionData)) FROM (SELECT a.label,a.action_type actionType,a.action_data actionData FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id WHERE p.group_id=i.target_id AND p.group_id IN(SELECT id FROM rich_menu_groups WHERE account_id=i.line_account_id) ORDER BY p.order_index,a.bounds_y,a.bounds_x) x)
      WHEN 'reminder' THEN (SELECT json_group_array(json_object('offsetMinutes',x.offsetMinutes,'offsetDays',x.offsetDays,'sendAtTime',x.sendAtTime,'text',x.text)) FROM (SELECT s.offset_minutes offsetMinutes,s.offset_days offsetDays,s.send_at_time sendAtTime,s.message_content text FROM reminder_version_steps s JOIN reminders r ON r.current_draft_version_id=s.reminder_version_id WHERE r.id=i.target_id AND r.line_account_id=i.line_account_id ORDER BY s.position) x)
      WHEN 'scenario' THEN (SELECT json_group_array(json_object('delayMinutes',x.delayMinutes,'text',x.text)) FROM (SELECT s.delay_minutes delayMinutes,s.message_content text FROM scenario_steps s JOIN scenarios r ON r.id=s.scenario_id WHERE r.id=i.target_id AND r.line_account_id=i.line_account_id ORDER BY s.step_order) x)
    END AS _definition` : '';
  type Extra = { _name: string | null; _status: string | null; _automation: string | null; _reminder_revision: string | null; _snapshot?: string | null; _definition?: string | null };
  const rows = (await c.env.DB.prepare(`SELECT i.*,
    CASE i.kind WHEN 'form' THEN (SELECT f.name FROM forms f JOIN form_accounts a ON a.form_id=f.id WHERE f.id=i.target_id AND a.line_account_id=i.line_account_id LIMIT 1) ${names} END AS _name,
    CASE i.kind
      WHEN 'automation' THEN COALESCE((SELECT status FROM automation_definitions WHERE id=i.target_id AND line_account_id=i.line_account_id),'missing')
      WHEN 'form' THEN COALESCE((SELECT CASE WHEN is_active=1 AND current_published_version_id IS NOT NULL THEN 'active' ELSE 'draft' END FROM forms f WHERE id=i.target_id AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=f.id AND a.line_account_id=i.line_account_id) AND f.status!='archived'),'missing')
      WHEN 'reminder' THEN COALESCE((SELECT lifecycle_status FROM reminders WHERE id=i.target_id AND line_account_id=i.line_account_id),'missing')
      WHEN 'booking_menu' THEN CASE WHEN (SELECT is_active FROM menus WHERE id=i.target_id AND line_account_id=i.line_account_id) THEN 'active' ELSE 'stopped' END
      WHEN 'rich_menu' THEN COALESCE((SELECT status FROM rich_menu_groups WHERE id=i.target_id AND account_id=i.line_account_id),'missing')
      WHEN 'scenario' THEN CASE WHEN (SELECT is_active FROM scenarios WHERE id=i.target_id AND line_account_id=i.line_account_id) THEN 'active' ELSE 'stopped' END
      WHEN 'tag_set' THEN 'held'
      WHEN 'friend_add_rule' THEN COALESCE((SELECT CASE WHEN EXISTS(SELECT 1 FROM friend_add_rule_versions v WHERE v.rule_id=r.id AND v.status='draft') THEN 'draft' ELSE r.status END FROM friend_add_rules r WHERE r.id=i.target_id AND r.line_account_id=i.line_account_id),'missing')
    END AS _status,
    CASE WHEN i.kind='automation' THEN (SELECT json_object('current_draft_version_id',d.current_draft_version_id,'trigger_type',v.trigger_type,'trigger_config',v.trigger_config,'condition_config',v.condition_config,'action_config',v.action_config) FROM automation_definitions d LEFT JOIN automation_versions v ON v.id=d.current_draft_version_id WHERE d.id=i.target_id AND d.line_account_id=i.line_account_id) END AS _automation,
    CASE WHEN i.kind='reminder' THEN (SELECT current_draft_version_id FROM reminders WHERE id=i.target_id AND line_account_id=i.line_account_id) END AS _reminder_revision
    ${details}
    FROM style_starter_items i WHERE i.line_account_id=? ORDER BY i.applied_at,i.item_key`).bind(a).all<Record<string, unknown> & Extra>()).results;
  // The same set supplies all tag entries; do not read the profile once per item.
  let tagItems: Awaited<ReturnType<typeof starter>>['definition']['items'] = [];
  if (rows.some(item => item.kind === 'tag_set')) {
    const p = await profile(c.env.DB, a);
    if (p) try { tagItems = (await starter(c.env.DB, staff?.tenantId ?? null, p.style)).definition.items; }
    catch (error) { if (!(error instanceof StyleError)) throw error; }
  }
  const items = [];
  for (const row of rows) {
    const { _name, _status, _automation, _reminder_revision, _snapshot, _definition, ...item } = row;
    if (includeContents && !STARTER_ITEM_KINDS.includes(item.kind as typeof STARTER_ITEM_KINDS[number])) throw new StyleError('invalid_resource');
    const automation = _automation ? JSON.parse(_automation) as {current_draft_version_id:string|null;trigger_type:string;trigger_config:string;condition_config:string;action_config:string} : null;
    const blockedConfirmation = item.kind === 'automation' && (item.item_key === 'reminder' || automation?.trigger_type === 'calendar_booked');
    let draftRevision: string | null = item.kind === 'reminder' ? _reminder_revision : null;
    if (includeContents && automation?.current_draft_version_id) draftRevision = await automationRevisionToken(automation.current_draft_version_id, automation);
    const tag = item.kind === 'tag_set' ? tagItems.find(i => i.key === item.item_key && i.kind === 'tag_set') : null;
    const name = _name ?? tag?.name ?? null;
    const requiresActivation = ['automation', 'reminder', 'booking_menu', 'rich_menu', 'friend_add_rule', 'tag_set', 'scenario'].includes(String(item.kind)) && !blockedConfirmation;
    const activationAllowed = !blockedConfirmation && !['form', 'friend_add_rule', 'tag_set', 'scenario'].includes(String(item.kind));
    if (!includeContents) {
      items.push({ target_id:item.target_id, kind:item.kind, key:item.item_key, name, is_sample:item.is_sample, isSample:!!item.is_sample, status:_status, draftRevision:null, requiresActivation, activationAllowed });
      continue;
    }
    const definition = item.kind === 'rich_menu' ? { buttons: JSON.parse(_definition ?? '[]') } : item.kind === 'reminder' || item.kind === 'scenario' ? { steps: JSON.parse(_definition ?? '[]') } : item.kind === 'tag_set' ? { tags:tag?.tags ?? [] } : null;
    items.push({ ...item, definition, key:item.item_key, name, isSample:!!item.is_sample, setId:item.set_id, setVersion:item.set_version, pendingUpdate:item.pending_update ? JSON.parse(String(item.pending_update)) : null, requiresActivation, activationAllowed,
      href:item.kind==='form' ? `/form-submissions/edit?id=${encodeURIComponent(String(item.target_id))}&tab=basic` : item.kind === 'reminder' ? '/reminders' : item.kind === 'friend_add_rule' ? '/friend-add-settings' : item.kind === 'scenario' ? '/scenarios' : item.kind === 'tag_set' ? '/tags' : undefined,
      currentSnapshot:_snapshot ?? null, status:_status, draftRevision });
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

/** 確認時の予約と版を固定し、変更があれば休業を1件も作らない。 */
styles.post(base + '/closures/confirmation', async (c) => {
  edit(c, 'booking.settings');
  const a = await account(c), b = await json(c);
  const { parseClosureConfirmation, readClosureSnapshot, readClosureExceptionSnapshot } = await import('../services/style-closure-confirmation.js');
  const input = parseClosureConfirmation(b);
  const accountRow = await c.env.DB.prepare(`SELECT COALESCE(timezone,'Asia/Tokyo') AS timezone FROM line_accounts WHERE id=?`).bind(a).first<{ timezone: string }>();
  if (!accountRow) throw new StyleError('not_found', 404);
  const result = await readClosureSnapshot(c.env.DB, a, input, accountRow.timezone);
  const exceptions = await readClosureExceptionSnapshot(c.env.DB, a, input);
  return c.json({ success: true, data: { reservations: result.reservations, snapshot: JSON.stringify({ input, timezone: accountRow.timezone, rows: result.snapshot, exceptions }) } });
});

styles.post(base + '/closures/confirmed', async (c) => {
  edit(c, 'booking.settings');
  const a = await account(c), b = await json(c);
  const { parseClosureConfirmation, closureSnapshotQuery, closureExceptionSnapshotQuery, readClosureSnapshot } = await import('../services/style-closure-confirmation.js');
  const input = parseClosureConfirmation(b);
  if (typeof b.expectedSnapshot !== 'string' || b.expectedSnapshot.length > 90000) throw new StyleError('invalid_confirmation');
  let expected: { input: unknown; timezone: string; rows: string; exceptions: string };
  try { expected = JSON.parse(b.expectedSnapshot); } catch { throw new StyleError('invalid_confirmation'); }
  if (!expected || typeof expected.timezone !== 'string' || typeof expected.rows !== 'string' || typeof expected.exceptions !== 'string') throw new StyleError('invalid_confirmation');
  const db = c.env.DB;
  const row = await db.prepare(`SELECT COALESCE(timezone,'Asia/Tokyo') AS timezone FROM line_accounts WHERE id=?`).bind(a).first<{ timezone: string }>();
  if (!row) throw new StyleError('not_found', 404);
  if (row.timezone !== expected.timezone || JSON.stringify(expected.input) !== JSON.stringify(input)) {
    const current = await readClosureSnapshot(db, a, input, row.timezone);
    return c.json({ success: false, error: 'confirmation_changed', code: 'confirmation_changed', data: { count: current.reservations.length } }, 409);
  }
  const query = closureSnapshotQuery(a, input, row.timezone);
  const exceptions = closureExceptionSnapshotQuery(a, input);
  const writes: D1PreparedStatement[] = [db.prepare(`SELECT json(CASE WHEN (${query.sql})=? AND (${exceptions.sql})=? AND EXISTS(
    SELECT 1 FROM line_accounts WHERE id=? AND COALESCE(timezone,'Asia/Tokyo')=?) THEN '{}' ELSE 'CLOSURE_CONFIRMATION_CHANGED' END)`)
    .bind(...query.binds, expected.rows, ...exceptions.binds, expected.exceptions, a, row.timezone)];
  for (const scopeId of input.target === 'staff' ? input.staffIds : [null]) {
    let open: Array<{ start: string; end: string }> = [];
    if (!input.allDay) {
      const weekday = new Date(input.date + 'T00:00:00Z').getUTCDay();
      if (scopeId === null) {
        open = (await db.prepare(`SELECT h.start_time start,h.end_time end FROM booking_business_hours h JOIN booking_settings s ON s.id=h.booking_settings_id WHERE s.line_account_id=? AND h.weekday=?`)
          .bind(a, weekday).all<{ start: string; end: string }>()).results;
      } else {
        const shifts = (await db.prepare(`SELECT sh.start_time start,sh.end_time end FROM staff_shifts sh JOIN staff s ON s.id=sh.staff_id WHERE s.line_account_id=? AND s.id=? AND sh.work_date=?`)
          .bind(a, scopeId, input.date).all<{ start: string; end: string }>()).results;
        open = shifts.length ? shifts : (await db.prepare(`SELECT r.start_time start,r.end_time end FROM staff_availability_rules r JOIN staff s ON s.id=r.staff_id WHERE s.line_account_id=? AND s.id=? AND r.weekday=? AND r.is_active=1`)
          .bind(a, scopeId, weekday).all<{ start: string; end: string }>()).results;
      }
      const existing = await db.prepare(`SELECT 1 FROM booking_availability_exceptions WHERE line_account_id=? AND date_from<=? AND date_to>=? AND (scope_kind='store' OR (scope_kind='staff' AND scope_id IS ?)) LIMIT 1`)
        .bind(a, input.date, input.date, scopeId).first();
      if (existing) throw new StyleError('existing_exception_use_edit', 409);
      if (!open.length) throw new StyleError('working_hours_unconfigured', 422);
      open = open.flatMap(i => i.end <= input.startTime! || i.start >= input.endTime! ? [i] : [
        ...(i.start < input.startTime! ? [{ start: i.start, end: input.startTime! }] : []),
        ...(i.end > input.endTime! ? [{ start: input.endTime!, end: i.end }] : []),
      ]);
    }
    const now = new Date().toISOString(), id = crypto.randomUUID();
    writes.push(db.prepare(`INSERT INTO booking_availability_exceptions
      (id,line_account_id,scope_kind,scope_id,date_from,date_to,kind,hours_json,reason,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS(SELECT 1 FROM staff WHERE id=? AND line_account_id=? AND is_active=1))
        AND (?=1 OR NOT EXISTS(SELECT 1 FROM booking_availability_exceptions
          WHERE line_account_id=? AND date_from<=? AND date_to>=? AND (scope_kind='store' OR (scope_kind='staff' AND scope_id IS ?))))`)
      .bind(id, a, input.target, scopeId, input.date, input.date, input.allDay || !open.length ? 'closed' : 'custom_hours', JSON.stringify(open), input.reason, now, now, scopeId, scopeId, a, Number(input.allDay), a, input.date, input.date, scopeId));
    writes.push(db.prepare(`SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'CLOSURE_SCOPE_CHANGED' END)`));
  }
  try { await db.batch(writes); }
  catch (error) {
    if (!String(error).includes('malformed JSON')) throw error;
    const current = await readClosureSnapshot(db, a, input, row.timezone);
    return c.json({ success: false, error: 'confirmation_changed', code: 'confirmation_changed', data: { count: current.reservations.length } }, 409);
  }
  return c.json({ success: true, data: { count: input.target === 'staff' ? input.staffIds.length : 1 } }, 201);
});
