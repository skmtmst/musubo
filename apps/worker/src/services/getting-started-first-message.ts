import { activeTenantLineAccountSql, getFriendByLineUserIdForAccount, getLineAccountById } from '@line-crm/db';
import { buttonsTemplate, LineApiError, LineClient, type WebhookEvent } from '@line-crm/line-sdk';
import { tracedFetch } from '@line-crm/shared/server';
import { classifyLineOutboundFailure, hashOutboundPayload } from './outbound-idempotency.js';
import { getSendPermissionForAccount } from './send-entitlements.js';

const KEY_PREFIX = 'onboarding.first-message:';
const VERIFY_PREFIX = 'musubo-first-message-verify:';
const CONFIRM_PREFIX = 'musubo-first-message-received:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENDING_WINDOW_MS = 20_000;
const VERIFY_WINDOW_MS = 10 * 60_000;

type AttemptStatus = 'sending' | 'sent' | 'received' | 'busy' | 'connection' | 'unknown' | 'failed';
type FirstMessageStatus = AttemptStatus | 'ready' | 'identity_required' | 'friend_required' | 'sending_stopped';
type Scope = { accountId: string; staffId: string };

interface Attempt {
  id: string;
  lineUserId: string;
  channelId: string;
  status: AttemptStatus;
  startedAt: number;
  retryAt?: number;
}

interface State {
  identity?: { lineUserId: string; channelId: string };
  challenge?: { hash: string; channelId: string; expiresAt: number };
  attempt?: Attempt;
}

interface StateRow { key: string; value: string }
interface Account {
  name: string;
  channel_id: string;
  line_basic_id: string | null;
  send_credentials: number;
}
interface Context {
  account: Account | null;
  lineUserId: string | null;
  friendReady: boolean;
}

export interface FirstMessageState {
  status: FirstMessageStatus;
  accountName: string | null;
  friendUrl: string | null;
  retryAt: number | null;
  verificationPending: boolean;
}

function readState(db: D1Database, scope: Scope) {
  return db.prepare('SELECT key, value FROM account_settings WHERE line_account_id=? AND key=?')
    .bind(scope.accountId, KEY_PREFIX + scope.staffId).first<StateRow>();
}

function saveState(db: D1Database, accountId: string, key: string, old: StateRow | null, next: State) {
  const value = JSON.stringify(next);
  if (!old) {
    return db.prepare('INSERT OR IGNORE INTO account_settings(id,line_account_id,key,value) VALUES(?,?,?,?)')
      .bind(crypto.randomUUID(), accountId, key, value).run();
  }
  return db.prepare(`UPDATE account_settings SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'),
      confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND key=? AND value=?`)
    .bind(value, accountId, key, old.value).run();
}

function stateOf(row: StateRow | null): State {
  return row ? JSON.parse(row.value) as State : {};
}

async function context(db: D1Database, scope: Scope, state: State): Promise<Context> {
  const [account, staff] = await Promise.all([
    db.prepare(`SELECT name, channel_id, line_basic_id,
        length(coalesce(nullif(channel_access_token_encrypted,''), channel_access_token))>0 AS send_credentials
      FROM line_accounts a WHERE a.id=? AND a.is_active=1 AND a.archived_at IS NULL
      AND a.role IS NOT 'platform_notice' AND ${activeTenantLineAccountSql('a.id')}`).bind(scope.accountId).first<Account>(),
    db.prepare('SELECT line_user_id FROM staff_members WHERE id=? AND is_active=1')
      .bind(scope.staffId).first<{ line_user_id: string | null }>(),
  ]);
  const verified = staff && account && state.identity?.channelId === account.channel_id ? state.identity.lineUserId : null;
  const candidate = staff && account ? verified ?? staff.line_user_id : null;
  const friend = candidate ? await getFriendByLineUserIdForAccount(db, candidate, scope.accountId) : null;
  // A staff LINE ID from another provider need not identify the same person for this account.
  const scopedFriend = friend?.line_account_id === scope.accountId ? friend : null;
  const lineUserId = verified ?? (scopedFriend ? candidate : null);
  const friendReady = Boolean(scopedFriend?.is_following && !scopedFriend.is_hidden);
  return { account, lineUserId, friendReady };
}

function basicId(account: Account | null): string | null {
  const id = account?.line_basic_id;
  return id && /^@?[a-z0-9._-]+$/i.test(id) ? (id.startsWith('@') ? id : '@' + id) : null;
}

