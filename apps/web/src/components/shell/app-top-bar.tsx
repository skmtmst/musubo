'use client'

import SharedButton from '@/components/shared/button'
import { useStaffRole, useStaffIdentity } from '@/lib/staff-role'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '@/components/shared/top-bar'
import Notice from '@/components/shared/notice'
import { isAccountIndependentRoute } from '@/lib/store-route-guard'
import BellNotifications from './bell-notifications'
import { loadNotificationCenter, type NotificationAccount, type NotificationScope } from './notification-center-data'
import { useAccount } from '@/contexts/account-context'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { usePageChrome } from './page-chrome'
import { HQ_MENU_SECTIONS, MENU_SECTIONS, isHqShellPath } from '@/lib/menu'
import { brandInitial } from '@/components/layout/brand-initial'
import { logoutAndGoToLogin } from '@/lib/logout'
import { useManualHref } from '@/lib/use-manual-href'
import { defaultTitleForPath } from '@/lib/page-title'
import { canReturnToHqFrom } from '@/lib/hq-return'
import { useOnboardingAccess } from '@/components/auth-guard'

/**
 * 共通トップバーを、いまの画面の値へつなぐ層。
 *
 * 見た目は `shared/top-bar.tsx`（Pencil `cBSCb`）が持つ。ここは値を集めるだけ。
 * 分けているのは、部品を1つの画面にも縛らないため（`docs/v8-design-rules.md` §5）。
 */

export { defaultTitleForPath, documentTitleForPath } from '@/lib/page-title'

/**
 * ★V8：画面がパンくずを渡さないときの「親の画面」（2026-10-08 オーナー「全部消す」）。
 *
 * 板の頭の「← 〇〇へ」を無くしたので、子の画面（作る・編集・詳細）から一覧へ戻る口は
 * 上の帯のパンくずだけになる。パンくずを渡し忘れた子の画面でも親へ戻れるよう、
 * 左メニューの項目のうち「いまの道の手前にあるいちばん長いもの」を親として出す。
 * 一覧そのもの（道がメニューの項目と同じ）では出さない。
 */
const PARENT_CRUMBS: Array<[string, string]> = [
  ...MENU_SECTIONS.flatMap((section) => section.items.map((item): [string, string] => [item.href, item.label])),
  ...HQ_MENU_SECTIONS.flatMap((section) => section.items.map((item): [string, string] => [item.href, item.label])),
  ['/hq/support', 'お問い合わせ'] as [string, string],
  ['/common-actions', '共通アクション'] as [string, string],
]
  .filter(([href]) => href !== '/' && href !== '/hq' && !href.includes('?'))
  .sort((a, b) => b[0].length - a[0].length)

export function parentCrumbForPath(pathname: string): { label: string; href: string } | null {
  // 一覧そのもの（左メニューの項目。/contents/vars のように別の項目の下にあるものも）は親を持たない。
  if (PARENT_CRUMBS.some(([href]) => href === pathname)) return null
  for (const [href, label] of PARENT_CRUMBS) {
    if (pathname.startsWith(`${href}/`)) return { label, href }
  }
  return null
}

/** 左メニューの「設定」の組に入っている項目の道（`/settings` は設定の入口そのもの）。 */
const SETTINGS_SECTION_PATHS: string[] = (MENU_SECTIONS.find((section) => section.id === 'settings')?.items ?? [])
  .map((item) => item.href.split('?')[0])

/** いまの道が属する左メニューの組（いちばん長く当たる項目の組）。 */
function menuSectionIdForPath(pathname: string): string | null {
  let best: { length: number; section: string } | null = null
  for (const section of MENU_SECTIONS) {
    for (const item of section.items) {
      const path = item.href.split('?')[0]
      if (path === '/') continue
      if (pathname !== path && !pathname.startsWith(`${path}/`)) continue
      if (!best || path.length > best.length) best = { length: path.length, section: section.id }
    }
  }
  return best?.section ?? null
}

const SETTINGS_CRUMB = { label: '設定', href: '/settings' }

/**
 * ★V8 上の帯のパンくずの仕上げ（2026-10-15 判定役 ・・・・・・）。
 * - 画面名と同じ名前の段は出さない（「予約設定 › 予約設定」にしない）。
 * - 左メニューの「設定」の組の画面は、手前に「設定」の段を置く（ホーム › 設定 › LINE通知）。
 *   左メニューの下の「設定」の入口が `/settings` なので、その段の行き先も `/settings`。
 *   `/settings` を親に持つ画面の「機能設定」の段は「設定」にそろえて二重にしない。
 * 設定の入口（`/settings`）そのものと統括の画面には足さない。
 */
