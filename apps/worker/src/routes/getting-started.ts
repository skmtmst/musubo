import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import { hasFirstDeliveredMessage, hasSavedFeatureConfiguration } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { starterApplication } from '../services/style-starter-ensure.js';
import { firstRunTimes, jst } from '../services/getting-started-first-run.js';
import { scenarioIdsStartedBy } from '../services/first-run-funnel.js';

/**
 * はじめの設定の順路。設計 ★34-1（`RAW35`）。台帳。
 *
 * **画面を開いたかではなく、実際に作られたもので判定する。**
 * 訪問の記録は持たない。毎回いまの中身を数え、キャッシュもしない
 * （要件 -34 §6-1）。
 */
const gettingStarted = new Hono<Env>();

export type StepState = 'done' | 'stalled' | 'todo' | 'forbidden' | 'unknown';

const STEP_HREFS = {
  accounts: '/accounts',
  featureSet: '/settings?tab=features',
  attributes: '/tags?tab=tags',
  friendAdd: '/friend-add-settings',
  scenario: '/scenarios',
  firstMessage: '/',
} as const;

const STEP_PERMISSIONS: Record<keyof typeof STEP_HREFS, string[]> = {
  accounts: ['/accounts', 'account.definition.edit'],
  featureSet: ['feature_settings.edit'],
  attributes: ['/tags', 'tag.definition.edit'],
  friendAdd: ['/friend-add-settings', 'friend_add.definition.edit'],
  scenario: ['/scenarios', 'scenario.definition.edit'],
  firstMessage: ['/chats', 'message.test.send'],
};

function canAdvance(staff: AuthenticatedStaff | undefined, key: keyof typeof STEP_HREFS) {
  if (!staff) return false;
  if (staff.role === 'owner' || staff.role === 'admin') return true;
  return STEP_PERMISSIONS[key].some((permission) => staff.permissionKeys?.includes(permission));
}

function withAccess(
  staff: AuthenticatedStaff | undefined,
  key: keyof typeof STEP_HREFS,
  state: StepState,
  reason?: string | null,
) {
  const allowed = canAdvance(staff, key);
  return {
    key,
    state: state === 'done' || allowed ? state : 'forbidden' as StepState,
    href: allowed ? STEP_HREFS[key] : null,
    reason: allowed ? reason ?? null : '管理者に依頼してください',
  };
}

interface AccountRow {
  id: string;
}