function firstMessageView(current: Context, state: State): FirstMessageState {
  const id = basicId(current.account);
  const attempt = state.attempt?.channelId === current.account?.channel_id ? state.attempt : undefined;
  const status = firstMessageStatus(current, attempt);
  return {
    status,
    accountName: current.account?.name ?? null,
    friendUrl: id ? `https://line.me/R/ti/p/${encodeURIComponent(id)}` : null,
    retryAt: status === 'busy' ? attempt?.retryAt ?? null : null,
    verificationPending: status === 'identity_required' && Boolean(state.challenge && state.challenge.channelId === current.account?.channel_id && state.challenge.expiresAt > Date.now()),
  };
}

function firstMessageStatus(current: Context, attempt: Attempt | undefined): FirstMessageStatus {
  if (!current.account?.send_credentials) return 'connection';
  if (attempt?.status === 'sending') return Date.now() - attempt.startedAt < SENDING_WINDOW_MS ? 'sending' : 'unknown';
  if (attempt?.status === 'received' || attempt?.status === 'sent' || attempt?.status === 'unknown') return attempt.status;
  if (!current.lineUserId) return basicId(current.account) ? 'identity_required' : 'connection';
  if (!current.friendReady) return 'friend_required';
  return attempt?.status ?? 'ready';
}

export async function readFirstMessageTest(db: D1Database, scope: Scope): Promise<FirstMessageState> {
  const state = stateOf(await readState(db, scope));
  return firstMessageView(await context(db, scope, state), state);
}

export async function hasReceivedFirstMessageTest(db: D1Database, scope: Scope): Promise<boolean> {
  const attempt = stateOf(await readState(db, scope)).attempt;
  if (attempt?.status !== 'received') return false;
  return Boolean(await db.prepare('SELECT 1 FROM line_accounts WHERE id=? AND channel_id=?')
    .bind(scope.accountId, attempt.channelId).first());
}

export async function issueFirstMessageIdentity(db: D1Database, scope: Scope): Promise<string | null> {
  const old = await readState(db, scope);
  const state = stateOf(old);
  const current = await context(db, scope, state);
  const id = basicId(current.account);
  if (!current.account || !id || firstMessageView(current, state).status !== 'identity_required') return null;
  const token = crypto.randomUUID();
  const challenge = { hash: await hashOutboundPayload(token), expiresAt: Date.now() + VERIFY_WINDOW_MS, channelId: current.account.channel_id };
  const saved = await saveState(db, scope.accountId, KEY_PREFIX + scope.staffId, old, { ...state, challenge });
  return saved.meta.changes === 1
    ? `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(VERIFY_PREFIX + token)}`
    : null;
}

function failedAttempt(error: unknown): Pick<Attempt, 'status' | 'retryAt'> {
  if (!(error instanceof LineApiError)) return { status: 'unknown' };
  if (error.status === 401 || error.status === 403) return { status: 'connection' };
  if (error.status === 429) {
    const failure = classifyLineOutboundFailure(error, new Date().toISOString());
    return { status: 'busy', retryAt: failure.nextRetryAt ? Date.parse(failure.nextRetryAt) : undefined };
  }
  return { status: error.status >= 400 && error.status < 500 && error.status !== 408 ? 'failed' : 'unknown' };
}

type SendDependencies = {
  credentialKey?: string;
  createClient?: (token: string) => Pick<LineClient, 'pushMessageWithRequestId'>;
};

function canTry(status: FirstMessageStatus, attempt: Attempt | undefined): boolean {
  return status === 'ready' || status === 'connection' || status === 'failed' || (status === 'busy' && Date.now() >= (attempt?.retryAt ?? 0));
}

export async function sendFirstMessageTest(db: D1Database, scope: Scope, dependencies: SendDependencies = {}): Promise<FirstMessageState> {
  const key = KEY_PREFIX + scope.staffId;
  const old = await readState(db, scope);
  const state = stateOf(old);
  const current = await context(db, scope, state);
  const view = firstMessageView(current, state);
  if (!current.account || !current.lineUserId || !current.friendReady || !canTry(view.status, state.attempt)) return view;
  if (!(await getSendPermissionForAccount(db, scope.accountId)).allowed) return { ...view, status: 'sending_stopped' };
  const account = await getLineAccountById(db, scope.accountId, dependencies.credentialKey);
  if (!account?.channel_access_token || account.channel_id !== current.account.channel_id || !account.is_active || account.archived_at) {
    return { ...view, status: 'connection' };
  }
  const previous = state.attempt;
  const id = previous?.channelId === account.channel_id && previous.lineUserId === current.lineUserId
    ? previous.id : crypto.randomUUID();
  const attempt: Attempt = { id, lineUserId: current.lineUserId, channelId: account.channel_id, status: 'sending', startedAt: Date.now() };
  const reserved = { ...state, attempt };
  const claimed = await saveState(db, scope.accountId, key, old, reserved);
  if (claimed.meta.changes !== 1) return readFirstMessageTest(db, scope);

  const fresh = await context(db, scope, reserved);
  if (!fresh.friendReady || fresh.lineUserId !== attempt.lineUserId || fresh.account?.channel_id !== attempt.channelId) {
    await saveState(db, scope.accountId, key, { key, value: JSON.stringify(reserved) }, state);
    return readFirstMessageTest(db, scope);
  }
  const client = dependencies.createClient?.(account.channel_access_token) ?? new LineClient(account.channel_access_token, {
    transport: (url, init) => tracedFetch(url, { ...init, signal: AbortSignal.timeout(12_000) }),
  });
  const message = buttonsTemplate({
    altText: '開店準備のテストメッセージです',
    text: '開店準備のテストメッセージです。届いたら下のボタンを押してください。',
    actions: [{ type: 'postback', label: '受け取りました', data: CONFIRM_PREFIX + attempt.id }],
  });
  let result: Pick<Attempt, 'status' | 'retryAt'>;
  try {
    await client.pushMessageWithRequestId(attempt.lineUserId, [message], attempt.id);
    result = { status: 'sent' };
  } catch (error) {
    result = failedAttempt(error);
  }
  // 送信結果の保存より先に受領ボタンが押されたら、受領済みを優先する。
  await saveState(db, scope.accountId, key, { key, value: JSON.stringify(reserved) }, { ...state, attempt: { ...attempt, ...result } });
  return readFirstMessageTest(db, scope);
}

