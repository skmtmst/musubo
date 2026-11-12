import { canonicalScreenPath } from './canonical-route'
import { HQ_MENU_SECTIONS, MENU_SECTIONS } from './menu'

/** メニューに置かない入口の画面名。権限の判定には使わず、完全一致だけで表示する。 */
const ENTRY_TITLES: Readonly<Record<string, string>> = {
  '/accounts/detail': 'LINEアカウントの詳細',
  '/accounts/handover': '乗り換え',
  '/accounts': 'LINEアカウント',
  '/booking/passes/new': '回数券・月謝を作る',
  '/booking/sales': '予約からの売上',
  '/health': 'BAN検知ダッシュボード',
  '/line-notifications/operator/new': '運用者へのお知らせを作る',
  '/line-notifications': 'LINE通知',
  '/notifications': '通知',
  '/recipes/clone': 'レシピを複製する',
  '/recipes': 'レシピから作る',
  '/restaurant-test/approvals': '承認の流れ',
  '/restaurant-test/dashboard': 'ダッシュボード',
  '/restaurant-test/organization': '組織・権限',
  '/restaurant-test': 'アカウント',
  '/restaurant-test/stores': 'アカウント',
  '/scoring/new': 'たまる決めごとを作る',
  '/scoring': 'マイル',
  '/search-console': 'Search Console',
  '/support': '問い合わせ',
  '/updates': 'アップデート履歴',
  '/users': '統合ユーザー',
  '/visual-qa/heading-band': '見出しの閲覧帯の確認',
  '/visual-qa/v8-parts': 'V8の部品の確認',
}

export function entryTitleForPath(pathname: string): string {
  return Object.hasOwn(ENTRY_TITLES, pathname) ? ENTRY_TITLES[pathname] : ''
}

/** ルート → メニューのラベル。長いほうから当てるので、`/tags/new` は「タグ」になる。 */
const MENU_LABELS: Array<[string, string]> = MENU_SECTIONS
  .flatMap((section) => section.items.map((item): [string, string] => [item.href, item.label]))
  .sort((a, b) => b[0].length - a[0].length)

/** ルートから既定の画面名を引く。当たらなければ空。 */
export function defaultTitleForPath(pathname: string): string {
  const entryTitle = entryTitleForPath(pathname)
  if (entryTitle) return entryTitle
  const path = canonicalScreenPath(pathname)
  for (const [href, label] of MENU_LABELS) {
    const route = href.split('?')[0]
    if (path === route) return label
    if (route !== '/' && path.startsWith(`${route}/`)) return label
  }
  return ''
}

/**
 * タブの題だけに使う画面名（上の帯の文字は変えない）。統括のメニューと、
 * 左メニューに無い画面。上の帯の名前が無いときだけ使う。
 */
const DOCUMENT_ONLY_LABELS = [
  ['/conversions', 'コンバージョン'],
  ['/ops/dashboard', 'ダッシュボード（運営）'],
  ['/ops/applications', '申込アカウント（運営）'],
  ['/ops/tenants', '契約先アカウント（運営）'],
  ['/ops/support', 'お問い合わせ（運営）'],
  ['/ops/announcements', 'お知らせ（運営）'],
  ['/ops/audit', '監査ログ（運営）'],
  ['/ops/members', 'メンバー管理（運営）'],
  ['/ops/invite', 'メンバーの招待（運営）'],
  ['/ops', '運営コンソール'],
  ...HQ_MENU_SECTIONS.flatMap((section) => section.items.map((item): [string, string] => [item.href, `${item.label}（統括）`])),
  ['/hq/support', 'お問い合わせ'] as [string, string],
  ['/common-actions', '共通アクション'] as [string, string],
  ['/scoring', 'スコアリング'] as [string, string],
  ['/updates', 'アップデート履歴'] as [string, string],
  ['/notifications', '通知'] as [string, string],
] satisfies Array<[string, string]>
DOCUMENT_ONLY_LABELS.sort((a, b) => b[0].length - a[0].length)

/** タブの題に使う画面名。上の帯の名前を先に、無ければ上の表から引く。 */
export function documentTitleForPath(pathname: string, shownTitle: string): string {
  if (shownTitle) return shownTitle
  const path = canonicalScreenPath(pathname)
  for (const [href, label] of DOCUMENT_ONLY_LABELS) {
    if (path === href || path.startsWith(`${href}/`)) return label
  }
  return ''
}
