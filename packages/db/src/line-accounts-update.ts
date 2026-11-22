import { jstNow } from './utils.js';
import { encryptCredential } from './credential-crypto.js';
import { type LineAccount, type UpdateLineAccountInput, type UpdateLineAccountFieldsInput } from './line-accounts-types.js';
import { resolveCredentialEncryptionKey, decryptLineAccountCredentials } from './line-accounts-credentials.js';
import { requireWritableLineAccount, LineAccountLifecycleError } from './line-accounts-lifecycle.js';
import { getLineAccountById } from './line-accounts-reads.js';


export async function getLineAccountByChannelId(
  db: D1Database,
  channelId: string,
  credentialEncryptionKey?: string,
): Promise<LineAccount | null> {
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const row = await db
    .prepare(`SELECT * FROM line_accounts WHERE channel_id = ?`)
    .bind(channelId)
    .first<LineAccount>();
  return row ? decryptLineAccountCredentials(row, encryptionKey) : null;
}

export async function updateLineAccount(
  db: D1Database,
  id: string,
  updates: UpdateLineAccountInput,
  credentialEncryptionKey?: string,
): Promise<LineAccount | null> {
  const current = await requireWritableLineAccount(db, id);
  if (!current) return null;
  if (updates.is_active === 0 && current.is_default) {
    throw new LineAccountLifecycleError('ACCOUNT_DEFAULT');
  }
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.channel_access_token !== undefined) {
    fields.push('channel_access_token = ?');
    values.push(updates.channel_access_token);
    fields.push('channel_access_token_encrypted = ?');
    values.push(await encryptCredential(updates.channel_access_token, encryptionKey));
    fields.push('channel_access_token_updated_at = ?');
    values.push(jstNow());
  }
  if (updates.channel_secret !== undefined) {
    fields.push('channel_secret = ?');
    values.push(updates.channel_secret);
    fields.push('channel_secret_encrypted = ?');
    values.push(await encryptCredential(updates.channel_secret, encryptionKey));
    fields.push('channel_secret_updated_at = ?');
    values.push(jstNow());
  }
  if (updates.login_channel_id !== undefined) {
    fields.push('login_channel_id = ?');
    values.push(updates.login_channel_id);
  }
  if (updates.login_channel_secret !== undefined) {
    // 平文の列には書かない。値は暗号化列だけに置き、平文は消す（-33 §19-2）。
    fields.push('login_channel_secret = ?');
    values.push(null);
    fields.push('login_channel_secret_encrypted = ?');
    values.push(
      updates.login_channel_secret
        ? await encryptCredential(updates.login_channel_secret, encryptionKey)
        : null,
    );
    fields.push('login_channel_secret_updated_at = ?');
    values.push(jstNow());
  }
  if (updates.liff_id !== undefined) {
    fields.push('liff_id = ?');
    values.push(updates.liff_id);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active);
  }
  if (updates.token_expires_at !== undefined) {
    fields.push('token_expires_at = ?');
    values.push(updates.token_expires_at);
  }
  if (updates.og_site_name !== undefined) {
    fields.push('og_site_name = ?');
    values.push(updates.og_site_name);
  }
  if (updates.og_default_image_url !== undefined) {
    fields.push('og_default_image_url = ?');
    values.push(updates.og_default_image_url);
  }
  if (updates.friend_capacity !== undefined) {
    fields.push('friend_capacity = ?');
    values.push(updates.friend_capacity);
  }
  if (updates.capacity_warn_at !== undefined) {
    fields.push('capacity_warn_at = ?');
    values.push(updates.capacity_warn_at);
  }
  if (updates.icon_url !== undefined) {
    fields.push('icon_url = ?');
    values.push(updates.icon_url);
  }
  if (updates.parent_line_account_id !== undefined) {
    fields.push('parent_line_account_id = ?');
    values.push(updates.parent_line_account_id);
  }
  if (updates.og_default_description !== undefined) {
    fields.push('og_default_description = ?');
    values.push(updates.og_default_description);
  }
  if (updates.official_profile_url !== undefined) {
    fields.push('official_profile_url = ?');
    values.push(updates.official_profile_url);
  }

  if (fields.length === 0) return getLineAccountById(db, id, encryptionKey);

  fields.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);

  await db
    .prepare(`UPDATE line_accounts SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return getLineAccountById(db, id, encryptionKey);
}

/** A late OAuth response must not replace credentials changed since the renewal began. */
export async function saveRenewedLineAccessToken(
  db: D1Database,
  account: LineAccount,
  token: { accessToken: string; expiresAt: string },
  credentialEncryptionKey?: string,
): Promise<boolean> {
  const key = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const encrypted = await encryptCredential(token.accessToken, key);
  const now = jstNow();
  const result = await db.prepare(
    `UPDATE line_accounts
        SET channel_access_token = ?, channel_access_token_encrypted = ?, token_expires_at = ?,
            channel_access_token_updated_at = ?, updated_at = ?
      WHERE id = ? AND channel_id = ? AND is_active = 1 AND archived_at IS NULL
        AND token_expires_at IS ?
        AND COALESCE(channel_access_token_encrypted, channel_access_token) IS ?
        AND COALESCE(channel_secret_encrypted, channel_secret) IS ?`,
  ).bind(
    token.accessToken, encrypted, token.expiresAt, now, now,
    account.id, account.channel_id, account.token_expires_at,
    account.channel_access_token_encrypted ?? account.channel_access_token,
    account.channel_secret_encrypted ?? account.channel_secret,
  ).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function updateLineAccountFields(
  db: D1Database,
  id: string,
  input: UpdateLineAccountFieldsInput,
  credentialEncryptionKey?: string,
): Promise<LineAccount | null> {
  const current = await requireWritableLineAccount(db, id);
  if (!current) return null;
  if (input.isActive === false && current.is_default) {
    throw new LineAccountLifecycleError('ACCOUNT_DEFAULT');
  }
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.timezone !== undefined) {
    new Intl.DateTimeFormat("ja-JP", { timeZone: input.timezone }).format();
    sets.push("timezone = ?");
    binds.push(input.timezone);
  }
  if (input.country !== undefined) {
    sets.push('country = ?');
    binds.push(input.country); // empty string normalization happens at the route layer
  }
  if (input.role !== undefined) {
    sets.push('role = ?');
    binds.push(input.role);
  }
  if (input.isActive !== undefined) {
    sets.push('is_active = ?');
    binds.push(input.isActive ? 1 : 0);
  }
  if (input.loginChannelId !== undefined) {
    sets.push('login_channel_id = ?');
    binds.push(input.loginChannelId);
  }
  if (input.loginChannelSecret !== undefined) {
    // 平文の列には書かない。値は暗号化列だけに置き、平文は消す（-33 §19-2）。
    sets.push('login_channel_secret = ?');
    binds.push(null);
    sets.push('login_channel_secret_encrypted = ?');
    binds.push(
      input.loginChannelSecret
        ? await encryptCredential(input.loginChannelSecret, encryptionKey)
        : null,
    );
    sets.push('login_channel_secret_updated_at = ?');
    binds.push(jstNow());
  }
  if (input.liffId !== undefined) {
    sets.push('liff_id = ?');
    binds.push(input.liffId);
  }
  if (input.ogSiteName !== undefined) {
    sets.push('og_site_name = ?');
    binds.push(input.ogSiteName);
  }
  if (input.ogDefaultImageUrl !== undefined) {
    sets.push('og_default_image_url = ?');
    binds.push(input.ogDefaultImageUrl);
  }
  if (input.ogDefaultDescription !== undefined) {
    sets.push('og_default_description = ?');
    binds.push(input.ogDefaultDescription);
  }
  if (input.officialProfileUrl !== undefined) {
    sets.push('official_profile_url = ?');
    binds.push(input.officialProfileUrl);
  }
  if (input.friendCapacity !== undefined) {
    sets.push('friend_capacity = ?');
    binds.push(input.friendCapacity);
  }
  if (input.capacityWarnAt !== undefined) {
    sets.push('capacity_warn_at = ?');
    binds.push(input.capacityWarnAt);
  }
  if (input.iconUrl !== undefined) {
    sets.push('icon_url = ?');
    binds.push(input.iconUrl);
  }
  if (input.lineDisplayName !== undefined) {
    sets.push('line_display_name = ?');
    binds.push(input.lineDisplayName);
  }
  if (input.linePictureUrl !== undefined) {
    sets.push('line_picture_url = ?');
    binds.push(input.linePictureUrl);
  }
  if (input.lineBasicId !== undefined) {
    sets.push('line_basic_id = ?');
    binds.push(input.lineBasicId);
  }
  if (input.lineProfileSyncedAt !== undefined) {
    sets.push('line_profile_synced_at = ?');
    binds.push(input.lineProfileSyncedAt);
  }

  if (sets.length === 0) {
    return getLineAccountById(db, id, encryptionKey);
  }

  sets.push('updated_at = ?');
  binds.push(jstNow());
  binds.push(id);

  await db
    .prepare(`UPDATE line_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  return getLineAccountById(db, id, encryptionKey);
}

export async function updateLineAccountOrder(
  db: D1Database,
  ordered: Array<{ id: string; displayOrder: number }>,
): Promise<void> {
  if (ordered.length === 0) return;

  for (const item of ordered) {
    await requireWritableLineAccount(db, item.id);
  }

  const now = jstNow();
  const stmts = ordered.map(({ id, displayOrder }) =>
    db.prepare(`UPDATE line_accounts SET display_order = ?, updated_at = ? WHERE id = ?`)
      .bind(displayOrder, now, id),
  );

  // db.batch is atomic on D1; if any UPDATE fails, none commit.
  await db.batch(stmts);
}