export function isFirstMessageTestEvent(event: WebhookEvent): boolean {
  return (event.type === 'postback' && event.postback.data.startsWith(CONFIRM_PREFIX))
    || (event.type === 'message' && event.message.type === 'text' && event.message.text.startsWith(VERIFY_PREFIX));
}

async function findState(db: D1Database, accountId: string, kind: 'challenge' | 'attempt', value: string) {
  const path = kind === 'challenge' ? '$.challenge.hash' : '$.attempt.id';
  return db.prepare(`SELECT key,value FROM account_settings
    WHERE line_account_id=? AND key LIKE ? AND json_valid(value) AND json_extract(value, ?) = ?`)
    .bind(accountId, KEY_PREFIX + '%', path, value).first<StateRow>();
}

export async function handleFirstMessageTestEvent(db: D1Database, accountId: string | null, event: WebhookEvent): Promise<void> {
  if (!accountId || event.source.type !== 'user' || !event.source.userId || event.mode !== 'active' || !Number.isFinite(event.timestamp)) return;
  if (event.type === 'message' && event.message.type === 'text') {
    const token = event.message.text.slice(VERIFY_PREFIX.length);
    if (UUID.test(token)) await verifyFirstMessageIdentity(db, accountId, event.source.userId, token, event.timestamp);
  } else if (event.type === 'postback') {
    const id = event.postback.data.slice(CONFIRM_PREFIX.length);
    if (UUID.test(id)) await confirmFirstMessageReceipt(db, accountId, event.source.userId, id, event.timestamp);
  }
}

async function verifyFirstMessageIdentity(db: D1Database, accountId: string, userId: string, token: string, eventAt: number) {
  const old = await findState(db, accountId, 'challenge', await hashOutboundPayload(token));
  if (!old) return;
  const state = stateOf(old), challenge = state.challenge;
  if (!challenge || eventAt < challenge.expiresAt - VERIFY_WINDOW_MS || eventAt >= challenge.expiresAt || Date.now() >= challenge.expiresAt) return;
  const current = await context(db, { accountId, staffId: old.key.slice(KEY_PREFIX.length) }, state);
  if (current.account?.channel_id !== challenge.channelId || current.lineUserId) return;
  await saveState(db, accountId, old.key, old, { ...state, challenge: undefined, identity: { lineUserId: userId, channelId: challenge.channelId } });
}

async function confirmFirstMessageReceipt(db: D1Database, accountId: string, userId: string, id: string, eventAt: number) {
  // ボタンを押した直後に送信側が結果を保存した場合は、最新の内容を読み直す。
  for (let tries = 0; tries < 3; tries += 1) {
    const old = await findState(db, accountId, 'attempt', id);
    if (!old) return;
    const state = stateOf(old), attempt = state.attempt;
    if (!attempt || attempt.lineUserId !== userId || eventAt < attempt.startedAt
      || !['sending', 'sent', 'unknown'].includes(attempt.status)) return;
    const current = await context(db, { accountId, staffId: old.key.slice(KEY_PREFIX.length) }, state);
    if (current.lineUserId !== userId || current.account?.channel_id !== attempt.channelId) return;
    const saved = await saveState(db, accountId, old.key, old, { ...state, attempt: { ...attempt, status: 'received' } });
    if (saved.meta.changes === 1) return;
  }
  throw new Error('first_message_receipt_conflict');
}
