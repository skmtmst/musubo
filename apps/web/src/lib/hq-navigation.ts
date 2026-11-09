import { safeNavigationPath } from './safe-navigation'
import { isAccountIndependentRoute } from './store-route-guard'

export const ACCOUNT_SELECTION_KEY = 'lh_selected_account'
export const AUTH_SELECTION_CLEARED_KEY = 'lh_auth_selection_cleared'

export const HQ_OPEN_TARGETS = {
  scenarios: { label: 'シナリオ管理', destination: '/scenarios' },
  tags: { label: 'タグ', destination: '/tags' },
  templates: { label: 'テンプレート管理', destination: '/templates' },
  'rich-menus': { label: 'リッチメニュー管理', destination: '/rich-menus' },
  'form-submissions': { label: '回答フォーム管理', destination: '/form-submissions' },
} as const

export type HqOpenTargetKey = keyof typeof HQ_OPEN_TARGETS
export type HqOpenTarget = (typeof HQ_OPEN_TARGETS)[HqOpenTargetKey] & { key: HqOpenTargetKey }

export function hqOpenHref(target: HqOpenTargetKey): string {
  return `/hq/open?target=${target}`
}

/** 許可済みの値だけを行き先へ解決し、任意URLは決して受け付けない。 */
export function resolveHqOpenTarget(value: string | null): HqOpenTarget | null {
  if (!value || !Object.prototype.hasOwnProperty.call(HQ_OPEN_TARGETS, value)) return null
  const key = value as HqOpenTargetKey
  return { key, ...HQ_OPEN_TARGETS[key] }
}

export type RootLandingDecision =
  | { action: 'show-dashboard' }
  | { action: 'select-account'; accountId: string }
  | { action: 'go-hq' }
  | { action: 'wait' }

/** ログイン直後の着地点を、前回値ではなく見える店舗数だけで決める。 */
export function decideRootLanding(
  loading: boolean,
  selectedAccountId: string | null,
  visibleAccountIds: string[],
): RootLandingDecision {
  if (loading) return { action: 'wait' }
  if (selectedAccountId) return { action: 'show-dashboard' }
  if (visibleAccountIds.length === 1) {
    return { action: 'select-account', accountId: visibleAccountIds[0] }
  }
  return { action: 'go-hq' }
}

/** 登録途中の統括だけを、確定済みの利用開始手順へ戻す。 */
export function musuboOnboardingResumePath(state: {
  status: string
  quoteId: string | null
  consentedAt: string | null
}): string | null {
  if (state.status !== 'awaiting_first_line') return null
  if (state.quoteId) return `/hq/onboarding/quotes/${encodeURIComponent(state.quoteId)}`
  return state.consentedAt ? '/hq/onboarding/card' : '/hq/onboarding/pricing'
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * ログインし直しにつき一度だけ前回の店舗選択を捨てる。
 *
 * 「もう消した」印の正本は共有の localStorage に置き、消すときに立てる。
 * 以前はタブごとの sessionStorage だけを見ていたため、新規タブ・再読込
 * では印が空に見えて「ログインし直し」と区別がつかず、開いている他タブの
 * 店舗選択まで消してしまっていた（NEXT-07）。
 * 読み出しは sessionStorage の印も残存扱いにする。旧版が残した印や、
 * 確認用スクリプトが置く sessionStorage の印で誤って消さないため。
 * ログイン・招待受諾・登録完了・ログアウトの各画面は両方の印を外し、
 * 次に AuthGuard がセッションを確認したとき一度だけ選択を捨てる。
 * AuthGuard は画面遷移ごとにセッションを再確認するため、毎回消すと
 * 同じセッション内の店舗ログインまで解除してしまう。
 * ストレージが使えない環境では消さない（画面を止めない）。
 */
export function clearSelectionAfterAuthentication(
  local: StorageLike,
  session: StorageLike,
): boolean {
  try {
    if (local.getItem(AUTH_SELECTION_CLEARED_KEY) === '1') return false
    if (session.getItem(AUTH_SELECTION_CLEARED_KEY) === '1') return false
    local.removeItem(ACCOUNT_SELECTION_KEY)
    local.setItem(AUTH_SELECTION_CLEARED_KEY, '1')
    return true
  } catch {
    return false
  }
}

/**
 * 「次の認証確認で前回の店舗選択を一度だけ捨てる」印を外す。
 * ログイン・招待受諾・登録完了・ログアウトから呼ぶ。
 * localStorage（正本）と sessionStorage（旧版や確認用スクリプトが置く残存印）
 * の両方を外し、片方だけ残った印で消し忘れないようにする。
 */
export function resetAuthSelectionCleared(
  local: StorageLike,
  session: StorageLike,
): void {
  try { local.removeItem(AUTH_SELECTION_CLEARED_KEY) } catch { /* non-essential navigation marker */ }
  try { session.removeItem(AUTH_SELECTION_CLEARED_KEY) } catch { /* non-essential navigation marker */ }
}

/**
 * 「店舗を選ぶ」から元いた画面へ戻すための行き先を検証する。
 * 同一アプリ内の、店舗を必要とする画面のパスだけを許可する。
 * 外部URL・`//host` 形式・店舗不要の画面（/hq・/login など）は捨てる。
 */
export function resolveStoreReturnPath(value: string | null): string | null {
  value = safeNavigationPath(value)
  if (!value) return null
  const pathname = value.split('?')[0].split('#')[0]
  if (!pathname || isAccountIndependentRoute(pathname)) return null
  return value
}

/**
 * 店舗未選択ゲートから統括の店舗一覧への行き先。
 * 元の画面を `return` で持ち越し、店舗を選んだあとに戻れるようにする。
 */
export function storeSelectionHref(returnTo: string | null): string {
  const resolved = resolveStoreReturnPath(returnTo)
  return resolved ? `/hq?return=${encodeURIComponent(resolved)}` : '/hq'
}