gettingStarted.get('/api/getting-started', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const staff = c.get('staff');
    const accountId = c.req.query('account_id') ?? c.req.query('accountId') ?? null;
    const visibleScope = await getVisibleLineAccountScope(c.env.DB, staff);
    if (accountId && !visibleScope.allowedAccountIds.includes(accountId)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const accountIds = accountId ? [accountId] : visibleScope.allowedAccountIds;
    const accounts = accountIds.length > 0 ? await c.env.DB.prepare(
      `SELECT id FROM line_accounts
        WHERE archived_at IS NULL AND id IN (${sqlIdSet(accountIds).sql})`,
    ).bind(...(accountIds.length ? sqlIdSet(accountIds).binds : [])).all<AccountRow>() : { results: [] as AccountRow[] };
    const rows = accounts.results;

    const tagCount = accountId ? await c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM tags
        WHERE line_account_id = ? AND COALESCE(status, 'active') != 'archived'`,
    ).bind(accountId).first<{ c: number }>() : null;
    const fieldCount = accountId ? await c.env.DB.prepare(
      `SELECT COUNT(*) AS c
         FROM friend_fields f
         JOIN friend_field_scopes s ON s.field_id = f.id
        WHERE s.line_account_id = ? AND f.status != 'archived'`,
    ).bind(accountId).first<{ c: number }>() : null;

    /*
      段3・段4。振り分けの版から見る。
      **公開されていない下書きを「公開した」と読まない。**
    */
    const ruleRows = accountId
      ? await c.env.DB.prepare(
          `SELECT r.is_unknown_route_fallback, v.definition_snapshot
             FROM friend_add_rules r
             JOIN friend_add_rule_versions v ON v.rule_id = r.id
            WHERE r.line_account_id = ? AND r.status = 'published'
              AND r.archived_at IS NULL AND v.status = 'published'`,
        )
          .bind(accountId)
          .all<{ is_unknown_route_fallback: number; definition_snapshot: string }>()
      : { results: [] as Array<{ is_unknown_route_fallback: number; definition_snapshot: string }> };
    const anyRule = accountId
      ? await c.env.DB.prepare(
          `SELECT 1 AS hit FROM friend_add_rules
            WHERE line_account_id = ? AND archived_at IS NULL LIMIT 1`,
        )
          .bind(accountId)
          .first<{ hit: number }>()
      : null;

    // 壊れた公開版を「設定済み」にしない。ほかの正常なルールは判定を続ける。
    const startedScenarioIds = [...new Set(ruleRows.results.flatMap((rule) => scenarioIdsStartedBy(rule.definition_snapshot)))];

    const scenarioTotal = await c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM scenarios${accountId ? ' WHERE line_account_id = ?' : ' WHERE 1 = 0'}`,
    )
      .bind(...(accountId ? [accountId] : []))
      .first<{ c: number }>();

    let scenarioFromFriendAdd = false;
    if (startedScenarioIds.length > 0) {
      const placeholders = sqlIdSet(startedScenarioIds).sql;
      const hit = await c.env.DB.prepare(
        `SELECT 1 AS hit FROM scenarios
          WHERE line_account_id = ? AND is_active = 1 AND id IN (${placeholders}) LIMIT 1`,
      )
        .bind(accountId, ...(startedScenarioIds.length ? sqlIdSet(startedScenarioIds).binds : []))
        .first<{ hit: number }>();
      scenarioFromFriendAdd = hit !== null;
    }

    const firstMessage = accountId ? await hasFirstDeliveredMessage(c.env.DB, accountId) : false;

    const hasPublishedRule = ruleRows.results.length > 0;
    const hasFallbackRule = ruleRows.results.some((row) => row.is_unknown_route_fallback === 1);
    const steps = [
      {
        // 登録済みアカウントがあれば段1は完了。接続状態は運用画面で別に確認する。
        ...withAccess(staff, 'accounts', rows.length > 0 ? 'done' : 'todo'),
      },
      withAccess(staff, 'attributes',
        (tagCount?.c ?? 0) > 0 || (fieldCount?.c ?? 0) > 0 ? 'done' : 'todo'),
      withAccess(staff, 'friendAdd',
        hasPublishedRule && hasFallbackRule ? 'done' : anyRule ? 'stalled' : 'todo',
        hasPublishedRule && !hasFallbackRule ? 'どの条件にも当たらない人の受け皿がありません' : null),
      withAccess(staff, 'scenario', scenarioFromFriendAdd
          ? 'done'
          : (scenarioTotal?.c ?? 0) > 0
            ? 'stalled'
            : 'todo'),
      withAccess(staff, 'firstMessage', firstMessage ? 'done' : 'todo'),
    ];

    if (c.req.query('version') === 'v8') {
      const configured = accountId ? await hasSavedFeatureConfiguration(c.env.DB, accountId) : false;
      steps.splice(1, 0, withAccess(staff, 'featureSet', configured ? 'done' : 'todo'));
    }

    /*
      「閉じた」は本人単位の記憶。**完了判定には使わない**（要件 §15）。
      帯を出すかは `dismissed` と `allDone` を画面が見て決める。
    */
    const dismissedRow = staff?.id
      ? await c.env.DB.prepare(
          `SELECT getting_started_dismissed_at AS dismissed_at FROM staff_members WHERE id = ?`,
        ).bind(staff.id).first<{ dismissed_at: string | null }>()
      : null;

    /*
      初期セットが入っているかと、最初の10分の時刻。どちらも読むだけで行を作らない
      （作成の口以外で設定を書かない決まり）。アカウントを1つ選んでいる時だけ返す。
    */
    const starter = accountId ? await starterApplication(c.env.DB, accountId, staff?.tenantId ?? null) : null;
    const firstRun = accountId ? await firstRunTimes(c.env.DB, accountId) : null;

    return c.json({
      success: true,
      data: {
        steps,
        accountId,
        starter,
        firstRun,
        doneCount: steps.filter((s) => s.state === 'done').length,
        total: steps.length,
        /** 全部終わったら、ダッシュボードの帯を出さない。 */
        allDone: steps.every((s) => s.state === 'done'),
        dismissed: dismissedRow?.dismissed_at != null,
      },
    });
  } catch (err) {
    throw err;
  }
});

/**
 * 進捗帯を閉じる（本人単位）。要件 §12。
 *
 * **完了ではない。** 閉じた日時は帯を出さないためだけの記憶で、
 * 段の判定には一切入れない（§15）。
 */
gettingStarted.post('/api/getting-started/dismiss', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  try {
    const staff = c.get('staff');
    if (!staff?.id) {
      return c.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    await c.env.DB.prepare(
      `UPDATE staff_members
          SET getting_started_dismissed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ?`,
    ).bind(staff.id).run();
    return c.json({ success: true, data: { dismissed: true } });
  } catch (err) {
    throw err;
  }
});

gettingStarted.post('/api/getting-started/first-run-done-seen', requireRole('owner', 'admin', 'staff'), async (c) => {
  const staff = c.get('staff');
  if (!staff?.id) return c.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  const accountId = c.req.query('account_id') ?? c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'Account is required' }, 400);
  const scope = await getVisibleLineAccountScope(c.env.DB, staff);
  if (!scope.allowedAccountIds.includes(accountId)) return c.json({ success: false, error: 'Not found' }, 404);
  await c.env.DB.prepare(`UPDATE account_styles
    SET first_run_done_seen_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
    WHERE line_account_id = ? AND first_run_done_seen_at IS NULL`).bind(accountId).run();
  const row = await c.env.DB.prepare('SELECT first_run_done_seen_at AS seen_at FROM account_styles WHERE line_account_id = ?')
    .bind(accountId).first<{ seen_at: string | null }>();
  return c.json({ success: true, data: { doneSeenAt: jst(row?.seen_at), tracked: row !== null } });
});

export { gettingStarted };
