'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import SettingsInnerNav, { isSettingsAreaPath } from './layout/settings-inner-nav'
import AuthGuard from './auth-guard'
import HqAccessGate from './hq-access-gate'
import { AccountProvider } from '@/contexts/account-context'
import SessionLostNotice from './session-lost-notice'
import RootLandingGate from './root-landing-gate'
import StoreSelectionGate from './store-selection-gate'
import FeatureDisabledGate from './feature-disabled-gate'
import AppTopBar from './shell/app-top-bar'
import { PageChromeProvider, usePageChrome } from './shell/page-chrome'
import styles from './app-shell.module.css'
import { isPublicAuthPath } from '@/lib/auth-email'
import OpsShell from './ops/ops-shell'
import MobileShell from './mobile/mobile-shell'
import { isMobileShellPath } from '@/lib/mobile-shell'
import ImpersonationNotice from './ops/impersonation-notice'
import UnfamiliarLoginNotice from './unfamiliar-login-notice'
import SuspendedSidebar from './layout/suspended-sidebar'
import CommandPalette from './shared/command-palette'
import HoverPrefetch from './shared/hover-prefetch'
import RowEntranceSettle from './shared/row-entrance-settle'
import TopBar from './shared/top-bar'
import NoteBar from './shared/note-bar'
import PlatformNotices from './hq/platform-notices'
import { logoutAndGoToLogin } from '@/lib/logout'
import { useEffect, useState } from 'react'
import ViewPermissionGate from './view-permission-gate'
import { PagePendingLayout } from './templates/page-pending'
import { routePendingForPath } from '@/lib/route-pending'
import MusuboLogo from './shared/musubo-logo'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return <PagePendingLayout {...routePendingForPath(pathname)}><AppShellContent pathname={pathname}>{children}</AppShellContent></PagePendingLayout>
}

