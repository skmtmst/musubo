import { starterCatalogRuntime } from './style-starter-runtime.js';
import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { readLineAccountListMetadata } from '../services/line-account-list-metadata.js';
import { jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import { verifyLineMessagingIdentity } from '../services/line-messaging-identity.js';
import { expectedWebhookUrl as accountWebhookUrl } from '../lib/webhook-endpoint.js';
import { readOfficialProfileUrl } from './line-account-profile-url.js';
import { ACCOUNT_STYLES, type AccountStyle } from '@line-crm/shared';
import { fail } from '../lib/fail.js';
import { initializeAccountStyle } from '../services/style-setup.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { validateRegistrationOptions, applyRegistrationOptions, RegistrationOptionsError } from '../services/connect-registration.js';
import { Hono, type Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getLineAccountListStats, getLineAccountTag, getLineAccountsByIds, getLineAccountScopeEntries, getLineAccountById, getLineAccountCredentialHealth, createLineAccount, listLineAccountTags, updateLineAccount, updateLineAccountFields, updateLineAccountOrder, deleteUncommittedLineAccount, getLineAccountArchiveBlockers, setDefaultLineAccount, archiveLineAccount, restoreLineAccount, deactivateLineAccount, activateLineAccount, listSkippedDeliveries, getLineAccountConnectionChecksByIdempotencyKey, saveLineAccountConnectionChecks, LineAccountRevisionConflictError, jstNow } from '@line-crm/db';
import type { LineAccount as DbLineAccount, LineAccountConnectionCheck } from '@line-crm/db';
import { CredentialEncryptionKeyError } from '@line-crm/db';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { auditLog } from '../lib/audit-log.js';
import { fetchBotProfile, type BotProfile } from '../lib/bot-profile.js';
import { detectFollowerImportCapability, getFollowerImportState, processFollowerImportStep, scheduleInitialFollowerImport, startFollowerImport } from '../services/follower-import.js';
import type { FollowerImportClient } from '../services/follower-import-state.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope, validateAccountHierarchy } from '../services/account-access.js';
import { copyLineAccountSettings, normalizeCopyItems } from '../services/account-copy.js';
import { IDENTITY_KEY_SQL } from '../lib/identity-key.js';
import { fetchLineMonthlyPlan } from '../services/line-monthly-plan.js';
import { fetchWebhookEndpointState } from '../services/line-webhook-state.js';
import { lineConnectStep, prepareLineConnection, type LineConnectStep } from '../services/line-account-connect.js';
import { getLineRegistrationReceipt } from '../services/line-registration-receipt.js';
import { getAuthorizedLineAccount, getVisibleLineAccountEntry } from './line-account-access.js';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { LINE_LIVE_ACCOUNT_CONCURRENCY, hasTenantWideLineAccountScope, lifecycleConflict, mapWithConcurrency, musuboFirstLineGate, startFirstMusuboLine } from './line-accounts-support.js';
import { readCapacity, normalizeOptionalString, validateLoginChannelPair, readConnectBody, type ConnectBody } from './line-accounts-input.js';
import { serializeLineAccount, serializeLineAccountFull } from './line-accounts-view.js';

const lineAccounts = new Hono<Env>();

// LINE の実データ取得は重いため、live=1 の明示要求時だけにする。
lineAccounts.get('/api/line-accounts', async (c) => {
  try {
    const db = c.env.DB;
    const visibleScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    let items = await getLineAccountsByIds(
      db,
      visibleScope.allowedAccountIds,
      c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    );
    const folderParam=c.req.query('folderId');
    if(folderParam!==undefined) {
      const folderId=folderParam==='' || folderParam==='__none__' ? null : folderParam;
      if(folderId && !await getLineAccountTag(db,c.get('staff').tenantId ?? DEFAULT_TENANT_ID,folderId)) return c.json({success:false,error:'フォルダが見つかりません'},404);
      items=items.filter(item=>(item.folder_id ?? null)===folderId);
    }
    const { tagsByAccount, foldersByAccount, statsByAccount, emailInboxAccountIds } = await readLineAccountListMetadata(
      db, c.get('staff').tenantId ?? DEFAULT_TENANT_ID, items.map((item) => item.id),
    );
    const serializeWithStats = (item: DbLineAccount) => {
      const overview = statsByAccount[item.id];
      return {
        ...serializeLineAccount(item),
        emailInboxEnabled: emailInboxAccountIds.has(item.id),
        tags: tagsByAccount[item.id] ?? [],
        folderId: foldersByAccount[item.id]?.id ?? null,
        folder: foldersByAccount[item.id] ?? null,
        stats: {
          friendCount: overview?.friendCount ?? 0,
          activeScenarios: overview?.activeScenarios ?? 0,
          messagesThisMonth: overview?.messagesThisMonth ?? 0,
          staffCount: overview?.staffCount ?? 0,
        },
        connection: overview?.connection ?? { status: 'unknown' as const, checkedAt: null, tokenExpired: false, issues: [] },
      };
    };

    if (c.req.query('live') !== '1') {
      return c.json({
        success: true,
        data: items.map(serializeWithStats),
      });
    }
    const base = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');

    // 1アカウントにつき最大3接続を同時に開くため、2アカウントずつに抑える。
    // Workersの同時外向き接続上限6を越えない。
    const results = await mapWithConcurrency(
      items,
      LINE_LIVE_ACCOUNT_CONCURRENCY,
      async (item) => {
        const [profile, webhook, plan] = await Promise.all([
          fetchBotProfile(item.channel_access_token),
          fetchWebhookEndpointState(item.channel_access_token, accountWebhookUrl(base, item.channel_id), [...acceptedWebhookUrls(c.env, accountWebhookUrl(base, item.channel_id)), ...acceptedWebhookUrls(c.env, `${base}/webhook`)]),
          fetchLineMonthlyPlan(item.channel_access_token),
        ]);

        return {
          ...serializeWithStats(item),
          displayName: profile.displayName || item.name,
          pictureUrl: profile.pictureUrl || null,
          basicId: profile.basicId || null,
          webhook,
          plan,
        };
      },
    );
    return c.json({ success: true, data: results });
  } catch (err) {
    throw err;
  }
});

// 一覧の軽量なスナップショットを表示した後、LINE公式アカウントの画像だけを
// 最新の状態へ差し替える。接続確認・プラン照会や DB 更新は行わない。
lineAccounts.get('/api/line-accounts/profile-pictures', async (c) => {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const accounts = (await getLineAccountsByIds(
    c.env.DB,
    scope.allowedAccountIds,
    c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
  )).filter((account) => account.is_active && !account.archived_at && account.channel_access_token);
  const pictures = await mapWithConcurrency(accounts, LINE_LIVE_ACCOUNT_CONCURRENCY, async (account) => {
    const profile = await fetchBotProfile(account.channel_access_token);
    // LINEへの問い合わせに失敗した場合、保存済みの画像を消さない。
    if (!profile.displayName && !profile.basicId) return null;
    return { id: account.id, pictureUrl: profile.pictureUrl ?? null };
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: pictures.filter((picture) => picture !== null) });
});

// 可視範囲内のアカウントだけを要約する。
lineAccounts.get('/api/line-accounts/summary', async (c) => {
  try {
    const db = c.env.DB;
    const visibleActiveIds = (await getVisibleLineAccountScope(c.env.DB, c.get('staff'))).accounts
      .filter((item) => Boolean(item.is_active))
      .map((item) => item.id);
    if (visibleActiveIds.length === 0) {
      return c.json({ success: true, data: { uniqueFriendCount: 0 } });
    }
    const placeholders = sqlIdSet(visibleActiveIds).sql;
    const row = await db.prepare(
      `SELECT COUNT(DISTINCT (${IDENTITY_KEY_SQL})) AS count
       FROM friends
       WHERE friends.is_following = 1
         AND friends.line_account_id IN (${placeholders})`,
    ).bind(...sqlIdSet(visibleActiveIds).binds).first<{ count: number }>();
    return c.json({ success: true, data: { uniqueFriendCount: row?.count ?? 0 } });
  } catch (err) {
    throw err;
  }
});

type ConnectionVerification = {
  messagingApi: boolean;
  webhook: boolean;
  lineLogin: boolean;
  liff: boolean;
  webhookUrl: string | null;
  botProfile: BotProfile | null;
  errors: string[];
};

type ConnectionCheckDraft = {
  kind: 'bot_info' | 'webhook_endpoint' | 'webhook_test' | 'liff_config';
  result: 'matched' | 'mismatched' | 'unconfigured' | 'unknown' | 'ok' | 'failed';
  expectedUrl?: string | null;
  registeredUrl?: string | null;
  webhookActive?: boolean | null;
  httpStatus?: number | null;
};

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** 正規 URL と WORKER_URL・設定済みの別名は同じ Worker を指すため、いずれに LINE が登録されていても不一致としない。 */
export function acceptedWebhookUrls(
  env: Pick<Env['Bindings'], 'WORKER_PUBLIC_URL' | 'WORKER_URL' | 'WORKER_ALIAS_URLS'>,
  canonicalWebhookUrl: string,
): string[] {
  const origins = [
    env.WORKER_PUBLIC_URL,
    env.WORKER_URL,
    ...(env.WORKER_ALIAS_URLS ?? '').split(','),
  ]
    .map((value) => (value ? trimTrailingSlash(value) : ''))
    .filter((value) => /^https:\/\/[^/]+$/.test(value));
  const path = new URL(canonicalWebhookUrl).pathname.replace(/\/+$/, '');
  const urls = [trimTrailingSlash(canonicalWebhookUrl), ...origins.map((origin) => `${origin}${path}`)];
  return [...new Set(urls)];
}

function isAcceptedWebhookUrl(registeredUrl: string | null | undefined, accepted: readonly string[]): boolean {
  if (!registeredUrl) return false;
  return accepted.includes(trimTrailingSlash(registeredUrl));
}

function publicAccountUrls(c: Context<Env>, liffId: string | null, channelId: string) {
  const base = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  return {
    webhook: accountWebhookUrl(base, channelId),
    webhookAccepted: [...acceptedWebhookUrls(c.env, accountWebhookUrl(base, channelId)), ...acceptedWebhookUrls(c.env, `${base}/webhook`)],
    callback: `${base}/auth/callback`,
    liffEndpoint: liffId ? `${base}?liffId=${encodeURIComponent(liffId)}` : null,
  };
}

function serializeConnectionCheck(row: LineAccountConnectionCheck) {
  return {
    kind: row.check_kind,
    result: row.result,
    expectedUrl: row.expected_url,
    registeredUrl: row.registered_url,
    webhookActive: row.webhook_active == null ? null : Boolean(row.webhook_active),
    httpStatus: row.http_status,
  };
}

function connectionCheckResponse(
  account: DbLineAccount,
  rows: LineAccountConnectionCheck[],
  urls: ReturnType<typeof publicAccountUrls>,
) {
  const first = rows[0];
  return {
    accountId: account.id,
    revision: first?.account_revision ?? account.revision ?? 1,
    checkedAt: first?.checked_at ?? null,
    correlationId: first?.correlation_id ?? null,
    expectedUrls: urls,
    checks: rows.map(serializeConnectionCheck),
  };
}

async function collectConnectionChecks(
  account: DbLineAccount,
  expectedWebhookUrl: string,
  expectedLiffEndpointUrl: string | null,
  acceptedWebhook: readonly string[] = [expectedWebhookUrl],
): Promise<{ checks: ConnectionCheckDraft[]; botProfile: BotProfile | null }> {
  const checks: ConnectionCheckDraft[] = [];
  const headers = { Authorization: `Bearer ${account.channel_access_token}` };
  let botOk = false;
  let botProfile: BotProfile | null = null;
  try {
    const response = await fetch('https://api.line.me/v2/bot/info', { headers });
    botOk = response.ok;
    if (response.ok) botProfile = await response.json<BotProfile>();
    checks.push({ kind: 'bot_info', result: response.ok ? 'ok' : 'failed', httpStatus: response.status });
  } catch {
    checks.push({ kind: 'bot_info', result: 'failed', httpStatus: null });
  }

  let endpointResult: ConnectionCheckDraft = {
    kind: 'webhook_endpoint',
    result: 'unknown',
    expectedUrl: expectedWebhookUrl,
    registeredUrl: null,
    webhookActive: null,
    httpStatus: null,
  };
  let mayTestWebhook = false;
  if (botOk) {
    try {
      const response = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers });
      if (response.ok) {
        const payload = await response.json<{ endpoint?: string; active?: boolean }>();
        const registeredUrl = payload.endpoint?.trim() || null;
        const active = payload.active === true;
        endpointResult = {
          kind: 'webhook_endpoint',
          result: !registeredUrl
            ? 'unconfigured'
            : isAcceptedWebhookUrl(registeredUrl, acceptedWebhook) && active
              ? 'matched'
              : 'mismatched',
          expectedUrl: expectedWebhookUrl,
          registeredUrl,
          webhookActive: payload.active == null ? null : active,
          httpStatus: response.status,
        };
        mayTestWebhook = endpointResult.result === 'matched';
      } else {
        endpointResult.httpStatus = response.status;
      }
    } catch {
      // The canonical unknown state intentionally stores null for unavailable values.
    }
  }
  checks.push(endpointResult);

  if (mayTestWebhook) {
    try {
      const response = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = response.ok ? await response.json<{ success?: boolean }>() : null;
      checks.push({
        kind: 'webhook_test',
        result: response.ok && payload?.success === true ? 'ok' : 'failed',
        expectedUrl: expectedWebhookUrl,
        httpStatus: response.status,
      });
    } catch {
      checks.push({ kind: 'webhook_test', result: 'unknown', expectedUrl: expectedWebhookUrl });
    }
  } else {
    checks.push({ kind: 'webhook_test', result: 'unknown', expectedUrl: expectedWebhookUrl });
  }

  const loginMatchesLiff = Boolean(
    account.login_channel_id &&
    account.login_channel_secret &&
    account.liff_id &&
    /^\d+$/.test(account.login_channel_id) &&
    /^\d+-[A-Za-z0-9]+$/.test(account.liff_id) &&
    account.liff_id.startsWith(`${account.login_channel_id}-`),
  );
  checks.push({
    kind: 'liff_config',
    // LINE は登録済み Webhook URL の読取 API を公開しないため、ローカルの組合せが正しくても一致と断定せず不明にする。
    result: loginMatchesLiff ? 'unknown' : 'failed',
    expectedUrl: expectedLiffEndpointUrl,
    registeredUrl: null,
  });
  return { checks, botProfile };
}