export function finishPageCrumbs<T extends { label: string; href?: string }>(pathname: string, crumbs: T[] | null, title: string, hq = false): Array<T | typeof SETTINGS_CRUMB> | null {
  let next: Array<T | typeof SETTINGS_CRUMB> | null = crumbs ? crumbs.filter((crumb) => crumb.label !== title) : null
  const inSettings = !hq && pathname !== '/settings' && SETTINGS_SECTION_PATHS.length > 0 && menuSectionIdForPath(pathname) === 'settings'
  if (inSettings) {
    const rest = (next ?? []).filter((crumb) => crumb.label !== 'ホーム' && crumb.label !== SETTINGS_CRUMB.label && crumb.href?.split('?')[0] !== '/settings')
    next = [SETTINGS_CRUMB, ...rest]
  }
  // 行き先なしの「設定」は、店舗LINEアカウント設定経路（詳細・乗り換え）でのみ
  // 正規の段にそろえる。統括や設定区画外は変えない。見た目と件数も変えない。
  const fillsHref = pathname === '/accounts/detail' || pathname === '/accounts/handover'
  const normalized = (next ?? []).map((crumb) => fillsHref && crumb.label === SETTINGS_CRUMB.label && !crumb.href ? { ...crumb, href: SETTINGS_CRUMB.href } : crumb)
  return normalized.length > 0 ? normalized : null
}

/**
 * 権限の呼び名。言葉の表（GLOSSARY.md）どおり **`owner` は「オーナー」**。
 *
 * 管理画面 の設計（Pencil `cBSCb`）が「統括」だったが、2026-10-01 のオーナー決定で
 * 「オーナー」にそろえた。「統括」は組織と統括コンソールの名前だけに使う。
 * ただし V8 の統括の画面では、名前の下に「統括」と出す（絵のオーナー 2026-10-07）。
 */
const ROLE_LABELS: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  viewer: '閲覧のみ',
  staff: 'スタッフ',
}

