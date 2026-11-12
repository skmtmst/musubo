import { sqlIdSet } from '../id-queries.js';
import { jstNow } from '../utils.js';
import { type WebinarParticipantClassification, type Webinar, type WebinarListScope, type WebinarListFilters, type WebinarListPaging, type WebinarListRow, type WebinarOverview, type WebinarOverviewMetric, type WebinarCreateInput } from './types.js';


export function classifyWebinarParticipant(
  row: { sessions: number; max_watched_seconds: number },
  options: { measured: boolean; completionThresholdSeconds: number },
): WebinarParticipantClassification {
  if (!options.measured) return 'unmeasured';
  if (row.sessions === 0) return 'unviewed';
  return row.max_watched_seconds >= options.completionThresholdSeconds
    ? 'completed'
    : 'dropped_off';
}

export async function getWebinars(db: D1Database): Promise<Webinar[]> {
  const { results } = await db
    .prepare('SELECT * FROM webinars ORDER BY created_at DESC')
    .all<Webinar>();
  return results ?? [];
}

export function webinarScopeWhere(scope: WebinarListScope, alias = 'w'): {
  sql: string;
  bindings: string[];
} {
  if (scope.accountId) {
    if (!scope.allowedAccountIds.includes(scope.accountId)) {
      return { sql: '1 = 0', bindings: [] };
    }
    return { sql: `${alias}.account_id = ?`, bindings: [scope.accountId] };
  }
  const accountSql = scope.allowedAccountIds.length > 0
    ? `${alias}.account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})`
    : null;
  if (accountSql && scope.canSeeUnassigned) {
    return {
      sql: `(${accountSql} OR ${alias}.account_id IS NULL)`,
      bindings: scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [],
    };
  }
  if (accountSql) return { sql: accountSql, bindings: scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [] };
  return {
    sql: scope.canSeeUnassigned ? `${alias}.account_id IS NULL` : '1 = 0',
    bindings: [],
  };
}

export const WEBINAR_LIST_SORT: Record<
  NonNullable<WebinarListFilters['sort']>,
  { order: string; field: string; direction: 'asc' | 'desc' }
> = {
  updated: { order: 'w.updated_at DESC, w.id DESC', field: 'updatedAt', direction: 'desc' },
  created: { order: 'w.created_at DESC, w.id DESC', field: 'createdAt', direction: 'desc' },
  /* 日本語の見出し順とは並びが違うことがある(SQLite のバイト順)。画面の名前順と完全一致はしない。 */
  name: { order: 'w.title ASC, w.id ASC', field: 'title', direction: 'asc' },
};

