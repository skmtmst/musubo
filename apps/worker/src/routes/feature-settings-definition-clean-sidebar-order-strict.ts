import { getAccountSetting, getAccountSettings, getVersionedAccountSetting } from '@line-crm/db';
import { MENU_SECTION_LABELS, RESTAURANT_MENU_LAYOUT, RESTAURANT_OPTIONAL_ITEM_IDS, expectedMenuItemOrder, expectedRestaurantMenuItemOrder, isMenuSectionId, type FeatureId } from '@line-crm/shared';

import { accountFeatureAvailabilityMap } from '../services/feature-enforcement.js';
import { cleanStringArray, cleanItemOrder } from './feature-settings-definition-collect-feature-impact.js';
import { type FeatureSettingsData, TOGGLEABLE_FEATURES, SETTING_PREFIX, SIDEBAR_ORDER_KEY, SIDEBAR_ITEM_ORDER_KEY, featureIsEnabled, type FeatureSettingsState, FEATURE_SETTINGS_BUNDLE_KEY, type FeatureVisibilityData, SPECIALIZED_CATALOG_KEY, specializedCatalog } from './feature-settings-definition-is-toggleable.js';

export /**
 * 区分の並び（sidebarOrder）の保存値検査。
 *
 * 読み出し側は部分・未知を許容して残すが、書き込みはカタログの
 * 区分見出しをちょうど1回ずつ並べた完全な順序だけを受け付ける。
 * 未知の区分や過不足を通すと、読み出し側の「知らない値は捨てる」
 * 処理で並びが黙って欠ける。
 */
function cleanSidebarOrderStrict(raw: unknown, restaurantStyle = false): string[] | null {
  const values = cleanStringArray(raw);
  if (!values) return null;
  const labels = restaurantStyle ? RESTAURANT_MENU_LAYOUT.map((section) => section.label) : MENU_SECTION_LABELS;
  if (values.length !== labels.length) return null;
  const known = new Set<string>(labels);
  return values.every((label) => known.has(label)) ? values : null;
}

export /**
 * 区分ごとの項目の並び（sidebarItemOrder）の保存値検査。
 *
 * 画面が組み立てる完全な順序と同じ約束をサーバーでも検査する:
 * 知らない区分・知らない項目・別区分の項目・重複・欠落・余分は
 * 全部400。専用機能の区分は、そのアカウントの専用カタログへ
 * 実際に載っている項目だけが正解になる（画面側の絞り込みと同じ）。
 */
function cleanItemOrderStrict(
  raw: unknown,
  specializedFeatureKeys: ReadonlySet<string>,
  restaurantStyle = false,
): Record<string, string[]> | null {
  const cleaned = cleanItemOrder(raw);
  if (!cleaned) return null;
  const expected = restaurantStyle
    ? expectedRestaurantMenuItemOrder(specializedFeatureKeys)
    : expectedMenuItemOrder(specializedFeatureKeys);
  for (const sectionId of Object.keys(cleaned)) {
    if (!(restaurantStyle ? RESTAURANT_MENU_LAYOUT.some((section) => section.id === sectionId) : isMenuSectionId(sectionId))) return null;
  }
  for (const [sectionId, ids] of Object.entries(cleaned)) {
    const wanted = expected[sectionId] ?? [];
    if (ids.length !== wanted.length) return null;
    const submitted = new Set(ids);
    if (!wanted.every((id) => submitted.has(id))) return null;
  }
  for (const sectionId of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(cleaned, sectionId)) return null;
  }
  return cleaned;
}

