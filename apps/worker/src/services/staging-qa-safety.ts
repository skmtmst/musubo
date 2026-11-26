import { AsyncLocalStorage } from 'node:async_hooks';
import type { StagingQaRun as QaRun } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';

export const QA_PREFIX = 'staging-qa:';
export const QA_STAGING_DATABASE = '00bd7aca-950b-4d67-b865-fd7427b9c43f';
type OutboundContext = { env: WorkerBindings; stopped: boolean };
const outbound = new AsyncLocalStorage<OutboundContext>();

/** 本番でフラグだけ変えても QA が開かないよう、独立した複数の環境識別を検査する。 */
export function qaEnvironment(env: WorkerBindings | undefined): boolean {
  return env?.DEPLOY_ENV === 'staging'
    && env.WORKER_NAME === 'nen-line-stg'
    && env.D1_DATABASE_ID === QA_STAGING_DATABASE
    && env.WORKER_PUBLIC_URL === 'https://stg-api.musubo.jp';
}

export function qaEnabled(env: WorkerBindings | undefined): boolean {
  return qaEnvironment(env) && env?.STAGING_QA_ENABLED === 'true'
    && env?.STAGING_QA_OUTBOUND_DISABLED === 'true';
}

export function qaOutboundStopped(env: WorkerBindings | undefined): boolean {
  // ほかの停止フラグが不正でも、QA を有効にしたら送信は強制停止する。
  return env?.DEPLOY_ENV === 'staging'
    && (env.STAGING_QA_OUTBOUND_DISABLED === 'true' || env.STAGING_QA_ENABLED === 'true');
}

export function assertQaOutboundAllowed(): void {
  if (outbound.getStore()?.stopped) throw new Error('STAGING_QA_OUTBOUND_BLOCKED');
}

/** この API が登録した合成接続だけに、LINE 送信の模擬を許す。 */
async function simulateLineSend(request: Request, env: WorkerBindings): Promise<Response | null> {
  const url = new URL(request.url);
  if (!qaEnabled(env) || url.origin !== 'https://api.line.me' || request.method !== 'POST'
    || !['/v2/bot/message/push', '/v2/bot/message/multicast', '/v2/bot/message/broadcast'].includes(url.pathname)) return null;
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!/^qa-mock:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(token)) return null;
  const runId = token.slice('qa-mock:'.length, 'qa-mock:'.length + 36);
  const row = await env.DB.prepare('SELECT value FROM platform_settings WHERE key=?')
    .bind(`${QA_PREFIX}run:${runId}`).first<{ value: string }>();
  if (!row) return null;
  const run = JSON.parse(row.value) as QaRun;
  if (run.status !== 'active') return null;
  const connection = await env.DB.prepare(`SELECT id FROM line_accounts
    WHERE id=? AND tenant_id=? AND channel_access_token=? AND is_active=1`)
    .bind(run.accountId, run.tenantId, token).first();
  if (!connection) return null;
  const body = await request.json() as { to?: unknown; messages?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 5) return null;
  const recipients = url.pathname.endsWith('/broadcast') ? []
    : Array.isArray(body.to) ? body.to : [body.to];
  if (recipients.length > 500 || (!recipients.length && !url.pathname.endsWith('/broadcast'))) return null;
  for (const recipient of recipients) {
    if (typeof recipient !== 'string') return null;
    const friend = await env.DB.prepare(`SELECT id FROM friends WHERE line_platform_user_id=?
      AND line_account_id=? AND is_following=1 AND id IN (SELECT value FROM json_each(?))`)
      .bind(recipient, run.accountId, JSON.stringify(run.friendIds)).first();
    if (!friend) return null;
  }
  return Response.json({ sentMessages: body.messages.map(() => ({ id: `qa-${crypto.randomUUID()}` })) }, {
    headers: { 'x-line-request-id': `qa-${crypto.randomUUID()}`, 'x-staging-qa-simulated': 'true' },
  });
}

let installedFetch: typeof fetch | undefined;
function installFetchBoundary(): void {
  if (globalThis.fetch === installedFetch) return;
  const original = globalThis.fetch;
  // 方針をプロセス全体の真偽値にせず非同期コンテキストへ置き、実行環境ごとに一度だけ接続する。
  installedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const context = outbound.getStore();
    if (!context?.stopped) return original(input, init);
    const simulated = await simulateLineSend(new Request(input, init), context.env);
    if (simulated) return simulated;
    throw new Error('STAGING_QA_OUTBOUND_BLOCKED');
  }) as typeof fetch;
  globalThis.fetch = installedFetch;
}

export function withQaOutboundBoundary<T>(env: WorkerBindings | undefined, work: () => T): T {
  if (!env) return work();
  const stopped = qaOutboundStopped(env);
  if (!stopped && !outbound.getStore()) return work();
  if (stopped) installFetchBoundary();
  return outbound.run({ env, stopped }, work);
}

/** service binding は global fetch を通らないため、その外部副作用も拒む。 */
export function qaSafeBindings(env: WorkerBindings): WorkerBindings;
export function qaSafeBindings(env: undefined): undefined;
export function qaSafeBindings(env: WorkerBindings | undefined): WorkerBindings | undefined {
  if (!env || !qaOutboundStopped(env)) return env;
  const blocked = async () => { throw new Error('STAGING_QA_OUTBOUND_BLOCKED'); };
  return {
    ...env,
    ...(env.EMAIL ? { EMAIL: { send: blocked } as unknown as SendEmail } : {}),
    ...(env.AI ? { AI: new Proxy(env.AI, { get: () => blocked }) } : {}),
    ...(env.CODEX_MENTION_QUEUE ? { CODEX_MENTION_QUEUE: new Proxy(env.CODEX_MENTION_QUEUE, { get: () => blocked }) } : {}),
  };
}

export type { StagingQaRole as QaRole, StagingQaRun as QaRun } from '@line-crm/shared';
