import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { normalizeEventQuestions, validateEventInput } from '../event-input.js';
import type { EventQuestion } from '../event-input.js';
import { bad } from '../../services/event-input-error.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import type { EventApplicationPreview } from '@line-crm/shared';
import { requireRole } from '../../middleware/role-guard.js';
import { type EventTargetType } from '../../services/event-booking-types.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../../lib/list-paging.js';
import { canAccessAllLineAccounts } from '../../services/account-access.js';
import { canTransitionLifecycle, isLifecycleStatus } from '../../services/event-change-review.js';
import { getAccountId, ACCOUNT_ACCESS_ERROR, validEventFolder, eventDefinitionSnapshot, withFolder } from './input.js';
import { summarizeFutureEventSlots } from './future-slots.js';
import { rebuildRemindersForEvent } from './admin-input.js';

export function registerAdminCatalog(events: Hono<Env>): void {
// ============================================================
// Admin: events CRUD
// ============================================================

events.post('/api/events/admin/application-preview', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return bad(c, 'invalid_body', 400, []);
  const validation = validateEventInput(body, true);
  if (!validation.ok) return bad(c, validation.code, 422, ["name","description","venue_name","venue_address","sort_order","approval_deadline_hours","target_type","account_ids","dedup_priority","questions"]);
  const slot = body.slot as { starts_at?: unknown; ends_at?: unknown; capacity?: unknown } | undefined;
  if (!slot || typeof slot.starts_at !== 'string' || typeof slot.ends_at !== 'string'
    || !Number.isFinite(Date.parse(slot.starts_at)) || !Number.isFinite(Date.parse(slot.ends_at))
    || Date.parse(slot.ends_at) <= Date.parse(slot.starts_at)
    || !Number.isSafeInteger(slot.capacity) || Number(slot.capacity) < 1) return bad(c, 'invalid_slot', 422, ["slot"]);
  const questions = body.questions;
  if (questions != null && (!Array.isArray(questions) || questions.length > 50 || questions.some((q: unknown) => !q || typeof q !== 'object' || typeof (q as Record<string, unknown>).label !== 'string'))) return bad(c, 'invalid_questions', 422, ["questions"]);
  const data: EventApplicationPreview = {
    name: String(body.name), description: body.description as string | null ?? null,
    venueName: body.venue_name as string | null ?? null, venueAddress: body.venue_address as string | null ?? null,
    venueUrl: body.venue_url as string | null ?? null, startsAt: slot.starts_at, endsAt: slot.ends_at,
    capacity: Number(slot.capacity), requiresApproval: body.requires_approval === 1,
    questions: ((questions ?? []) as Array<Record<string, unknown>>).map((q) => ({ id: String(q.id ?? ''), label: String(q.label), required: q.required === true, type: String(q.type ?? 'text') })),
    previewOnly: true,
  };
  return c.json(data);
});

