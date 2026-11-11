import { canonicalScreenPath } from './canonical-route'

/**
 * 画面ID（管理画面 の採番、例: 受信箱は「2-1」）とルートの対応。
 *
 * 運営が `/settings/manual-links` の正本表へこの ID でURLを登録すると、
 * その画面のトップバーに「マニュアル」リンクが出る仕組み。
 * 対応が無い画面ではリンク自体が出ない。
 *
 * ID は設計（design-structure.json の画面名に埋まる `管理画面 x-y`）と同じもの。
 * 画面が増えたらここへ足す。正本表側に無い ID は「まだ決めていません」
 * として一覧に出るだけで、画面へは何も出ない。
 */

const ROUTE_TO_SCREEN: ReadonlyArray<readonly [string, string]> = [
  // ---- 画面（トップバーの出る管理画面）
  ['/', '1-1'],
  ['/chats', '2-1'],
  ['/friends', '3-1'],
  ['/friends/detail', '3-1'],
  ['/duplicates', '3-1'],
  ['/tags', '4-1'],
  ['/tags/fields/new', '4-2'],
  ['/tags/fields/migrate', '4-2'],
  ['/scenarios', '5-1'],
  ['/broadcasts', '6-1'],
  ['/broadcasts/detail', '6-1'],
  ['/reminders', '7-1'],
  ['/reminders/new', '7-1'],
  ['/auto-replies', '8-1'],
  ['/friend-add-settings', '9-1'],
  ['/webinars', '10-1'],
  ['/webinars/new', '10-1'],
  ['/webinars/edit', '10-1'],
  ['/templates', '11-1'],
  ['/templates/edit', '11-1'],
  ['/templates/carousel', '11-1'],
  ['/rich-menus', '12-1'],
  ['/rich-menus/edit', '12-1'],
  ['/form-submissions', '13-1'],
  ['/form-submissions/edit', '13-1'],
  ['/contents/vars', '14-1'],
  ['/contents', '15-1'],
  ['/affiliates', '16-1'],
  ['/affiliates/new', '16-1'],
  ['/affiliate-offers', '16-1'],
  ['/mileage', '17-1'],
  ['/mileage/earning-rules/new', '17-1'],
  ['/mileage/earning-rules/edit', '17-1'],
  ['/scoring', '17-1'],
  ['/inflow-links', '18-1'],
  ['/inflow-links/new', '18-1'],
  ['/inflow-links/detail', '18-1'],
  ['/conversions', '19-1'],
  ['/conversions/new', '19-1'],
  ['/analytics', '20-1'],
  ['/search-console', '20-1'],
  ['/nen-campaigns', '37-6'],
  ['/nen-campaigns/edit', '21-1'],
  ['/nen-members', '37-5'],
  ['/ec-commerce', '23-1'],
  ['/line-notifications', '24-1'],
  ['/automations', '25-1'],
  ['/automations/new', '25-1'],
  ['/common-actions', '25-1'],
  ['/webhooks', '26-1'],
  ['/booking/bookings', '27-1'],
  ['/booking/bookings/detail', '27-1'],
  ['/booking/bookings/new', '27-1'],
  ['/booking/menus', '28-1'],
  ['/booking/menus/new', '28-1'],
  ['/booking/menus/staff', '28-1'],
  ['/booking/staff', '28-1'],
  ['/booking/staff/new', '28-1'],
  ['/booking/staff/shifts', '28-1'],
  ['/events', '29-1'],
  ['/events/edit', '29-1'],
  ['/staff', '30-1'],
  ['/staff/new', '30-1'],
  ['/users', '30-1'],
  ['/settings', '31-1'],
  ['/emergency', '32-1'],
  ['/updates', '32-1'],
  ['/health', '32-1'],
  ['/accounts', '33-1'],
  ['/accounts/new', '33-2'],
  ['/pools', '33-1'],
  ['/getting-started', '34-1'],
  ['/recipes', '34-1'],
  ['/support', '34-1'],
  // ---- 統括・運営の画面
  ['/hq', '36-7'],
  ['/hq/members', '36-5'],
  ['/hq/billing', '36-2'],
]

// 長いほうから当てる。`/friends/detail` が `/friends` に負けないように。
const ROUTE_TO_SCREEN_SORTED = [...ROUTE_TO_SCREEN].sort((a, b) => b[0].length - a[0].length)

/**
 * いまのルートの画面IDを返す。対応が無ければ null。
 * 一覧未収載の下位ルートは、一番近い親の画面IDへ寄せる。
 */
export function manualScreenKeyForPath(pathname: string): string | null {
  // ダッシュボードは '/' そのもの。下のループは1文字より短くならないので先に見る。
  if (pathname === '/') return '1-1'
  let path = canonicalScreenPath(pathname)
  while (path.length > 1) {
    for (const [route, screenId] of ROUTE_TO_SCREEN_SORTED) {
      if (path === route || path.startsWith(`${route}/`)) return screenId
    }
    path = path.slice(0, path.lastIndexOf('/'))
  }
  return null
}
