'use client'

import Link from './list-navigation'
import { ChevronRight, ChevronsUpDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import AccountSwitchMenu, { type AccountSwitchMenuHq } from './account-switch-menu'
import type { MenuPortalRect } from './menu-portal'
import { SIDEBAR_TOGGLE_EVENT } from '@/lib/events'
import ActionMenu, { type ActionMenuItem } from './action-menu'
import Avatar from './avatar'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import styles from './top-bar.module.css'
import { formatNumber } from '@/lib/format'

export interface TopBarAccount {
  id: string
  label: string
  /** アカウントのアイコン。無ければ名前の1文字目を出す。 */
  iconUrl?: string | null
  /** 頭の1文字。アイコンの代わりに出す。無ければ名前の1文字目。 */
  mark?: string
  /** LINE の ID（@ なし）。切り替えの一覧で名前の下に出す。 */
  basicId?: string | null
}

export interface TopBarNotificationsPopover {
  open: boolean
  onClose: () => void
  /** ベル。外を押したかの判定と Esc で焦点を戻す先。 */
  getAnchor: () => HTMLElement | null
  /** 小窓の位置の基準：上の帯の右端から 8 内側・帯の下。 */
  getPositionRect: () => MenuPortalRect | null
  /** 小窓の id（ベルの aria-controls）。 */
  id: string
}

/** 小窓の右端を上の帯の右端から内側へ寄せる幅（絵 mV28V）。 */
const BELL_POPOVER_EDGE = 8

export interface TopBarProps {
  title: string
  /**
   * マニュアルの行き先。**空文字と null のときは、そもそも描かない。**
   * URLは Masato 確定待ちで、いまは `manual-links.ts` が全部空。
   * 空のまま Link にすると `/` へ飛んでしまい、開いた人が画面を見失う。
   * 押せない札を「準備中」の吹き出し付きで置くのもやめた。出す＝使える
   * （`docs/v8-design-rules.md` §5）。
   */
  manualHref?: string | null
  accounts: TopBarAccount[]
  selectedAccountId: string
  onAccountChange: (accountId: string) => void
  /** 統括配下ではアカウントを切り替えないため非表示にする。 */
  showAccountSwitcher?: boolean
  roleLabel: string
  accountScopeLabel?: string
  /**
   * 権限バッジを押したときの行き先。渡さなければ押せない印のまま。
   * 統括は、ここから店舗の一覧へ戻る（本文に別のボタンを置かない）。
   */
  onRoleClick?: () => void
  userName: string
  onLogout: () => void | Promise<void>
  /**
   * ★V8：ベルの未読の件数。数の取得は呼び出し側が持つ（ここでは取らない）。
   * 互換経路では描かない。
   */
  notificationUnreadCount?: number | null
  /**
   * ★V8：ベルを押したときの小窓（V8.pen `DIHFx/D2eAyQ`・小窓 `mV28V`）を描く。
   * 渡すとベルはページを移らずに小窓を開くボタンになる。渡さなければ今までどおり
   * 通知の一覧（/notifications）へのリンク。中身（取得・既読）は呼ぶ側が持つ。
   */
  renderNotifications?: (popover: TopBarNotificationsPopover) => ReactNode
  /**
   * ★V8 外側の左側（畳むボタンとパンくず）を出すか。
   * 左メニューの無い殻（停止中のワークスペース等）では渡さない。
   * 畳むボタンは投げるだけなので、受け手の無い場所に置くと
   * 押しても何も起きない偽の操作になる。
   */
  v8Chrome?: boolean
  /** 初回利用開始中は左メニューが無いため、畳むボタンを描画しない。 */
  showSidebarToggle?: boolean
  /** 初回利用開始中は通常ホームに戻れないため、ホーム導線を描画しない。 */
  showHomeBreadcrumb?: boolean
  /** 画面の絵に合わせた外側の形。統括などの既存の形は default。 */
  chromeVariant?: 'default' | 'shell'
  menuCollapsed?: boolean
  /**
   * ★V8：パンくずの手前の段。「ホーム」「一斉配信」など。
   * 渡されなければ従来どおり選んでいるアカウント名を出す。
   * 互換経路では描かない。
   */
  crumbs?: { label: string; href?: string; onSelect?: () => void }[] | null
  /**
   * ★V8 統括の画面（/hq）のとき、切替の札に「統括」と統括名を出す。
   * 渡さなければ店の画面の札（「LINEアカウント」と選んでいるアカウント）。互換経路では描かない。
   */
  hq?: { name: string; mark: string; iconUrl?: string | null } | null
  /** ★V8 パンくずの「ホーム」の行き先。統括の画面は統括のホーム（/hq）。 */
  homeHref?: string
  /**
   * ★V8 子の画面で、画面名が左メニューの名前と同じ（絵の上の帯が「ホーム › 一覧の名前」）とき、
   * その名前を一覧への戻り口にする行き先（2026-10-08 板の頭の「← 〇〇へ」を無くしたため）。
   */
  titleHref?: string
  /**
   * ★V8 店の画面から統括へ戻る口（絵 V8 `DIHFx/Psg7n`）。統括の権限がある人にだけ渡す。
   * 渡すと切り替えの左に［統括へ］、切り替えを開いた一覧のいちばん上に「統括に戻る」を出す。互換経路では描かない。
   */
  hqReturn?: AccountSwitchMenuHq | null
  /**
   * 右端の自分（顔・名前・役割）とログアウトを出すか。既定は出す。
   * ★V8 の管理画面は左下の自分のメニューへ移したので `false` を渡す（オーナー 2026-10-07）。
   */
  showIdentity?: boolean
  /** 運営の自分の操作。省いたときの名前と配置は変えない。 */
  identityActions?: ActionMenuItem[]
  className?: string
}

/**
 * Pencil 管理画面 `cBSCb` を正本にした、管理画面共通のトップバー。
 *
 * 認証やアカウント取得は持たず、既存のコンテキストから受け取った値だけを
 * 表示する。これにより、見た目を全画面で共有しながら現行のデータ取得方法を
 * 変えずに段階移行できる。
 */
export default function TopBar({
  title,
  manualHref,
  accounts,
  selectedAccountId,
  onAccountChange,
  showAccountSwitcher = true,
  roleLabel,
  accountScopeLabel,
  onRoleClick,
  userName,
  onLogout,
  notificationUnreadCount = 0,
  renderNotifications,
  v8Chrome = false,
  showSidebarToggle = true,
  showHomeBreadcrumb = true,
  chromeVariant = 'default',
  menuCollapsed = false,
  crumbs,
  hq = null,
  homeHref = '/',
  titleHref,
  hqReturn = null,
  showIdentity = true,
  identityActions,
  className,
}: TopBarProps) {
  const [switchOpen, setSwitchOpen] = useState(false)
  const [identityOpen, setIdentityOpen] = useState(false)
  const identityRef = useRef<HTMLButtonElement>(null)
  const switchRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const [bellOpen, setBellOpen] = useState(false)
  const bellPopoverId = useId()
  const closeBell = useCallback(() => setBellOpen(false), [])
  const getBell = useCallback(() => bellRef.current, [])
  const getBellPosition = useCallback((): MenuPortalRect | null => {
    const bar = rootRef.current?.getBoundingClientRect()
    if (!bar) return null
    const right = bar.right - BELL_POPOVER_EDGE
    return { top: bar.top, bottom: bar.bottom, left: right, right, width: 0 }
  }, [])
  const classes = [styles.root, className].filter(Boolean).join(' ')
  const current = accounts.find((account) => account.id === selectedAccountId)

  /*
   * ★V8 外側の合図。⌘\ で左メニューを畳む。
   * 互換経路では動きを出さない（テーマが v8 のときだけ受け付ける）。
   * 帯の探す欄は V8 で外したので、探す欄への焦点合図は持たない
   * （探すのは各一覧の中の欄が受ける）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '\\') {
        e.preventDefault()
        window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header ref={rootRef} className={classes} data-design-node="cBSCb" data-v8-chrome={chromeVariant} data-menu-collapsed={menuCollapsed || undefined}>
      {/*
        ★V8 外側（Pencil `y3gx8R`）：左に畳むボタンとパンくず
        （アカウント › 画面名）。
        左メニューを持つ殻（v8Chrome）のときだけ出す。
        現在位置を h1 で示す。
      */}
      {v8Chrome ? (
        <div className={`${styles.v8Left}`}>
          {showSidebarToggle ? <button
            type="button"
            className={styles.iconButton}
            aria-label="メニューを畳む・広げる"
            title="メニューを畳む（⌘\）"
            onClick={() => window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT))}
          >
            {chromeVariant === 'shell' ? (menuCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />) : <PanelLeftIcon />}
          </button> : null}
          <nav className={styles.crumbs} aria-label="パンくず">
            {/*
              ★V8 殻合わせ（絵 `V8-B/JKjsE`）：手前はホーム。格子印＋
              「ホーム」で最初の画面へ（統括もふだんの画面も同じ殻）。
            */}
            {showHomeBreadcrumb ? <><Link prefetch={false} href={homeHref} className={styles.crumbHome}>
              <HomeGridIcon /><span>ホーム</span>
            </Link>
            <span className={styles.crumbSep} aria-hidden="true">{chromeVariant === 'shell' ? <ChevronRight size={16} /> : '›'}</span></> : null}
            {/*
              手前の段。ページが crumbs を渡したらそれを出す
              （一覧からの詳細で「一斉配信 › 配信名」）。渡さない画面は
              従来どおり選んでいるアカウント名。未選択（統括の一覧など）
              では「店舗を選択」と出さず、画面名だけにする。
            */}
            {/*
              手前の段。帯は「ホーム ›」を自分で出すので、画面が渡した
              先頭の「ホーム」は重ねない（`ホーム › ホーム › 画面名` になる）。
              何も渡さない画面はアカウント名を出さず題だけにする（絵の指示）。
            */}
            {/* 題がまだ無い（対象が見つからない画面など）ときは、最後の段を今の場所にして空の「›」を残さない（tSgl6）。 */}
            {(crumbs ?? []).filter((crumb, index) => index > 0 || crumb.label !== 'ホーム').filter((_crumb, index, list) => title || index < list.length - 1).map((crumb) => (
              <span key={crumb.label} className={styles.crumbFromWrap}>
                {crumb.onSelect ? (
                  /*
                   * 同じ URL のまま中の段だけ替える画面（統括のテンプレート・統合ユーザーの詳細など）は、
                   * 同じ URL へのリンクでは戻れない。画面が渡した動きで戻す。書きかけなら
                   * requestUnsavedAction が「保存せずに移りますか」を出してから動く（2026-10-08）。
                   */
                  <button type="button" className={`${styles.crumbFromLink} ${styles.crumbFromButton}`} onClick={() => requestUnsavedAction(crumb.onSelect!)}>{crumb.label}</button>
                ) : crumb.href ? (
                  <Link prefetch={false} href={crumb.href} className={styles.crumbFromLink}>{crumb.label}</Link>
                ) : (
                  <span className={styles.crumbFrom}>{crumb.label}</span>
                )}
                <span className={styles.crumbSep} aria-hidden="true">{chromeVariant === 'shell' ? <ChevronRight size={16} /> : '›'}</span>
              </span>
            ))}
            {/* パンくずの今いる所は見出しにしない。画面の題（h1）は本文の頭（PageHeading）が持つ。 */}
            {title ? <span className={styles.crumbCurrent} title={title} aria-current="page">{titleHref ? <Link prefetch={false} href={titleHref} className={styles.crumbCurrentLink}>{title}</Link> : title}</span>
              : (() => { const last = (crumbs ?? []).filter((crumb, index) => index > 0 || crumb.label !== 'ホーム').at(-1); return last ? <span className={styles.crumbCurrent} title={last.label} aria-current="page">{last.href ? <Link prefetch={false} href={last.href} className={styles.crumbCurrentLink}>{last.label}</Link> : last.label}</span> : null })()}
          </nav>
        </div>
      ) : null}

      {!v8Chrome ? <div className={styles.titleGroup}>
        <span className={styles.title} title={title}>{title}</span>
        {manualHref
          ? <Link prefetch={false} href={manualHref} className={styles.manual}><BookIcon /><span>マニュアル</span></Link>
          : null}
      </div> : null}

      <div className={styles.actions}>
        {showAccountSwitcher ? <>
          {/*
            ★V8: 帯の探す欄はオーナー決定で外した（2026-10-01）。
            探すのは各一覧の中の欄が受ける。ここには行き先の曖昧な
            全体検索を置かない。
          */}
          {/*
            ★V8 の［統括へ］ボタンはやめた（オーナー 2026-10-07）。統括へ戻るのは、
            切り替えの一覧の頭の「統括に戻る」と、左下の自分のメニュー。
          */}
          <label className={styles.accountField}>
          <span>LINEアカウント</span>
          {/*
            Pencil `cBSCb/xvrTI` は「印 ＋ 名前 ＋ ▾」の白い札。印は `select` の
            中へ置けないので、札の側に重ねて置き、`select` は透明にして上に敷く。
            自前のドロップダウンにしないのは、キーボードと読み上げが
            ブラウザの実装のまま使えるほうが確かなため。
          */}
          <span className={styles.accountPill}>
            <Avatar
              name={hq ? hq.name : current?.label ?? ''}
              src={hq ? hq.iconUrl ?? null : current?.iconUrl ?? null}
              size={24}
              shape="rounded"
              alt={hq ? hq.name : current?.label ?? null}
            />
            {/*
              ★V8 殻合わせ（絵 `V8-B/JKjsE`）：札に役割（統括など）を小さい
              行で添える。
            */}
            {roleLabel ? (
              <span className={styles.pillText}>
                <span className={`${styles.pillRole}`}>{accountScopeLabel ?? (hq ? '統括' : 'LINEアカウント')}</span>
                {/* ★V8 統括の画面：札は統括にいることを示す（絵 `V8-B/JKjsE`）。 */}
                {hq ? (
                  <>
                    <span className={`${styles.accountName}`} data-part="account-name" title={hq.name}>{hq.name}</span>
                  </>
                ) : (
                  <span className={styles.accountName} data-part="account-name" title={current?.label ?? 'LINE公式アカウントを選んでください'}>{current?.label ?? '未選択'}</span>
                )}
              </span>
            ) : (
              <span className={styles.accountName} data-part="account-name" title={current?.label ?? 'LINE公式アカウントを選んでください'}>{current?.label ?? '未選択'}</span>
            )}
            <span className={styles.switchChevron} data-open={switchOpen || undefined} aria-hidden="true">{chromeVariant === 'shell' ? <ChevronsUpDown size={16} /> : <ChevronIcon />}</span>

            {/*
              開くと統括に戻る操作と店の一覧を出す。
              札の上に透明のボタンを敷き、押すと一覧を出す。
              選ぶ欄より後ろに置く（外の見出しが指すのは選ぶ欄のまま）。
            */}
            <button
              ref={switchRef}
              type="button"
              className={`${styles.accountSelect}`}
              aria-label="アカウントを切り替える"
              aria-haspopup="menu"
              aria-expanded={switchOpen}
              onClick={(event) => { event.preventDefault(); setSwitchOpen((current) => !current) }}
            />
          </span>
          </label>
          <AccountSwitchMenu
            open={switchOpen}
            onClose={() => setSwitchOpen(false)}
            getAnchor={() => switchRef.current}
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onSelect={onAccountChange}
            hq={hqReturn}
          />
          {/*
            ★V8: 通知。小窓を渡されたら、押すとページを移らずにベルの下へ小窓を開く
            （絵 DIHFx/D2eAyQ）。渡されなければ通知の一覧（/notifications）へのリンク。
            未読は赤い丸で右上に出す（100以上は 99+）。
          */}
          {renderNotifications ? (
            <>
              <button
                ref={bellRef}
                type="button"
                className={`${styles.iconButton}`}
                data-topbar-bell=""
                aria-label={notificationBellLabel(notificationUnreadCount)}
                aria-haspopup="dialog"
                aria-expanded={bellOpen}
                aria-controls={bellOpen ? bellPopoverId : undefined}
                onClick={() => setBellOpen((current) => !current)}
              >
                <BellIcon />
                <BellBadge count={notificationUnreadCount} />
              </button>
              {renderNotifications({ open: bellOpen, onClose: closeBell, getAnchor: getBell, getPositionRect: getBellPosition, id: bellPopoverId })}
            </>
          ) : (
            <Link
              prefetch={false}
              href="/notifications"
              className={`${styles.iconButton}`}
              aria-label={notificationBellLabel(notificationUnreadCount)}
            >
              <BellIcon />
              <BellBadge count={notificationUnreadCount} />
            </Link>
          )}
          <span className={styles.separator} aria-hidden="true" />
        </> : null}

        {showIdentity ? <>
        {/*
          ★V8 殻合わせ（絵 `V8-B/JKjsE`）：名前を太字・役割を下の小さい行に
          積む。
        */}
        <div className={styles.identity}>
          {/* ★V8: 自分（36px の顔）。名まえの頭1文字を丸いタイルで出す。 */}
          <span className={`${styles.avatar}`} aria-hidden="true">
            {userName.trim().slice(0, 1)}
          </span>
          <span className={styles.identityText}>
            {identityActions?.length ? <>
              <button type="button" ref={identityRef} className={styles.user} title={userName} aria-label="自分のメニュー" aria-haspopup="menu" aria-expanded={identityOpen} onClick={() => setIdentityOpen((open) => !open)}>{userName}</button>
              <ActionMenu open={identityOpen} items={identityActions} anchorRef={identityRef} onClose={() => setIdentityOpen(false)} ariaLabel="自分の操作" />
            </> : <span className={styles.user} title={userName}>{userName}</span>}
            {onRoleClick
              ? <button type="button" className={styles.roleButton} onClick={onRoleClick}>{roleLabel}</button>
              : <span className={styles.role}>{roleLabel}</span>}
          </span>
        </div>

        <button type="button" className={styles.logout} onClick={onLogout} aria-label="ログアウト">
          <LogOutIcon /><span aria-hidden="true">ログアウト</span>
        </button>
        </> : null}
      </div>
    </header>
  )
}

/* Pencil のアイコンは lucide。同じ形を手で写す（外の読み込みを増やさない）。 */
function BookIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

function LogOutIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/* ★V8 殻合わせ：ホームの格子印（lucide `layout-grid`） */
function HomeGridIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </svg>
  )
}

/* ★V8: メニューの畳み（lucide `panel-left`） */
function PanelLeftIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

/* ★V8: ベルの未読の数（赤い丸・100以上は 99+）。 */
function notificationBellLabel(count: number | null) {
  return count === null ? '通知（未読数を確認できません）' : count > 0 ? `通知（未読 ${formatNumber(count)} 件）` : '通知'
}

function BellBadge({ count }: { count: number | null }) {
  if (count === null) return <span className={styles.bellBadge} data-count-unknown="" aria-hidden="true" />
  if (count <= 0) return null
  return (
    <span className={styles.bellBadge} aria-hidden="true">
      {count > 99 ? '99+' : count}
    </span>
  )
}

/* ★V8: 通知（lucide `bell`） */
function BellIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  )
}