export async function loadLegacyFeatureSettings(
  db: D1Database,
  accountId: string,
  restaurantEnabled: boolean,
): Promise<FeatureSettingsData> {
  // 一括設定が無い旧保存だけの読み分け。キーごとの往復(30本超)を1往復に束ねる。
  const stored = await getAccountSettings(db, accountId, [
    ...TOGGLEABLE_FEATURES.map((key) => `${SETTING_PREFIX}${key}`),
    SIDEBAR_ORDER_KEY,
    SIDEBAR_ITEM_ORDER_KEY,
  ]);
  const features: Record<string, boolean> = {};
  for (const key of TOGGLEABLE_FEATURES) {
    features[key] = key === 'restaurant_test' && !restaurantEnabled
      ? false
      : featureIsEnabled(stored[`${SETTING_PREFIX}${key}`] ?? null, key);
  }

  const orderRaw = stored[SIDEBAR_ORDER_KEY] ?? null;
  const itemOrderRaw = stored[SIDEBAR_ITEM_ORDER_KEY] ?? null;
  let sidebarOrder: string[] | null = null;
  let sidebarItemOrder: Record<string, string[]> | null = null;
  try {
    sidebarOrder = orderRaw ? cleanStringArray(JSON.parse(orderRaw)) : null;
  } catch {
    sidebarOrder = null;
  }
  try {
    sidebarItemOrder = itemOrderRaw ? cleanItemOrder(JSON.parse(itemOrderRaw)) : null;
  } catch {
    sidebarItemOrder = null;
  }
  return { features, sidebarOrder, sidebarItemOrder, favoriteItemIds: [], restaurantHiddenItemIds: [] };
}

export async function loadFeatureSettings(
  db: D1Database,
  accountId: string,
  restaurantEnabled: boolean,
  enabledByStyle = false,
): Promise<FeatureSettingsState> {
  const saved = await getVersionedAccountSetting<FeatureSettingsData>(
    db,
    accountId,
    FEATURE_SETTINGS_BUNDLE_KEY,
  );
  if (!saved) {
    const legacy = await loadLegacyFeatureSettings(db, accountId, restaurantEnabled);
    if (enabledByStyle) legacy.features.restaurant_test = true;
    return { ...legacy, version: 0 };
  }

  const features: Record<string, boolean> = {};
  for (const key of TOGGLEABLE_FEATURES) {
    const value = saved.data.features?.[key];
    features[key] = key === 'restaurant_test' && !restaurantEnabled
      ? false
      : typeof value === 'boolean' ? value : featureIsEnabled(null, key);
  }
  if (enabledByStyle) features.restaurant_test = true;
  return {
    version: saved.version,
    features,
    sidebarOrder: cleanStringArray(saved.data.sidebarOrder) ?? null,
    sidebarItemOrder: cleanItemOrder(saved.data.sidebarItemOrder) ?? null,
    favoriteItemIds: cleanStringArray(saved.data.favoriteItemIds) ?? [],
    restaurantHiddenItemIds: (cleanStringArray(saved.data.restaurantHiddenItemIds) ?? [])
      .filter((id) => (RESTAURANT_OPTIONAL_ITEM_IDS as readonly string[]).includes(id)),
  };
}

export async function loadFeatureVisibility(
  db: D1Database,
  accountId: string,
  restaurantEnabled: boolean,
  enabledByStyle = false,
): Promise<FeatureVisibilityData> {
  // 専用カタログは設定束と独立して読めるため先に並列で投げる。
  const [state, specializedRaw] = await Promise.all([
    loadFeatureSettings(db, accountId, restaurantEnabled, enabledByStyle),
    getAccountSetting(db, accountId, SPECIALIZED_CATALOG_KEY),
  ]);
  const featureStates = await accountFeatureAvailabilityMap(db, accountId, state.features);
  const specialized = new Set(specializedCatalog(specializedRaw));
  return {
    favoriteItemIds: state.favoriteItemIds ?? [],
    restaurantHiddenItemIds: state.restaurantHiddenItemIds ?? [],
    features: {
      ...Object.fromEntries(TOGGLEABLE_FEATURES.map((featureId) => [
        featureId,
        featureStates[featureId].effectiveEnabled
          && (!['nen_campaigns', 'photo_review'].includes(featureId) || specialized.has(featureId)),
      ])) as Record<FeatureId, boolean>,
      // EC連携は通常の設定にもあるため、専用メニュー側だけを別に判定する。
      specialized_ec_commerce: featureStates.ec_commerce.effectiveEnabled && specialized.has('ec_commerce'),
    },
  };
}