export function webinarListFilterWhere(
  filters: WebinarListFilters,
  alias = 'w',
): { sql: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  const q = filters.q?.trim();
  if (q) {
    const like = `%${q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(`(LOWER(${alias}.title) LIKE ? ESCAPE '\\' OR LOWER(${alias}.slug) LIKE ? ESCAPE '\\')`);
    bindings.push(like, like);
  }
  if (filters.folderId !== undefined) {
    if (filters.folderId === null) {
      conditions.push(`${alias}.folder_id IS NULL`);
    } else {
      conditions.push(`${alias}.folder_id = ?`);
      bindings.push(filters.folderId);
    }
  }
  if (filters.status) {
    conditions.push(`${alias}.status = ?`);
    bindings.push(filters.status);
  }
  return { sql: conditions.length > 0 ? conditions.join(' AND ') : '1 = 1', bindings };
}

export function webinarListWhere(
  scope: WebinarListScope,
  filters: WebinarListFilters,
): { sql: string; bindings: string[] } {
  const where = webinarScopeWhere(scope);
  const filter = webinarListFilterWhere(filters);
  return {
    sql: `${where.sql} AND ${filter.sql}${filters.status === 'archived' ? '' : " AND w.status <> 'archived'"}`,
    bindings: [...where.bindings, ...filter.bindings],
  };
}

/** 一覧用。人数は予約枠数ではなく、ウェビナーごとの重複しない友だち数。 */
export async function getWebinarList(
  db: D1Database,
  scope: WebinarListScope,
  paging?: WebinarListPaging,
  filters: WebinarListFilters = {},
): Promise<WebinarListRow[]> {
  const where = webinarListWhere(scope, filters);
  const sort = WEBINAR_LIST_SORT[filters.sort ?? 'updated'];
  const bindings: Array<string | number> = [...where.bindings];
  // paging省略時は全件(旧契約の呼び出し形を保つ)。一覧APIは必ずpagingを渡す。
  const pageClause = paging ? 'LIMIT ? OFFSET ?' : '';
  if (paging) bindings.push(paging.limit, paging.offset);
  const result = await db.prepare(
    `SELECT w.*,
            f.name AS folder_name,
            (SELECT COUNT(DISTINCT r.friend_id)
               FROM webinar_registrations r
              WHERE r.webinar_id = w.id AND r.status = 'active') AS registration_count,
            (SELECT COUNT(DISTINCT v.friend_id)
               FROM webinar_viewers v
              WHERE v.webinar_id = w.id) AS viewer_count
       FROM webinars w
       LEFT JOIN folders f ON f.id = w.folder_id
                            AND f.kind = 'webinar'
                            AND f.account_id = w.account_id
      WHERE ${where.sql}
      ORDER BY ${sort.order}
      ${pageClause}`,
  ).bind(...bindings).all<WebinarListRow>();
  return result.results ?? [];
}

/** 一覧の総件数。絞りは `getWebinarList` と同じ条件。 */
export async function countWebinarList(
  db: D1Database,
  scope: WebinarListScope,
  filters: WebinarListFilters = {},
): Promise<number> {
  const where = webinarListWhere(scope, filters);
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM webinars w WHERE ${where.sql}`,
  ).bind(...where.bindings).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** 一覧の並び順の応答表示。共通一覧契約の `sort` に入れる。 */
export function webinarListSort(filters: WebinarListFilters): Array<{ field: string; direction: 'asc' | 'desc' }> {
  const sort = WEBINAR_LIST_SORT[filters.sort ?? 'updated'];
  return [{ field: sort.field, direction: sort.direction }];
}

/** GET /api/folders?kind=webinar の各フォルダに表示する、権限内の件数。 */
export async function getWebinarFolderCounts(
  db: D1Database,
  scope: WebinarListScope,
): Promise<Record<string, number>> {
  const where = webinarScopeWhere(scope);
  const result = await db.prepare(
    `SELECT w.folder_id, COUNT(*) AS item_count
       FROM webinars w
       JOIN folders f ON f.id = w.folder_id
                     AND f.kind = 'webinar'
                     AND f.account_id = w.account_id
      WHERE ${where.sql} AND w.status <> 'archived'
      GROUP BY w.folder_id`,
  ).bind(...where.bindings).all<{ folder_id: string; item_count: number }>();
  return Object.fromEntries(
    (result.results ?? []).map((row) => [row.folder_id, Number(row.item_count)]),
  );
}

export async function getWebinarOverview(
  db: D1Database,
  accountId: string,
): Promise<WebinarOverview> {
  const row = await db.prepare(
    `WITH visible_webinars AS (
       SELECT id, status
         FROM webinars
        WHERE account_id = ? AND status <> 'archived'
     )
     SELECT
       (SELECT COUNT(*) FROM visible_webinars) AS webinar_count,
       (SELECT COUNT(*) FROM visible_webinars WHERE status = 'active') AS active_webinar_count,
       (SELECT COUNT(DISTINCT r.friend_id)
          FROM webinar_registrations r
          JOIN visible_webinars w ON w.id = r.webinar_id
         WHERE r.status = 'active') AS registration_people,
       (SELECT COUNT(*)
          FROM webinar_registrations r
          JOIN visible_webinars w ON w.id = r.webinar_id
         WHERE r.status = 'active') AS registration_bookings,
       (SELECT COUNT(DISTINCT v.friend_id)
          FROM webinar_viewers v
          JOIN visible_webinars w ON w.id = v.webinar_id
         WHERE v.cta_clicked_at IS NOT NULL) AS cta_unique_people`,
  ).bind(accountId).first<{
    webinar_count: number;
    active_webinar_count: number;
    registration_people: number;
    registration_bookings: number;
    cta_unique_people: number;
  }>();

  const available = (value: number): WebinarOverviewMetric => ({
    value,
    state: 'available',
    reason: null,
  });
  const unavailable = (reason: string): WebinarOverviewMetric => ({
    value: null,
    state: 'unavailable',
    reason,
  });

  return {
    state: 'partial',
    registrationMode: 'people',
    metrics: {
      webinars: available(row?.webinar_count ?? 0),
      activeWebinars: available(row?.active_webinar_count ?? 0),
      registrations: available(row?.registration_people ?? 0),
      registrationBookings: available(row?.registration_bookings ?? 0),
      viewers: unavailable('実際に見た区間の記録をまだ集計できないため'),
      viewRate: unavailable('視聴人数を取得できないため'),
      averageWatchSeconds: unavailable('実際に見た時間の記録をまだ集計できないため'),
      ctaUniquePeople: available(row?.cta_unique_people ?? 0),
      ctaTotalClicks: unavailable('同じ視聴中の複数クリックを数える記録がないため'),
    },
  };
}

export async function getWebinarById(db: D1Database, id: string): Promise<Webinar | null> {
  return db.prepare('SELECT * FROM webinars WHERE id = ?').bind(id).first<Webinar>();
}

export async function createWebinar(db: D1Database, input: WebinarCreateInput): Promise<Webinar> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO webinars (id, account_id, title, slug, status, video_prefix,
         duration_seconds, schedule_json, cta_json, tag_on_attend, tag_on_cta_click,
         folder_id, publication_starts_at, publication_ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, input.accountId ?? null, input.title, input.slug, input.status ?? 'draft',
      input.videoPrefix ?? null, input.durationSeconds ?? 0, input.scheduleJson ?? '[]',
      input.ctaJson ?? null, input.tagOnAttend ?? null, input.tagOnCtaClick ?? null,
      input.folderId ?? null, input.publicationStartsAt ?? null, input.publicationEndsAt ?? null,
      now, now,
    )
    .run();
  return (await getWebinarById(db, id))!;
}