events.post('/api/events/admin/events', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateEventInput(body, true);
  if (!v.ok) return bad(c, v.code, 422, ["name","description","venue_name","venue_address","sort_order","approval_deadline_hours","target_type","account_ids","dedup_priority","questions"]);

  if (Array.isArray(body.account_ids)
      && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), body.account_ids as string[])) {
    return bad(c, ACCOUNT_ACCESS_ERROR, 403);
  }

  if ('folderId' in body && !await validEventFolder(c, body.folderId,
    body.target_type === 'multi-account-dedup' ? body.account_ids as string[] : [account_id])) {
    return bad(c, 'invalid_folder', 422, ["folderId","target_type","account_ids"]);
  }
  const id = crypto.randomUUID();
  const targetType = (body.target_type as EventTargetType | undefined) ?? 'single';
  const accountIds = targetType === 'multi-account-dedup' ? (body.account_ids as string[]) : null;
  const dedupPriority =
    targetType === 'multi-account-dedup' ? ((body.dedup_priority as string[] | undefined) ?? null) : null;
  // line_account_id sentinel: multi では account_ids[0] を保存 (NOT NULL 制約回避)
  const lineAccountIdToWrite = targetType === 'multi-account-dedup' ? accountIds![0] : account_id;
  const isPublished = ((body.is_published as number | undefined) ?? 0) === 1;
  const publishedVersionId = isPublished ? crypto.randomUUID() : null;
  const approvalDeadlineHours = (body.approval_deadline_hours as number | undefined) ?? 24;
  const createdSnapshot = JSON.stringify(eventDefinitionSnapshot({
    name: body.name as string,
    image_url: (body.image_url as string | null | undefined) ?? null,
    description: (body.description as string | null | undefined) ?? null,
    venue_name: (body.venue_name as string | null | undefined) ?? null,
    venue_address: (body.venue_address as string | null | undefined) ?? null,
    venue_url: (body.venue_url as string | null | undefined) ?? null,
    cancel_deadline_hours_before: (body.cancel_deadline_hours_before as number | null | undefined) ?? null,
    confirmation_message_extra: (body.confirmation_message_extra as string | null | undefined) ?? null,
    approval_deadline_hours: approvalDeadlineHours,
  }));

  const insertEvent = c.env.DB.prepare(
      `INSERT INTO events (
         id, line_account_id, name, venue_name, venue_url, image_url,
         description, description_centered,
         max_bookings_per_friend, requires_approval, approval_deadline_hours, cancel_deadline_hours_before,
         reminder_day_before_enabled, reminder_hours_before,
         is_published, sort_order,
         target_type, account_ids, dedup_priority,
         confirmation_message_extra, reminder_message_extra,
         og_title, og_description, og_image_url,
         visible_tag_id, waitlist_enabled, entry_cutoff_hours_before,
         questions_json,
         current_published_version_id,
         lifecycle_status, lifecycle_changed_at, folder_id, venue_address
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      lineAccountIdToWrite,
      body.name as string,
      (body.venue_name as string | null) ?? null,
      (body.venue_url as string | null) ?? null,
      (body.image_url as string | null) ?? null,
      (body.description as string | null) ?? null,
      (body.description_centered as number | undefined) ?? 0,
      (body.max_bookings_per_friend as number | null | undefined) ?? null,
      (body.requires_approval as number | undefined) ?? 0,
      approvalDeadlineHours,
      (body.cancel_deadline_hours_before as number | null | undefined) ?? null,
      (body.reminder_day_before_enabled as number | undefined) ?? 1,
      (body.reminder_hours_before as number | null | undefined) ?? null,
      (body.is_published as number | undefined) ?? 0,
      (body.sort_order as number | undefined) ?? 0,
      targetType,
      accountIds ? JSON.stringify(accountIds) : null,
      dedupPriority ? JSON.stringify(dedupPriority) : null,
      (body.confirmation_message_extra as string | null | undefined) ?? null,
      (body.reminder_message_extra as string | null | undefined) ?? null,
      (body.og_title as string | null | undefined) ?? null,
      (body.og_description as string | null | undefined) ?? null,
      (body.og_image_url as string | null | undefined) ?? null,
      (body.visible_tag_id as string | null | undefined) ?? null,
      (body.waitlist_enabled as number | undefined) ?? 0,
      (body.entry_cutoff_hours_before as number | null | undefined) ?? null,
      // validateEventInput で形は検証済み。id未指定の分だけここで連番を補う。
      body.questions == null ? null : JSON.stringify((normalizeEventQuestions(body.questions) as { questions: EventQuestion[] }).questions),
      publishedVersionId,
      // m26g : 作成時も公開フラグと保存する状態を両書きする。
      // 公開で作った行が下書きのままでは、顧客 GET の可視性と
      // 管理表示がずれる（lifecycle_status が正本・移行 492 の決め）。
      isPublished ? 'published' : 'draft',
      new Date().toISOString(),
      body.folderId ?? null,
      (body.venue_address as string | null | undefined) ?? null,
    );
  if (publishedVersionId) {
    await c.env.DB.batch([
      insertEvent,
      c.env.DB.prepare(
        `INSERT INTO event_versions
           (id, event_id, line_account_id, version_number, snapshot_json,
            approval_deadline_hours, published_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        publishedVersionId,
        id,
        lineAccountIdToWrite,
        createdSnapshot,
        approvalDeadlineHours,
        new Date().toISOString(),
      ),
    ]);
  } else {
    await insertEvent.run();
  }
  const row = await c.env.DB
    .prepare(`SELECT * FROM events WHERE id = ?`)
    .bind(id)
    .first();
  return c.json(withFolder(row), 201);
});