async function verifyConnection(input: {
  channelAccessToken: string;
  loginChannelId: string;
  loginChannelSecret: string;
  liffId: string;
  expectedWebhookUrl: string | null;
  acceptedWebhookUrls?: readonly string[];
}): Promise<ConnectionVerification> {
  const result: ConnectionVerification = {
    messagingApi: false,
    webhook: false,
    lineLogin: /^\d+$/.test(input.loginChannelId),
    liff: /^\d+-[A-Za-z0-9]+$/.test(input.liffId),
    webhookUrl: null,
    botProfile: null,
    errors: [],
  };
  if (!input.loginChannelSecret.trim()) result.lineLogin = false;
  if (!result.lineLogin) result.errors.push('LINE LoginのChannel IDまたはChannel Secretを確認してください');
  if (!result.liff) result.errors.push('LIFF IDの形式を確認してください');

  const headers = { Authorization: `Bearer ${input.channelAccessToken}` };
  try {
    const botResponse = await fetch('https://api.line.me/v2/bot/info', { headers });
    result.messagingApi = botResponse.ok;
    if (botResponse.ok) result.botProfile = await botResponse.json<BotProfile>();
    if (!botResponse.ok) result.errors.push('Messaging APIのChannel Access Tokenを確認してください');
  } catch {
    result.errors.push('Messaging APIへ接続できませんでした');
  }

  if (result.messagingApi) {
    try {
      const endpointResponse = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      if (endpointResponse.ok) {
        const endpoint = await endpointResponse.json<{ endpoint?: string; active?: boolean }>();
        result.webhookUrl = endpoint.endpoint ?? null;
        const sameEndpoint = !input.expectedWebhookUrl
          || isAcceptedWebhookUrl(endpoint.endpoint, input.acceptedWebhookUrls ?? [input.expectedWebhookUrl]);
        if (endpoint.active && sameEndpoint) {
          const testResponse = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (testResponse.ok) {
            const tested = await testResponse.json<{ success?: boolean }>();
            result.webhook = tested.success === true;
          }
        }
      }
      if (!result.webhook) {
        result.errors.push('Webhook URLの一致・利用設定・接続テストを確認してください');
      }
    } catch {
      result.errors.push('Webhookの接続確認に失敗しました');
    }
  }
  return result;
}

// 保存前の接続確認。成功してもDBには一切書き込まない。
lineAccounts.post(
  '/api/line-accounts/verify-connection',
  requireRole('owner', 'admin'),
  denyReadOnly(),
  inputJsonBoundary({"channelAccessToken":["string"],"loginChannelId":["string"],"loginChannelSecret":["string"],"liffId":["string"]}), async (c) => {
    const body = await c.req.json<{
      channelAccessToken?: string;
      loginChannelId?: string;
      loginChannelSecret?: string;
      liffId?: string;
    }>();
    const base = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
    const data = await verifyConnection({
      channelAccessToken: body.channelAccessToken?.trim() ?? '',
      loginChannelId: body.loginChannelId?.trim() ?? '',
      loginChannelSecret: body.loginChannelSecret?.trim() ?? '',
      liffId: body.liffId?.trim() ?? '',
      expectedWebhookUrl: `${base}/webhook`,
      acceptedWebhookUrls: acceptedWebhookUrls(c.env, `${base}/webhook`),
    });
    return c.json({ success: true, data });
  },
);

// 一覧・詳細・運用画面で共有できるよう、再確認の結果を保存する。
lineAccounts.post(
  '/api/line-accounts/:id/connection-checks',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    try {
      const id = c.req.param('id')!;
      const account = await getAuthorizedLineAccount(c, id);
      if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      if (account.archived_at) return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);

      const idempotencyKey = c.req.header('Idempotency-Key')?.trim() ?? '';
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        return inputError(c, { success: false, error: 'Idempotency-Key is required' }, 422, []);
      }
      let body: { expectedRevision?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return inputError(c, { success: false, error: 'request body must be valid JSON' }, 422, []);
      }
      if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
        return inputError(c, { success: false, error: 'expectedRevision must be a positive integer' }, 422, ["expectedRevision"]);
      }

      const urls = publicAccountUrls(c, account.liff_id, account.channel_id);
      const existing = await getLineAccountConnectionChecksByIdempotencyKey(c.env.DB, id, idempotencyKey);
      if (existing.length > 0) {
        return c.json({ success: true, data: connectionCheckResponse(account, existing, urls) });
      }
      const currentRevision = account.revision ?? 1;
      if (currentRevision !== body.expectedRevision) {
        return c.json({ success: false, error: 'REVISION_CONFLICT', currentRevision }, 409);
      }

      const collected = await collectConnectionChecks(account, urls.webhook, urls.liffEndpoint, urls.webhookAccepted);
      const rows = await saveLineAccountConnectionChecks(c.env.DB, {
        lineAccountId: id,
        expectedRevision: Number(body.expectedRevision),
        checkedBy: c.get('staff').id,
        checkedAt: jstNow(),
        correlationId: c.req.header('X-Correlation-ID')?.trim() || crypto.randomUUID(),
        idempotencyKey,
        checks: collected.checks,
      });
      if (collected.botProfile) {
        await updateLineAccountFields(c.env.DB, id, {
          lineDisplayName: collected.botProfile.displayName ?? null,
          linePictureUrl: collected.botProfile.pictureUrl ?? null,
          lineBasicId: collected.botProfile.basicId ?? null,
          lineProfileSyncedAt: jstNow(),
        });
      }
      return c.json({ success: true, data: connectionCheckResponse(account, rows, urls) });
    } catch (error) {
      if (error instanceof LineAccountRevisionConflictError) {
        return c.json({ success: false, error: 'REVISION_CONFLICT' }, 409);
      }
      throw error;
    }
  },
);

