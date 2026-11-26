import { Hono, type Context } from 'hono';
import type { Env } from '../worker-env.js';
import { requirePermission, requireRole, denyReadOnly } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { hashMail, verificationSubject, accountEmailPrefix } from '../services/account-email-inbound.js';
import { sendPlainMail } from '../services/plain-mail.js';
import { accountEmailInbox } from './account-email-inbox.js';

export const accountEmail = new Hono<Env>();
type Connection = {
  id: string;
  address: string;
  mailbox: string;
  status: 'setup' | 'pending' | 'connected' | 'revoked';
  forwarding_confirmation: string | null;
  checked_at: string | null;
  challenge_sent: number | null;
  awaiting: number;
  automated_at: number | null;
};
async function connectionResponse(c: Context<Env>, accountId: string) {
  const row = await c.env.DB.prepare(
    `SELECT id,address,mailbox,status,forwarding_confirmation,checked_at,challenge_sent,challenge_hash IS NOT NULL AS awaiting,automated_at
    FROM account_email_connections WHERE account_id=? ORDER BY status='revoked', created_at DESC LIMIT 1`,
  )
    .bind(accountId)
    .first<Connection>();
  const staff = c.get('staff');
  const manage =
    (staff.role === 'admin' || staff.role === 'owner') && !staff.readOnly && row?.status !== 'revoked';
  let issue: string | null = null;
  if (row && row.status !== 'revoked') {
    const elapsed = Date.now() - (row.challenge_sent ?? Date.now());
    if (row.awaiting && elapsed >= 3600_000) issue = 'verification_expired';
    else if (row.awaiting && elapsed >= 300_000) issue = 'confirmation_delayed';
    else if (row.automated_at && Date.now() - row.automated_at < 3600_000) issue = 'automated_mail';
  }
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    data: {
      issue,
      checkedAt: row?.checked_at ?? null,
      connectionId: manage ? (row?.id ?? null) : null,
      status: row?.status ?? 'disconnected',
      address: manage ? (row?.address ?? null) : null,
      mailbox: manage ? (row?.mailbox ?? null) : null,
      forwardingConfirmation: manage ? (row?.forwarding_confirmation ?? null) : null,
      canReply: false,
    },
  });
}
accountEmail.use('*', requireRole('owner', 'admin', 'staff'), async (c, next) => {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  if (!scope.allowedAccountIds.includes(c.req.param('accountId')!))
    return fail(c, 404, '店舗が見つかりません');
  c.header('Cache-Control', 'private, no-store');
  return next();
});
accountEmail.get('/connection', async (c) => connectionResponse(c, c.req.param('accountId')!));
accountEmail.post(
  '/connection',
  requireRole('owner', 'admin'),
  denyReadOnly(),
  inputJsonBoundary({ mailbox: ['string'] }, { maxBytes: 2048 }),
  async (c) => {
    const account = c.req.param('accountId')!;
    const domain = c.env.ACCOUNT_EMAIL_DOMAIN?.trim().toLowerCase();
    if (!domain || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain))
      return fail(c, 503, '受信用ドメインの準備が必要です');
    const input = await c.req.json<{ mailbox?: string }>();
    const mailbox = input.mailbox?.trim().toLowerCase();
    if (
      !mailbox ||
      mailbox.length > 254 ||
      !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(mailbox) ||
      mailbox.endsWith('@' + domain) ||
      mailbox === c.env.CONTACT_EMAIL?.toLowerCase()
    )
      return fail(c, 400, 'お店のメールアドレスを確認してください');
    const result = await c.env.DB.prepare(
      `INSERT INTO account_email_connections(id,account_id,address,mailbox,status,created_at)
    VALUES(?,?,?,?,'setup',?) ON CONFLICT(account_id) WHERE status <> 'revoked' DO NOTHING`,
    )
      .bind(
        crypto.randomUUID(),
        account,
        accountEmailPrefix + crypto.randomUUID().replaceAll('-', '') + '@' + domain,
        mailbox,
        new Date().toISOString(),
      )
      .run();
    if (!result.meta.changes) return fail(c, 409, '接続を解除してから再発行してください');
    return connectionResponse(c, account);
  },
);
accountEmail.delete('/connection', requireRole('owner', 'admin'), denyReadOnly(), async (c) => {
  const account = c.req.param('accountId')!;
  const expected = c.req.header('If-Match')?.replace(/^"|"$/g, '');
  if (!expected) return fail(c, 428, '解除する接続を読み直してください');
  const result = await c.env.DB.prepare(
    `UPDATE account_email_connections SET status='revoked',challenge_hash=NULL,forwarding_confirmation=NULL
    WHERE account_id=? AND id=? AND status <> 'revoked'`,
  )
    .bind(account, expected)
    .run();
  if (!result.meta.changes) return fail(c, 409, '接続が変更されました。読み直してください');
  return connectionResponse(c, account);
});
accountEmail.post(
  '/connection/verify',
  requireRole('owner', 'admin'),
  denyReadOnly(),
  inputJsonBoundary(),
  async (c) => {
    const account = c.req.param('accountId')!;
    const now = Date.now();
    const proof = crypto.randomUUID();
    const hash = await hashMail(proof);
    const row = await c.env.DB.prepare(
      `UPDATE account_email_connections SET status=CASE WHEN status='connected' THEN status ELSE 'pending' END,challenge_hash=?,challenge_sent=?
    WHERE account_id=? AND status IN ('setup','pending','connected') AND (challenge_sent IS NULL OR challenge_sent <= ?)
      AND NOT EXISTS (SELECT 1 FROM account_email_connections recent WHERE recent.challenge_sent>? AND
        (recent.account_id=account_email_connections.account_id OR recent.mailbox=account_email_connections.mailbox))
    RETURNING id,mailbox`,
    )
      .bind(hash, now, account, now - 60_000, now - 60_000)
      .first<{ id: string; mailbox: string }>();
    if (!row) return fail(c, 409, '設定中の接続を確認し、再送は1分後にお試しください');
    try {
      await sendPlainMail(c.env, {
        to: row.mailbox,
        subject: verificationSubject,
        body:
          'お店のメールから musubo に転送できることを確認します。有効期限は1時間です。\n\nmusubo-verify=' +
          proof,
      });
    } catch {
      await c.env.DB.prepare(
        `UPDATE account_email_connections SET status=CASE WHEN status='connected' THEN status ELSE 'setup' END,challenge_hash=NULL
      WHERE id=? AND status IN ('pending','connected') AND challenge_hash=?`,
      )
        .bind(row.id, hash)
        .run();
      return fail(c, 503, '確認メールを送れませんでした');
    }
    return connectionResponse(c, account);
  },
);
accountEmail.use('*', requirePermission('/chats'));
accountEmail.route('/', accountEmailInbox);