events.get('/api/events/admin/events', async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400);
  const q = c.req.query('q')?.trim() ?? '';
  const filter = c.req.query('filter') ?? 'all';
  const sort = c.req.query('sort') ?? 'soon';
  if (!['all', 'open', 'pending', 'full'].includes(filter)) return bad(c, 'filter_invalid', 400);
  if (!['soon', 'name'].includes(sort)) return bad(c, 'sort_invalid', 400);
  // 1行ごとに副問い合わせが4つ走る。件数が増えても一覧が重くならないよう、
  // 共通一覧契約(offset方式)で件数を切る。並びは固定のままにする。
  const paging = parseOffsetPaging(
    { page: c.req.query('page'), limit: c.req.query('limit') },
    { defaultLimit: 200, maxLimit: 200 },
  );
  const conditions = [`e.deleted_at IS NULL`, `(
         (e.target_type = 'single' AND e.line_account_id = ?)
         OR (e.target_type = 'multi-account-dedup'
             AND EXISTS (SELECT 1 FROM json_each(e.account_ids) WHERE value = ?))
       )`];
  const params: unknown[] = [account_id, account_id];
  const folderId = c.req.query('folderId');
  if (folderId === '__ungrouped__') conditions.push('e.folder_id IS NULL');
  else if (folderId) { conditions.push('e.folder_id = ?'); params.push(folderId); }
  if (q) {
    /*
     * LIKE ではなく instr で部分一致する。
     * D1 の LIKE/GLOB パターンは最大50バイト。`%<検索語>%` を束縛すると
     * 48バイト超の検索語で SQLite エラー(500)になっていた。
     */
    conditions.push(`instr(lower(e.name), lower(?)) > 0`);
    params.push(q);
  }
  /*
   * 「受付中のみ」は公開済みだけでなく、今後の有効な枠がある行だけ。
   * 終わった回しかない行を返すと、一覧の状態も受付中になり、終わった
   * イベントを募集中として選んでしまう。
   */
  if (filter === 'open') conditions.push(`e.is_published = 1
    AND EXISTS (SELECT 1 FROM event_slots s
                 WHERE s.event_id = e.id AND s.deleted_at IS NULL AND s.is_active = 1
                   AND s.starts_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  if (filter === 'pending') conditions.push(`EXISTS (
    SELECT 1 FROM event_bookings pending WHERE pending.event_id = e.id AND pending.status = 'requested'
  )`);
  if (filter === 'full') conditions.push(`
    EXISTS (SELECT 1 FROM event_slots cap WHERE cap.event_id = e.id AND cap.deleted_at IS NULL AND cap.is_active = 1)
    AND NOT EXISTS (SELECT 1 FROM event_slots cap WHERE cap.event_id = e.id AND cap.deleted_at IS NULL AND cap.is_active = 1 AND cap.capacity IS NULL)
    AND (SELECT COALESCE(SUM(cap.capacity), 0) FROM event_slots cap WHERE cap.event_id = e.id AND cap.deleted_at IS NULL AND cap.is_active = 1)
      <= ((SELECT COALESCE(SUM(b.party_size), 0) FROM event_bookings b WHERE b.event_id = e.id AND b.status IN ('requested','confirmed'))
        + (SELECT COALESCE(SUM(w.party_size), 0) FROM event_waitlist w WHERE w.event_id = e.id AND w.status IN ('offered','accepted')))
  `);
  const where = `FROM events e
       WHERE ${conditions.join(' AND ')}`;
  const counted = await c.env.DB
    .prepare(`SELECT COUNT(*) AS c ${where}`)
    .bind(...params)
    .first<{ c: number }>();
  const { results } = await c.env.DB
    .prepare(
      `SELECT
         e.*,
         (SELECT MIN(s.starts_at)
            FROM event_slots s
           WHERE s.event_id = e.id
             AND s.deleted_at IS NULL
             AND s.is_active = 1
             AND s.starts_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ) AS next_slot_starts_at,
         (SELECT MAX(s.starts_at)
            FROM event_slots s
           WHERE s.event_id = e.id
             AND s.deleted_at IS NULL
             AND s.is_active = 1
             AND s.starts_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ) AS latest_past_slot_starts_at,
         -- 定員なしの枠が1つでも混ざっていたら合計は出さない(null)。
         -- 編集画面は同じ決め方で「—」と出している。一覧だけ数を出すと、
         -- 残りの判断がずれる。全部が定員なしのときも SUM は null になる。
         (CASE WHEN EXISTS (
            SELECT 1 FROM event_slots s
             WHERE s.event_id = e.id AND s.deleted_at IS NULL AND s.is_active = 1
               AND s.capacity IS NULL
          ) THEN NULL ELSE (
            SELECT COALESCE(SUM(s.capacity), NULL)
              FROM event_slots s
             WHERE s.event_id = e.id AND s.deleted_at IS NULL AND s.is_active = 1
          ) END
         ) AS total_capacity,
         ((SELECT COALESCE(SUM(b.party_size), 0)
             FROM event_bookings b
            WHERE b.event_id = e.id AND b.status IN ('requested','confirmed'))
          + (SELECT COALESCE(SUM(w.party_size), 0)
               FROM event_waitlist w
              WHERE w.event_id = e.id AND w.status IN ('offered','accepted'))
         ) AS total_active,
         (SELECT COUNT(*)
            FROM event_bookings b
           WHERE b.event_id = e.id AND b.status = 'requested'
         ) AS pending_count,
         -- 申込条件。e.* に visible_tag_id は入るが ID だけでは一覧に出せない。
         -- タグが消されていると NULL になるので、ID の有無と名前の有無は
         -- 呼び出し側で別に見ること。
         (SELECT t.name FROM tags t WHERE t.id = e.visible_tag_id) AS visible_tag_name
       ${where}
       ORDER BY ${c.req.query('highlight') ? 'CASE WHEN e.id = ? THEN 0 ELSE 1 END,' : ''} ${sort === 'name'
         ? `e.name COLLATE NOCASE ASC, e.id ASC`
         : `next_slot_starts_at IS NULL ASC, next_slot_starts_at ASC, e.id ASC`}
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, ...(c.req.query('highlight') ? [c.req.query('highlight')!] : []), paging.limit, paging.offset)
    .all();
  /*
   * 上部の数値カードは「今後の開催回」の全体像を出す。
   * ページ内の行だけを数えると、20件目以降があるときに全体が小さく見える。
   * イベント単位の合計（過去の回を含む）を開催回の数として出すと、
   * 集客すべき回を見誤る。絞り込み条件に合う全イベントの「今後の枠」
   * だけを数え直し、ページ切りとは別の summary として返す。
   * 残り1〜3席・7日以内で半分未満の目安は、画面の summarizeEventAttention
   * と同じ値にすること。片方だけ変えると数が食い違う。
   */
  const { results: futureSlots } = await c.env.DB
    .prepare(
      `SELECT
         s.id, s.event_id, s.starts_at, s.capacity,
         ((SELECT COALESCE(SUM(b.party_size), 0)
             FROM event_bookings b
            WHERE b.slot_id = s.id AND b.status IN ('requested','confirmed'))
          + (SELECT COALESCE(SUM(w.party_size), 0)
               FROM event_waitlist w
              WHERE w.slot_id = s.id AND w.status IN ('offered','accepted'))
         ) AS active_count
       FROM event_slots s
       WHERE s.deleted_at IS NULL
         AND s.is_active = 1
         AND s.starts_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         -- 数値カードは受付の見通し。下書きの枠を混ぜると、まだ出せない回まで
         -- 「これからの回」に数えてしまう。画面の summarizeEventAttention と
         -- 同じく公開済みだけを数える。
         AND EXISTS (SELECT 1 FROM events e WHERE e.id = s.event_id AND e.is_published = 1 AND ${conditions.join(' AND ')})`,
    )
    .bind(...params)
    .all<{
      id: string;
      event_id: string;
      starts_at: string;
      capacity: number | null;
      active_count: number;
    }>();
  return c.json({
    ...buildOffsetListResponse({
      items: (results ?? []).map(row => withFolder(row as Record<string, unknown>)),
      total: counted?.c ?? 0,
      paging,
      sort: sort === 'name'
        ? [{ field: 'name', direction: 'asc' }, { field: 'id', direction: 'asc' }]
        : [{ field: 'next_slot_starts_at', direction: 'asc' }, { field: 'id', direction: 'asc' }],
    }),
    summary: summarizeFutureEventSlots(futureSlots ?? []),
  });
});