// 組織の既定アカウントを切り替える。
lineAccounts.put('/api/line-accounts/default', requireRole('owner'), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  try {
    const body = await c.req.json<{ accountId?: string }>();
    if (!body.accountId) {
      return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
    }
    const account = await getAuthorizedLineAccount(c, body.accountId);
    if (!account) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    if (account.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }
    if (!account.is_active) {
      return c.json({ success: false, error: '停止中のLINEアカウントは既定にできません' }, 409);
    }
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    if ((account.tenant_id ?? DEFAULT_TENANT_ID) !== tenantId) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const updated = await setDefaultLineAccount(c.env.DB, account.id, tenantId);
    if (!updated?.is_default) {
      return c.json({ success: false, error: '既定のLINEアカウントを変更できませんでした' }, 409);
    }
    return c.json({ success: true, data: serializeLineAccount(updated) });
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

async function archiveAccountResponse(
  c: Context<Env>,
  defaultReason: string,
) {
  const id = c.req.param('id')!;
  const account = await getAuthorizedLineAccount(c, id);
  if (!account) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  // アカウントの停止・削除は大事な操作（V）。セッションの10分窓か、
  // この操作専用の1回限り grant が必要。
  if (!await sensitiveStepUpSatisfied(c, 'line_account.archive')) {
    return stepUpRequiredResponse(c, 'アカウントの停止・削除には本人確認が必要です');
  }
  if (account.archived_at) {
    return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
  }
  const blockers = await getLineAccountArchiveBlockers(c.env.DB, id);
  if (blockers.length > 0) {
    return c.json({
      success: false,
      error: 'LINE_ACCOUNT_ARCHIVE_BLOCKED',
      // `data` は ApiError.data へ載る口。画面は blockers を理由の言葉に写す。
      data: { blockers },
      details: { blockers },
    }, 409);
  }
  const body: { reason?: unknown } = await c.req
    .json<{ reason?: unknown }>()
    .catch(() => ({} as { reason?: unknown }));
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : defaultReason;
  if (reason.length > 500) {
    return inputError(c, { success: false, error: 'reason must be 500 characters or fewer' }, 422, ["reason"]);
  }
  const archived = await archiveLineAccount(c.env.DB, id, c.get('staff').id, reason);
  if (!archived) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  return c.json({ success: true, data: serializeLineAccount(archived) });
}

lineAccounts.post('/api/line-accounts/:id/archive', requireRole('owner'), inputJsonBoundary(), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  try {
    return await archiveAccountResponse(c, '運用者によるアーカイブ');
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

lineAccounts.post('/api/line-accounts/:id/restore', requireRole('owner'), inputJsonBoundary(), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  try {
    // 止めたアカウントの再有効化は接続の変更（V）。停止・削除と同じ確認を求める。
    if (!await sensitiveStepUpSatisfied(c, 'line_account.credentials')) {
      return stepUpRequiredResponse(c, 'アカウントの再開には本人確認が必要です');
    }
    const id = c.req.param('id')!;
    const account = await getAuthorizedLineAccount(c, id);
    if (!account) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const restored = await restoreLineAccount(c.env.DB, id);
    return c.json({ success: true, data: serializeLineAccount(restored!) });
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

/**
 * 送受信を止める（-33 §10-1、X-1）。
 * 理由は必須。止めている間の受信は署名検証から外れ、予約配信は
 * 「止めていたので送らなかった」として一覧に残る。
 */
lineAccounts.post('/api/line-accounts/:id/deactivate', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    if (!await sensitiveStepUpSatisfied(c, 'line_account.credentials')) {
      return stepUpRequiredResponse(c, 'アカウントの停止には本人確認が必要です');
    }
    const id = c.req.param('id')!;
    const account = await getAuthorizedLineAccount(c, id);
    if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    if (account.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }

    const body = await c.req
      .json<{ reason?: unknown }>()
      .catch(() => ({} as { reason?: unknown }));
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return inputError(c, { success: false, error: 'reason is required' }, 422, ["reason"]);
    }
    if (reason.length > 500) {
      return inputError(c, { success: false, error: 'reason must be 500 characters or fewer' }, 422, ["reason"]);
    }
    if (!account.is_active) {
      return c.json({ success: true, data: serializeLineAccount(account) });
    }

    const updated = await deactivateLineAccount(c.env.DB, id, {
      reason: 'manual',
      detail: reason,
    });
    auditLog(c, 'line_account.deactivate', { id, kind: 'line_account' }, { lineAccountId: id });
    return c.json({ success: true, data: serializeLineAccount(updated!) });
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

/**
 * 送受信を再開する（-33 §10-2、X-1）。
 * 理由は必須。再開の前に接続を確かめ、LINE との接続（bot_info）が
 * 通らないときは再開しない。確かめた結果は台帳にも残す。
 */
lineAccounts.post('/api/line-accounts/:id/activate', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  try {
    if (!await sensitiveStepUpSatisfied(c, 'line_account.credentials')) {
      return stepUpRequiredResponse(c, 'アカウントの再開には本人確認が必要です');
    }
    const id = c.req.param('id')!;
    const account = await getAuthorizedLineAccount(c, id);
    if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    if (account.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }

    const body = await c.req
      .json<{ reason?: unknown }>()
      .catch(() => ({} as { reason?: unknown }));
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) {
      return inputError(c, { success: false, error: 'reason is required' }, 422, ["reason"]);
    }
    if (reason.length > 500) {
      return inputError(c, { success: false, error: 'reason must be 500 characters or fewer' }, 422, ["reason"]);
    }

    // 再開の前に接続を確かめる。bot_info が通らなければ再開しない。
    const urls = publicAccountUrls(c, account.liff_id, account.channel_id);
    const collected = await collectConnectionChecks(account, urls.webhook, urls.liffEndpoint, urls.webhookAccepted);
    const botInfo = collected.checks.find((check) => check.kind === 'bot_info');
    const connectionOk = botInfo?.result === 'ok';
    try {
      await saveLineAccountConnectionChecks(c.env.DB, {
        lineAccountId: id,
        expectedRevision: account.revision ?? 1,
        checkedBy: c.get('staff').id,
        checkedAt: jstNow(),
        correlationId: c.req.header('X-Correlation-ID')?.trim() || crypto.randomUUID(),
        idempotencyKey: `activate-${crypto.randomUUID()}`,
        checks: collected.checks,
      });
    } catch (checkError) {
      // 台帳への記録が失敗しても再開判定は止めない（検査自体は済んでいる）。
      logger.error("line_accounts.by_id_activate_create_failed");
    }
    if (!connectionOk) {
      return inputError(c, {
          success: false,
          error: 'LINE との接続を確認できなかったため、まだ再開できません',
          checks: collected.checks.map((check) => ({
            kind: check.kind,
            result: check.result,
            expectedUrl: check.expectedUrl ?? null,
            registeredUrl: check.registeredUrl ?? null,
            webhookActive: check.webhookActive ?? null,
            httpStatus: check.httpStatus ?? null,
          })),
        }, 422, []);
    }

    const updated = await activateLineAccount(c.env.DB, id);
    auditLog(c, 'line_account.activate', { id, kind: 'line_account' }, { lineAccountId: id });
    return c.json({ success: true, data: serializeLineAccount(updated!) });
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

/**
 * 「止めていたので送らなかった」の一覧（-33 §10-2）。
 * 再開の画面で運用者が確認し、再実行は別途選ぶ。
 */
lineAccounts.get(
  '/api/line-accounts/:id/skipped-deliveries',
  requireRole('owner', 'admin'),
  async (c) => {
    try {
      const id = c.req.param('id')!;
      const account = await getAuthorizedLineAccount(c, id);
      if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      const rows = await listSkippedDeliveries(c.env.DB, id);
      return c.json({
        success: true,
        data: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          refId: row.ref_id,
          title: row.title,
          reason: row.reason,
          skippedAt: row.skipped_at,
        })),
      });
    } catch (err) {
      throw err;
    }
  },
);

// 登録アカウントの署名付き受信記録だけで、設定の完了を確認する。
lineAccounts.get('/api/line-accounts/:id/registration-receipt', requireRole('owner', 'admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const account = await getAuthorizedLineAccount(c, c.req.param('id'));
  if (!account || account.archived_at) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  return c.json({ success: true, data: await getLineRegistrationReceipt(c.env.DB, account.id) });
});

// GET /api/line-accounts/:id - get single without persisted secret values
lineAccounts.get('/api/line-accounts/:id', async (c) => {
  try {
    const account = await getAuthorizedLineAccount(c, c.req.param('id'));
    if (!account) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    return c.json({ success: true, data: { ...serializeLineAccount(account), connection: (await getLineAccountListStats(c.env.DB, [account.id]))[account.id]?.connection ?? { status: 'unknown', checkedAt: null, tokenExpired: false, issues: [] } } });
  } catch (err) {
    throw err;
  }
});

// オーナー向けの読み取り診断とし、資格情報は DB 層から外へ出さない。
lineAccounts.get(
  '/api/line-accounts/:id/credential-health',
  requireRole('owner'),
  async (c) => {
    try {
      const id = c.req.param('id');
      if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])) {
        return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      }
      const health = await getLineAccountCredentialHealth(
        c.env.DB,
        id,
      );
      if (!health) {
        return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      }
      return c.json({ success: true, data: health });
    } catch (error) {
      // 暗号や実行環境の例外に内部情報が含まれ得るため、元の例外は応答へ直列化しない。
      throw error;
    }
  },
);

// DB の状態を LINE 公式のフォロワー統計と比較する。
lineAccounts.get('/api/line-accounts/:id/follower-insight', async (c) => {
  try {
    const date = c.req.query('date');
    if (!date || !/^\d{8}$/.test(date)) {
      return c.json({ success: false, error: 'date query is required in yyyyMMdd format' }, 400);
    }

    const account = await getAuthorizedLineAccount(c, c.req.param('id'));
    if (!account) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const client = new LineClient(account.channel_access_token);
    const insight = await client.getFollowersInsight(date);
    return c.json({
      success: true,
      data: {
        lineAccountId: account.id,
        date,
        status: insight.status,
        followers: typeof insight.followers === 'number' ? insight.followers : null,
        targetedReaches: typeof insight.targetedReaches === 'number' ? insight.targetedReaches : null,
        blocks: typeof insight.blocks === 'number' ? insight.blocks : null,
      },
    });
  } catch (err) {
    const lineStatus = typeof (err as { status?: unknown } | null)?.status === 'number' ? (err as { status: number }).status : null; // LINEの状態番号(401失効/403権限不足/429上限)だけ残す。本文・トークンは出さない
    logger.error("line_accounts.by_id_follower_insight_get_failed");
    return c.json({ success: false, error: 'Failed to fetch LINE follower insight', lineStatus }, 502);
  }
});

// 既存友だちの移行は、明示的な一度限りのジョブとして保存する。D1 のカーソルを正本とし、ブラウザを閉じても cron が同じロックで継続する。1ページで止めず、時間と問い合わせ予算の範囲で進める。
lineAccounts.get('/api/line-accounts/:id/follower-import', async (c) => {
  const id = c.req.param('id')!;
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const state = await getFollowerImportState(c.env.DB, id);
  return c.json({ success: true, data: state });
});

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/detect',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    try {
      const account = await getAuthorizedLineAccount(c, c.req.param('id')!);
      if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      if (account.archived_at) {
        return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
      }
      const client = new LineClient(account.channel_access_token);
      const state = await detectFollowerImportCapability(
        c.env.DB,
        client as unknown as FollowerImportClient,
        account.id,
      );
      return c.json({ success: true, data: state });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("line_accounts.by_id_follower_import_detect_create_failed");
      return c.json({ success: false, error: '利用可否の確認に失敗しました' }, 502);
    }
  },
);

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/start',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const account = await getVisibleLineAccountEntry(c, c.req.param('id')!);
    if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    if (account.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }
    try {
      const state = await startFollowerImport(c.env.DB, account.id);
      return c.json({ success: true, data: state });
    } catch (err) {
      if (err instanceof Error && err.message === 'FOLLOWER_IMPORT_NOT_AVAILABLE') {
        return c.json({ success: false, error: 'このアカウントでは既存友だち取得を利用できません' }, 409);
      }
      throw err;
    }
  },
);