export async function updateWebinar(
  db: D1Database,
  id: string,
  patch: Partial<WebinarCreateInput>,
  expectedVersion?: number,
  expectedStatus?: Webinar['status'],
): Promise<Webinar | null> {
  const existing = await getWebinarById(db, id);
  if (!existing) return null;
  const update = db
    .prepare(
      `UPDATE webinars SET account_id = ?, title = ?, slug = ?, status = ?,
         video_prefix = ?, duration_seconds = ?, schedule_json = ?, cta_json = ?,
         tag_on_attend = ?, tag_on_cta_click = ?, folder_id = ?,
         publication_starts_at = ?, publication_ends_at = ?, updated_at = ?
       WHERE id = ?${expectedVersion === undefined ? '' : ' AND EXISTS (SELECT 1 FROM webinar_editor_settings s WHERE s.webinar_id = webinars.id AND s.version = ?)'}${expectedStatus === undefined ? '' : ' AND status = ?'}`,
    )
    .bind(
      patch.accountId !== undefined ? patch.accountId : existing.account_id,
      patch.title ?? existing.title,
      patch.slug ?? existing.slug,
      patch.status ?? existing.status,
      patch.videoPrefix !== undefined ? patch.videoPrefix : existing.video_prefix,
      patch.durationSeconds ?? existing.duration_seconds,
      patch.scheduleJson ?? existing.schedule_json,
      patch.ctaJson !== undefined ? patch.ctaJson : existing.cta_json,
      patch.tagOnAttend !== undefined ? patch.tagOnAttend : existing.tag_on_attend,
      patch.tagOnCtaClick !== undefined ? patch.tagOnCtaClick : existing.tag_on_cta_click,
      patch.folderId !== undefined ? patch.folderId : existing.folder_id,
      patch.publicationStartsAt !== undefined
        ? patch.publicationStartsAt : existing.publication_starts_at,
      patch.publicationEndsAt !== undefined ? patch.publicationEndsAt : existing.publication_ends_at,
      jstNow(), id, ...(expectedVersion === undefined ? [] : [expectedVersion]), ...(expectedStatus === undefined ? [] : [expectedStatus]),
    );
  if (expectedVersion === undefined) await update.run();
  else {
    const result = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO webinar_editor_settings (webinar_id,version,created_at,updated_at) VALUES (?,0,?,?)`).bind(id,jstNow(),jstNow()),
      update,
      db.prepare(`UPDATE webinar_editor_settings SET version = version + 1, updated_at = ? WHERE webinar_id = ? AND version = ? AND changes() = 1`).bind(jstNow(), id, expectedVersion),
      db.prepare(`INSERT INTO webinar_versions (id,webinar_id,version,state,snapshot_json,created_at)
        SELECT ?,webinar_id,version,'draft',json_object(
          'deliveryKind',delivery_kind,'viewingCondition',json(viewing_condition_json),
          'publicDescription',public_description,'registrationFormId',registration_form_id,
          'notificationMessages',json(notification_messages_json),
          'notificationTest',CASE WHEN notification_test_json IS NULL THEN NULL ELSE json(notification_test_json) END,
          'actionTemplateBody',action_template_body,'missingResultPolicy',missing_result_policy,
          'publicPageTest',CASE WHEN public_page_test_json IS NULL THEN NULL ELSE json(public_page_test_json) END),?
        FROM webinar_editor_settings WHERE webinar_id=? AND version=? AND changes()=1`)
        .bind(crypto.randomUUID(),jstNow(),id,expectedVersion+1),

    ]);
    if (Number(result[1].meta?.changes ?? 0) !== 1) return null;
  }
  return getWebinarById(db, id);
}