events.get('/api/events/admin/events/:id', async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400);
  const row = await c.env.DB
    .prepare(
      `SELECT * FROM events
        WHERE id = ? AND deleted_at IS NULL AND (
          (target_type = 'single' AND line_account_id = ?)
          OR (target_type = 'multi-account-dedup'
              AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?))
        )`,
    )
    .bind(c.req.param('id'), account_id, account_id)
    .first();
  if (!row) return bad(c, 'not_found', 404);
  return c.json(withFolder(row));
});

// 設定と開催回だけを下書きへ写す。申込者・公開版・送信予定は写さない。
events.post('/api/events/admin/events/:id/duplicate', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const accountId = getAccountId(c);
  if (!accountId) return bad(c, 'account_id_required', 400);
  const sourceId = c.req.param('id');
  const source = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ? AND deleted_at IS NULL AND
    ((target_type = 'single' AND line_account_id = ?) OR
     (target_type = 'multi-account-dedup' AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?)))`)
    .bind(sourceId, accountId, accountId).first<Record<string, unknown>>();
  if (!source) return bad(c, 'not_found', 404);
  const accounts = source.target_type === 'multi-account-dedup' ? JSON.parse(String(source.account_ids)) as string[] : [accountId];
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), accounts)) return bad(c, 'not_found', 404);
  const body = await c.req.json<{ expectedVersion?: number }>().catch(() => ({} as { expectedVersion?: number }));
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion! < 1) return bad(c, 'expected_version_required', 422);
  if (body.expectedVersion !== source.version) return bad(c, 'version_conflict', 409);
  const id = crypto.randomUUID();
  const columns = ['line_account_id','venue_name','venue_url','venue_address','image_url','description','description_centered',
    'max_bookings_per_friend','requires_approval','approval_deadline_hours','cancel_deadline_hours_before',
    'reminder_day_before_enabled','reminder_hours_before','sort_order','target_type','account_ids','dedup_priority',
    'confirmation_message_extra','reminder_message_extra','og_title','og_description','og_image_url','visible_tag_id',
    'waitlist_enabled','entry_cutoff_hours_before','questions_json'];
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO events (id,name,is_published,lifecycle_status,${columns.join(',')},folder_id)
      SELECT ?,name || '（複製）',0,'draft',${columns.join(',')},folder_id FROM events
      WHERE id = ? AND version = ? AND deleted_at IS NULL`).bind(id, sourceId, body.expectedVersion!),
    c.env.DB.prepare(`INSERT INTO event_slots (id,event_id,starts_at,ends_at,capacity,is_active,sort_order)
      SELECT lower(hex(randomblob(16))),?,starts_at,ends_at,capacity,is_active,sort_order FROM event_slots
      WHERE event_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM events WHERE id = ?)`)
      .bind(id, sourceId, id),
  ]);
  if (!result[0].meta.changes) return bad(c, 'version_conflict', 409);
  return c.json({ id, lifecycle_status: 'draft' }, 201);
});