lineAccounts.post(
  '/api/line-accounts/:id/follower-import/step',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const account = await getAuthorizedLineAccount(c, c.req.param('id')!);
    if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    if (account.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }
    const client = new LineClient(account.channel_access_token);
    /* 画面を閉じられても、この 1 回ぶんは走り切らせる。途中で切られると進んだ分は
     * D1 に残るがロックだけ取られた状態になり、続きを拾えるまで待たされる。 */
    const run = processFollowerImportStep(c.env.DB, client as unknown as FollowerImportClient, account.id);
    try { c.executionCtx.waitUntil(run); } catch { /* 試験では executionCtx が無い */ }
    return c.json({ success: true, data: await run });
  },
);

// OAuth と LIFF の参照は先頭1行を選ぶため、login_channel_id/liff_id が重複すると別アカウントへ結び付く。事前確認に加え DB の UNIQUE で同時要求も防ぎ、どちらの競合も同じ理由で409を返す。
async function checkUniqueLoginAndLiff(
  db: D1Database,
  values: { loginChannelId?: string | null | undefined; liffId?: string | null | undefined },
  excludeId: string | null,
): Promise<string | null> {
  // 明示的に空でない値へ更新する項目だけを検査する。
  const checks: Array<{ column: string; value: string; label: string }> = [];
  if (typeof values.loginChannelId === 'string' && values.loginChannelId !== '') {
    checks.push({ column: 'login_channel_id', value: values.loginChannelId, label: 'loginChannelId' });
  }
  if (typeof values.liffId === 'string' && values.liffId !== '') {
    checks.push({ column: 'liff_id', value: values.liffId, label: 'liffId' });
  }
  for (const { column, value, label } of checks) {
    const row = excludeId
      ? await db
          .prepare(`SELECT id FROM line_accounts WHERE ${column} = ? AND id != ? LIMIT 1`)
          .bind(value, excludeId)
          .first<{ id: string }>()
      : await db
          .prepare(`SELECT id FROM line_accounts WHERE ${column} = ? LIMIT 1`)
          .bind(value)
          .first<{ id: string }>();
    if (row) {
      return `${label} '${value}' is already assigned to another account`;
    }
  }
  return null;
}

// 事前確認後の同時 INSERT も UNIQUE で検出し、使われている識別子を示して一般的な接続失敗と区別する。
function duplicateAccountError(
  message: string,
  values: { loginChannelId?: string | null; liffId?: string | null },
): { status: 409; error: string } | null {
  if (!/UNIQUE constraint failed/i.test(message)) return null;
  if (values.loginChannelId && message.includes('login_channel_id')) {
    return {
      status: 409,
      error: `loginChannelId '${values.loginChannelId}' is already assigned to another account`,
    };
  }
  if (values.liffId && message.includes('liff_id')) {
    return {
      status: 409,
      error: `liffId '${values.liffId}' is already assigned to another account`,
    };
  }
  return { status: 409, error: 'channelId already registered' };
}

async function readConnectRequest(c: Context<Env>) {
  try {
    const parsed = readConnectBody(await c.req.json<ConnectBody>());
    if (parsed.ok && parsed.value.tagIds.length) {
      const tags = await listLineAccountTags(c.env.DB, c.get('staff').tenantId ?? DEFAULT_TENANT_ID);
      if (!parsed.value.tagIds.every(id => tags.some(tag => tag.id === id))) return { ok: false as const, error: '指定した登録前のタグが見つかりません', status: 403 as const };
    }
    return parsed;
  } catch {
    return { ok: false as const, error: 'request body must be valid JSON' };
  }
}

async function probeFollowerCapability(channelAccessToken: string): Promise<'available' | 'unavailable' | 'unknown'> {
  try {
    await new LineClient(channelAccessToken).getFollowerIds(1);
    return 'available';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /LINE API error:\s*403/i.test(message) ? 'unavailable' : 'unknown';
  }
}

/*
 * V8 登録 ④接続確認（``）用の検証の内訳。`steps` の5段とは切り口が
 * 違い、画面の5行（チャネル・同じプロバイダー・Webhook・LINE ID・友だち
 * 追加URL）にそのまま載る。LINEにプロバイダ照合の口は無いため、
 * 同じプロバイダーは「Messaging APIとLINE Loginの両方の認証が通ったこと」
 * を代理条件にする（どちらかが落ちればここも落ちる）。
 */
export interface LineConnectVerification {
  tokenOk: boolean;
  loginOk: boolean;
  sameProvider: boolean;
  webhook: {
    expectedUrl: string;
    registeredUrl: string | null;
    active: boolean | null;
    testPassed: boolean | null;
  };
  followerTotal: number | null;
}

function stepPassed(steps: LineConnectStep[], order: LineConnectStep['order']): boolean {
  return steps.some((item) => item.order === order && item.state === 'passed');
}

/* 友だち数の統計は前日分しか無い。日本時間の昨日を yyyyMMdd で返す。 */
export function insightDateJst(now: Date = new Date()): string {
  return japanDateOffset(-1, now).replaceAll('-', '');
}

/*
 * 登録前の友だち総数。V8 ④の結果窓（``）のボット情報に出す。
 * 取れなければ null（表示は名前だけにする）。検査の合否には使わない。
 */
export async function fetchPreConnectFollowerTotal(channelAccessToken: string): Promise<number | null> {
  try {
    const insight = await new LineClient(channelAccessToken).getFollowersInsight(insightDateJst());
    return typeof insight.followers === 'number' ? insight.followers : null;
  } catch {
    return null;
  }
}

function publicConnectData(
  prepared: Awaited<ReturnType<typeof prepareLineConnection>>,
  steps: LineConnectStep[],
  followerImport: { capability: 'unknown' | 'available' | 'unavailable'; phase: string },
  id?: string,
  followerTotal: number | null = null,
) {
  const tokenOk = stepPassed(steps, 1);
  const loginOk = stepPassed(steps, 4);
  const verification: LineConnectVerification = {
    tokenOk,
    loginOk,
    sameProvider: tokenOk && loginOk,
    webhook: { ...prepared.webhook },
    followerTotal,
  };
  return {
    steps,
    verification,
    id,
    displayName: prepared.bot?.displayName,
    pictureUrl: prepared.bot?.pictureUrl ?? null,
    basicId: prepared.bot?.basicId ?? null,
    liffId: prepared.liffId,
    followerImport,
    // 「チャット」オンでもWebhookは届く（LINEは2022-11-30から併用を
    // サポート）。残す案内は自動返信の重複だけにする。チャットのまま
    // 運用している店舗にオフを求めない。
    remainingActions: prepared.bot?.chatMode === 'chat'
      ? ['LINE公式アカウントの「チャット」がオンです。メッセージの受信はそのまま動きます。自動返信が二重に届かないよう、LINE Official Account Managerの「あいさつメッセージ」「応答メッセージ」はオフにしてください']
      : [],
  };
}

