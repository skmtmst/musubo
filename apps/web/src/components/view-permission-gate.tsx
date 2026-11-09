'use client'

import { Suspense, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { HQ_MENU_SECTIONS, MENU_SECTIONS, isHqShellPath, menuOwnerForScreen, type MenuItem } from '@/lib/menu'
import { canManageRole, canAdministerRole, effectiveStaffRole, useStaffIdentityLoad } from '@/lib/staff-role'
import { canEditFeature, canViewFeature } from '@/lib/staff-capability'
import { readPermissionSessionSnapshot as readSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import TargetMissing from '@/components/shared/target-missing'
import { LockedCreatePage } from '@/components/templates'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import PagePending from '@/components/templates/page-pending'
import { entryTitleForPath } from '@/lib/page-title'

const MENU_ITEMS = [...MENU_SECTIONS, ...HQ_MENU_SECTIONS].flatMap(section => section.items)
// メニューに置かない既知の入口だけを列挙する。未登録の子の道筋まで許可しない。
const SELF_SERVICE_PATHS = new Set(['/notifications', '/updates', '/support'])
const REDIRECT_PATHS = new Set(['/restaurant-test', '/restaurant-test/stores', '/scoring', '/scoring/new'])
const MANAGER_PATHS = new Set([
  '/accounts', '/accounts/detail', '/accounts/handover', '/users', '/search-console',
  '/line-notifications', '/line-notifications/operator/new', '/recipes', '/recipes/clone',
])
const UNLISTED_VIEW_KEYS: Readonly<Record<string, string>> = {
  '/health': '/health',
  '/booking/passes/new': '/booking/bookings',
  '/booking/sales': '/booking/bookings',
  '/restaurant-test/approvals': '/restaurant-test/menu',
  '/restaurant-test/dashboard': '/',
  '/restaurant-test/organization': '/hq',
}
const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}
const serverSession = () => null

/** 別名のURLとその下の画面も、左メニューの所属の表で判定する。 */
function menuItemsForPath(pathname: string, search = ''): MenuItem[] {
  let path = pathname
  while (path !== '/') {
    const owners = menuOwnerForScreen(path, path === pathname ? search : '')
    const declared = owners?.flatMap(id => MENU_ITEMS.filter(item => item.id === id))
    if (declared?.length) return declared
    path = path.slice(0, path.lastIndexOf('/')) || '/'
  }
  let found: MenuItem | null = null
  for (const item of MENU_ITEMS) {
    const hit = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`)
    if (hit && (!found || item.href.length > found.href.length)) found = item
  }
  return found ? [found] : []
}

export function menuItemForPath(pathname: string, search = ''): MenuItem | null {
  return menuItemsForPath(pathname, search)[0] ?? null
}

function ResolvedViewPermissionGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  const search = useSearchParams()?.toString() ?? ''
  const { identity: staffIdentity, failed, retry } = useStaffIdentityLoad()
  const role = effectiveStaffRole(staffIdentity)
  const session = useSyncExternalStore(subscribeSession, readSessionSnapshot, serverSession)
  // 本人の権限が分かるまで子をマウントせず、自動下書きや読込を始めさせない。
  if (role === null) return <PagePending failed={failed} onRetry={retry} />

  if ((pathname === '/hq/billing/payment-recovery' || pathname === '/hq/onboarding/card'
    || pathname === '/hq/onboarding/pricing' || pathname.startsWith('/hq/onboarding/quotes/'))
    && !canAdministerRole(role)) return <PageFrame kind="detail">
    <PageHeading title={pathname === '/hq/onboarding/card' ? 'お支払い情報'
      : pathname === '/hq/onboarding/pricing' ? '利用料金のご確認'
        : pathname.startsWith('/hq/onboarding/quotes/') ? 'お見積もりの確認' : 'お支払いの確認'} />
    <TargetMissing kind="forbidden" title="この画面を見る権限がありません" description="お支払いの確認はオーナーか管理者に頼んでください。" backHref="/hq/billing" backLabel="請求へ" />
  </PageFrame>

  // LINEアカウントの管理画面は統括の所属だけ。店舗の管理者でもURLから開けない。
  if ((pathname === '/accounts' || pathname.startsWith('/accounts/')) && staffIdentity?.accountScope !== 'all') return <PageFrame kind="detail">
    <PageHeading title={entryTitleForPath(pathname) || 'LINEアカウント'} />
    <TargetMissing kind="forbidden" title="この画面を見る権限がありません" description="LINEアカウントの管理は統括のメンバーが行います。" backHref="/" backLabel="ダッシュボードへ" />
  </PageFrame>

  const items = menuItemsForPath(pathname, search)
  const signedInRole = staffIdentity?.role ?? role
  const canRead = (item: MenuItem) => {
    if (item.href === '/staff' && !canAdministerRole(signedInRole)) return false
    if (item.href === '/accounts' && signedInRole === 'staff' && !canManageRole(signedInRole)) return false
    if (item.staffOnly && signedInRole !== 'staff') return false
    const key = item.permissionKey ?? item.href
    return item.required || canEditFeature(key, role) || canViewFeature(key, role)
  }
  const restricted = role === 'staff' || role === 'viewer'
  const allowed = restricted ? items.find(canRead) : items[0]
  const item = allowed ?? items[0]
  const unlistedKey = UNLISTED_VIEW_KEYS[pathname]
  const unlistedAllowed = items.length === 0 && (SELF_SERVICE_PATHS.has(pathname) || REDIRECT_PATHS.has(pathname)
    || (MANAGER_PATHS.has(pathname) && canManageRole(signedInRole))
    || (unlistedKey !== undefined && canViewFeature(unlistedKey, role)))
  if (restricted && !allowed && !unlistedAllowed) return <PageFrame kind="detail">
    <PageHeading title={entryTitleForPath(pathname) || item?.label || 'アクセスできません'} />
    <TargetMissing kind="forbidden" title="この画面を見る権限がありません" description="見たい時はオーナーか管理者に頼んでください。" backHref="/" backLabel="ダッシュボードへ" />
  </PageFrame>

  const creating = /\/(?:new|create)(?:\/|$)/.test(pathname)
  const params = new URLSearchParams(search)
  const startsDraft = pathname === '/automations/drafts' && Boolean(params.get('automationId')) && !params.get('id')
  const writingEntry = creating || startsDraft
  const backHref = item?.href ?? (pathname.replace(/\/(?:new|create)(?:\/.*)?$/, '') || '/')
  const title = entryTitleForPath(pathname) || (item ? `${item.label}の${creating ? '作成' : '編集'}` : '新しく作る')
  const backLabel = item ? `${item.label}の一覧へ` : '一覧へ'
  if (writingEntry && session?.impersonation?.mode === 'read') return <PageFrame kind="create">
    <PageHeading title={title} />
    <TargetMissing kind="forbidden" title={`代理ログイン（閲覧）中のため、ここでは${creating ? '作れません' : '変えられません'}`} description="書き込みに切り替えてから操作してください。" backHref={backHref} backLabel={backLabel} />
  </PageFrame>
  const writeKey = item?.permissionKey ?? item?.href ?? unlistedKey
  if (writingEntry && role === 'staff' && writeKey && !canEditFeature(writeKey, role)) return <PageFrame kind="create">
    <PageHeading title={title} />
    <TargetMissing kind="forbidden" title="この画面を変える権限がありません" description="作りたい時はオーナーか管理者に頼んでください。" backHref={backHref} backLabel={backLabel} />
  </PageFrame>
  if (role === 'viewer' && writingEntry) return <LockedCreatePage title={title} mode={creating ? 'create' : 'edit'}
    scope={isHqShellPath(pathname) ? 'hq' : 'store'} backHref={backHref} backLabel={backLabel} />
  return <>{children}</>
}

/** 閲覧権限と作成権限を、画面の処理を始める前に確認する。 */
export default function ViewPermissionGate({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PagePending stage="route" />}><ResolvedViewPermissionGate>{children}</ResolvedViewPermissionGate></Suspense>
}
