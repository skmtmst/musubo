/*
 * 電話の専用の画面（/m）の住所と下のタブの表。
 *
 * - /m は管理画面を縮めた物ではなく、機能をしぼった別の外枠で開く。
 * - 判定は `/m` と `/m/…` だけ。`startsWith('/m')` にすると `/mileage` などが電話の外枠に入る。
 * - タブは作った画面だけを出す（中身の無いタブ・「次の段で」の空の形は出さない）。
 *   並びと中身はこの表 1 つで持ち、画面の中に書かない。
 * - 権限は PC と同じ鍵で見る。守るのは Worker（API の 403）で、ここは見せ方だけ。
 */

export const MOBILE_ROOT = '/m'

/** ログインの後に /m へ戻すための印。決まった値だけを受け、任意の住所にしない。 */
export const MOBILE_LOGIN_NEXT = 'm'

export function isMobileShellPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === MOBILE_ROOT || pathname.startsWith(`${MOBILE_ROOT}/`)
}

export type MobileTabId = 'today' | 'talk' | 'todo' | 'more'

export type MobileTab = {
  id: MobileTabId
  label: string
  href: string
  /** PC の画面の権限の鍵。null は店を選んで入れる人なら誰でも見られる。 */
  permission: string | null
}

/** 下のタブ。権限に応じて見せる。 */
export const MOBILE_TABS: readonly MobileTab[] = [
  { id: 'today', label: '今日', href: '/m/today', permission: '/booking/bookings' },
  { id: 'talk', label: 'トーク', href: '/m/chats', permission: '/chats' },
  { id: 'todo', label: '対応', href: '/m/todo', permission: null },
  { id: 'more', label: 'もっと', href: '/m/more', permission: null },
]

/** 今の住所に当たるタブ。どれにも当たらなければ null。 */
export function mobileTabForPath(pathname: string): MobileTab | null {
  return MOBILE_TABS.find((tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`)) ?? null
}

/** 見せてよいタブだけ。権限の確認が済むまで（canView が null）は何も出さない。 */
export function visibleMobileTabs(canView: ((permission: string) => boolean) | null): MobileTab[] {
  if (!canView) return []
  return MOBILE_TABS.filter((tab) => tab.permission === null || canView(tab.permission))
}

/** 会話の住所。友だちの ID で開く（PC の `/chats?friend=` と同じ指定）。 */
export function mobileTalkHref(friendId: string): string {
  return `/m/chats?${new URLSearchParams({ friend: friendId })}`
}

/**
 * PC の画面の住所を /m の住所へ読み替える。/m に当たる画面が無いときは null
 * （その時は［PC の画面で開く］で PC の住所をそのまま開く）。
 */
export function mobileHrefForPcPath(href: string): string | null {
  let url: URL
  try { url = new URL(href, 'https://musubo.invalid') } catch { return null }
  if (url.origin !== 'https://musubo.invalid') return null
  if (url.pathname !== '/chats') return null
  const friend = (url.searchParams.get('friend') ?? url.searchParams.get('friendId') ?? '').trim()
  return friend ? mobileTalkHref(friend) : '/m/chats'
}

/** ログイン・二段階認証の住所の `?next=m`（電話の画面から来た印）。 */
export function isMobileLoginReturn(search: string): boolean {
  return new URLSearchParams(search.replace(/^\?/, '')).get('next') === MOBILE_LOGIN_NEXT
}