// UI用の自動接続確認。LINE側のWebhook・LIFFは設定するが、musuboのDBには書き込まない。
lineAccounts.post('/api/line-accounts/connect/check', requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary(), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  const parsed = await readConnectRequest(c);
  if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 'status' in parsed ? parsed.status : 422, ["name","channelId","channelSecret"]);
  let registration;
  try { registration=await validateRegistrationOptions(c.env.DB,c.get('staff').tenantId ?? DEFAULT_TENANT_ID,parsed.value,c.get('staff').id); }
  catch(error) { if(error instanceof RegistrationOptionsError) return inputError(c, {success:false,error:'タグ・親・担当者の指定を確認してください',code:error.code}, error.status, []); throw error; }
  const alreadyRegistered = await c.env.DB.prepare('SELECT id FROM line_accounts WHERE channel_id = ?')
    .bind(parsed.value.channelId).first();
  if (alreadyRegistered) return c.json({ success: false, error: 'このLINEチャネルは登録済みです' }, 409);
  const baseUrl = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const prepared = await prepareLineConnection({ ...parsed.value, baseUrl, acceptedWebhookUrls: acceptedWebhookUrls(c.env, accountWebhookUrl(baseUrl, parsed.value.channelId)) });
  if (!prepared.success || !prepared.channelAccessToken) {
    return c.json({
      success: true,
      data: publicConnectData(prepared, prepared.steps, { capability: 'unknown', phase: 'not_started' }),
    });
  }
  if (!parsed.value.importFriends) return c.json({
    success: true,
    data: publicConnectData(prepared, [...prepared.steps.slice(0, 4), lineConnectStep(5, 'passed', '友だちは引き継ぎません。')], { capability: 'unknown', phase: 'not_started' }),
  });
  const capability = await probeFollowerCapability(prepared.channelAccessToken);
  const finalStep = capability === 'unknown'
    ? lineConnectStep(5, 'failed', '認証状態を確認できませんでした。時間をおいて、もう一度お試しください。')
    : lineConnectStep(5, 'passed');
  const followerTotal = await fetchPreConnectFollowerTotal(prepared.channelAccessToken);
  return c.json({
    success: true,
    data: publicConnectData(
      prepared,
      [...prepared.steps.slice(0, 4), finalStep],
      { capability, phase: 'not_started' },
      undefined,
      followerTotal,
    ),
  });
});

// UI用の自動接続・保存。5段目が完了しなければ作成途中の行を必ず巻き戻す。
lineAccounts.post('/api/line-accounts/connect', requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary(), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  const musuboGate = await musuboFirstLineGate(c);
  if (musuboGate instanceof Response) return musuboGate;
  // LINE の接続（新しいアカウントの接続）は大事な操作（V）。
  if (!await sensitiveStepUpSatisfied(c, 'line_account.connect')) {
    return stepUpRequiredResponse(c, 'LINEの接続には本人確認が必要です');
  }
  const parsed = await readConnectRequest(c);
  if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 'status' in parsed ? parsed.status : 422, ["name","channelId","channelSecret"]);
  let registration;
  try { registration=await validateRegistrationOptions(c.env.DB,c.get('staff').tenantId ?? DEFAULT_TENANT_ID,parsed.value,c.get('staff').id); }
  catch(error) { if(error instanceof RegistrationOptionsError) return inputError(c, {success:false,error:'タグ・親・担当者の指定を確認してください',code:error.code}, error.status, []); throw error; }
  const alreadyRegistered = await c.env.DB.prepare('SELECT id FROM line_accounts WHERE channel_id = ?')
    .bind(parsed.value.channelId).first();
  if (alreadyRegistered) return c.json({ success: false, error: 'このLINEチャネルは登録済みです' }, 409);
  const baseUrl = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  const prepared = await prepareLineConnection({ ...parsed.value, baseUrl, acceptedWebhookUrls: acceptedWebhookUrls(c.env, accountWebhookUrl(baseUrl, parsed.value.channelId)) });
  if (!prepared.success || !prepared.channelAccessToken || !prepared.bot || !prepared.liffId) {
    return inputError(c, {
      success: false,
      error: prepared.steps.find((item) => item.state === 'failed')?.message ?? '接続設定を完了できませんでした',
      data: publicConnectData(prepared, prepared.steps, { capability: 'unknown', phase: 'not_started' }),
    }, 400, []);
  }

  const duplicate = await checkUniqueLoginAndLiff(c.env.DB, {
    loginChannelId: parsed.value.loginChannelId,
    liffId: prepared.liffId,
  }, null);
  if (duplicate) return c.json({ success: false, error: duplicate }, 409);

  let account: DbLineAccount | null = null;
  let savingStyle = false;
  try {
    account = await createLineAccount(c.env.DB, {
      createdByStaffId: c.get('staff').id,
      channelId: parsed.value.channelId,
      name: parsed.value.name || prepared.bot.displayName,
      channelAccessToken: prepared.channelAccessToken,
      channelSecret: parsed.value.channelSecret,
      loginChannelId: parsed.value.loginChannelId,
      loginChannelSecret: parsed.value.loginChannelSecret,
      liffId: prepared.liffId,
      timezone: 'Asia/Tokyo',
      parentLineAccountId: parsed.value.parentLineAccountId ?? null,
      tenantId: c.get('staff').tenantId ?? DEFAULT_TENANT_ID,
      lineDisplayName: prepared.bot.displayName ?? null,
      linePictureUrl: prepared.bot.pictureUrl ?? null,
      lineBasicId: prepared.bot.basicId ?? null,
      lineProfileSyncedAt: jstNow(),
    }, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);

    const followerState = parsed.value.importFriends ? await detectFollowerImportCapability(
      c.env.DB,
      new LineClient(prepared.channelAccessToken) as unknown as FollowerImportClient,
      account.id,
    ) : await getFollowerImportState(c.env.DB, account.id);
    if (parsed.value.importFriends && followerState.capability === 'unknown') {
      throw new Error('FOLLOWER_CAPABILITY_UNKNOWN');
    }

    await saveLineAccountConnectionChecks(c.env.DB, {
      lineAccountId: account.id,
      expectedRevision: account.revision ?? 1,
      checkedBy: c.get('staff').id,
      checkedAt: jstNow(),
      correlationId: crypto.randomUUID(),
      idempotencyKey: `auto-connect-${crypto.randomUUID()}`,
      checks: [
        { kind: 'bot_info', result: 'ok', httpStatus: 200 },
        {
          kind: 'webhook_endpoint',
          result: prepared.webhook.registeredUrl === prepared.webhook.expectedUrl ? 'matched' : 'mismatched',
          expectedUrl: prepared.webhook.expectedUrl,
          registeredUrl: prepared.webhook.registeredUrl,
          webhookActive: prepared.webhook.active,
          httpStatus: 200,
        },
        { kind: 'webhook_test', result: prepared.webhook.testPassed ? 'ok' : 'failed', httpStatus: 200 },
        {
          kind: 'liff_config',
          result: 'matched',
          expectedUrl: `${baseUrl}?liffId=${encodeURIComponent(prepared.liffId)}`,
          registeredUrl: `${baseUrl}?liffId=${encodeURIComponent(prepared.liffId)}`,
          httpStatus: 200,
        },
      ],
    });

    await applyRegistrationOptions(c.env.DB,account.id,c.get('staff').id,registration);
    const started = parsed.value.importFriends && followerState.capability === 'available' ? await startFollowerImport(c.env.DB,account.id) : followerState;
    if (musuboGate === 'first') await startFirstMusuboLine(c, account.id);
    savingStyle = true;
    await initializeAccountStyle(c.env.DB,account.id,account.tenant_id??DEFAULT_TENANT_ID,c.get('staff').id,parsed.value.style,starterCatalogRuntime(c));
    savingStyle = false; try { if (parsed.value.importFriends) scheduleInitialFollowerImport(c.executionCtx, c.env.DB, new LineClient(prepared.channelAccessToken) as unknown as FollowerImportClient, account.id, started, () => logger.error('line_accounts.initial_follower_import_failed')); } catch { /* 単体試験は executionCtx を持たない */ }
    const steps = [...prepared.steps.slice(0, 4), lineConnectStep(5, 'passed', parsed.value.importFriends ? undefined : '友だちは引き継ぎません。')];
    return c.json({
      success: true,
      data: publicConnectData(prepared, steps, {
        capability: started.capability,
        phase: started.phase,
      }, account.id),
    }, 201);
  } catch (error) {
    if (account && savingStyle) return c.json({ success: false, error: 'style_save_failed', data: { accountId: account.id, style: parsed.value.style ?? null, styleSaved: false, retryAt: `/api/dashboard/style?account_id=${encodeURIComponent(account.id)}`, starterRetryAt: `/api/dashboard/style/starter-items/ensure?account_id=${encodeURIComponent(account.id)}` } }, 502);
    if (account) await deleteUncommittedLineAccount(c.env.DB, account.id);
    if (error instanceof RegistrationOptionsError) return inputError(c, {success:false,error:'登録中にタグ・親・担当範囲が変わりました。選び直してください',code:error.code}, error.status, []);
    if (error instanceof CredentialEncryptionKeyError) {
      return c.json({ success: false, error: 'LINE資格情報の暗号鍵が未設定です' }, 503);
    }
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = duplicateAccountError(message, {
      loginChannelId: parsed.value.loginChannelId,
      liffId: prepared.liffId,
    });
    return inputError(c, {
      success: false,
      error: duplicate ? duplicate.error : '認証状態を確認できなかったため、アカウントは保存していません',
      data: publicConnectData(
        prepared,
        [...prepared.steps.slice(0, 4), lineConnectStep(5, 'failed', '認証状態を確認できませんでした。時間をおいて、もう一度お試しください。')],
        { capability: 'unknown', phase: 'not_started' },
      ),
    }, duplicate ? duplicate.status : 502, []);
  }
});

