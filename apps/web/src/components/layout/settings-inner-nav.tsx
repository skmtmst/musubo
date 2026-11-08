'use client'

import { effectiveStaffRole, useStaffIdentity, canManageRole, canAdministerRole } from '@/lib/staff-role'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { MENU_SECTION_BY_ID, type MenuItem } from '@/lib/menu'
import { styleMenuItemVisible } from './style-menu'
import { SIDEBAR_FEATURE_BY_HREF } from '@/lib/feature-settings'
import { FEATURE_SETTINGS_UPDATED_EVENT } from '@/lib/feature-settings-event'
import { Activity, Layers, Palette, Rocket, Share2, ShoppingCart, SlidersHorizontal, Store, Truck, Users, type LucideIcon } from 'lucide-react'
import { useSettingsNavInline } from '@/components/shell/page-chrome'
import styles from './settings-inner-nav.module.css'

/*
 * ★V8（夕41）：設定の画面どうしを行き来するための、白い板の中の左の
 * 「設定の中のメニュー」（幅 208）。
 *
 * 「設定の画面では左のメニューの歯車が選ばれた形」になる側の受け皿。
 * いまの画面は薄い地＋太字で示す。
 *
 * 項目の正本は左のメニューと同じ `lib/menu.ts` の「設定」組。ここでは
 * 絵の並び（夕41）に並べ直して出す。「会社とロゴ」は API ができるまで
 * 出さない（MIGRATION-RISKS §1-4・ユーザーの指示）。「プール管理」は
 * 絵の中のメニューに無いのでここには出さない（左のメニューからは
 * 今までどおり行ける）。
 */

/**
 * ★V8 設定の板（・・ ほか 8 枚）の並び。左のメニュー（menu.ts）の並びとは違うので、ここで明示する。
 * 2026-10-06：夕41 の並び（専用の小見出し・プール管理なし）から、今の絵の並びへ。
 */
const SETTINGS_ORDER = [
  '/settings/customer-look', // お客さまのデザイン（・絵  では会社とロゴの次＝今は先頭）
  '/getting-started', // はじめの設定
  '/pools', // プール管理
  '/staff', // ログインユーザー
  '/settings', // 機能設定
  '/emergency', // 運用状態
  '/ec-commerce', // EC連携
  '/settings/sns', // SNS 連携（提案 E-6）。今ある絵の並びを動かさないよう末尾に足す
  '/settings/booking-media', // 予約サイト・グルメ媒体（提案 E-4）。飲食店向け（テスト）が使える環境だけ出す
  '/settings/delivery', // デリバリー連携（承認案 DL-1 `dF4Ov`）。飲食店向け（テスト）が使える環境だけ出す
] as const

/** 絵の印（lucide）。 */
const SETTINGS_ICONS: Record<(typeof SETTINGS_ORDER)[number], LucideIcon> = {
  '/settings/customer-look': Palette,
  '/getting-started': Rocket,
  '/pools': Layers,
  '/staff': Users,
  '/settings': SlidersHorizontal,
  '/emergency': Activity,
  '/ec-commerce': ShoppingCart,
  '/settings/sns': Share2,
  '/settings/booking-media': Store,
  '/settings/delivery': Truck,
}

/** 左のメニュー（lib/menu）に無く、設定の中のメニューにだけ出す項目。 */
const SETTINGS_ONLY_ITEMS: MenuItem[] = [
  { id: 'settings-customer-look', href: '/settings/customer-look', label: 'お客さまのデザイン', icon: '', note: '予約・回答フォームなど、お客さまに見える画面のデザイン', required: true },
  { id: 'settings-sns', href: '/settings/sns', label: 'SNS 連携', icon: '', note: 'Google ビジネスと Instagram をつなぎます', required: true },
  { id: 'settings-booking-media', href: '/settings/booking-media', label: '予約サイト・グルメ媒体', icon: '', note: '店ごとの予約サイト・グルメ媒体の URL と、他のサイトの枠を閉じる知らせ', required: true },
  { id: 'settings-delivery', href: '/settings/delivery', label: 'デリバリー連携', icon: '', note: 'Uber Eats・出前館・ロケットナウの注文をまとめて受け取ります', required: true },
]

