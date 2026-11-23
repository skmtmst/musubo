import { logger } from '@line-crm/shared/server';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { CredentialEncryptionKeyError, decryptCredential } from './credential-crypto.js';
import { type LineCredentialFailureReason, type LineCredentialContext, type LineAccount, type LineCredentialHealth, type LineAccountCredentialHealth } from './line-accounts-types.js';

// =============================================================================
// LINE Accounts — Multi-Account Management
// =============================================================================

export async function resolveCredentialEncryptionKey(explicit?: string): Promise<string | undefined> {
  if (explicit?.trim()) return explicit;
  try {
    // Workers expose bindings through this runtime module. Node-based DB tests
    // and offline tools do not, so reads retain the migration fallback there.
    const runtime = await import('cloudflare:workers');
    const bindings = runtime.env as unknown as { LINE_CREDENTIAL_ENCRYPTION_KEY?: string };
    return bindings.LINE_CREDENTIAL_ENCRYPTION_KEY?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export const TENANT_STATUS_SELECT = `CASE
  WHEN COALESCE(account.tenant_id, '${DEFAULT_TENANT_ID}') = '${DEFAULT_TENANT_ID}' THEN 'active'
  WHEN tenant.status IN ('active', 'suspended', 'archived') THEN tenant.status
  ELSE 'archived'
END`;

/** SQL predicate used by dispatcher claim queries. Unknown tenant rows fail closed. */
export function activeTenantLineAccountSql(accountIdExpression: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(accountIdExpression)) {
    throw new Error('Invalid line account SQL expression');
  }
  return `EXISTS (
    SELECT 1
      FROM line_accounts tenant_gate_account
      LEFT JOIN tenants tenant_gate_tenant
        ON tenant_gate_tenant.id = COALESCE(tenant_gate_account.tenant_id, '${DEFAULT_TENANT_ID}')
     WHERE tenant_gate_account.id = ${accountIdExpression}
       AND tenant_gate_account.data_purged_at IS NULL
       AND (
         COALESCE(tenant_gate_account.tenant_id, '${DEFAULT_TENANT_ID}') = '${DEFAULT_TENANT_ID}'
         OR tenant_gate_tenant.status = 'active'
       )
  )`;
}

export function classifyCredentialFailure(error: unknown): LineCredentialFailureReason {
  return error instanceof CredentialEncryptionKeyError
    ? 'key_unavailable_or_invalid'
    : 'decrypt_failed';
}

export function warnPlaintextCredentialFallback(
  context: LineCredentialContext,
  error: unknown,
): void {
  // Credential values and thrown error messages are deliberately excluded.
  logger.warn("line_credential_plaintext_fallback");
}

/**
 * Prefer encrypted credentials. During the staged migration only, a missing key
 * or failed decrypt falls back to the legacy plaintext columns when they exist.
 */
export async function decryptLineAccountCredentials(
  row: LineAccount,
  credentialEncryptionKey?: string,
): Promise<LineAccount> {
  const last4 = (value: string | null | undefined): string | null =>
    value ? value.slice(-4) : null;
  const next: LineAccount = {
    ...row,
    channel_access_token_last4: last4(row.channel_access_token),
    channel_secret_last4: last4(row.channel_secret),
    login_channel_secret_last4: last4(row.login_channel_secret),
  };
  for (const field of [
    ['channel_access_token', 'channel_access_token_encrypted', 'channel_access_token_last4'],
    ['channel_secret', 'channel_secret_encrypted', 'channel_secret_last4'],
    ['login_channel_secret', 'login_channel_secret_encrypted', 'login_channel_secret_last4'],
  ] as const) {
    const [plainField, encryptedField, last4Field] = field;
    const encrypted = row[encryptedField];
    if (!encrypted) continue;
    try {
      next[plainField] = await decryptCredential(encrypted, credentialEncryptionKey);
      next[last4Field] = last4(next[plainField]);
    } catch (error) {
      // 暗号文があるのに復号できない場合、平文フォールバックで末尾を推測しない。
      next[last4Field] = null;
      if (!row[plainField]) {
        throw new Error(`Unable to decrypt ${plainField}; no legacy fallback is available`);
      }
      warnPlaintextCredentialFallback(
        { lineAccountId: row.id, field: plainField },
        error,
      );
      next[plainField] = row[plainField];
    }
  }
  return next;
}

/** Resolves one joined credential column while preserving the migration fallback. */
export async function resolveLineCredential(
  encrypted: string | null | undefined,
  legacyPlaintext: string | null | undefined,
  context: LineCredentialContext,
  credentialEncryptionKey?: string,
): Promise<string> {
  if (!encrypted) return legacyPlaintext ?? '';
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  try {
    return await decryptCredential(encrypted, encryptionKey);
  } catch (error) {
    if (legacyPlaintext) {
      warnPlaintextCredentialFallback(context, error);
      return legacyPlaintext;
    }
    throw new Error('Unable to decrypt LINE credential; no legacy fallback is available');
  }
}

export async function inspectCredentialHealth(
  encrypted: string | null | undefined,
  legacyPlaintext: string | null | undefined,
  credentialEncryptionKey?: string,
): Promise<LineCredentialHealth> {
  if (!encrypted) {
    return { encrypted: false, decryptable: false, source: 'plaintext' };
  }
  try {
    await decryptCredential(encrypted, credentialEncryptionKey);
    return { encrypted: true, decryptable: true, source: 'encrypted' };
  } catch {
    return {
      encrypted: true,
      decryptable: false,
      source: legacyPlaintext ? 'plaintext' : 'encrypted',
    };
  }
}

/** Returns credential storage/decryption state without exposing either value. */
export async function getLineAccountCredentialHealth(
  db: D1Database,
  id: string,
  credentialEncryptionKey?: string,
): Promise<LineAccountCredentialHealth | null> {
  const row = await db
    .prepare(
      `SELECT channel_access_token, channel_secret,
              channel_access_token_encrypted, channel_secret_encrypted
         FROM line_accounts
        WHERE id = ?`,
    )
    .bind(id)
    .first<
      Pick<
        LineAccount,
        | 'channel_access_token'
        | 'channel_secret'
        | 'channel_access_token_encrypted'
        | 'channel_secret_encrypted'
      >
    >();
  if (!row) return null;

  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const [channelAccessToken, channelSecret] = await Promise.all([
    inspectCredentialHealth(
      row.channel_access_token_encrypted,
      row.channel_access_token,
      encryptionKey,
    ),
    inspectCredentialHealth(
      row.channel_secret_encrypted,
      row.channel_secret,
      encryptionKey,
    ),
  ]);
  return {
    channel_access_token: channelAccessToken,
    channel_secret: channelSecret,
  };
}