// POST /api/line-accounts - create
lineAccounts.post('/api/line-accounts', requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary(), async (c) => {
  if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  const musuboGate = await musuboFirstLineGate(c);
  if (musuboGate instanceof Response) return musuboGate;
  // LINE の接続の追加は大事な操作（V）。
  if (!await sensitiveStepUpSatisfied(c, 'line_account.connect')) {
    return stepUpRequiredResponse(c, 'LINEの接続には本人確認が必要です');
  }
  // INSERT競争の負け側の409案内に使う。catch からも読めるよう try の外に置く。
  let attemptedLoginChannelId: string | null = null;
  let attemptedLiffId: string | null = null;
  try {
    let body: {
      style?: AccountStyle;
      channelId: string;
      name: string;
      channelAccessToken: string;
      channelSecret: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
      ogSiteName?: string | null;
      ogDefaultImageUrl?: string | null;
      ogDefaultDescription?: string | null;
      officialProfileUrl?: string | null;
      timezone?: string;
      country?: string | null;
      role?: string | null;
      parentLineAccountId?: string | null;
      copyFromAccountId?: string | null;
      copyItems?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return inputError(c, { success: false, error: 'request body must be valid JSON' }, 422, []);
    }

    if (body.style !== undefined && !ACCOUNT_STYLES.includes(body.style)) return inputError(c, { success: false, error: 'invalid_style' }, 422, ['style']);
    if (!body.channelId || !body.name || !body.channelAccessToken || !body.channelSecret) {
      return inputError(c, { success: false, error: 'channelId, name, channelAccessToken, and channelSecret are required' }, 400, ["channelId","name","channelAccessToken","channelSecret"]);
    }
    if (
      typeof body.channelId !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.channelAccessToken !== 'string' ||
      typeof body.channelSecret !== 'string' ||
      (body.timezone !== undefined && typeof body.timezone !== 'string') ||
      (body.country !== undefined && body.country !== null && typeof body.country !== 'string') ||
      (body.role !== undefined && body.role !== null && typeof body.role !== 'string') ||
      (body.parentLineAccountId !== undefined &&
        body.parentLineAccountId !== null &&
        typeof body.parentLineAccountId !== 'string')
    ) {
      return inputError(c, { success: false, error: 'request fields have invalid types' }, 422, ["channelId","name","channelAccessToken","channelSecret","timezone","country","role","parentLineAccountId"]);
    }
    const name = body.name.trim();
    if (name.length === 0 || name.length > 40 || !/^\d+$/.test(body.channelId.trim())) {
      return inputError(c, { success: false, error: 'name or channelId is invalid' }, 422, ["name","channelId"]);
    }
    const timezone = body.timezone?.trim() || 'Asia/Tokyo';
    try {
      new Intl.DateTimeFormat('ja-JP', { timeZone: timezone }).format();
    } catch {
      return inputError(c, { success: false, error: 'timezone must be a valid IANA time zone' }, 422, ["timezone"]);
    }
    const country = normalizeOptionalString(body.country) ?? null;
    const role = normalizeOptionalString(body.role) ?? null;
    const parentLineAccountId = normalizeOptionalString(body.parentLineAccountId) ?? null;
    if ((country?.length ?? 0) > 80 || (role?.length ?? 0) > 200) {
      return inputError(c, { success: false, error: 'country or role is too long' }, 422, ["country","role"]);
    }

    // コピー時の余分な空白で OAuth を壊さないよう文字列を trim し、空は NULL へ正規化する。
    const loginChannelId = normalizeOptionalString(body.loginChannelId) ?? null;
    const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret) ?? null;
    const liffId = normalizeOptionalString(body.liffId) ?? null;
    attemptedLoginChannelId = loginChannelId;
    attemptedLiffId = liffId;
    const officialProfileUrl = readOfficialProfileUrl(body.officialProfileUrl);
    if (!officialProfileUrl.ok) return inputError(c, { success: false, error: officialProfileUrl.error }, 400, ["officialProfileUrl"]);

    const pairError = validateLoginChannelPair(
      { loginChannelId, loginChannelSecret },
      null,
    );
    if (pairError) return inputError(c, { success: false, error: pairError }, 400, ["liffId","liffChannelId"]);
    if (!loginChannelId || !loginChannelSecret || !liffId) {
      return inputError(c, { success: false, error: 'LINE LoginとLIFFの設定は必須です' }, 400, ["loginChannelId","loginChannelSecret","liffId"]);
    }

    const dupError = await checkUniqueLoginAndLiff(c.env.DB, { loginChannelId, liffId }, null);
    if (dupError) return c.json({ success: false, error: dupError }, 409);

    const copyItems = normalizeCopyItems(body.copyItems);
    if (copyItems === null) return inputError(c, { success: false, error: 'コピー項目が正しくありません' }, 400, ["copyItems"]);
    const copyFromAccountId = normalizeOptionalString(body.copyFromAccountId) ?? null;
    const visibleAccounts = (await getVisibleLineAccountScope(c.env.DB, c.get('staff'))).accounts;
    const currentStaff = c.get('staff');
    if (
      currentStaff.role === 'admin' &&
      currentStaff.assignedLineAccountId &&
      !currentStaff.canAccessDescendantAccounts
    ) {
      return c.json({ success: false, error: '他アカウント権限がないため追加できません' }, 403);
    }
    if (parentLineAccountId) {
      const parent = visibleAccounts.find((item) => item.id === parentLineAccountId);
      if (!parent) return fail(c, 404, 'PARENT_LINE_ACCOUNT_NOT_FOUND');
      if (parent.archived_at) {
        return c.json({ success: false, error: 'archived account cannot be selected as parent' }, 409);
      }
    }
    if (copyFromAccountId) {
      const source = visibleAccounts.find((item) => item.id === copyFromAccountId);
      if (!source) return c.json({ success: false, error: 'コピー元を選択できません' }, 404);
      if (!source.is_active || !source.login_channel_id || !source.liff_id) {
        return inputError(c, { success: false, error: '接続済みのアカウントだけコピー元に選べます' }, 400, ["copyFromAccountId"]);
      }
      if (copyItems.length === 0) {
        return inputError(c, { success: false, error: 'コピーする項目を1つ以上選択してください' }, 400, ["copyItems"]);
      }
    } else if (copyItems.length > 0) {
      return inputError(c, { success: false, error: 'コピー元を選択してください' }, 400, ["copyItems"]);
    }

    const base = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
    const verification = await verifyConnection({
      channelAccessToken: body.channelAccessToken.trim(),
      loginChannelId,
      loginChannelSecret,
      liffId,
      expectedWebhookUrl: accountWebhookUrl(base, body.channelId.trim()),
      acceptedWebhookUrls: [...acceptedWebhookUrls(c.env, accountWebhookUrl(base, body.channelId.trim())), ...acceptedWebhookUrls(c.env, `${base}/webhook`)],
    });
    if (!verification.messagingApi || !verification.webhook || !verification.lineLogin || !verification.liff) {
      return inputError(c, { success: false, error: 'すべての接続確認を完了してください', details: { connection: verification.errors } }, 400, ["channelAccessToken"]);
    }

    if (!await verifyLineMessagingIdentity({ channelId: body.channelId.trim(), channelSecret: body.channelSecret.trim(), channelAccessToken: body.channelAccessToken.trim() })) {
      return inputError(c, { success: false, error: '同じMessaging APIチャネルのID・シークレット・アクセストークンを指定してください' }, 422, ['channelId', 'channelSecret', 'channelAccessToken']);
    }

    const account = await createLineAccount(c.env.DB, {
      createdByStaffId: currentStaff.id,
      channelId: body.channelId.trim(),
      name,
      channelAccessToken: body.channelAccessToken,
      channelSecret: body.channelSecret,
      loginChannelId,
      loginChannelSecret,
      liffId,
      ogSiteName: normalizeOptionalString(body.ogSiteName) ?? null,
      ogDefaultImageUrl: normalizeOptionalString(body.ogDefaultImageUrl) ?? null,
      ogDefaultDescription: normalizeOptionalString(body.ogDefaultDescription) ?? null,
      officialProfileUrl: officialProfileUrl.value ?? null,
      timezone,
      country,
      role,
      parentLineAccountId,
      tenantId: currentStaff.tenantId ?? DEFAULT_TENANT_ID,
      lineDisplayName: verification.botProfile?.displayName ?? null,
      linePictureUrl: verification.botProfile?.pictureUrl ?? null,
      lineBasicId: verification.botProfile?.basicId ?? null,
      lineProfileSyncedAt: verification.botProfile ? jstNow() : null,
    }, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);

    if (copyFromAccountId && copyItems.length > 0) {
      try {
        await copyLineAccountSettings(c.env.DB, copyFromAccountId, account.id, copyItems);
      } catch (copyError) {
        await deleteUncommittedLineAccount(c.env.DB, account.id);
        throw new UnexpectedRouteError(c, { success: false, error: '設定のコピーに失敗したため、アカウントは追加していません' });
      }
    }

    // 接続時に1回だけ followers/ids の利用可否を確認する。移行は始めず、一時的な LINE 障害でもアカウント登録は取り消さない。
    try {
      await detectFollowerImportCapability(
        c.env.DB,
        new LineClient(account.channel_access_token) as unknown as FollowerImportClient,
        account.id,
      );
    } catch (err) {
      logger.error("line_accounts.create_failed");
    }

    if (musuboGate === 'first') {
      try {
        await startFirstMusuboLine(c, account.id);
      } catch {
        await deleteUncommittedLineAccount(c.env.DB, account.id);
        return c.json({ success: false, error: 'LINEの利用開始を確定できませんでした。時間をおいて再度お試しください' }, 409);
      }
    }
    try {
      await initializeAccountStyle(c.env.DB,account.id,account.tenant_id??DEFAULT_TENANT_ID,c.get('staff').id,body.style,starterCatalogRuntime(c));
    } catch {
      return c.json({ success: false, error: 'style_save_failed', data: { accountId: account.id, style: body.style ?? null, styleSaved: false, retryAt: `/api/dashboard/style?account_id=${encodeURIComponent(account.id)}`, starterRetryAt: `/api/dashboard/style/starter-items/ensure?account_id=${encodeURIComponent(account.id)}` } }, 502);
    }
    return c.json({ success: true, data: serializeLineAccountFull(account) }, 201);
  } catch (err) {
    if (err instanceof CredentialEncryptionKeyError) {
      return c.json({ success: false, error: 'LINE資格情報の暗号鍵が未設定です' }, 503);
    }
    // 同時登録の一意制約エラーは409へ変換し、CLI が登録済みとして安全に扱えるようにする。ログインチャネルと LIFF の重複も含める。
    const message = err instanceof Error ? err.message : String(err);
    const duplicate = duplicateAccountError(message, {
      loginChannelId: attemptedLoginChannelId,
      liffId: attemptedLiffId,
    });
    if (duplicate) {
      return inputError(c, { success: false, error: duplicate.error }, duplicate.status, []);
    }
    throw err;
  }
});

