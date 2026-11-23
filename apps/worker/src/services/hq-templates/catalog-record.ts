import type { HqCatalogTemplateType } from '@line-crm/shared';

/** 対応表に残す「配った中身」の指紋の作り方の版。作り方を変えたら上げ、古い指紋とは比べない。 */
export const CATALOG_HASH_VERSION = 1;

/*
 * 指紋に入れるのは本部が配る項目だけ。店ごとの状態（受付中か・並び順・担当・在庫・引換コード・
 * 決済の接続）は入れない。店がそれらを変えても「店が変えた」とは扱わない。
 * 予約メニューのお支払いは、メニューごとの上書きの行（無ければ店の既定）を本部が配る項目として入れる。
 */
const MENU_COLUMNS = ['name', 'category_label', 'description', 'duration_minutes', 'buffer_after_minutes', 'base_price', 'price_mode',
  'image_url', 'concurrent_capacity', 'booking_window_days', 'cutoff_hours_before', 'cancel_deadline_hours_before', 'intake_question', 'auto_tag_id'] as const;
const MENU_PAYMENT_FIELDS = ['payment_mode', 'payment_provider'] as const;
const MENU_FIELDS = [...MENU_COLUMNS, ...MENU_PAYMENT_FIELDS] as const;
const REWARD_FIELDS = ['name', 'description', 'image_url', 'reward_kind', 'required_miles', 'per_friend_limit', 'starts_at', 'ends_at',
  'benefit_expires_days', 'common_action_version_id', 'failure_policy', 'customer_message', 'target_conditions'] as const;

export type CatalogRecordValue = string | number | null | Record<string, unknown> | unknown[];
export type CatalogRecord = Record<string, CatalogRecordValue>;

export function catalogRecordFields(kind: HqCatalogTemplateType): readonly string[] {
  return kind === 'booking_menu' ? MENU_FIELDS : REWARD_FIELDS;
}
/** 予約メニューの表そのものの列だけ。お支払いの上書きは別の表にある。 */
export function menuColumnFields(): readonly string[] {
  return MENU_COLUMNS;
}

/** 書く予定の値と、DB から読んだ行のどちらからでも同じ形を作る。 */
export function catalogRecord(kind: HqCatalogTemplateType, source: Record<string, unknown>): CatalogRecord {
  return Object.fromEntries(catalogRecordFields(kind).map(field => [field, normalize(field, source[field])]));
}

function normalize(field: string, value: unknown): CatalogRecordValue {
  if (value === undefined || value === null) return null;
  // 対象条件は文字列で保存される。書く前の値はオブジェクトなので、比べる前にそろえる。
  if (field === 'target_conditions') return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' || typeof value === 'string') return value;
  return value as Record<string, unknown>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function catalogRecordHash(kind: HqCatalogTemplateType, record: CatalogRecord): Promise<string> {
  return `hqb${CATALOG_HASH_VERSION}.${await sha256Hex(JSON.stringify(stable({ kind, record })))}`;
}
