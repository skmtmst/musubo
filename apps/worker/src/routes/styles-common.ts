import { readAuthenticatedStaffRecord } from '../lib/authenticated-staff-record.js';
import { type Context } from 'hono';
import { type IndustryStyle } from '@line-crm/shared';
import { getStaffById } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { hasStaffPermission } from '../middleware/role-guard.js';
import { StyleError } from '../services/style-setup.js';
import { instant } from '../services/style-analytics.js';

export const base = '/api/dashboard/style';

export async function hq(c: Context<Env>, allowScoped = false) {
  const s = c.get('staff');
  if (!s?.tenantId || (!['GET', 'HEAD'].includes(c.req.method) && s.readOnly))
    throw new StyleError('forbidden', 403);
  const m = readAuthenticatedStaffRecord(c.env.DB, s) ?? await getStaffById(c.env.DB, s.id);
  if (
    !m ||
    !m.is_active ||
    m.tenant_id !== s.tenantId ||
    (m.account_scope === 'accounts' && !allowScoped) ||
    (!['owner', 'admin'].includes(m.role) && s.hqRole !== 'operator' && s.hqRole !== 'viewer') ||
    (!['GET', 'HEAD'].includes(c.req.method) && m.access_level === 'read_only')
  )
    throw new StyleError('forbidden', 403);
  return s.tenantId;
}

export async function account(c: Context<Env>) {
  const id = c.req.query('account_id');
  if (!id) throw new StyleError('account_required');
  if (!(await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])))
    throw new StyleError('not_found', 404);
  return id;
}

export async function json(c: Context<Env>): Promise<Record<string, unknown>> {
  if (Number(c.req.header('content-length') ?? 0) > 100000)
    throw new StyleError('request_too_large');
  const t = await c.req.text();
  if (t.length > 100000) throw new StyleError('request_too_large');
  try {
    const b = JSON.parse(t);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0;
    return b;
  } catch {
    throw new StyleError('invalid_json');
  }
}

export function edit(c: Context<Env>, permission?: string) {
  const s = c.get('staff');
  if (
    !s ||
    s.readOnly ||
    (permission
      ? !hasStaffPermission(c, permission)
      : !['owner', 'admin'].includes(s.role) && s.hqRole !== 'operator')
  )
    throw new StyleError('forbidden', 403);
}

export function text(v: unknown, max = 1000): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > max)
    throw new StyleError('invalid_text');
  return v.trim() || null;
}

export function oneOf(v: unknown, values: string[], nullable = false) {
  if (nullable && (v === null || v === undefined)) return null;
  if (typeof v !== 'string' || !values.includes(v))
    throw new StyleError('invalid_choice');
  return v;
}

export function version(v: unknown, current: number) {
  if (!Number.isInteger(v) || v !== current)
    throw new StyleError('version_conflict', 409);
}

export async function staffFilter(c: Context<Env>, id: string, style: IndustryStyle) {
  const selected = c.req.query('staff_id');
  const s = c.get('staff');
  if (s.role === 'staff' && style === 'consult') {
    const own = await c.env.DB.prepare(
      'SELECT id FROM staff WHERE line_account_id=? AND staff_member_id=? AND is_active=1',
    )
      .bind(id, s.id)
      .first<{ id: string }>();
    if (!own || (selected && selected !== own.id))
      throw new StyleError('forbidden', 403);
    return own.id;
  }
  if (
    selected &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND line_account_id=? AND is_active=1',
    )
      .bind(selected, id)
      .first())
  )
    throw new StyleError('staff_not_found', 404);
  return selected;
}

/** 分析結果から対象者を作る既存 API として扱い、メッセージは送らない。 */
export async function bookingAudience(
  c: Context<Env>,
  id: string,
  body: Record<string, unknown>,
  accountId: string,
) {
  const result = await c.env.DB.prepare(
    'SELECT selection_json,expires_at FROM style_analytics_results WHERE id=? AND line_account_id=?',
  )
    .bind(id, accountId)
    .first<{ selection_json: string; expires_at: string }>();
  if (!result || instant(result.expires_at) <= Date.now())
    throw new StyleError('result_not_found', 404);
  const selected = JSON.parse(result.selection_json) as {
    ids: Array<{ friendId: string | null; personKey: string }>;
  };
  const requested = body.friendIds;
  if (
    requested !== undefined &&
    (!Array.isArray(requested) ||
      requested.some(
        (v) =>
          typeof v !== 'string' || !selected.ids.some((r) => r.friendId === v),
      ))
  )
    throw new StyleError('invalid_selection', 422);
  const people = new Set(
    selected.ids.filter((r) => !r.friendId).map((r) => r.personKey),
  );
  const ids = [
    ...new Set(
      selected.ids
        .map((r) => r.friendId)
        .filter(
          (v): v is string =>
            !!v &&
            (requested === undefined || (requested as string[]).includes(v)),
        ),
    ),
  ];
  const audienceId = crypto.randomUUID(),
    now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 86400000).toISOString();
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO analytics_result_audiences(id,line_account_id,source_kind,source_result_id,selection_key,member_count,expires_at,created_by,created_at) VALUES(?,?,'booking',?,'selection',0,?,?,?)`,
    ).bind(audienceId, accountId, id, expiresAt, c.get('staff').id, now),
  ];
  for (const friendId of ids)
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO analytics_result_audience_members(audience_id,friend_id) SELECT ?,id FROM friends WHERE id=? AND line_account_id=? AND is_following=1 AND is_hidden=0`,
      ).bind(audienceId, friendId, accountId),
    );
  statements.push(
    c.env.DB.prepare(
      'UPDATE analytics_result_audiences SET member_count=(SELECT COUNT(*) FROM analytics_result_audience_members WHERE audience_id=?) WHERE id=?',
    ).bind(audienceId, audienceId),
  );
  await c.env.DB.batch(statements);
  const count = (await c.env.DB.prepare(
    'SELECT member_count FROM analytics_result_audiences WHERE id=?',
  )
    .bind(audienceId)
    .first<{ member_count: number }>())!.member_count;
  return {
    id: audienceId,
    memberCount: count,
    unreachableCount: people.size + ids.length - count,
    expiresAt,
  };
}
