import { logger } from '@line-crm/shared/server';
import { CredentialEncryptionKeyError, decryptCredential, encryptCredential } from './credential-crypto.js';
import { jstNow } from './utils.js';
import { type WebhookKeyInput, type WebhookKeySet, type WebhookSecretColumns, type WebhookSecretTable, type WebhookSecretBackfillOptions, type WebhookSecretBackfillReport, type WebhookSecretKeyStats } from './webhooks-types.js';
import { WEBHOOK_SECRET_MIN_LENGTH } from './webhooks-interactions.js';


/**
 * 入れ替えた前の合言葉を受け付ける併用期間。
 * 新しい合言葉を保存した時点から24時間だけ、前の合言葉の署名も通す。
 */
export const WEBHOOK_SECRET_PREVIOUS_GRACE_MS = 24 * 60 * 60 * 1000;

export const keyIdCache = new Map<string, string>();

/** 鍵素材から鍵ID(SHA-256 先頭12桁)を作る。鍵素材そのものは含まない。 */
export async function webhookKeyId(material: string): Promise<string> {
  const normalized = material.trim();
  const cached = keyIdCache.get(normalized);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const id = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
  keyIdCache.set(normalized, id);
  return id;
}

export async function readWorkerEnvKey(name: string): Promise<string | undefined> {
  try {
    // Worker は bindings から読む。Node の単体テストには bindings がないため、
    // その場合は呼び出し側が渡した鍵だけを使う(暗号化の書き込みは鍵必須)。
    const runtime = await import('cloudflare:workers');
    const bindings = runtime.env as unknown as Record<string, string | undefined>;
    return bindings[name]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeKeyInput(keys?: WebhookKeyInput | string): WebhookKeyInput {
  if (typeof keys === 'string') return { current: keys };
  return keys ?? {};
}

export async function readWebhookKeySet(keys?: WebhookKeyInput | string): Promise<WebhookKeySet | undefined> {
  const input = normalizeKeyInput(keys);
  const current = input.current?.trim() || await readWorkerEnvKey('LINE_CREDENTIAL_ENCRYPTION_KEY');
  if (!current) return undefined;
  const rawPrevious = input.previous ?? await readWorkerEnvKey('LINE_CREDENTIAL_PREVIOUS_KEYS');
  const materials = (Array.isArray(rawPrevious) ? rawPrevious : String(rawPrevious ?? '').split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== current);
  const previous: WebhookKeySet['previous'] = [];
  for (const material of materials) {
    previous.push({ id: await webhookKeyId(material), material });
  }
  return { current: { id: await webhookKeyId(current), material: current }, previous };
}

export const STORED_SECRET_PATTERN = /^k([0-9a-f]{12})\.(v1\..+)$/;

/** 保存値を鍵IDと暗号本体に分ける。旧平文・不明形式は null。 */
export function parseStoredSecret(stored: string): { keyId: string | null; payload: string } | null {
  const versioned = STORED_SECRET_PATTERN.exec(stored);
  if (versioned) return { keyId: versioned[1], payload: versioned[2] };
  if (stored.startsWith('v1.')) return { keyId: null, payload: stored };
  return null;
}

/** 平文を1件、現行鍵で暗号化する。現行鍵がなければ書かずに例外にする。 */
export async function encryptWebhookSecret(
  value: string,
  keys?: WebhookKeyInput | string,
): Promise<string> {
  const set = await readWebhookKeySet(keys);
  if (!set) throw new CredentialEncryptionKeyError();
  const payload = await encryptCredential(value, set.current.material);
  return `k${set.current.id}.${payload}`;
}

/**
 * 送信・照合の直前だけ呼ぶ。暗号文があれば現行→旧鍵の順で復号し、
 * 旧平文だけの行はそのまま返す。鍵不足・復号失敗は例外にする。
 * 戻り値 null は未設定。例外とログに秘密値・鍵は含めない。
 */
export async function resolveWebhookSecret(
  row: WebhookSecretColumns,
  keys?: WebhookKeyInput | string,
): Promise<string | null> {
  if (row.secret_encrypted) {
    const parsed = parseStoredSecret(row.secret_encrypted);
    if (!parsed) {
      logger.error("webhook_secret_unknown_format");
      throw new Error('Unable to decrypt webhook secret');
    }
    const set = await readWebhookKeySet(keys);
    const candidates = set
      ? (parsed.keyId
        ? [set.current, ...set.previous].filter((key) => key.id === parsed.keyId)
        : [set.current, ...set.previous])
      : [];
    if (candidates.length === 0) {
      logger.error("webhook_secret_key_unavailable");
      throw new Error('Unable to decrypt webhook secret');
    }
    for (const candidate of candidates) {
      try {
        return await decryptCredential(parsed.payload, candidate.material);
      } catch {
        // 鍵IDが付いた行は対応鍵だけ試す。付いていない旧形式だけ全鍵を試す。
        if (parsed.keyId) break;
      }
    }
    logger.error("webhook_secret_decrypt_failed");
    throw new Error('Unable to decrypt webhook secret');
  }
  return row.secret;
}

/**
 * 併用期間内の前の合言葉を返す。
 * 期限切れ・未設定・前の値が無い行は null。復号に失敗しても例外にせず、
 * 「前の合言葉では通せない」だけにする(現行の合言葉の判定は別で行う)。
 */
export async function resolvePreviousWebhookSecret(
  row: WebhookSecretColumns,
  keys?: WebhookKeyInput | string,
  now = Date.now(),
): Promise<string | null> {
  if (!row.secret_previous_encrypted || !row.secret_rotated_at) return null;
  const rotatedAt = Date.parse(row.secret_rotated_at);
  if (!Number.isFinite(rotatedAt) || now - rotatedAt > WEBHOOK_SECRET_PREVIOUS_GRACE_MS) return null;
  try {
    return await resolveWebhookSecret(
      { id: row.id, secret: null, secret_encrypted: row.secret_previous_encrypted },
      keys,
    );
  } catch {
    logger.error("webhook_secret_previous_decrypt_failed");
    return null;
  }
}

/** 一覧・詳細の hasSecret 判定。秘密値そのものは返さない。 */
export function hasWebhookSecret(row: WebhookSecretColumns): boolean {
  if (row.secret_encrypted) return true;
  return !!row.secret && row.secret.length >= WEBHOOK_SECRET_MIN_LENGTH;
}

export async function countLegacyWebhookSecrets(
  db: D1Database,
  table: WebhookSecretTable,
  lineAccountId?: string,
): Promise<number> {
  // 「平文が残っているか」だけを見る。暗号文が既に入っていても平文が残る行は
  // 未完了として数える。両方ある行を移行済みと数えると、done が嘘になる。
  const where = lineAccountId === undefined
    ? `secret IS NOT NULL`
    : `line_account_id = ? AND secret IS NOT NULL`;
  const binds = lineAccountId === undefined ? [] : [lineAccountId];
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).bind(...binds).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countRekeyWebhookSecrets(
  db: D1Database,
  table: WebhookSecretTable,
  currentKeyId: string,
  lineAccountId?: string,
): Promise<number> {
  const where = lineAccountId === undefined
    ? `secret_encrypted IS NOT NULL AND secret_encrypted NOT LIKE ?`
    : `line_account_id = ? AND secret_encrypted IS NOT NULL AND secret_encrypted NOT LIKE ?`;
  const binds = lineAccountId === undefined ? [`k${currentKeyId}.%`] : [lineAccountId, `k${currentKeyId}.%`];
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).bind(...binds).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * 既存の平文・旧鍵暗号文を現行鍵へ寄せる(dry-run→batch→照合→再開)。
 *
 * - dryRun=true は件数だけ数えて書かない(移行前の見積もり用)。
 * - 1行ごとに「読む→現行鍵で暗号化→復号で照合→1文で平文NULL化」し、
 *   どこかで失敗した行は平文を残したまま failed に積んで次へ進む。
 * - べき等なので中断したら同じ条件で呼び直せば残りが進む(失敗再開)。
 * - 現行鍵がなければ何も書かず例外にする。
 */
export async function backfillWebhookSecrets(
  db: D1Database,
  options: WebhookSecretBackfillOptions = {},
): Promise<WebhookSecretBackfillReport> {
  const tables = options.tables ?? ['incoming_webhooks', 'outgoing_webhooks'];
  const batchSize = Math.min(500, Math.max(1, Math.floor(options.batchSize ?? 50)));
  const dryRun = options.dryRun ?? true;
  const set = await readWebhookKeySet(options.keys);
  if (!set) throw new CredentialEncryptionKeyError();
  const likeCurrent = `k${set.current.id}.%`;

  const report: WebhookSecretBackfillReport = {
    dryRun,
    batchSize,
    legacyTotal: 0,
    rekeyTotal: 0,
    processed: 0,
    migrated: 0,
    failed: [],
    remainingLegacy: 0,
    remainingRekey: 0,
    done: false,
  };
  for (const table of tables) {
    report.legacyTotal += await countLegacyWebhookSecrets(db, table, options.lineAccountId);
    report.rekeyTotal += await countRekeyWebhookSecrets(db, table, set.current.id, options.lineAccountId);
  }
  if (dryRun) {
    report.remainingLegacy = report.legacyTotal;
    report.remainingRekey = report.rekeyTotal;
    report.done = report.legacyTotal === 0 && report.rekeyTotal === 0;
    return report;
  }

  for (const table of tables) {
    // 平文が残っている行と、旧鍵のままの行を拾う。暗号文を入れた後に平文だけ
    // 消し損ねた行も `secret IS NOT NULL` で拾い直せる(数えるだけで終わらせない)。
    const where = options.lineAccountId === undefined
      ? `secret IS NOT NULL OR (secret_encrypted IS NOT NULL AND secret_encrypted NOT LIKE ?)`
      : `line_account_id = ? AND (secret IS NOT NULL OR (secret_encrypted IS NOT NULL AND secret_encrypted NOT LIKE ?))`;
    const binds = options.lineAccountId === undefined ? [likeCurrent] : [options.lineAccountId, likeCurrent];
    const targets = await db.prepare(
      `SELECT id, secret, secret_encrypted FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT ?`,
    ).bind(...binds, batchSize).all<{ id: string; secret: string | null; secret_encrypted: string | null }>();
    for (const target of targets.results ?? []) {
      report.processed += 1;
      let plaintext: string | null;
      try {
        plaintext = await resolveWebhookSecret(
          { id: target.id, secret: target.secret, secret_encrypted: target.secret_encrypted },
          { current: set.current.material, previous: set.previous.map((key) => key.material) },
        );
      } catch {
        report.failed.push({ table, id: target.id, reason: 'unreadable' });
        continue;
      }
      if (!plaintext) {
        report.failed.push({ table, id: target.id, reason: 'unreadable' });
        continue;
      }
      let stored: string;
      try {
        stored = await encryptWebhookSecret(plaintext, { current: set.current.material });
      } catch {
        report.failed.push({ table, id: target.id, reason: 'encrypt_failed' });
        continue;
      }
      const parsed = parseStoredSecret(stored);
      let verified = false;
      if (parsed) {
        try {
          verified = (await decryptCredential(parsed.payload, set.current.material)) === plaintext;
        } catch {
          verified = false;
        }
      }
      if (!verified) {
        report.failed.push({ table, id: target.id, reason: 'verify_failed' });
        continue;
      }
      try {
        const updateWhere = options.lineAccountId === undefined ? `id = ?` : `id = ? AND line_account_id = ?`;
        const updateBinds = options.lineAccountId === undefined
          ? [stored, jstNow(), target.id]
          : [stored, jstNow(), target.id, options.lineAccountId];
        await db.prepare(
          `UPDATE ${table} SET secret_encrypted = ?, secret = NULL, updated_at = ?, confirmation_revision = confirmation_revision + 1 WHERE ${updateWhere}`,
        ).bind(...updateBinds).run();
        report.migrated += 1;
      } catch {
        report.failed.push({ table, id: target.id, reason: 'write_failed' });
      }
    }
  }

  for (const table of tables) {
    report.remainingLegacy += await countLegacyWebhookSecrets(db, table, options.lineAccountId);
    report.remainingRekey += await countRekeyWebhookSecrets(db, table, set.current.id, options.lineAccountId);
  }
  report.done = report.remainingLegacy === 0 && report.remainingRekey === 0;
  return report;
}

/**
 * 鍵IDごとの暗号文の分布。旧鍵の参照が 0 件になったら旧鍵を捨てられる(廃止照合)。
 * 未指定時は全アカウント、指定時はそのアカウントだけ数える。
 */
export async function getWebhookSecretKeyStats(
  db: D1Database,
  lineAccountId?: string,
): Promise<WebhookSecretKeyStats> {
  const stats: WebhookSecretKeyStats = { legacy: 0, encrypted: 0, unknownFormat: 0, byKeyId: {} };
  const tables: WebhookSecretTable[] = ['incoming_webhooks', 'outgoing_webhooks'];
  for (const table of tables) {
    const where = lineAccountId === undefined ? '' : 'WHERE line_account_id = ?';
    const binds = lineAccountId === undefined ? [] : [lineAccountId];
    const rows = await db.prepare(
      `SELECT secret, secret_encrypted FROM ${table} ${where}`,
    ).bind(...binds).all<{ secret: string | null; secret_encrypted: string | null }>();
    for (const row of rows.results ?? []) {
      if (row.secret) stats.legacy += 1;
      if (!row.secret_encrypted) continue;
      const parsed = parseStoredSecret(row.secret_encrypted);
      if (!parsed?.keyId) {
        stats.unknownFormat += 1;
        continue;
      }
      stats.encrypted += 1;
      stats.byKeyId[parsed.keyId] = (stats.byKeyId[parsed.keyId] ?? 0) + 1;
    }
  }
  return stats;
}