events.put('/api/events/admin/events/:id', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const id = c.req.param('id');
  const exists = await c.env.DB
    .prepare(
      `SELECT * FROM events
        WHERE id = ? AND deleted_at IS NULL AND (
          (target_type = 'single' AND line_account_id = ?)
          OR (target_type = 'multi-account-dedup'
              AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?))
        )`,
    )
    .bind(id, account_id, account_id)
    .first<Record<string, unknown>>();
  if (!exists) return bad(c, 'not_found', 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const expectedVersion = body.expected_version ?? body.expectedVersion;
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
    return bad(c, 'expected_version_required', 422, ["expected_version","expectedVersion"]);
  }
  const v = validateEventInput(body, false);
  if (!v.ok) return bad(c, v.code, 422, ["name","description","venue_name","venue_address","sort_order","approval_deadline_hours","target_type","account_ids","dedup_priority","questions"]);

  if (Array.isArray(body.account_ids)
      && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), body.account_ids as string[])) {
    return bad(c, ACCOUNT_ACCESS_ERROR, 403);
  }

  const updatable = [
    'name',
    'venue_name',
    'venue_address',
    'venue_url',
    'image_url',
    'description',
    'description_centered',
    'max_bookings_per_friend',
    'requires_approval',
    'approval_deadline_hours',
    'cancel_deadline_hours_before',
    'reminder_day_before_enabled',
    'reminder_hours_before',
    'is_published',
    'sort_order',
    'target_type',
    'confirmation_message_extra',
    'reminder_message_extra',
    'og_title',
    'og_description',
    'og_image_url',
    'visible_tag_id',
    'waitlist_enabled',
    'entry_cutoff_hours_before',
  ] as const;
  const setClauses: string[] = [];
  const setValues: unknown[] = [];
  for (const k of updatable) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      setClauses.push(`${k} = ?`);
      setValues.push(body[k]);
    }
  }
  if ('folderId' in body) {
    const targetType = body.target_type ?? exists.target_type;
    const accountIds = targetType === 'multi-account-dedup'
      ? (body.account_ids as string[] | undefined) ?? JSON.parse(exists.account_ids as string)
      : [account_id];
    if (!await validEventFolder(c, body.folderId, accountIds)) return bad(c, 'invalid_folder', 422, ["folderId","target_type","account_ids"]);
    setClauses.push('folder_id = ?');
    setValues.push(body.folderId);
  }
  // JSON-encoded columns (broadcasts と同じ扱い): account_ids / dedup_priority
  // null は NULL として書く、配列は JSON.stringify する。
  if (Object.prototype.hasOwnProperty.call(body, 'account_ids')) {
    setClauses.push('account_ids = ?');
    setValues.push(body.account_ids == null ? null : JSON.stringify(body.account_ids));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'dedup_priority')) {
    setClauses.push('dedup_priority = ?');
    setValues.push(body.dedup_priority == null ? null : JSON.stringify(body.dedup_priority));
  }
  // 質問の定義は questions_json 列に正規化して保存する(account_ids と同じ
  // JSON 列の扱い)。null を送ると定義ごと消える。
  if (Object.prototype.hasOwnProperty.call(body, 'questions')) {
    setClauses.push('questions_json = ?');
    setValues.push(
      body.questions == null
        ? null
        : JSON.stringify((normalizeEventQuestions(body.questions) as { questions: EventQuestion[] }).questions),
    );
  }
  // multi-account-dedup に切り替わったら line_account_id sentinel を account_ids[0] に合わせる
  if (body.target_type === 'multi-account-dedup' && Array.isArray(body.account_ids) && (body.account_ids as string[]).length > 0) {
    setClauses.push('line_account_id = ?');
    setValues.push((body.account_ids as string[])[0]);
  }
  // multi → single に戻すときは line_account_id を caller account に書き戻す。
  // 他アカ admin が編集していた場合、古い sentinel のままだと自分の /events
  // 一覧から消えるため。target_type='single' かつ account_ids が null/省略
  // のケースを対象にする。
  if (body.target_type === 'single') {
    setClauses.push('line_account_id = ?');
    setValues.push(account_id);
  }
  if (setClauses.length === 0) {
    if (exists.version !== expectedVersion) return bad(c, 'version_conflict', 409);
    const row = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    return c.json(withFolder(row));
  }
  const nextVersion = (expectedVersion as number) + 1;
  const nextPublished = (body.is_published ?? exists.is_published) === 1;
  // m26g : 公開フラグと保存する状態の両書き。lifecycle 口では
  // is_published へ両書きしているが、通常 PUT は lifecycle_status を
  // 触らず、is_published=1・lifecycle=draft の不整合行を作っていた。
  // その行は管理表示が「下書き」なのに顧客 GET が 200 になる。
  // 公開フラグが実際に切り替わるときだけ、保存する状態も連動させる。
  // 内容だけの保存（一時停止中の名前直し等）では状態を壊さない。
  const currentLifecycle = isLifecycleStatus(exists.lifecycle_status)
    ? exists.lifecycle_status
    : exists.is_published === 1 ? 'published' : 'draft';
  let nextLifecycle: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body, 'is_published')
    && body.is_published !== exists.is_published) {
    const target = body.is_published === 1 ? 'published' : 'draft';
    if (target !== currentLifecycle) {
      if (canTransitionLifecycle(currentLifecycle, target)) {
        nextLifecycle = target;
      } else if (currentLifecycle === 'published' && target === 'draft') {
        // 編集画面の公開ラジオは下書きに戻す操作を許している（lifecycle 口の
        // 遷移表は published→draft を禁じるが、あちらは状態操作の口の決め）。
        // ここでは「公開表示なのに顧客に届かない」逆向きの不整合を消すため、
        // 公開中→下書きの切替だけは編集の口でも受けて両書きする。
        nextLifecycle = target;
      } else {
        // 終了・中止からの公開など、終端状態の復活は内容編集では受けない。
        // 状態操作の口（lifecycle）で理由つきにやり直してもらう。
        return bad(c, 'lifecycle_transition_invalid', 409);
      }
    }
  }
  if (nextLifecycle !== null) {
    setClauses.push('lifecycle_status = ?');
    setValues.push(nextLifecycle);
    setClauses.push(`lifecycle_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  }
  const writeToken = crypto.randomUUID();
  const publishedVersionId = nextPublished ? crypto.randomUUID() : null;
  const nextEvent = { ...exists, ...body } as Record<string, unknown>;
  const snapshotJson = JSON.stringify(eventDefinitionSnapshot({
    name: nextEvent.name as string,
    image_url: nextEvent.image_url as string | null | undefined,
    description: nextEvent.description as string | null | undefined,
    venue_name: nextEvent.venue_name as string | null | undefined,
    venue_address: nextEvent.venue_address as string | null | undefined,
    venue_url: nextEvent.venue_url as string | null | undefined,
    cancel_deadline_hours_before: nextEvent.cancel_deadline_hours_before as number | null | undefined,
    confirmation_message_extra: nextEvent.confirmation_message_extra as string | null | undefined,
    approval_deadline_hours: nextEvent.approval_deadline_hours as number | null | undefined,
  }));
  setClauses.push('version = version + 1');
  setClauses.push('version_write_token = ?');
  setValues.push(writeToken);
  setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  setValues.push(id, expectedVersion);
  const update = c.env.DB
    .prepare(`UPDATE events SET ${setClauses.join(', ')} WHERE id = ? AND version = ?`)
    .bind(...setValues);
  const results = nextPublished && publishedVersionId
    ? await c.env.DB.batch([
        update,
        c.env.DB.prepare(
          `INSERT INTO event_versions
             (id, event_id, line_account_id, version_number, snapshot_json,
              approval_deadline_hours, published_at)
           SELECT ?, id, line_account_id, version, ?, approval_deadline_hours, ?
             FROM events
            WHERE id = ? AND version = ? AND version_write_token = ?`,
        ).bind(
          publishedVersionId,
          snapshotJson,
          new Date().toISOString(),
          id,
          nextVersion,
          writeToken,
        ),
        c.env.DB.prepare(
          `UPDATE events
              SET current_published_version_id = ?, version_write_token = NULL
            WHERE id = ? AND version = ? AND version_write_token = ?`,
        ).bind(publishedVersionId, id, nextVersion, writeToken),
      ])
    : await c.env.DB.batch([
        update,
        c.env.DB.prepare(
          `UPDATE events SET version_write_token = NULL
            WHERE id = ? AND version = ? AND version_write_token = ?`,
        ).bind(id, nextVersion, writeToken),
      ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return bad(c, 'version_conflict', 409);
  // 通知設定が変わった場合、確定予約の未送信通知を作り直し、新しい予定へ合わせる。
  if (
    Object.prototype.hasOwnProperty.call(body, 'reminder_day_before_enabled') ||
    Object.prototype.hasOwnProperty.call(body, 'reminder_hours_before')
  ) {
    await rebuildRemindersForEvent(c.env.DB, id);
  }
  const row = await c.env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  return c.json(withFolder(row));
});
}
