import type { FeatureId } from './feature-catalog.js';

/**
 * サイドメニューの区分と項目の正本。
 *
 * 並び順の保存はサーバーがこの表と完全に同じ顔ぶれだけを受け付ける。
 * 画面側の `apps/web/src/lib/menu.ts` は表示用の情報
 * （アイコン・説明・URL）をここへ足した形で持ち、両者が一致することは
 * `apps/web/src/lib/menu-catalog-parity.test.ts` が固定する。
 *
 * ここに項目を足す・消すときは menu.ts 側も同じ変更にすること。
 */
export type MenuItemCatalogEntry = {
  /** 並び順を保存するときの目印。 */
  readonly id: string;
  /** 機能設定のオン／オフに対応する機能。無い項目は常に出す。 */
  readonly featureKey?: FeatureId;
  /** 消せない項目。 */
  readonly required?: boolean;
};

export type MenuSectionCatalogEntry = {
  /** 並び順を保存するときの目印。 */
  readonly id: string;
  /** サイドバーに出す見出し。null は見出しを付けない。 */
  readonly label: string | null;
  /** 機能設定に出す見出し。 */
  readonly title: string;
  readonly items: readonly MenuItemCatalogEntry[];
};

export const MENU_SECTION_CATALOG: readonly MenuSectionCatalogEntry[] = [
  {
    id: 'basic',
    label: 'メイン',
    title: 'メイン',
    items: [
      { id: 'dashboard', required: true },
      { id: 'inbox', required: true },
      { id: 'friends', required: true },
      { id: 'friend-attributes', required: true },
    ],
  },
  {
    id: 'delivery',
    label: '配信',
    title: '配信',
    items: [
      { id: 'scenarios', featureKey: 'scenarios' },
      { id: 'broadcasts', featureKey: 'broadcasts' },
      { id: 'reminders', featureKey: 'reminders' },
      { id: 'auto-replies', featureKey: 'auto_replies' },
      { id: 'friend-add-settings', featureKey: 'friend_add_routing' },
      { id: 'webinars', featureKey: 'webinars' },
    ],
  },
  {
    id: 'contents',
    label: 'コンテンツ',
    title: 'コンテンツ',
    items: [
      { id: 'templates', featureKey: 'templates' },
      { id: 'rich-menus', featureKey: 'rich_menus' },
      { id: 'forms', featureKey: 'forms' },
      { id: 'common-vars', featureKey: 'common_vars' },
      { id: 'contents', featureKey: 'media' },
    ],
  },
  {
    id: 'booking',
    label: '予約',
    title: '予約',
    items: [
      { id: 'booking-bookings', featureKey: 'booking' },
      { id: 'booking-menus', featureKey: 'booking' },
      { id: 'events', featureKey: 'events' },
      // 来店スタンプ。飲食店もサロンも使う。鍵は予約と同じ（専用の鍵は無い）。
      { id: 'visit-stamps', featureKey: 'visit_stamps' },
      { id: 'booking-own-shifts', featureKey: 'booking' },
    ],
  },
  {
    id: 'results',
    label: '成果と分析',
    title: '成果と分析',
    items: [
      { id: 'affiliates', featureKey: 'affiliates' },
      { id: 'mileage', featureKey: 'mileage' },
      { id: 'inflow', featureKey: 'inflow_tracking' },
      { id: 'conversions', featureKey: 'affiliates' },
      { id: 'analytics', featureKey: 'analytics' },
    ],
  },
  {
    id: 'automation',
    label: '自動化',
    title: '自動化',
    items: [
      { id: 'automations', featureKey: 'automations' },
      { id: 'webhooks', featureKey: 'external_integrations' },
    ],
  },
  {
    id: 'specialized',
    label: '専用機能',
    title: '専用機能',
    items: [
      { id: 'nen-members', featureKey: 'ec_commerce' },
      // ペットの写真。「投稿」と同じ photo_review の受け口。
      { id: 'nen-pets', featureKey: 'photo_review' },
      { id: 'nen-health', featureKey: 'photo_review' },
      { id: 'photo-review', featureKey: 'photo_review' },
      { id: 'nen-campaigns', featureKey: 'nen_campaigns' },
    ],
  },
  {
    id: 'settings',
    label: '設定',
    title: '設定',
    items: [
      { id: 'getting-started', required: true },
      { id: 'pools', featureKey: 'multi_store_hierarchy' },
      { id: 'staff', required: true },
      { id: 'settings', required: true },
      { id: 'google-business-hours', required: true },
      { id: 'emergency', required: true },
      { id: 'ec-commerce', featureKey: 'ec_commerce' },
    ],
  },
  {
    id: 'restaurant-test',
    label: '飲食店向け（テスト）',
    title: '飲食店向け（テスト）',
    items: [
      { id: 'restaurant-reservations', featureKey: 'restaurant_test' },
      { id: 'restaurant-tables', featureKey: 'restaurant_test' },
      { id: 'restaurant-inventory', featureKey: 'restaurant_test' },
      { id: 'restaurant-menu', featureKey: 'restaurant_test' },
      { id: 'restaurant-delivery', featureKey: 'restaurant_test' },
      { id: 'restaurant-google', featureKey: 'restaurant_test' },
      { id: 'restaurant-line-followup', featureKey: 'restaurant_test' },
    ],
  },
];

export const MENU_SECTION_IDS = MENU_SECTION_CATALOG.map(({ id }) => id);

/** サイドバーの見出しに使う区分名（`sidebar.order` の正本）。 */
export const MENU_SECTION_LABELS = MENU_SECTION_CATALOG
  .map(({ label }) => label)
  .filter((label): label is string => label !== null);

const MENU_SECTION_BY_ID = new Map(MENU_SECTION_CATALOG.map((s) => [s.id, s]));

/**
 * そのアカウントへ保存されるべき「完全な項目の並び」を返す。
 *
 * 専用機能の区分はアカウントごとの専用カタログに載った項目だけが
 * 対象になる（画面も同じ条件で絞る）。項目が1つも無い区分は
 * 並び順そのものを持たない。
 */
export function expectedMenuItemOrder(
  specializedFeatureKeys: ReadonlySet<string>,
): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const section of MENU_SECTION_CATALOG) {
    const items = section.id === 'specialized'
      ? section.items.filter((item) => item.featureKey !== undefined && specializedFeatureKeys.has(item.featureKey))
      : section.items;
    if (items.length > 0) order[section.id] = items.map(({ id }) => id);
  }
  return order;
}

/** 区分の目印として知っているか。 */
export function isMenuSectionId(id: string): boolean {
  return MENU_SECTION_BY_ID.has(id);
}