function AppShellContent({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const onboarding = pathname.startsWith('/hq/onboarding/')
  /*
   * LINEアカウントを登録（/accounts/new）。互換経路は外枠の無い専用の全画面。
   * ★V8 は絵（〜）どおり、ほかの画面と同じ外枠（左メニュー・上の帯）で出す（2026-10-07 司令塔）。
   */


  if (isPublicAuthPath(pathname)) {
    return <>{children}</>
  }

  // 2要素認証の設定（★管理画面 37-10-B）は、まだ運営メンバーでない人も開く。外枠を付けない。
  if (pathname === '/ops/two-factor') {
    return <>{children}</>
  }

  // 運営コンソール（★管理画面 37）。統括・店舗の共通メニューとは別の外枠を使う。
  if (pathname === '/ops' || pathname.startsWith('/ops/')) {
    return <OpsShell>{children}</OpsShell>
  }

  // 電話の専用の画面（/m）。管理画面を縮めず、下のタブの別の外枠で開く。`/mileage` などは入れない。
  if (isMobileShellPath(pathname)) {
    return <MobileShell>{children}</MobileShell>
  }

  // 参照画像との比較専用。開発中だけ表示し、実データの取得・保存は行わない。
  // 本番ビルドでは通常の認証ガードを必ず通る。
  if (process.env.NODE_ENV === 'development' && pathname.startsWith('/visual-qa/')) {
    return (
      <AccountProvider>
        <div className={styles.workspace}>
          <Sidebar />
          <main className={styles.main}>
            <div data-design-shell="v6-1920" data-design-node="J33xq" className={styles.content}>
              {children}
            </div>
          </main>
        </div>
      </AccountProvider>
    )
  }

  const guardedContent = <HqAccessGate><ViewPermissionGate><RootLandingGate><StoreSelectionGate><FeatureDisabledGate>{children}</FeatureDisabledGate></StoreSelectionGate></RootLandingGate></ViewPermissionGate></HqAccessGate>

  const suspendedSupport = (
    <PageChromeProvider>
      <SuspendedSupportWorkspace>{children}</SuspendedSupportWorkspace>
    </PageChromeProvider>
  )

  return (
    <AuthGuard suspendedSupport={suspendedSupport}>
      <AccountProvider>
        <PageChromeProvider>
          {(
            <div className={`${styles.shell} ${onboarding ? styles.onboardingShell : ''}`}>
              {/*
                本文へ移動（★V7 修正方針 §2）。ふだんは見えず、Tab で最初に焦点が来たときだけ
                左上に出る。更新案内とメニュー11項目を飛ばして本文へ行ける（WCAG 2.4.1）。
              */}
              <a href="#main-content" className={styles.skipLink}>本文へ移動</a>
              {/* Cookieが届いていないときの案内。全画面で同じものを1つだけ出す。 */}
              <SessionLostNotice />
              {/* Phase 6: banner above sidebar+header so it pins to the top of the
                  admin shell. Renders nothing while loading; one of latest/fork/
                  upgrade once /admin/version + manifest resolve.
                  ★V8 では帯を出さない（移行③「黄色の版の帯を消す」）。版は
                  メニューの一番下の「Ver.」が持つ。 */}
              {/* 代理ログイン中の赤い帯（★V6 37-5）。運営マスター以外には出ない。 */}
              <ImpersonationNotice />
              <div className={`${styles.workspace} ${onboarding ? styles.onboardingWorkspace : ''}`}>
                {/* V8 の先読み（F①）。V8 のときだけ中の聞き耳が働く。 */}
                <HoverPrefetch />
                <RowEntranceSettle />
                {/* V8 の探す窓（F②）。⌘K・Ctrl+K で開く。帯には置かない。 */}
                <CommandPalette />
                {onboarding ? <div className={styles.onboardingBrand}><MusuboLogo /></div> : <Sidebar />}
                <Workspace>
                  {guardedContent}
                </Workspace>
              </div>
            </div>
          )}
        </PageChromeProvider>
      </AccountProvider>
    </AuthGuard>
  )
}

/** 停止中のお問い合わせ。管理画面 `IwfA0` の外枠だけを組み、通常の画面機能は再利用する。 */
function SuspendedSupportWorkspace({ children }: { children: React.ReactNode }) {
  const { title } = usePageChrome()
  const [staffName, setStaffName] = useState('')

  useEffect(() => {
    try { setStaffName(localStorage.getItem('lh_staff_name') ?? '') } catch { /* storage なし */ }
  }, [])

  return (
    <div className={styles.shell} data-design-node="IwfA0">
      <SessionLostNotice />
      <div className={styles.workspace}>
        <SuspendedSidebar />
        <div className={styles.side}>
          <div className="hidden xl:block">
            <TopBar
              title={title ?? 'お問い合わせ'}
              manualHref={null}
              accounts={[]}
              selectedAccountId=""
              onAccountChange={() => undefined}
              showAccountSwitcher={false}
              roleLabel="オーナー"
              userName={staffName}
              onLogout={logoutAndGoToLogin}
            />
          </div>
          <main id="main-content" tabIndex={-1} className={styles.main}>
            <div className={`${styles.content} ${styles.contentFull} flex min-h-full flex-col`}>
              <div className="flex min-h-full flex-1 flex-col gap-4">
                <div data-design-node="MdTiR">
                  <NoteBar tone="danger">
                    ご契約の利用が停止されています。この画面の「お問い合わせ」と、運営からのお知らせだけご利用いただけます。他の機能は復帰後に使えるようになります。
                  </NoteBar>
                </div>
                <PlatformNotices />
                {children}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

/**
 * 共通メニューの右側。上にトップバー、下に本文。
 *
 * `PageChromeProvider` の中でしか使えない（`usePageChrome` を読むため）。
 * 本文の幅は既定で `--container-shell` までにし、**ページが明示したときだけ**外す。
 * ルート名で自動判定しない（`docs/v8-design-rules.md` §5）。
 */
export function Workspace({ children }: { children: React.ReactNode }) {
  const { fullWidth, settingsNavInline } = usePageChrome()
  const pathname = usePathname()
  /*
   * ★V8（夕41）：設定の画面は、白い板の中の左に「設定の中のメニュー」
   * （幅208）を付ける。互換経路では部品も枠組みも出さない（1画素も変えない）。
   * SSR・最初の描画は 管理画面 の形で、レイアウト効果の中で v8 に揃える。
   */

  // 画面がメニューを白い板の中に置いたら（settingsNavInline）、外には出さない。
  // LINEアカウントを登録（/accounts/new）は統括の画面。設定の中のメニューは付けない（絵 〜）。
  const settingsArea = isSettingsAreaPath(pathname ?? '') && pathname !== '/accounts/new'
  const withSettingsNav = !fullWidth && !settingsNavInline && settingsArea
  return (
    <div className={styles.side}>
      <AppTopBar />
      <main id="main-content" tabIndex={-1} className={`${styles.main} ${pathname?.startsWith('/hq/onboarding/') ? styles.onboardingMain : ''}`}>
        {/* V-2: いつもと違う端末・場所からのログイン。そのログイン中だけ、白いカードで出す。 */}
        <UnfamiliarLoginNotice className={styles.securityNotice} />
        {/* V6 共通メニュー J33xq と同じ256pxサイドバーを基準にする。 */}
        <div
          data-design-shell="v6-1920"
          data-design-node="J33xq"
          className={`${styles.content} ${fullWidth ? styles.contentFull : ''} ${withSettingsNav ? styles.contentSettings : ''}`}
        >
          {/*
            設定の住所では、外のメニューの有る無しで包みの形を変えない（本文を作り直さない）。
            形を変えると本文が作り直され、テーマが v7 から読み直されて、板の中のメニュー
            （settingsNavInline）が出る・消えるを繰り返し、画面が落ちる。外のメニューだけを出し入れし、
            出さないときの包みは display: contents で並びに影響させない。
          */}
          {settingsArea ? (
            <div className={withSettingsNav ? styles.settingsSplit : styles.settingsPass} data-settings-split={withSettingsNav ? '' : undefined}>
              {withSettingsNav ? <SettingsInnerNav /> : null}
              <div className={withSettingsNav ? styles.settingsBody : styles.settingsPass}>{children}</div>
            </div>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  )
}