// Messaging の資格情報を誤って変更すると受信全体を止めるため、PUT は owner のみにする。表示情報の PATCH と順序変更は owner/admin に許可する。

// order を動的 ID と誤認しないよう、まとめて順序を変える入口を /:id より先に置く。
lineAccounts.patch(
  '/api/line-accounts/hierarchy',
  requireRole('owner', 'admin'),
  inputJsonBoundary({"relationships":["array"]}), async (c) => {
    if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
    try {
      const body = await c.req.json<{
        relationships?: Array<{ id?: unknown; parentLineAccountId?: unknown }>;
      }>();
      if (!Array.isArray(body.relationships) || body.relationships.length === 0) {
        return inputError(c, { success: false, error: '変更するLINEアカウント構成がありません' }, 400, ["relationships"]);
      }
      const relationships: Array<{ id: string; parentLineAccountId: string | null }> = [];
      for (const item of body.relationships) {
        if (
          typeof item.id !== 'string' ||
          !(item.parentLineAccountId === null || typeof item.parentLineAccountId === 'string')
        ) {
          return inputError(c, { success: false, error: 'LINEアカウント構成の形式が正しくありません' }, 400, ["relationships"]);
        }
        relationships.push({ id: item.id, parentLineAccountId: item.parentLineAccountId });
      }

      const visible = (await getVisibleLineAccountScope(c.env.DB, c.get('staff'))).accounts;
      const tenantAccounts = await getLineAccountScopeEntries(
        c.env.DB,
        c.get('staff').tenantId ?? DEFAULT_TENANT_ID,
      );
      const visibleIds = new Set(visible.map((account) => account.id));
      if (
        relationships.some(
          (item) =>
            !visibleIds.has(item.id) ||
            (item.parentLineAccountId !== null && !visibleIds.has(item.parentLineAccountId)),
        )
      ) {
        return c.json({ success: false, error: '権限のないLINEアカウントは変更できません' }, 403);
      }
      if (relationships.some((item) => {
        const target = visible.find((account) => account.id === item.id);
        const parent = item.parentLineAccountId
          ? visible.find((account) => account.id === item.parentLineAccountId)
          : null;
        return Boolean(target?.archived_at || parent?.archived_at);
      })) {
        return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
      }
      const hierarchyError = validateAccountHierarchy(tenantAccounts, relationships);
      if (hierarchyError) return inputError(c, { success: false, error: hierarchyError }, 400, ["relationships"]);

      await c.env.DB.batch(
        relationships.map((item) =>
          c.env.DB
            .prepare(
              `UPDATE line_accounts
               SET parent_line_account_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
               WHERE id = ?`,
            )
            .bind(item.parentLineAccountId, item.id),
        ),
      );
      return c.json({ success: true, data: relationships });
    } catch (err) {
      throw err;
    }
  },
);

lineAccounts.patch(
  '/api/line-accounts/order',
  requireRole('owner', 'admin'),
  inputJsonBoundary({"ordered":["array"]}), async (c) => {
    if (!await hasTenantWideLineAccountScope(c)) return c.json({ success: false, error: '統括の権限が必要です' }, 403);
    try {
      const body = await c.req.json<{
        ordered: Array<{ id: string; displayOrder: number }>;
      }>();

      if (!Array.isArray(body.ordered)) {
        return inputError(c, { success: false, error: 'ordered: array required' }, 400, ["ordered"]);
      }
      for (const item of body.ordered) {
        if (typeof item.id !== 'string' || typeof item.displayOrder !== 'number') {
          return inputError(c, { success: false, error: 'ordered[].id (string) and displayOrder (number) required' }, 400, ["ordered"]);
        }
      }

      const visibleAccounts = (await getVisibleLineAccountScope(c.env.DB, c.get('staff'))).accounts;
      const visibleIds = new Set(visibleAccounts.map((item) => item.id));
      if (body.ordered.some((item) => !visibleIds.has(item.id))) {
        return c.json({ success: false, error: '権限のないLINEアカウントは並べ替えできません' }, 403);
      }
      const archivedIds = new Set(
        visibleAccounts
          .filter((account) => Boolean(account.archived_at))
          .map((account) => account.id),
      );
      if (body.ordered.some((item) => archivedIds.has(item.id))) {
        return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
      }

      await updateLineAccountOrder(c.env.DB, body.ordered);
      return c.json({ success: true });
    } catch (err) {
      const conflict = lifecycleConflict(err);
      if (conflict) return c.json(conflict, 409);
      throw err;
    }
  },
);

// PATCH は表示情報と Login/LIFF の接続を扱い、Messaging の資格情報は owner 専用 PUT へ分ける。Login の秘密値の変更は新規認証に限るが、Messaging の変更は全 Webhook の署名検証に及ぶため、異なる権限境界を保つ。
lineAccounts.patch(
  '/api/line-accounts/:id',
  requireRole('owner', 'admin'),
  inputJsonBoundary({"name":["string"],"isActive":["boolean"],"country":["null","string"],"role":["null","string"],"loginChannelId":["null","string"],"loginChannelSecret":["null","string"],"liffId":["null","string"],"ogSiteName":["null","string"],"ogDefaultImageUrl":["null","string"],"ogDefaultDescription":["null","string"],"iconUrl":["null","string"],"officialProfileUrl":["null","string"]}), async (c) => {
    try {
      const id = c.req.param('id')!;
      if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])) {
        return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      }
      const currentAccount = await getLineAccountById(c.env.DB, id);
      if (!currentAccount) {
        return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      }
      if (currentAccount.archived_at) {
        return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
      }
      const body = await c.req.json<{
        name?: string;
        isActive?: boolean;
        country?: string | null;
        role?: string | null;
        loginChannelId?: string | null;
        loginChannelSecret?: string | null;
        liffId?: string | null;
        ogSiteName?: string | null;
        ogDefaultImageUrl?: string | null;
        ogDefaultDescription?: string | null;
        friendCapacity?: unknown;
        capacityWarnAt?: unknown;
        iconUrl?: string | null;
        officialProfileUrl?: string | null;
      }>();
      // 送受信の停止・再開は理由が必須（X-1）。この窓口では受けない。
      if (body.isActive !== undefined && Boolean(currentAccount.is_active) !== body.isActive) {
        return inputError(c, {
          success: false,
          error: '送受信の停止・再開は理由が必要です。/deactivate・/activate を使ってください',
        }, 422, ["isActive"]);
      }

      // 画面で消去した空文字を NULL にし、国旗などの表示が安全に代替できるようにする。
      const country = normalizeOptionalString(body.country);
      const role = normalizeOptionalString(body.role);
      const loginChannelId = normalizeOptionalString(body.loginChannelId);
      const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret);
      const liffId = normalizeOptionalString(body.liffId);
    if (liffId && !/^\d+-[A-Za-z0-9]+$/.test(liffId)) return inputError(c, { success: false, error: 'LIFF IDを確認してください' }, 400, ['liffId']);
      const ogSiteName = normalizeOptionalString(body.ogSiteName);
      const ogDefaultImageUrl = normalizeOptionalString(body.ogDefaultImageUrl);
      const ogDefaultDescription = normalizeOptionalString(body.ogDefaultDescription);
      const iconUrl = normalizeOptionalString(body.iconUrl);
      const officialProfileUrl = readOfficialProfileUrl(body.officialProfileUrl);
      if (!officialProfileUrl.ok) return inputError(c, { success: false, error: officialProfileUrl.error }, 400, ["officialProfileUrl"]);

      // 警告値と上限の突き合わせには、送られていない側の現在値が要る。
      // 上限だけを下げたときに、既存の警告値が上限を超える場合があるため。
      const touchesCapacity =
        Object.prototype.hasOwnProperty.call(body, 'friendCapacity') ||
        Object.prototype.hasOwnProperty.call(body, 'capacityWarnAt');
      const capacity = readCapacity(
        body,
        touchesCapacity ? currentAccount : null,
      );
      if (!capacity.ok) return inputError(c, { success: false, error: capacity.error }, 400, ["friendCapacity","capacityWarnAt"]);

      // 書込前にログインの組合せと一意性を検査する。該当項目に触れない更新では不要な SELECT を省き、既存の片側だけの設定で LIFF の保存まで拒まない。
      const touchesLogin =
        loginChannelId !== undefined || loginChannelSecret !== undefined;
      const touchesLoginOrLiff = touchesLogin || liffId !== undefined;
      /*
       * Login鍵の書き換え・送受信の有効/停止は大事な操作（V）。
       * 名前やOG情報だけの更新は対象外なので、触った項目で分ける。
       */
      if (
        (touchesLoginOrLiff || body.isActive !== undefined)
        && !await sensitiveStepUpSatisfied(c, 'line_account.credentials')
      ) {
        return stepUpRequiredResponse(c, '接続情報・有効状態の変更には本人確認が必要です');
      }
      if (touchesLoginOrLiff) {
        if (touchesLogin) {
          const pairError = validateLoginChannelPair(
            { loginChannelId, loginChannelSecret },
            currentAccount,
          );
          if (pairError) return inputError(c, { success: false, error: pairError }, 400, ["liffId","loginChannelId"]);
        }
        const dupError = await checkUniqueLoginAndLiff(
          c.env.DB,
          { loginChannelId, liffId },
          id,
        );
        if (dupError) return c.json({ success: false, error: dupError }, 409);
      }

      const touchesOg =
        ogSiteName !== undefined ||
        ogDefaultImageUrl !== undefined ||
        ogDefaultDescription !== undefined;

      const fieldsTouched =
        country !== undefined ||
        role !== undefined ||
        body.isActive !== undefined ||
        touchesLoginOrLiff ||
        touchesOg ||
        touchesCapacity ||
        iconUrl !== undefined;
      const touchesOfficialProfileUrl = officialProfileUrl.value !== undefined;

      // 名前が未指定なら、項目だけを更新する関数へ渡す。
      if (body.name === undefined && (fieldsTouched || touchesOfficialProfileUrl)) {
        const updated = await updateLineAccountFields(c.env.DB, id, {
          country,
          role,
          isActive: body.isActive,
          loginChannelId,
          loginChannelSecret,
          liffId,
          ogSiteName,
          ogDefaultImageUrl,
          ogDefaultDescription,
          iconUrl,
          officialProfileUrl: officialProfileUrl.value,
          ...capacity.value,
        });
        if (!updated) return fail(c, 404, 'NOT_FOUND');
        return c.json({ success: true, data: serializeLineAccount(updated) });
      }

      // 名前が指定されていれば、アカウント全体の更新関数へ渡す。
      const updated = await updateLineAccount(c.env.DB, id, {
        name: body.name,
        is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
        login_channel_id: loginChannelId,
        login_channel_secret: loginChannelSecret,
        liff_id: liffId,
        og_site_name: ogSiteName,
        og_default_image_url: ogDefaultImageUrl,
        og_default_description: ogDefaultDescription,
        icon_url: iconUrl,
        friend_capacity: capacity.value.friendCapacity,
        capacity_warn_at: capacity.value.capacityWarnAt,
        official_profile_url: officialProfileUrl.value,
      });
      if (!updated) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      return c.json({ success: true, data: serializeLineAccount(updated) });
    } catch (err) {
      const conflict = lifecycleConflict(err);
      if (conflict) return c.json(conflict, 409);
      throw err;
    }
  },
);