/** この中のメニューを出す画面（左のメニューの「設定」が光る画面と同じ範囲）。 */
// 統括から開いた旧一覧でも設定の板を保つが、項目には出さない。
const SETTINGS_AREA_PATHS = [...SETTINGS_ORDER, '/accounts']
const RESTAURANT_ONLY_SETTINGS = new Set<string>(['/settings/booking-media', '/settings/delivery'])

/** いまのパスが設定の中のメニューを出す画面か。 */
export function isSettingsAreaPath(pathname: string): boolean {
  return SETTINGS_AREA_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'boolean')
}

const settingsSectionItems = MENU_SECTION_BY_ID.get('settings')?.items ?? []

/**
 * inline：画面が白い板の中（題の下の左）に置くとき true。枠の側は外のメニューを出さない。
 * 置き方の例：`<SettingsPage navigation={<SettingsInnerNav inline />} …>`
 */
export default function SettingsInnerNav({ inline = false }: { inline?: boolean } = {}) {
  useSettingsNavInline(inline)
  const pathname = usePathname() ?? ''
  const { selectedAccountId } = useAccount()
  const accountStyle = useAccountStyle(selectedAccountId)
  const restaurantSettingsVisible = accountStyle.status === 'ready' && !accountStyle.stale && accountStyle.data?.style === 'restaurant'
  const staffIdentity = useStaffIdentity()
  const staffRole = effectiveStaffRole(staffIdentity)
  const [staffPermissions, setStaffPermissions] = useState<string[]>([])
  const [staffViewPermissions, setStaffViewPermissions] = useState<string[]>([])
  const [visibility, setVisibility] = useState<Record<string, boolean> | null>(null)
  const [visibilityAccount, setVisibilityAccount] = useState<string | null>(null)
  const [visibilityVersion, setVisibilityVersion] = useState(0)

  useEffect(() => {
    const updated = (event: Event) => {
      const accountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId
      if (accountId && accountId !== selectedAccountId) return
      setVisibilityAccount(null)
      setVisibilityVersion(value => value + 1)
    }
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, updated)
    return () => window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, updated)
  }, [selectedAccountId])

  useEffect(() => {
    try { setStaffPermissions(JSON.parse(localStorage.getItem('lh_staff_permissions') || '[]')) } catch { setStaffPermissions([]) }
    try { setStaffViewPermissions(JSON.parse(localStorage.getItem('lh_staff_view_permissions') || '[]')) } catch { setStaffViewPermissions([]) }
  }, [])

  /*
   * 任意機能の表示可否は左のメニューと同じ staff 向け read-model を読む
   * （キャッシュは共有）。取れていない間は任意機能を出さない。
   */
  useEffect(() => {
    if (!selectedAccountId) {
      setVisibility(null)
      return
    }
    let cancelled = false
    void import('@/lib/feature-visibility-cache')
      .then(({ loadFeatureVisibility }) => loadFeatureVisibility(selectedAccountId))
      .then((response) => {
        if (cancelled) return
        const features = response.success ? response.data?.features : undefined
        setVisibility(isBooleanRecord(features) ? features : {})
        setVisibilityAccount(selectedAccountId)
      })
      .catch(() => {
        if (!cancelled) { setVisibility({}); setVisibilityAccount(selectedAccountId) }
      })
    return () => { cancelled = true }
  }, [selectedAccountId, visibilityVersion])

  /*
   * 見える項目だけを出す（夕41：見るだけの人には、見られる画面だけの
   * 設定の中のメニュー）。出し分けの決まりは左のメニューと同じ。
   */
  const itemVisible = (item: MenuItem): boolean => {
    if (item.href === '/ec-commerce' && !styleMenuItemVisible(item, accountStyle.data?.style ?? null, null, accountStyle.data?.styleSelected === true)) return false
    if (item.href === '/staff' && !canAdministerRole(staffRole)) return false
    if (item.href === '/settings/customer-look' && !canManageRole(staffRole)) return false
    const permissionKey = item.permissionKey ?? item.href
    if (staffRole === 'staff' && !canManageRole(staffRole) && !item.required && !staffPermissions.includes(permissionKey) && !staffViewPermissions.includes(permissionKey)) return false
    const featureKey = SIDEBAR_FEATURE_BY_HREF[item.href]
    if (!featureKey) return true
    if (visibilityAccount !== selectedAccountId || !visibility || visibility[featureKey] !== true) return false
    return true
  }

  const byHref = new Map([...settingsSectionItems, ...SETTINGS_ONLY_ITEMS].map((item) => [item.href, item]))
  const itemActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  // いま開いている画面は、権限の出し分けで隠れる項目でも必ず出す（選ばれた形が消えないように）。
  const items = SETTINGS_ORDER
    .map((href) => byHref.get(href))
    .filter((item): item is MenuItem => Boolean(item))
    .filter((item) => {
      if (RESTAURANT_ONLY_SETTINGS.has(item.href) && !restaurantSettingsVisible) return false
      if (item.featureKey === 'ec_commerce' && !itemVisible(item)) return false
      return itemActive(item.href) && item.href !== '/settings' ? true : itemVisible(item)
    })

  const entries: SettingsMenuEntry[] = items.map((item) => {
    const active = item.href === '/settings'
      ? pathname === '/settings'
      : itemActive(item.href)
    return {
      href: item.href,
      label: item.label,
      Icon: SETTINGS_ICONS[item.href as (typeof SETTINGS_ORDER)[number]],
      active,
    }
  })

  return <SettingsMenu heading="設定" label="設定の中のメニュー" entries={entries} placement={inline ? 'inline' : 'outer'} />
}

