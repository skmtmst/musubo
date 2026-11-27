import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { consumeStepUpGrant, getAdminSessionByTokenHash } from '@line-crm/db';
import { adminSessionTokenHashFromRequest, sha256Hex } from '../middleware/auth/credentials/auth.js';

/**
 * 大事な操作の直前再確認（V：-26 §16・-30 §14・-33 §16）。
 *
 * 対象：鍵・トークンの操作、権限の変更、LINE の接続の変更、一斉配信の承認、
 * アカウントの停止・削除。二者承認など後続の高危険操作もここへ乗せる。
 *
 * 通し方は3段：
 * 1. いつもの端末・場所のセッションは、最後の再確認から10分以内ならそのまま通す
 *    （再確認の時刻は admin_sessions.step_up_at が持つ。ヘッダだけでは通さない）。
 * 2. 期限切れ・未確認のときは X-Step-Up-Token の1回限り grant を消費して通す
 *    （従来の確認ダイアログ→本操作のやり直し経路）。
 * 3. いつもと違う端末・場所（unfamiliar_at が立つ）のセッションは10分の再利用を
 *    効かせず、操作ごとに新しい grant を求める。
 */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/** POST /api/auth/step-up が受け付ける目的。ここに無い文字列は発行しない。 */
export const STEP_UP_PURPOSES = [
  'privacy.retention',
  'data.export',
  'broadcast.send',
  'ops.impersonation',
  'secrets.reveal',
  'auth.api_key',
  'auth.mfa.policy',
  'auth.mfa.reenroll',
  'auth.login.trust',
  'auth.passkey.register',
  'auth.passkey.remove',
  'operations.control',
  'affiliate.payout.export',
  'photo.original.download',
  'staff.permissions.change',
  'staff.two_factor.remove',
  'line_account.connect',
  'line_account.credentials',
  'line_account.archive',
  'account_handover.execute',
  'broadcast.approval',
  'webhook.api_token',
  'webhook.secret',
  'ai.settings',
  'mcp.connection',
] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

export function isStepUpPurpose(value: unknown): value is StepUpPurpose {
  return typeof value === 'string' && (STEP_UP_PURPOSES as readonly string[]).includes(value);
}

/** X-Step-Up-Token の1回限り grant を消費する。token が無ければそのまま false。 */
export async function consumeStepUpToken(
  c: Context<Env>,
  purpose: StepUpPurpose,
): Promise<boolean> {
  const staff = c.get('staff');
  const token = c.req.header('X-Step-Up-Token')?.trim();
  if (!staff || !token) return false;
  try {
    // 確認票は発行したセッションに結び付いている。別セッション・終了済み
    // セッションからの使い回しはここで止まる（fail closed）。
    return await consumeStepUpGrant(c.env.DB, {
      tokenHash: await sha256Hex(token),
      staffId: staff.id,
      purpose,
      sessionTokenHash: await adminSessionTokenHashFromRequest(c),
    });
  } catch {
    // grant 台帳が読めないときも止める側に倒す（fail closed）。
    return false;
  }
}

/**
 * このリクエストが再確認済みか。通せるなら true、止めるなら false。
 * 止める側は 401 + code 'STEP_UP_REQUIRED' で応答を返す。
 */
async function checkSensitiveStepUp(
  c: Context<Env>,
  purpose: StepUpPurpose,
): Promise<boolean> {
  const staff = c.get('staff');
  if (!staff) return false;
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  let session: Awaited<ReturnType<typeof getAdminSessionByTokenHash>> | null = null;
  if (tokenHash) {
    try {
      session = await getAdminSessionByTokenHash(c.env.DB, tokenHash);
    } catch {
      // セッション行が読めないときは窓を効かせず grant 側へ倒す。
      session = null;
    }
  }
  // いつもと違うセッションは窓を使わせず、操作ごとに1回限りの grant を求める。
  // 窓を効かせるのは本人のセッションに限る（他人のセッション行で通さない）。
  if (session?.staff_id === staff.id && !session.unfamiliar_at && session.step_up_at
    && Date.parse(session.step_up_at) > Date.now() - STEP_UP_WINDOW_MS) {
    return true;
  }
  return consumeStepUpToken(c, purpose);
}

/** 再確認が要るときの統一応答。 */
export function stepUpRequiredResponse(c: Context<Env>, detail: string): Response {
  return c.json({ success: false, error: detail, code: 'STEP_UP_REQUIRED' }, 401);
}

// 同じ要求・目的では実行中の確認を共有する。別要求は D1 上の一度限りの確認票を取り合う。
const verifiedInRequest = new WeakMap<Context<Env>, Map<StepUpPurpose, Promise<boolean>>>();
export async function sensitiveStepUpSatisfied(c: Context<Env>, purpose: StepUpPurpose): Promise<boolean> {
  const purposes = verifiedInRequest.get(c) ?? new Map<StepUpPurpose, Promise<boolean>>();
  const existing = purposes.get(purpose);
  if (existing) return existing;
  const verification = checkSensitiveStepUp(c, purpose);
  purposes.set(purpose, verification);
  verifiedInRequest.set(c, purposes);
  let verified = false;
  try {
    verified = await verification;
    return verified;
  } finally {
    // 同じ要求内でも失敗した確認を後続の許可に使わない。
    if (!verified) purposes.delete(purpose);
  }
}