// PUT は指定された項目だけを更新するが、Messaging の資格情報交換を含むため owner に限る。表示情報も同じ要求で更新できるよう、PATCH と同じ country/role などを受け付ける。

lineAccounts.put('/api/line-accounts/:id', requireRole('owner'), inputJsonBoundary({"timezone":["string"],"name":["string"],"channelAccessToken":["string"],"channelSecret":["string"],"loginChannelId":["null","string"],"loginChannelSecret":["null","string"],"liffId":["null","string"],"isActive":["boolean"],"country":["null","string"],"role":["null","string"],"ogSiteName":["null","string"],"ogDefaultImageUrl":["null","string"],"ogDefaultDescription":["null","string"],"officialProfileUrl":["null","string"]}), async (c) => {
  try {
    const id = c.req.param('id')!;
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [id])) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const currentAccount = await getLineAccountById(c.env.DB, id);
    if (!currentAccount) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    if (currentAccount.archived_at) {
      return c.json({ success: false, error: 'ACCOUNT_ARCHIVED' }, 409);
    }
    const body = await c.req.json<{
      timezone?: string;
      name?: string;
      channelAccessToken?: string;
      channelSecret?: string;
      loginChannelId?: string | null;
      loginChannelSecret?: string | null;
      liffId?: string | null;
      isActive?: boolean;
      country?: string | null;
      role?: string | null;
      ogSiteName?: string | null;
      ogDefaultImageUrl?: string | null;
      ogDefaultDescription?: string | null;
      officialProfileUrl?: string | null;
    }>();
    // 送受信の停止・再開は理由が必須（X-1）。この窓口では受けない。
    if (body.isActive !== undefined && Boolean(currentAccount.is_active) !== body.isActive) {
      return inputError(c, {
        success: false,
        error: '送受信の停止・再開は理由が必要です。/deactivate・/activate を使ってください',
      }, 422, ["isActive"]);
    }

    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || !body.timezone.trim()) {
        return inputError(c, { success: false, error: 'timezone must be a valid IANA time zone' }, 422, ["timezone"]);
      }
      try { new Intl.DateTimeFormat('ja-JP', { timeZone: body.timezone.trim() }).format(); }
      catch { return inputError(c, { success: false, error: 'timezone must be a valid IANA time zone' }, 422, ["timezone"]); }
    }
    const country = normalizeOptionalString(body.country);
    const role = normalizeOptionalString(body.role);
    const loginChannelId = normalizeOptionalString(body.loginChannelId);
    const loginChannelSecret = normalizeOptionalString(body.loginChannelSecret);
    const liffId = normalizeOptionalString(body.liffId);
    if (liffId && !/^\d+-[A-Za-z0-9]+$/.test(liffId)) return inputError(c, { success: false, error: 'LIFF IDを確認してください' }, 400, ['liffId']);
    const ogSiteName = normalizeOptionalString(body.ogSiteName);
    const ogDefaultImageUrl = normalizeOptionalString(body.ogDefaultImageUrl);
    const ogDefaultDescription = normalizeOptionalString(body.ogDefaultDescription);
    const officialProfileUrl = readOfficialProfileUrl(body.officialProfileUrl);
    if (!officialProfileUrl.ok) return inputError(c, { success: false, error: officialProfileUrl.error }, 400, ["officialProfileUrl"]);

    // PUT でも PATCH と同じログインの組合せ・重複検査を行い、資格情報交換時の整合性を守る。
    const putTouchesLogin =
      loginChannelId !== undefined || loginChannelSecret !== undefined;
    if (putTouchesLogin || liffId !== undefined) {
      if (putTouchesLogin) {
        const pairError = validateLoginChannelPair(
          { loginChannelId, loginChannelSecret },
          currentAccount,
        );
        if (pairError) return inputError(c, { success: false, error: pairError }, 400, ["liffId","loginChannelId"]);
      }
      const dupError = await checkUniqueLoginAndLiff(
        c.env.DB,
        { loginChannelId, liffId },
        id,
      );
      if (dupError) return c.json({ success: false, error: dupError }, 409);
    }

    // 表示項目と資格情報は別関数で更新する。不要な updated_at の変更を防ぐため、対象のない側は呼ばない。
    const credentialsTouched =
      body.name !== undefined ||
      body.channelAccessToken !== undefined ||
      body.channelSecret !== undefined ||
      loginChannelId !== undefined ||
      loginChannelSecret !== undefined ||
      liffId !== undefined ||
      body.isActive !== undefined;
    const officialProfileUrlTouched = officialProfileUrl.value !== undefined;

    // 鍵・トークンの書き換え（接続情報・有効/無効の切替）は大事な操作（V）。
    if (credentialsTouched && !await sensitiveStepUpSatisfied(c, 'line_account.credentials')) {
      return stepUpRequiredResponse(c, '接続情報の変更には本人確認が必要です');
    }

    if ((body.channelAccessToken !== undefined || body.channelSecret !== undefined) && !await verifyLineMessagingIdentity({
      channelId: currentAccount.channel_id,
      channelSecret: body.channelSecret ?? currentAccount.channel_secret,
      channelAccessToken: body.channelAccessToken ?? currentAccount.channel_access_token,
    })) {
      return inputError(c, { success: false, error: '同じMessaging APIチャネルのシークレット・アクセストークンを指定してください' }, 422, ['channelSecret', 'channelAccessToken']);
    }

    let updated = credentialsTouched
      ? await updateLineAccount(c.env.DB, id, {
          name: body.name,
          channel_access_token: body.channelAccessToken,
          channel_secret: body.channelSecret,
          login_channel_id: loginChannelId,
          login_channel_secret: loginChannelSecret,
          liff_id: liffId,
          is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
        }, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY)
      : await getLineAccountById(c.env.DB, id);

    if (!updated) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }

    if (
      body.timezone !== undefined ||
      country !== undefined ||
      role !== undefined ||
      ogSiteName !== undefined ||
      ogDefaultImageUrl !== undefined ||
      ogDefaultDescription !== undefined ||
      officialProfileUrlTouched
    ) {
      updated = await updateLineAccountFields(c.env.DB, id, {
        timezone: body.timezone?.trim(),
        country,
        role,
        ogSiteName,
        ogDefaultImageUrl,
        ogDefaultDescription,
        officialProfileUrl: officialProfileUrl.value,
      });
      if (!updated) {
        return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
      }
    }

    return c.json({ success: true, data: serializeLineAccountFull(updated) });
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    if (err instanceof CredentialEncryptionKeyError) {
      return c.json({ success: false, error: 'LINE資格情報の暗号鍵が未設定です' }, 503);
    }
    throw err;
  }
});

// 履歴を保つため、互換 DELETE も保管として扱う。
lineAccounts.delete('/api/line-accounts/:id', requireRole('owner'), async (c) => {
  try {
    return await archiveAccountResponse(c, '旧DELETE APIからのアーカイブ');
  } catch (err) {
    const conflict = lifecycleConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

export { lineAccounts };
