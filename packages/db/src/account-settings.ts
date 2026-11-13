import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { sqlIdSet } from './id-queries.js';
/**
 * account_settings table helpers.
 *
 * The table stores arbitrary key/value pairs keyed by (line_account_id, key).
 * Each setting is a JSON-encoded string so the column type never changes.
 */
import { featureCatalogEntry, type FeatureId } from '@line-crm/shared';


// SQL だけを組み立てる関数は D1 の型に触れないよう別ファイルへ置く。
// scripts の型検査は Workers 型を読み込まないため、この表から
// 直接 import されると壊れる。従来の import 先はそのまま使える。
export { accountFeatureOffExclusionSql } from './account-feature-sql.js';

/**
 * Retrieve a raw setting value (JSON string) for an account.
 * Returns null when the key is not set.
 */
export async function getAccountSetting(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(accountId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Retrieve several raw setting values for an account in one round trip.
 *
 * 管理APIが機能設定の束を読むとき、キーごとに getAccountSetting を投げると
 * 往復が本数分だけかかる。まとめて取って欠けたキーは「未設定」と
 * 同じ扱いにする（返値へキーが出ない）。
 */
export async function getAccountSettings(
  db: D1Database,
  accountId: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return {};
  const result = await db
    .prepare(
      `SELECT key, value FROM account_settings
       WHERE line_account_id = ? AND key IN (${sqlIdSet(unique).sql})`,
    )
    .bind(accountId, ...(unique.length ? sqlIdSet(unique).binds : []))
    .all<{ key: string; value: string }>();
  return Object.fromEntries(result.results.map((row) => [row.key, row.value]));
}

/**
 * Upsert a raw setting value (JSON string) for an account.
 */
export async function setAccountSetting(
  db: D1Database,
  accountId: string,
  key: string,
  value: string,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = japanCalendar()
    .toISOString()
    .replace('Z', '+09:00');

  await db
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?,
         confirmation_revision = confirmation_revision + CASE WHEN key = 'test_recipients' THEN 1 ELSE 0 END`,
    )
    .bind(id, accountId, key, value, now, now, value, now)
    .run();
}

export interface VersionedAccountSetting<T> {
  version: number;
  data: T;
}

export type SaveVersionedAccountSettingResult<T> =
  | { status: 'saved'; setting: VersionedAccountSetting<T> }
  | { status: 'conflict'; current: VersionedAccountSetting<T> | null };

/**
 * Save one logical settings bundle with optimistic locking.
 *
 * Keeping the version in the same row lets D1 reject a stale writer with one
 * conditional UPDATE instead of partially saving several independent keys.
 */
export async function saveVersionedAccountSetting<T>(
  db: D1Database,
  input: {
    accountId: string;
    key: string;
    expectedVersion: number;
    data: T;
  },
): Promise<SaveVersionedAccountSettingResult<T>> {
  const current = await getVersionedAccountSetting<T>(db, input.accountId, input.key);
  if ((current?.version ?? 0) !== input.expectedVersion) {
    return { status: 'conflict', current };
  }

  const next: VersionedAccountSetting<T> = {
    version: input.expectedVersion + 1,
    data: input.data,
  };
  const value = JSON.stringify(next);
  const now = japanCalendar()
    .toISOString()
    .replace('Z', '+09:00');

  if (current) {
    const updated = await db.prepare(
      `UPDATE account_settings
          SET value = ?, updated_at = ?,
              confirmation_revision = confirmation_revision + CASE WHEN key = 'test_recipients' THEN 1 ELSE 0 END
        WHERE line_account_id = ? AND key = ?
          AND json_valid(value)
          AND CAST(json_extract(value, '$.version') AS INTEGER) = ?`,
    ).bind(value, now, input.accountId, input.key, input.expectedVersion).run();
    if ((updated.meta?.changes ?? 0) !== 1) {
      return {
        status: 'conflict',
        current: await getVersionedAccountSetting<T>(db, input.accountId, input.key),
      };
    }
  } else {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO account_settings
        (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), input.accountId, input.key, value, now, now).run();
    if ((inserted.meta?.changes ?? 0) !== 1) {
      return {
        status: 'conflict',
        current: await getVersionedAccountSetting<T>(db, input.accountId, input.key),
      };
    }
  }

  return { status: 'saved', setting: next };
}

/**
 * このアカウントで機能が有効か。worker の accountFeatureIsEnabled と
 * 同じ順序(一括設定→個別設定→カタログ初期値)で読む。正本は worker 側に
 * あり、ここは cron 処理が db 層だけで止めるための最小複製。
 */
export async function isAccountFeatureEnabled(
  db: D1Database,
  accountId: string,
  featureId: string,
): Promise<boolean> {
  const bundle = await getVersionedAccountSetting<{ features?: Record<string, unknown> }>(
    db,
    accountId,
    'feature.settings_bundle_v1',
  );
  const bundled = bundle?.data.features?.[featureId];
  if (typeof bundled === 'boolean') return bundled;

  const legacy = await getAccountSetting(db, accountId, `feature.${featureId}`);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as boolean | { enabled?: unknown };
      if (typeof parsed === 'boolean') return parsed;
      if (typeof parsed.enabled === 'boolean') return parsed.enabled;
    } catch {
      // 壊れた旧値はカタログの既定値へ戻す。設定画面の読取と同じ扱い。
    }
  }
  const entry = featureCatalogEntry(featureId as FeatureId);
  return entry?.defaultEnabled ?? true;
}

export async function getVersionedAccountSetting<T>(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<VersionedAccountSetting<T> | null> {
  const raw = await getAccountSetting(db, accountId, key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VersionedAccountSetting<T>>;
    if (!Number.isInteger(parsed.version) || Number(parsed.version) < 1 || parsed.data === undefined) {
      return null;
    }
    return { version: Number(parsed.version), data: parsed.data };
  } catch {
    return null;
  }
}

// ── URL settings (link_base_url / tracked_link_base_url) ─────────────────────

const LINK_BASE_URL_KEY = 'link_base_url';
const TRACKED_LINK_BASE_URL_KEY = 'tracked_link_base_url';

async function getUrlSetting(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<string | null> {
  const raw = await getAccountSetting(db, accountId, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

/**
 * Validate and persist an https URL setting.
 *
 * Rules:
 *  - Empty string clears the setting (returns without storing).
 *  - Must start with "https://".
 *  - Trailing slash is stripped before saving.
 *
 * Throws a descriptive Error on validation failure.
 */
async function setUrlSetting(
  db: D1Database,
  accountId: string,
  key: string,
  value: string,
): Promise<void> {
  const trimmed = value.trim();

  if (trimmed === '') {
    // Clear the setting.
    await db
      .prepare(
        `DELETE FROM account_settings WHERE line_account_id = ? AND key = ?`,
      )
      .bind(accountId, key)
      .run();
    return;
  }

  if (!trimmed.startsWith('https://')) {
    throw new Error(`${key} must start with https://`);
  }

  const normalized = trimmed.replace(/\/$/, '');
  await setAccountSetting(db, accountId, key, JSON.stringify(normalized));
}

/**
 * Get the configured short-link base URL for an account (affiliate links).
 * Returns null when not set (caller should fall back to WORKER_URL/r).
 * The stored value has no trailing slash.
 */
export async function getLinkBaseUrl(
  db: D1Database,
  accountId: string,
): Promise<string | null> {
  return getUrlSetting(db, accountId, LINK_BASE_URL_KEY);
}

export async function setLinkBaseUrl(
  db: D1Database,
  accountId: string,
  value: string,
): Promise<void> {
  return setUrlSetting(db, accountId, LINK_BASE_URL_KEY, value);
}

/**
 * Get the configured base URL for message tracked links (/t/...).
 * When set, auto-tracked message URLs are built as `${base}/t/<code>` instead
 * of `${WORKER_URL}/t/<code>`. The domain must route /t/* to the Worker
 * (Redirect Rule or Custom Domain). Returns null when not set.
 *
 * Kept separate from link_base_url on purpose: existing deployments map that
 * domain's root paths to /r/ (affiliate), so silently reusing it for /t/
 * would emit broken URLs on upgrade.
 */
export async function getTrackedLinkBaseUrl(
  db: D1Database,
  accountId: string,
): Promise<string | null> {
  return getUrlSetting(db, accountId, TRACKED_LINK_BASE_URL_KEY);
}

export async function setTrackedLinkBaseUrl(
  db: D1Database,
  accountId: string,
  value: string,
): Promise<void> {
  return setUrlSetting(db, accountId, TRACKED_LINK_BASE_URL_KEY, value);
}

// ── Mileage manual adjustment policy ────────────────────────────────────────

const MILEAGE_MANUAL_ADJUSTMENT_POLICY_KEY = 'mileage_manual_adjustment_policy';

export interface MileageManualAdjustmentPolicy {
  /** Absolute amount at or above which a second owner must approve. */
  approvalThreshold: number;
}

export async function getMileageManualAdjustmentPolicy(
  db: D1Database,
  accountId: string,
): Promise<MileageManualAdjustmentPolicy | null> {
  const raw = await getAccountSetting(db, accountId, MILEAGE_MANUAL_ADJUSTMENT_POLICY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MileageManualAdjustmentPolicy>;
    return Number.isInteger(parsed.approvalThreshold) && Number(parsed.approvalThreshold) > 0
      ? { approvalThreshold: Number(parsed.approvalThreshold) }
      : null;
  } catch {
    return null;
  }
}

export async function setMileageManualAdjustmentPolicy(
  db: D1Database,
  accountId: string,
  policy: MileageManualAdjustmentPolicy,
): Promise<void> {
  if (!Number.isInteger(policy.approvalThreshold) || policy.approvalThreshold <= 0) {
    throw new Error('Mileage approval threshold must be a positive integer');
  }
  await setAccountSetting(
    db,
    accountId,
    MILEAGE_MANUAL_ADJUSTMENT_POLICY_KEY,
    JSON.stringify({ approvalThreshold: policy.approvalThreshold }),
  );
}

/** 初期セットは実際に保存された機能の束があるときだけ完了。 */
export async function hasSavedFeatureConfiguration(db: D1Database, accountId: string): Promise<boolean> {
  return isSavedFeatureConfiguration(await getAccountSetting(db, accountId, 'feature.settings_bundle_v1'));
}

/** 保存された機能の束の値が「済み」と言える形か。全アカウントの集計も同じ判定を使う。 */
export function isSavedFeatureConfiguration(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const data = JSON.parse(value);
    const features = data?.data?.features;
    return Number.isInteger(data.version) && data.version >= 1 && features != null
      && typeof features === 'object' && !Array.isArray(features)
      && Object.keys(features).length > 0 && Object.values(features).every((flag) => typeof flag === 'boolean');
  } catch { return false; }
}
