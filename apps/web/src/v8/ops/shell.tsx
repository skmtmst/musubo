'use client'

import Link from '@/components/shared/list-navigation'
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import {
  Building2,
  MessagesSquare,
  LayoutDashboard,
  Megaphone,
  Menu,
  ScrollText,
  ShieldCheck,
  X,
} from 'lucide-react'
import TopBar from '@/components/shared/top-bar'
import { PageChromeProvider, usePageChrome } from '@/components/shell/page-chrome'
import SidebarUserMenu from '@/components/shared/sidebar-user-menu'
import SidebarVersion from '@/components/layout/sidebar-version'
import OpsBrand from './ops-brand'
import { SIDEBAR_AUTO_COLLAPSE_BELOW } from '@/components/layout/sidebar-collapse'
import { humanizeErrorText } from '@/components/shared/human-error-text'
import { PageHeading } from '@/components/templates/page-frame'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import { SIDEBAR_TOGGLE_EVENT } from '@/lib/events'
import { logoutAndGoToLogin } from '@/lib/logout'
import type { OpsMe } from '@/lib/api'
import shellStyles from '@/components/app-shell.module.css'
import nav from '@/components/layout/sidebar.module.css'
import styles from './shell.module.css'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * 運営コンソールの V8 の外枠（絵  ほか運営の板一式）。
 *
 * 統括・店舗と同じ外側（左メニュー 240・上の帯 60・白い板1枚）に、
 * 運営のメニューだけを載せる。見た目は共通の左メニュー・外枠の class を
 * そのまま使い、値は変えない。認証・担当者の取得は呼び元（OpsShell）が持つ。
 */

export const OPS_MENU: Array<{ href: string; label: string; icon: typeof LayoutDashboard }> = [
  { href: '/ops/dashboard', label: 'ダッシュボード', icon: LayoutDashboard },
  { href: '/ops/applications', label: '申込アカウント', icon: Building2 },
  { href: '/ops/tenants', label: '契約先アカウント', icon: Building2 },
  { href: '/ops/support', label: 'お問い合わせ', icon: MessagesSquare },
  { href: '/ops/announcements', label: 'お知らせ', icon: Megaphone },
  { href: '/ops/audit', label: '監査ログ', icon: ScrollText },
]

/** 道から画面名を引く（パンくずの最後の段）。 */
export function opsTitleForPath(pathname: string): string {
  const all = [...OPS_MENU, { href: '/ops/members', label: 'メンバー管理' }, { href: '/ops/invite', label: 'メンバーの招待' }, { href: '/ops/two-factor', label: '二段階認証' }]
  const hit = all.filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]
  if (pathname.startsWith('/ops/tenants/detail')) return '契約先の詳細'
  if (pathname.startsWith('/ops/applications/detail')) return '申込アカウント › 詳細'
  return hit?.label ?? ''
}

type OpsShellProps = {
  me: OpsMe | null
  meError: string
  onRetryMe: () => void
  pathname: string
  /** 代理ログイン中の帯など、板の上に出すもの。 */
  banner?: ReactNode
  children: ReactNode
}

/** 中の画面が usePageTitle で渡した名前（記事の題名など）を上の帯のパンくずの最後に出す。 */
export default function OpsShellV8(props: OpsShellProps) {
  return <PageChromeProvider><OpsShellFrame {...props} /></PageChromeProvider>
}

