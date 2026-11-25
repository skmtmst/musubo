import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  getOnboardingGuideProgress,
  hasFirstDeliveredMessage,
  hasSavedFeatureConfiguration,
  saveOnboardingGuideProgress,
  acknowledgeOnboardingWelcome,
} from '@line-crm/db';
import type { OnboardingGuidePhase, OnboardingGuideProgressRow } from '@line-crm/db';
import { hasStaffAccess } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { starterApplication } from '../services/style-starter-ensure.js';
import { firstRunTimes } from '../services/getting-started-first-run.js';
import { scenarioIdsStartedBy } from '../services/first-run-funnel.js';
import {
  hasReceivedFirstMessageTest, issueFirstMessageIdentity, readFirstMessageTest, sendFirstMessageTest,
} from '../services/getting-started-first-message.js';

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
  return STEP_PERMISSIONS[key].some((permission) => hasStaffAccess(staff, permission));
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
  style: string | null;
  is_active: number;
  webhook_ready: number | null;
}

function accountStep(rows: AccountRow[], accountId: string | null, version: string | undefined): { state: StepState; reason?: string } {
  if (!rows.length) return { state: 'todo' };
  const selected = accountId && rows.find(row => row.id === accountId);
  if (version !== 'v8' || !selected || selected.style !== 'restaurant') return { state: 'done' };
  if (!selected.is_active) return { state: 'stalled', reason: 'LINEアカウントが停止中です。LINEアカウント画面で稼働状態を確認してください。' };
  if (selected.webhook_ready === 1) return { state: 'done' };
  if (selected.webhook_ready === 0) return { state: 'stalled', reason: 'LINEのWebhookを有効にし、接続を確認してください。' };
  return { state: 'unknown', reason: 'LINEアカウント画面で接続を確認してください。' };
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
      `SELECT a.id, a.is_active, s.style,
        (SELECT CASE WHEN c.result IN ('ok','matched') AND c.webhook_active=1 THEN 1 ELSE 0 END
           FROM line_account_connection_checks c
          WHERE c.line_account_id=a.id AND c.check_kind='webhook_endpoint' AND c.account_revision=a.revision
          ORDER BY c.checked_at DESC,c.id DESC LIMIT 1) AS webhook_ready
        FROM line_accounts a LEFT JOIN account_styles s ON s.line_account_id=a.id
        WHERE a.archived_at IS NULL AND a.id IN (${sqlIdSet(accountIds).sql})`,
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

    const firstMessage = accountId && staff?.id && c.req.query('version') === 'v8'
      && rows.some(row => row.id === accountId && row.style === 'restaurant')
      ? await restaurantFirstMessageDone(c.env.DB, { accountId, staffId: staff.id })
      : accountId ? await hasFirstDeliveredMessage(c.env.DB, accountId) : false;

    const hasPublishedRule = ruleRows.results.length > 0;
    const hasFallbackRule = ruleRows.results.some((row) => row.is_unknown_route_fallback === 1);
    const connection = accountStep(rows, accountId, c.req.query('version'));
    const steps = [
      withAccess(staff, 'accounts', connection.state, connection.reason),
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

/*
  ガイドの進行状態（ユーザー×アカウント）。
  承認済み Pen 枠 14 (orKSi) の L3lP08 どおり、
  「有効/一時停止・現在ステップ・現在手順」をここに置き、
  リロード・端末切替・離脱のあとも同じ所から再開できるようにする。

  **9項目の済み判定はここに入れない。** 完了は上の GET /api/getting-started が
  いまの中身を数えて出すもので、ガイドを使わなくてもチェックは付く（枠14 L3lP08）。
*/
const GUIDE_PHASES: OnboardingGuidePhase[] = ['idle', 'active', 'paused', 'done'];

async function requireGuideScope(c: {
  env: Env['Bindings'];
  get: (key: 'staff') => AuthenticatedStaff | undefined;
  req: { query: (key: string) => string | undefined };
}): Promise<{ staffId: string; accountId: string } | { response: Response }> {
  const staff = c.get('staff');
  if (!staff?.id) {
    return { response: Response.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 }) };
  }
  const accountId = c.req.query('account_id') ?? c.req.query('accountId') ?? null;
  if (!accountId) {
    return { response: Response.json({ success: false, error: 'LINEアカウントを選択してください' }, { status: 400 }) };
  }
  const visibleScope = await getVisibleLineAccountScope(c.env.DB, staff);
  if (!visibleScope.allowedAccountIds.includes(accountId)) {
    return { response: Response.json({ success: false, error: 'Not found' }, { status: 404 }) };
  }
  return { staffId: staff.id, accountId };
}