export type SettingsMenuEntry = {
  href: string
  label: string
  Icon?: LucideIcon
  active: boolean
  children?: { href: string; label: string; active: boolean }[]
}

/**
 * 設定の中のメニューの形（見出し＋印つきの項目・いまの画面は薄い地＋太字）。
 * 店の設定（SettingsInnerNav）と統括の設定（v8/hq/settings-nav）が同じ形を使う。
 * placement：'inline'＝白い板の中の左の欄（幅・余白・仕切り線を持つ）、
 * 'outer'＝まだ移っていない画面の外の欄、'folder'＝型（ListPage）のフォルダの列の中（幅・余白・線は型が持つ）。
 */
export function SettingsMenu({ heading, label, entries, placement = 'inline', fit = false }: {
  heading: string
  label: string
  entries: SettingsMenuEntry[]
  placement?: 'inline' | 'outer' | 'folder'
  /** 型のフォルダの列を中身の高さで止める（data-folder-fit）。 */
  fit?: boolean
}) {
  return (
    <nav className={placement === 'folder' ? styles.folder : `${styles.root} ${placement === 'inline' ? styles.inline : ''}`} aria-label={label} data-settings-nav={placement === 'outer' ? 'outer' : placement} data-folder-fit={fit ? '' : undefined}>
      <p className={styles.heading}>{heading}</p>
      <ul className={styles.list}>
        {entries.map(({ href, label: itemLabel, Icon, active, children = [] }) => (
          <li key={href}>
            <Link
              prefetch={false}
              href={href}
              className={`${styles.item} ${active ? styles.itemActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {Icon ? <Icon size={16} aria-hidden="true" className={styles.icon} /> : null}
              {itemLabel}
            </Link>
            {children.length > 0 && (
              <ul className={styles.children}>
                {children.map((child) => (
                  <li key={child.href}>
                    <Link prefetch={false} href={child.href} className={`${styles.child} ${child.active ? styles.itemActive : ''}`}>
                      {child.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}