function OpsShellFrame({
  me,
  meError,
  onRetryMe,
  pathname,
  banner,
  children,
}: OpsShellProps) {
  const pageChrome = usePageChrome()
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const drawerRef = useOverlayFocus<HTMLElement>(drawer, () => setDrawer(false))

  // iPad 横（1024px）ではアイコンだけの列で開く。店の画面の左メニューと同じ幅の決まり。
  useIsoLayoutEffect(() => { if (window.innerWidth < SIDEBAR_AUTO_COLLAPSE_BELOW) setCollapsed(true) }, [])
  // 上の帯の畳むボタン（⌘\）を受ける。共通の左メニューと同じ合図。
  useEffect(() => {
    const onToggle = () => setCollapsed((v) => !v)
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle)
  }, [])
  useEffect(() => { setDrawer(false) }, [pathname])

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`)
  const title = opsTitleForPath(pathname)

  const menu = (
    <>
      <OpsBrand compact={collapsed && !drawer} />
      <nav className={nav.nav} aria-label="運営メニュー">
        <div className={nav.section}>
          <p className={nav.sectionToggle}>
            <span className="min-w-0 flex-1 truncate text-left">運営</span>
          </p>
          {OPS_MENU.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                title={item.label}
                aria-current={active ? 'page' : undefined}
                className={`${nav.item} ${active ? nav.active : ''}`}
              >
                <Icon aria-hidden="true" />
                <span className={`${nav.itemLabel} min-w-0 flex-1 truncate`}>{item.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
      <p className={styles.auditMark} title="契約先のデータを扱います。操作はすべて記録されます">
        <ShieldCheck aria-hidden="true" />
        {collapsed && !drawer ? <span className="sr-only">操作は記録されます</span> : <span>操作は記録されます</span>}
      </p>
      {!me ? (
        <div className={nav.settingsEntry}>
          <p className={styles.meNote} role="status">
            {humanizeErrorText(meError || '担当者を読み込んでいます')}
            {meError ? <button type="button" onClick={onRetryMe} className={styles.meRetry}>もう一度</button> : null}
          </p>
        </div>
      ) : null}
      <div className={nav.collapseHide}><SidebarVersion /></div>
      <SidebarUserMenu name={me?.name || '—'} role="運営" collapsed={collapsed && !drawer} pathname={pathname} items={[
        { id: 'members', label: 'メンバー管理', href: '/ops/members' },
        { id: 'two-factor', label: me?.totpEnabled ? '二段階認証（設定済み）' : '二段階認証の設定', href: '/ops/two-factor' },
        { id: 'logout', label: 'ログアウト', tone: 'danger', dividerBefore: true, onSelect: () => void logoutAndGoToLogin('/ops/login') },
      ]} />
    </>
  )

  return (
    <div className={shellStyles.shell} data-design-node="CyW0E">
      <div className={styles.mobileBar}>
        <button type="button" aria-expanded={drawer} onClick={() => setDrawer(true)} className={styles.mobileButton}>
          <Menu aria-hidden="true" />
          メニュー
        </button>
        <span className={styles.mobileTitle}>{title}</span>
      </div>
      {drawer ? (
        <>
          <button type="button" aria-label="メニューを閉じる" onClick={() => setDrawer(false)} className={styles.scrim} />
          <aside ref={drawerRef} aria-label="運営メニュー（開いた形）" className={styles.drawer}>
            <button type="button" aria-label="メニューを閉じる" onClick={() => setDrawer(false)} className={styles.drawerClose}>
              <X aria-hidden="true" />
            </button>
            {menu}
          </aside>
        </>
      ) : null}
      {banner}
      <div className={shellStyles.workspace}>
        <aside className={nav.desktop} data-collapsed={collapsed ? '' : undefined}>
          {menu}
        </aside>
        <div className={`${shellStyles.side} ${styles.side}`}>
          <div className="hidden xl:block v8-topbar-wrap">
            <TopBar
              title={title ? `運営 › ${title}${pageChrome.title ? ` › ${pageChrome.title}` : ''}` : '運営'}
              manualHref={null}
              accounts={[{ id: 'ops', label: '運営コンソール', mark: 'm' }]}
              selectedAccountId="ops"
              onAccountChange={() => undefined}
              roleLabel="運営"
              accountScopeLabel="運営"
              userName={me?.name ?? ''}
              onLogout={() => logoutAndGoToLogin('/ops/login')}
              showIdentity={false}
              v8Chrome
              chromeVariant="shell"
              menuCollapsed={collapsed}
            />
          </div>
          <main id="ops-main" tabIndex={-1} className={shellStyles.main}>
            <div className={shellStyles.content} data-content-layout="ops">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}

/**
 * 板の中の頭（題・説明・右の操作）と、その下の数の帯。
 * 「操作は記録されます」の注意は左メニューの下の小さな印1つにまとめ、
 * 各画面の帯は出さない。
 */
export function OpsHead({
  title,
  description,
  actions,
  stats,
  band,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  stats?: ReactNode
  /** 見出しの下に置く数の帯。 */
  band?: ReactNode
}) {
  return (
    <div className={styles.head}>
      <PageHeading title={title} help={description} actions={actions} inset="none" />
      {band}
    </div>
  )
}