function guidePayload(row: OnboardingGuideProgressRow | null) {
  // 行が無いのは「まだ案内を始めていない」。既定を返して画面側で分岐を増やさない。
  return {
    phase: row?.phase ?? 'idle',
    stepKey: row?.step_key ?? null,
    procedureIndex: row?.procedure_index ?? 1,
    updatedAt: row?.updated_at ?? null,
  };
}

gettingStarted.get('/api/getting-started/guide', requireRole('owner', 'admin', 'staff'), async (c) => {
  const scope = await requireGuideScope(c);
  if ('response' in scope) return scope.response;
  const row = await getOnboardingGuideProgress(c.env.DB, scope.staffId, scope.accountId);
  return c.json({ success: true, data: guidePayload(row) });
});

gettingStarted.put('/api/getting-started/guide', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const scope = await requireGuideScope(c);
  if ('response' in scope) return scope.response;

  const body = await c.req.json<{ phase?: unknown; stepKey?: unknown; procedureIndex?: unknown; acknowledgeWelcome?: unknown }>().catch(() => null);
  if (!body || !GUIDE_PHASES.includes(body.phase as OnboardingGuidePhase)) {
    return inputError(c, { success: false, error: '案内の状態が正しくありません' }, 400, ['phase']);
  }
  if (body.stepKey != null && typeof body.stepKey !== 'string') {
    return inputError(c, { success: false, error: '案内の段が正しくありません' }, 400, ['stepKey']);
  }
  // 現在手順は1から数える。数でない値や0以下は保存せず、入力の誤りとして返す。
  const procedureIndex = body.procedureIndex ?? 1;
  if (!Number.isInteger(procedureIndex) || (procedureIndex as number) < 1) {
    return inputError(c, { success: false, error: '案内の手順が正しくありません' }, 400, ['procedureIndex']);
  }

  if (body.acknowledgeWelcome !== undefined) {
    if (body.acknowledgeWelcome !== true || body.phase !== 'idle' || body.stepKey != null || procedureIndex !== 1) {
      return inputError(c, { success: false, error: 'ウェルカムの確認内容が正しくありません' }, 400, ['acknowledgeWelcome']);
    }
    const row = await acknowledgeOnboardingWelcome(c.env.DB, scope.staffId, scope.accountId);
    return c.json({ success: true, data: guidePayload(row) });
  }

  const row = await saveOnboardingGuideProgress(c.env.DB, {
    staffId: scope.staffId,
    lineAccountId: scope.accountId,
    phase: body.phase as OnboardingGuidePhase,
    stepKey: (body.stepKey as string | null | undefined) ?? null,
    procedureIndex: procedureIndex as number,
  });
  return c.json({ success: true, data: guidePayload(row) });
});

async function restaurantFirstMessageDone(db: D1Database, scope: { staffId: string; accountId: string }): Promise<boolean> {
  if (await hasReceivedFirstMessageTest(db, scope)) return true;
  const guide = await getOnboardingGuideProgress(db, scope.staffId, scope.accountId);
  // 以前の手順で完了した人の進捗は維持する。
  return guide?.phase === 'done' && await hasFirstDeliveredMessage(db, scope.accountId);
}

const firstMessageRole = requireRole('owner', 'admin', 'staff');
const firstMessagePermission: MiddlewareHandler<Env> = async (c, next) => {
  if (!canAdvance(c.get('staff'), 'firstMessage')) {
    return c.json({ success: false, error: 'この操作を実行する権限がありません' }, 403);
  }
  return next();
};
gettingStarted.get('/api/getting-started/first-message', firstMessageRole, firstMessagePermission, async (c) => {
  const scope = await requireGuideScope(c);
  if ('response' in scope) return scope.response;
  return c.json({ success: true, data: await readFirstMessageTest(c.env.DB, scope) });
});

gettingStarted.post('/api/getting-started/first-message/identity', firstMessageRole, firstMessagePermission, async (c) => {
  const scope = await requireGuideScope(c);
  if ('response' in scope) return scope.response;
  const verificationUrl = await issueFirstMessageIdentity(c.env.DB, scope);
  return c.json({ success: true, data: { verificationUrl } });
});

gettingStarted.post('/api/getting-started/first-message/send', firstMessageRole, firstMessagePermission, async (c) => {
  const scope = await requireGuideScope(c);
  if ('response' in scope) return scope.response;
  const data = await sendFirstMessageTest(c.env.DB, scope, { credentialKey: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY });
  return c.json({ success: true, data });
});

export { gettingStarted };