export default function AppTopBar() {
  const pathname = usePathname() ?? '/'
  const onboarding = useOnboardingAccess() || pathname.startsWith('/hq/onboarding/')
  const { title, crumbs: pageCrumbs } = usePageChrome()
  const router = useRouter()
  const { accounts, selectedAccountId, setSelectedAccountId, clearSelectedAccountId, loading, error, refreshing, refreshAccounts } = useAccount()
  const [staffName, setStaffName] = useState('')
  const staffRole = useStaffRole()
  const staffIdentity = useStaffIdentity()
  const hqShell = isHqShellPath(pathname)
  const notificationTarget = useMemo<NotificationScope>(() => hqShell ? { kind: 'all' } : selectedAccountId ? { kind: 'store', accountId: selectedAccountId } : { kind: 'none' }, [hqShell, selectedAccountId])
  const notificationAccountsKey = JSON.stringify(accounts.map((account) => ({ id: account.id, label: account.displayName || account.name })))
  const notificationAccounts = useMemo(() => JSON.parse(notificationAccountsKey) as NotificationAccount[], [notificationAccountsKey])
  const notificationScope = JSON.stringify([notificationTarget, notificationAccountsKey])
  /*
   * ★V8 外側：ベルの未読の数。取るのは v8 のときだけ（互換経路では描かない
   * ので余計な要求を出さない）。取れなくても帯は壊さない。
   * 設定画面でその場で v8 へ切り替えたときにも取れるよう、テーマ
   * 変更の合図を受ける。
   */
  const [unreadState, setUnreadState] = useState<{ scope: string; count: number | null } | null>(null)
  const notificationUnread = unreadState?.scope === notificationScope ? unreadState.count : undefined
  const unreadRequest = useRef(0)
  const setNotificationUnread = useCallback((count: number | null) => {
    unreadRequest.current += 1
    setUnreadState({ scope: notificationScope, count })
  }, [notificationScope])
  useEffect(() => {
    let cancelled = false
    const request = ++unreadRequest.current
    const load = async () => {
      try {
        const data = await loadNotificationCenter(notificationTarget, notificationAccounts, { limit: 1 })
        if (!cancelled && request === unreadRequest.current) setUnreadState({ scope: notificationScope, count: data?.unreadCount ?? (notificationTarget.kind === 'none' ? 0 : null) })
      } catch {
        if (!cancelled && request === unreadRequest.current) setUnreadState({ scope: notificationScope, count: null })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [notificationTarget, notificationAccounts, notificationScope])

  // AuthGuard が保存した値を読む。ここでは取りに行かない（二重に叩かない）。
  useEffect(() => {
    try {
      setStaffName(localStorage.getItem('lh_staff_name') ?? '')
    } catch {
      // localStorage が使えない環境では名前を出さない
    }
  }, [pathname])

  /*
   * 画面ごとのマニュアルは、運営が正本表（/settings/manual-links）へ
   * 画面IDでURLを登録したときだけ出す。未登録・開けない・読み取れない
   * ときはリンク自体を出さない（「押したら無い」を作らない）。
   */
  const manualHref = useManualHref(pathname)

  const shownTitle = title ?? defaultTitleForPath(pathname)
  /*
   * ★V8 統括の外側（絵のオーナー 2026-10-07）：統括の画面（LINEアカウントの登録も含む）では、
   * 切替の札に「統括」と統括名、名前の下に「統括」を出す。互換経路は今までどおり。
   */

  /*
   * 画面がパンくずを渡さない（または「ホーム」だけの）子の画面では、左メニューの親へ戻れるようにする。
   * - 画面名が親と違う（「テンプレートを作る」）→ 手前に親を置く（ホーム › テンプレート › テンプレートを作る）
   * - 画面名が親と同じ（絵の上の帯が「ホーム › ウェビナー」）→ その名前を親への戻り口にする（文字は絵のまま）
   */
  const onlyHome = pageCrumbs === null || pageCrumbs.every((crumb) => crumb.label === 'ホーム')
  const parentCrumb = onlyHome ? parentCrumbForPath(pathname) : null
  // LINEアカウントの登録（/accounts/new）も統括の外側なので「設定」の段を足さない。
  const crumbs = onboarding
    ? (shownTitle === '利用開始の準備' ? null : [{ label: '利用開始の準備' }])
    : finishPageCrumbs(pathname, parentCrumb && parentCrumb.label !== shownTitle ? [parentCrumb] : pageCrumbs, shownTitle, isHqShellPath(pathname))
  const titleHref = onboarding ? undefined : parentCrumb && parentCrumb.label === shownTitle ? parentCrumb.href : undefined
  const [hqName, setHqName] = useState<string | null>(null)
  useEffect(() => {
    if (!hqShell) return
    let cancelled = false
    void import('@/lib/api').then(({ api }) => api.tenants.me()).then((res) => {
      if (!cancelled && res.success && res.data?.name) setHqName(res.data.name)
    }).catch(() => {
      // 取れなければ「統括」だけで出す
    })
    return () => { cancelled = true }
  }, [hqShell])
  const hqPill = hqShell ? { name: hqName ?? '統括', mark: brandInitial(hqName ?? '統括') } : null
  const roleLabel = hqShell && (staffRole === 'owner' || staffRole === 'admin') ? '統括' : (staffRole ? ROLE_LABELS[staffRole] ?? '' : '')
  /* 統括の札から店を選んだら、その店へ入る（カードの「このアカウントへ入る」と同じ）。 */
  const changeAccount = (accountId: string, after?: () => void) => {
    requestUnsavedAction(async () => {
      if (hqShell && accountId) {
        try {
          const { api } = await import('@/lib/api')
          const response = await api.lineAccounts.followerImportState(accountId)
          if (!response.success || response.data.phase === 'importing_ids' || response.data.phase === 'hydrating_profiles') {
            router.push(`/accounts/new/handover?accountId=${encodeURIComponent(accountId)}`)
            return
          }
        } catch {
          router.push(`/accounts/new/handover?accountId=${encodeURIComponent(accountId)}`)
          return
        }
      }
      setSelectedAccountId(accountId)
      if (hqShell && accountId && !after) router.push('/')
      after?.()
    })
  }

  const options = useMemo(
    () => [...accounts].sort((a, b) => (b.stats?.friendCount ?? 0) - (a.stats?.friendCount ?? 0)).map((a) => ({ id: a.id, label: a.displayName || a.name, iconUrl: a.iconUrl || a.pictureUrl || null, basicId: a.basicId ?? null })),
    [accounts],
  )

  /**
   * 統括の印を押したら、店舗の一覧へ戻る。
   *
   * 2026-08-26 まで、本文の右上に「統括」ボタンが浮いていた（`HqReturnButton`）。
   * バーの印と同じ言葉が2つ並ぶので、印のほうへ畳んだ。統括以外は押せない。
   * すでに統括の画面にいるときも押せない。
   */
  // 統括へ戻る口はオーナーと管理者に出す（管理者も統括を開ける。2026-10-07 オーナーの役割が管理者のため）
  const canReturnToHq = canReturnToHqFrom(staffRole, pathname, hqShell, staffIdentity?.accountScope)
  const returnToHq = () => {
    requestUnsavedAction(() => {
      clearSelectedAccountId()
      router.push('/hq')
    })
  }

  const logout = () => logoutAndGoToLogin()

  /*
   * ★V8 店の画面から統括へ戻る口（絵 V8 `DIHFx/Psg7n`・オーナー 2026-10-07）。
   * 統括へ戻るのは左下の自分のメニューだけ（切り替えの一覧には置かない・オーナー 2026-10-08）。
   * 帯の［統括へ］ボタンはやめ、左下の自分のメニューへまとめた（オーナー 2026-10-07）。
   * 店だけの担当には出さない。
   */
  // 2026-10-08 オーナー「左下から統括に戻れるので右上はアカウント切り替えだけでいい」：切り替えの一覧には出さない。
  const hqReturn = null

  /*
   * ★V8：帯の探す欄は V8 の外側から外した（オーナー決定 2026-10-01）。
   * `?q=` の受け口自体は友だち一覧が持ち続ける。
   */

  const isHq = pathname === '/hq' || pathname.startsWith('/hq/')
  const accountsLoadFailed = !isHq && isAccountIndependentRoute(pathname) && !loading && Boolean(error) && accounts.length === 0

  return (
    <>
    {/*
      1280px 未満では畳む。現在地はモバイルの固定ヘッダーが持つ
      （U037/U038）。TopBar 自身のクラスではなく無印の div で包む:
      部品側の display 指定（CSS Module）より utilities の hidden が
      負ける書き方を避けるため。xl は Tailwind 既定の 1280px。
    */}
    {/*
      v8 では帯を 1024px から出す（畳んだ左メニューと組むため）。
      v7 はこれまでどおり 1280px から。
    */}
    <div className="hidden xl:block v8-topbar-wrap">
    {/*
      ★V8 殻合わせ（絵 V8-B/JKjsE）：統括の画面にも切替の札を出す。
      選ぶのは状態の切替だけで、画面の移動はしない（従来どおり）。
      未選択の統括では「店舗を選択」と出る。
    */}
    <TopBar
      title={shownTitle}
      manualHref={manualHref}
      accounts={options}
      selectedAccountId={selectedAccountId ?? ''}
      onAccountChange={changeAccount}
      showAccountSwitcher={true}
      roleLabel={roleLabel}
      onRoleClick={canReturnToHq ? returnToHq : undefined}
      userName={staffName}
      onLogout={logout}
      notificationUnreadCount={notificationUnread}
      renderNotifications={(popover) => (
        <BellNotifications hqOrigin={hqShell} popover={popover} target={notificationTarget} accounts={options} onAccountChange={changeAccount} onUnreadChange={setNotificationUnread} />
      )}
      v8Chrome
      showSidebarToggle={!onboarding}
      showHomeBreadcrumb={!onboarding}
      chromeVariant="shell"
      crumbs={crumbs}
      titleHref={titleHref}
      hq={hqPill}
      homeHref={hqShell ? '/hq' : '/'}
      hqReturn={hqReturn}
      /*
        ★V8：自分の名前・役割・ログアウトは左下の自分のメニューへ移した
        （オーナー 2026-10-07・絵 zUg8S の zyFtB・l0VY4 を隠した）。互換経路は今までどおり。
      */
      showIdentity={false}
    />
    </div>
    {accountsLoadFailed ? (
      <Notice
        tone="danger"
        action={(
          <SharedButton variant="text" size="inline" data-notice-inline-action
            type="button"
            onClick={() => { void refreshAccounts() }}
            disabled={refreshing}
          >
            {refreshing ? '読み込んでいます' : '再読み込み'}
          </SharedButton>
        )}
      >
        LINEアカウントの一覧を読み込めませんでした。
      </Notice>
    ) : null}
    </>
  )
}
