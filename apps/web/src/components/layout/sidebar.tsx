'use client'

import SharedButton from '@/components/shared/button'
import { useRememberedSidebar } from './use-remembered-sidebar'
import { revealInScroller } from './sidebar-current-item'
import { V8_NAV_ICONS, V8_SETTINGS_ICON } from './sidebar-icons'
export { revealInScroller } from './sidebar-current-item'

import { readStaffIdentity } from '@/lib/staff-identity-state'

import { SidebarAccountMenu } from '@/components/hq/account-menu'
import Notice from '@/components/shared/notice'
import { ShellStaleStyleNotice } from '@/components/shared/stale-style-notice'
import { defaultTitleForPath } from '@/components/shell/app-top-bar'
import { usePageChrome } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { restaurantTestUiEnabled } from '@/lib/environment-features'
import { styleMenuItemVisible, styleMenuLabel } from './style-menu'
import { allowFeatureNavigation, featureGateVisibility, usePreparingDialog } from './sidebar-feature-gate'
import { SIDEBAR_TOGGLE_EVENT,UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import {
FEATURE_SETTINGS_UPDATED_EVENT,
SIDEBAR_FEATURE_BY_HREF,
SPECIALIZED_FEATURE_KEYS,
} from '@/lib/feature-settings'
import { HQ_MENU_SECTIONS,isHqShellPath,menuOwnerForScreen,orderedMenuSections,restaurantMenuSections,type MenuItem,type MenuSection } from '@/lib/menu'
import { useStaffRole, canManageRole, canAdministerRole } from '@/lib/staff-role'
import { useBrand } from '@/lib/use-brand'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect,useLayoutEffect,useRef,useState } from 'react'
import { brandInitial } from './brand-initial'
import SidebarIdentity from './sidebar-identity'
import { isBooleanRecord,watchNavOverflow } from './sidebar-nav-overflow'
import SidebarVersion from './sidebar-version'
import styles from './sidebar.module.css'
import { SIDEBAR_AUTO_COLLAPSE_BELOW } from './sidebar-collapse'

function NavIcon({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className ?? "h-[18px] w-[18px]"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={d} />
    </svg>
  )
}

/* SSR では useLayoutEffect が警告になるので、描き込み前に畳み状態を
   反映するため同型のエイリアスを使う（描画後の1回分のズレを防ぐ）。 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** ★V8（夕44-A）：はじめから開く4組。ほかは見出しだけで畳む。 */
const V8_GROUPS_OPEN_BY_DEFAULT = new Set(['favorites', 'basic', 'restaurant-booking', 'restaurant-operations', 'delivery', 'contents', 'booking', 'hq'])

/** 統括の左メニューの組の見出し。 */
const HQ_V8_SECTION_LABEL = '統括'

/** ★V8 統括の左下「統括の設定」が選ばれた形になる画面（統括の設定の中のメニューの4つ）。 */
const HQ_SETTINGS_PATHS = ['/hq/settings', '/hq/members', '/hq/billing', '/hq/support']

/** 組の開閉を覚えるキー（ブラウザごと）。 */
const SIDEBAR_GROUPS_KEY = 'lh-sidebar-groups'

/*
 * PERF-08: バッジ件数をアカウント単位で共有する直近値。
 * 切替・再マウントで 0 へちらつかせず、表示は直近値で復帰させてから
 * 裏で取り直す。値は表示専用で、正本は常にAPIの応答。
 */
interface SidebarCounts {
  unanswered: number
  photos: number
  operations: number
}
const sidebarCountCache = new Map<string, SidebarCounts>()

/** テスト用: 共有している直近値を捨てる。 */
export function clearSidebarCountCache(): void {
  sidebarCountCache.clear()
}

/** 統括の左メニューを出す住所。決め方は上の帯と同じものを使う（`@/lib/menu`）。 */
export { isHqShellPath }

export default function Sidebar({
  friendAttributesV2Mode = false,
  preview = false,
}: {
  friendAttributesV2Mode?: boolean
  preview?: boolean
} = {}) {
  const pathname = usePathname()
  /*
   * 統括の左メニューは住所が /hq のときに出す。LINEアカウントの登録（/accounts/new）は
   * 統括の「アカウント」から開く統括の画面なので、統括のメニューのままにする。
   */
  const isHq = isHqShellPath(pathname)
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const accountStyle = useAccountStyle(isHq ? null : selectedAccountId)
  const brand = useBrand()
  /*
   * モバイルの固定ヘッダーに出す現在地（U037）。
   * PC の上部バーと同じ「ページが渡した名前 → メニューの名前 → アカウント名」。
   * PageChromeProvider の外（/visual-qa など）では null が返るだけで落ちない。
   */
  const { title: chromeTitle } = usePageChrome()
  const mobileTitle = chromeTitle ?? defaultTitleForPath(pathname ?? '')
  const [isOpen, setIsOpen] = useState(false)
  const preparing = usePreparingDialog()
  /* 保存済みの組の開閉は、サーバーと最初の描画をそろえてから適用する。 */

  /*
   * V2 のタグモード（移行中だけの特別な形）で組を丸ごと隠すのは
   * V8 では真似しない（MIGRATION-RISKS §1-2）。V8 では組の見出しは常に出て、
   * 中身の開閉だけが変わる。
   */

  /*
   * ★V8（夕44-A）：メイン・配信・コンテンツ・予約は開いた形、それ以外は
   * 見出しだけで畳む。押すと開き、開いた状態はブラウザが覚える
   * （lh-sidebar-groups）。いまの画面の組は常に開く。
   */
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({})
  useIsoLayoutEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_GROUPS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as unknown
        if (isBooleanRecord(parsed)) setGroupOpen(parsed)
      }
    } catch {
      // localStorage が使えないときは既定の開閉だけで動かす
    }
  }, [])
  const groupOpenByDefault = (section: MenuSection) =>
    V8_GROUPS_OPEN_BY_DEFAULT.has(section.id)
  const groupIsOpen = (section: MenuSection) =>
    groupOpen[section.id] ?? groupOpenByDefault(section)
  const toggleGroup = (section: MenuSection) => {
    setGroupOpen((current) => {
      const next = { ...current, [section.id]: !(current[section.id] ?? groupOpenByDefault(section)) }
      try {
        window.localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(next))
      } catch {
        // 覚えられなくても開閉自体は動かす
      }
      return next
    })
  }

  /*
   * ★V8 外側：左メニューの畳み（幅 64・アイコンだけ）。
   * 上の帯のボタンと ⌘\ が SIDEBAR_TOGGLE_EVENT を投げ、ここで受ける。
   * 状態はブラウザに覚える（lh-sidebar-collapsed）。保存がなければ
   * 1024px 以下では畳んだ形で開く。保存済みの状態があればそちらを優先する。
   */
  const [collapsed, setCollapsed] = useState(false)
  /* 畳んだ時、アイコンに乗せた・フォーカスした項目の名前を右の吹き出しに出す。メニューは縦に送れるので中に描くと切れる。画面に固定して出す。 */
  const [railTip, setRailTip] = useState<{ label: string; count: string; top: number } | null>(null)
  const collapsedInitRef = useRef(false)
  useIsoLayoutEffect(() => {
    if (collapsedInitRef.current) return
    collapsedInitRef.current = true
    try {
      const saved = window.localStorage.getItem('lh-sidebar-collapsed')
      if (saved !== null) {
        setCollapsed(saved === '1')
      } else {
        setCollapsed(window.innerWidth < SIDEBAR_AUTO_COLLAPSE_BELOW)
      }
    } catch {
      // localStorage が使えないときは展開のまま
    }
  }, [])
  useEffect(() => {
    const toggle = () => {
      /* 上の帯とショートカットの同じ操作で開閉する。 */
      setCollapsed((current) => {
        const next = !current
        try {
          window.localStorage.setItem('lh-sidebar-collapsed', next ? '1' : '0')
        } catch {
          // 覚えられなくても畳み自体は動かす
        }
        return next
      })
    }
    /*
     * ⌘\ / Ctrl+\ の受け口は TopBar の keydown が投げる
     * SIDEBAR_TOGGLE_EVENT に一本化する。ここでも keydown を受けると
     * 同じ押下で2回畳みが走り、開閉が元に戻る(V8-1085-KEYBOARD-01)。
     */
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, toggle)
    return () => {
      window.removeEventListener(SIDEBAR_TOGGLE_EVENT, toggle)
    }
  }, [])

  const [staffName, setStaffName] = useState<string | null>(null)
  const staffRole = useStaffRole()
  const staffIdentity = readStaffIdentity()
  const staffReadRole = staffIdentity?.role ?? staffRole
  const [staffPermissions, setStaffPermissions] = useState<string[]>([])
  const [staffViewPermissions, setStaffViewPermissions] = useState<string[]>([])

  useEffect(() => {
    setStaffName(localStorage.getItem('lh_staff_name'))
    try { setStaffPermissions(JSON.parse(localStorage.getItem('lh_staff_permissions') || '[]')) } catch { setStaffPermissions([]) }
    try { setStaffViewPermissions(JSON.parse(localStorage.getItem('lh_staff_view_permissions') || '[]')) } catch { setStaffViewPermissions([]) }
  }, [])

  // 未対応件数 polling — メニュー項目にバッジを出す。5 分間隔。
  // (裏の countUnanswered は messages_log 全走査を含む重い集計なので間隔は詰めない。)
  // チャット画面での status 変更・手動返信直後は UNANSWERED_REFRESH_EVENT で
  // 即時再取得する (ポーリング待ちだと操作してもバッジが減らないと感じるため)。
  const [unansweredCount, setUnansweredCount] = useState<number>(0)
  const [pendingPhotoCount, setPendingPhotoCount] = useState<number>(0)
  const [operationIssueCount, setOperationIssueCount] = useState<number>(0)
  // 仕様 §5 の「EC連携＝未突合の会員数」は、それを返すAPIがまだ無い。
  // overview が持つのは failed / skipped で、意味が違う。取り違えて
  // 別の数を出すより、出さないほうがよい。API ができたらここを繋ぐ。
  const unmatchedCount = 0

  // 並び順の設定。account_settings の 'sidebar.order' に、セクションの
  // ラベルを並べて持つ。設定が無ければ MENU_SECTIONS のままの順で出す。
  //
  // 知らないラベルは無視し、設定に無いセクションは後ろに残す。こうしないと、
  // 機能が増えたときに新しいセクションが消えてしまう。
  const [sectionOrder, setSectionOrder] = useState<string[] | null>(null)
  /** 区分の中の項目の並び。機能設定の↑↓で決めたもの。 */
  const [itemOrder, setItemOrder] = useState<Record<string, string[]> | null>(null)
  const [favoriteItemIds, setFavoriteItemIds] = useState<string[]>([])
  const [restaurantHiddenItemIds, setRestaurantHiddenItemIds] = useState<string[]>([])
  const [featureVisibility, setFeatureVisibility] = useState<Record<string, boolean> | null>(null)
  /** 成功した可視性read-modelのaccount。切替直後に古い表示を使わない。 */
  const [visibilityAccountId, setVisibilityAccountId] = useState<string | null>(null)
  const [visibilityStatus, setVisibilityStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [visibilityRetry, setVisibilityRetry] = useState(0)
  const [specializedFeatureKeys, setSpecializedFeatureKeys] = useState<string[]>([])
  const [explicitSettings, setExplicitSettings] = useState<{ accountId: string; value: boolean | null } | null>(null)
  const [currentSearch, setCurrentSearch] = useState('')

  // 同じ画面の別タブをメニューへ出す項目（コンバージョン、データ移行）が
  // あるため、pathnameだけでなくクエリも選択状態へ反映する。
  useEffect(() => {
    const sync = () => setCurrentSearch(window.location.search)
    sync()
    window.addEventListener('popstate', sync)
    /*
     * router.push/replace は popstate を出さない（popstate は戻る/進む専用）。
     * 同じパスでクエリだけ変わる画面（/accounts → /accounts?tab=migration の
     * UID移行など）でも所属の選択を即時に切り替えられるよう、history の
     * 2関数だけを薄く包んで再読する。掃除のときは必ず元へ戻す。
     */
    const originalPushState = history.pushState
    const originalReplaceState = history.replaceState
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args)
      sync()
      return result
    }
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args)
      sync()
      return result
    }
    return () => {
      window.removeEventListener('popstate', sync)
      history.pushState = originalPushState
      history.replaceState = originalReplaceState
    }
  }, [pathname])

  // 表示可否は全roleがstaff向けread-modelから読む。未確認/失敗を「表示可」と
  // みなすと別accountの任意機能を一瞬見せるので、必須ナビ以外はfail-closedにする。
  // owner/admin表示のときだけ、管理GETから保存済みの並びを追加で読む。
  useEffect(() => {
    if (!selectedAccountId) {
      setSectionOrder(null)
      setItemOrder(null)
      setFavoriteItemIds([])
      setRestaurantHiddenItemIds([])
      setFeatureVisibility(null)
      setVisibilityAccountId(null)
      setVisibilityStatus('ready')
      setSpecializedFeatureKeys([])
      return
    }
    let cancelled = false
    const accountId = selectedAccountId
    const canManageFeatureSettings = canManageRole(staffRole)
    setFeatureVisibility(null)
    setFavoriteItemIds([])
    setRestaurantHiddenItemIds([])
    setExplicitSettings(null)
    setVisibilityAccountId(null)
    setVisibilityStatus('loading')
    const loadSettings = () => {
      void Promise.all([import('@/lib/feature-visibility-cache'), import('@/lib/feature-settings-cache')])
        .then(async ([{ loadFeatureVisibility }, { loadFeatureSettings }]) => {
          // 画面側の useFeatureVisibility と同じ答えを共有する（V6R-S0-b）。
          const visibilityRequest = loadFeatureVisibility(accountId)
          // 並びは表示可否の結果を使わない。確認済み管理者だけ並行して読み、失敗は先に受け止める。
          const settingsRequest = canManageFeatureSettings ? loadFeatureSettings(accountId).catch(() => null) : null
          const visibility = await visibilityRequest
          const features = visibility.success ? visibility.data?.features : undefined
          if (!cancelled && isBooleanRecord(features)) {
            setSectionOrder(null)
            setItemOrder(null)
            setFeatureVisibility(features)
            setFavoriteItemIds(visibility.success ? visibility.data.favoriteItemIds ?? [] : [])
            setRestaurantHiddenItemIds(visibility.success ? visibility.data.restaurantHiddenItemIds ?? [] : [])
            setVisibilityAccountId(accountId)
            setVisibilityStatus('ready')
            setSpecializedFeatureKeys(SPECIALIZED_FEATURE_KEYS)
            if (visibility.success && 'version' in visibility.data && typeof visibility.data.version === 'number') setExplicitSettings({ accountId, value: visibility.data.version > 0 })
          } else if (!cancelled) {
            setVisibilityStatus('error')
          }
          if (!canManageFeatureSettings) return
          try {
            // 機能設定画面と同じ答えを共有する。保存の合図で捨てられる。
            const settings = await settingsRequest
            if (!cancelled && settings?.success) {
              setExplicitSettings({ accountId, value: settings.data.version > 0 })
              setSectionOrder(settings.data.sidebarOrder)
              setItemOrder(settings.data.sidebarItemOrder)
            } else if (!cancelled) { setExplicitSettings({ accountId, value: null }) }
          } catch {
            // 権限降格後など管理GETが拒否されても、最小read-modelの表示可否は残す。
            if (!cancelled) setExplicitSettings({ accountId, value: null })
          }
        })
        .catch(() => {
          if (!cancelled) setVisibilityStatus('error')
        })
    }
    loadSettings()
    const onSettingsUpdated = (event: Event) => {
      const accountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId
      if (!accountId || accountId === selectedAccountId) setVisibilityRetry((current) => current + 1)
    }
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      cancelled = true
      window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [selectedAccountId, staffRole, visibilityRetry])
  // 区分の中の並びを当ててから、区分そのものの並びを当てる。
  const currentVisibility = visibilityAccountId === selectedAccountId ? featureVisibility : null
  const restaurantStyle = accountStyle.status === 'ready' && accountStyle.data?.style === 'restaurant'
  const storeSections = restaurantStyle
    ? restaurantMenuSections(orderedMenuSections(null), itemOrder)
    : orderedMenuSections(itemOrder)
  const normalizedSectionOrder = sectionOrder?.map((label) => label === 'NEN運用' ? '専用機能' : label)
  const orderedStoreSections = normalizedSectionOrder
    ? [
        ...normalizedSectionOrder
          .map((label) => storeSections.find((s) => (s.label ?? '') === label))
          .filter((s): s is (typeof storeSections)[number] => Boolean(s)),
        ...storeSections.filter((s) => !normalizedSectionOrder.includes(s.label ?? '')),
      ]
    : storeSections
  const sections = isHq ? HQ_MENU_SECTIONS : orderedStoreSections.map(section => ({ ...section, items: section.items.filter(item => item.id !== 'conversions') }))

  const freshSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        /*
         * ★管理画面 C6: 統括のひな形配布（4画面）は Worker の受け口が無いあいだ
         * 「利用できません」だけのページになるため、サイドバーには出さない。
         * ページ自体は残し、配布が有効になれば再表示する。
         * ★V8 は4画面とも中身を出す（app/hq/hq-template-page.tsx と同じ条件）ので、
         * 左メニューにも出す（統括の6項目）。互換経路は今までどおり。
         */

        if (isHq) return true
        if (restaurantStyle && restaurantHiddenItemIds.includes(item.id)) return false
        const savedSettings = explicitSettings?.accountId === selectedAccountId ? explicitSettings.value : canManageRole(staffRole) ? false : null
        if (!styleMenuItemVisible(item, accountStyle.data?.style ?? null, savedSettings, accountStyle.data?.styleSelected === true)) return false
        // 移行中のV2画面では、承認画像どおり「タグ」を1行だけ出す。
        // 現行 /tags 自体は消さず、通常画面のメニューにはそのまま残す。

        if (item.href === '/staff' && !canAdministerRole(staffReadRole)) return false
        // N-411: staff 専用項目（自分の勤務）は owner/admin には出さない。
        if (item.staffOnly && staffReadRole !== 'staff') return false
        // 失敗時にも必須ナビは残す。任意機能だけを権限・可視性で絞る。
        // 変えられる権限でも見えるだけ権限でも、メニューには出す（N-424）。
        const permissionKey = item.permissionKey ?? item.href
        if (staffReadRole === 'staff' && !canManageRole(staffReadRole) && !item.required && !staffPermissions.includes(permissionKey) && !staffViewPermissions.includes(permissionKey)) return false
        const gated = featureGateVisibility(item); if (gated !== undefined) return gated
        const featureKey = SIDEBAR_FEATURE_BY_HREF[item.href]
        if (!featureKey) return true
        if (!currentVisibility || currentVisibility[featureKey] !== true) return false
        if (section.id === 'specialized' && featureKey === 'ec_commerce' && currentVisibility.specialized_ec_commerce !== true) return false
        if (SPECIALIZED_FEATURE_KEYS.includes(featureKey) && !specializedFeatureKeys.includes(featureKey)) return false
        return true
      }).map(item => isHq ? item : { ...item, label: styleMenuLabel(item, accountStyle.data?.style ?? null) }),
    }))
    .filter((section) => section.items.length > 0)
    /*
     * 機能の見え方を読み込んでいる間は、最初の区分だけ出す（動きの点検 8・11 番）。
     * 以前は機能に縛られない「設定」だけが先に出て、読み込み後にその上へ区分が
     * 差し込まれ、「設定」が 250px 押し下げられていた（全画面で CLS の主な元）。
     * 後ろに足すだけにすれば、出ている物は動かない。
     */
    .filter((_section, index) => isHq || currentVisibility !== null || visibilityStatus !== 'loading' || (!selectedAccountId && !accountLoading) || index === 0)

  const favoriteIds = restaurantStyle ? new Set(favoriteItemIds) : new Set<string>()
  const favoriteItems = freshSections.flatMap((section) => section.items.filter((item) => favoriteIds.has(item.id)))
  const displayedSections = favoriteItems.length === 0 ? freshSections : [
    { id: 'favorites', label: 'お気に入り', title: 'お気に入り', items: favoriteItems },
    ...freshSections,
  ]

  const menuLoading = !isHq && (visibilityStatus === 'loading' || accountStyle.status === 'loading')
  const visibleSections = useRememberedSidebar(displayedSections, sections, selectedAccountId, menuLoading,
    !isHq && visibilityStatus === 'ready' && accountStyle.status === 'ready')

  /*
   * PERF-08: バッジ用の件数は「出す項目があるもの」だけを購読する。
   *
   * 写真審査（nenMembers.overview）は、写真バッジの項目がメニューに無い
   * 環境（機能OFF・権限なし）でも毎サイクル呼ばれて 403 を繰り返していた。
   * メニューに写真バッジが無いなら呼ばない。未対応・運用警告は必須購読で、
   * 写真審査は別の購読に分け、成功した分から先に反映する。
   *
   * アカウント切替や再マウントで 0 に戻ると数字がちらつくので、
   * アカウントごとの直近値をモジュールに共有しておき、表示はそれで
   * 即復帰させてから裏で取り直す。
   */
  /* 統括の「対応が要るもの」の札。全アカウントの件数の合計。読めないときは出さない。 */
  const [hqAttentionCount, setHqAttentionCount] = useState(0)
  useEffect(() => {
    if (!isHq) return
    let cancelled = false
    const load = async () => {
      try {
        const { hqStyleApi } = await import('@/lib/api/helpers/styles')
        const res = await hqStyleApi.attention()
        if (cancelled || !res.success) return
        setHqAttentionCount(res.data.items.reduce((sum, item) => sum + Object.values(item.counts as Record<string, number>).reduce<number>((a, b) => a + (b ?? 0), 0), 0))
      } catch {
        // 口がまだ無い・読めない：札を出さない
      }
    }
    void load()
    const id = setInterval(load, 5 * 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [isHq])

  const photosBadgeVisible = visibleSections.some(
    (section) => section.items.some((item) => item.badge === 'photos'),
  )

  useEffect(() => {
    if (!selectedAccountId) {
      setUnansweredCount(0)
      setOperationIssueCount(0)
      return
    }
    const accountId = selectedAccountId
    const cached = sidebarCountCache.get(accountId)
    setUnansweredCount(cached?.unanswered ?? 0)
    setOperationIssueCount(cached?.operations ?? 0)
    let cancelled = false
    // 連続操作で fetch が並走した際、遅い古いレスポンスが新しい値を上書きしない
    // ように発行順 seq でガードする。
    let seq = 0
    const fetchCount = async () => {
      const mySeq = ++seq
      try {
        const { api } = await import('@/lib/api')
        // 運用警告は要約APIを1回だけ呼ぶ。件数分の個別取得は呼ばない(#630)。
        // ログ本文は要らない(警告数だけ)。staff に見える分だけが返る。
        const [unanswered, summary] = await Promise.allSettled([
          api.inbox.unanswered.count(),
          api.health.summary(),
        ])
        if (cancelled || mySeq !== seq) return
        const entry = sidebarCountCache.get(accountId) ?? { unanswered: 0, photos: 0, operations: 0 }
        if (unanswered.status === 'fulfilled' && unanswered.value.success) {
          // count API の total は閲覧可能な全アカウントの合計。
          // 店舗メニューには、今選んでいるLINEアカウントの件数だけを出す。
          const accountCount = unanswered.value.data.byAccount.find((item) => item.accountId === accountId)?.count ?? 0
          setUnansweredCount(accountCount)
          entry.unanswered = accountCount
        }
        if (summary.status === 'fulfilled' && summary.value.success) {
          const total = summary.value.data.warningCount + summary.value.data.dangerCount
          setOperationIssueCount(total)
          entry.operations = total
        }
        sidebarCountCache.set(accountId, entry)
      } catch {
        // サイレント失敗
      }
    }
    fetchCount()
    const id = setInterval(fetchCount, 5 * 60_000)
    const onRefresh = () => { void fetchCount() }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener(UNANSWERED_REFRESH_EVENT, onRefresh)
    }
  }, [selectedAccountId])

  // 写真審査の件数は、写真バッジがメニューに出ているときだけ購読する。
  // 別購読なので、権限・機能で項目が無い環境では 1回も呼ばれない。
  useEffect(() => {
    if (!selectedAccountId || !photosBadgeVisible) {
      setPendingPhotoCount(0)
      return
    }
    const accountId = selectedAccountId
    const cached = sidebarCountCache.get(accountId)
    setPendingPhotoCount(cached?.photos ?? 0)
    let cancelled = false
    let seq = 0
    const fetchPhotos = async () => {
      const mySeq = ++seq
      try {
        const { api } = await import('@/lib/api')
        const nen = await api.nenMembers.overview()
        if (cancelled || mySeq !== seq) return
        if (nen.success) {
          setPendingPhotoCount(nen.data.pendingPhotos)
          const entry = sidebarCountCache.get(accountId) ?? { unanswered: 0, photos: 0, operations: 0 }
          entry.photos = nen.data.pendingPhotos
          sidebarCountCache.set(accountId, entry)
        }
      } catch {
        // サイレント失敗
      }
    }
    fetchPhotos()
    const id = setInterval(fetchPhotos, 5 * 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedAccountId, photosBadgeVisible])

  useEffect(() => { setIsOpen(false) }, [pathname])
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  /*
   * スマホのメニューの焦点（★管理画面 修正方針 §2）。
   * 開いたら中の先頭へ、Esc で閉じ、閉じたら焦点をハンバーガーへ戻す。
   * 閉じている間は aside に inert を付け、画面外の項目へ Tab が行かないようにする
   * （以前は閉じても11項目が Tab で選べ、焦点が見えない所へ行っていた）。
   */
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const desktopRef = useRef<HTMLElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true
      drawerRef.current?.querySelector<HTMLElement>('a[href], button')?.focus()
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setIsOpen(false)
      }
      document.addEventListener('keydown', onKeyDown)
      return () => document.removeEventListener('keydown', onKeyDown)
    }
    if (wasOpen.current) {
      wasOpen.current = false
      if (!document.activeElement || document.activeElement === document.body || drawerRef.current?.contains(document.activeElement)) {
        menuButtonRef.current?.focus()
      }
    }
  }, [isOpen])

  /**
   * 項目に出す数。0 のときは出さない（仕様 §5）。
   *
   * どの項目に何を出すかは MENU_SECTIONS の `badge` が決める。
   * ここで href を見て分岐すると、行き先を変えたときにバッジだけ
   * 取り残される。
   */
  const badgeCount = (item: MenuItem) => {
    if (item.badge === 'hq-attention') return hqAttentionCount
    if (item.badge === 'unanswered') return unansweredCount
    if (item.badge === 'photos') return pendingPhotoCount
    if (item.badge === 'unmatched') return unmatchedCount
    if (item.badge === 'operations') return operationIssueCount
    return 0
  }

  /**
   * いまの画面が、この項目のものか。
   *
   * 仕様 §4「子画面は親の項目を選択状態にする」。
   * /events/bookings を開いたら「イベント予約」が選ばれていてほしい。
   *
   * ダッシュボードだけ完全一致にする。'/' は全部の前方一致に当たるため。
   * クエリ付きの行き先はパスだけで判定する。?tab= が変わっても
   * 同じ画面にいることに変わりはない。
   */
  /*
   * 前方一致だと、片方が他方の下にある2項目で両方が光る。
   * 「共通情報」(/contents/vars) を開くと「登録メディア一覧」(/contents) も
   * 選ばれて見えていた。当たるもののうち、いちばん長いものだけを選ぶ。
   */
  const activePathname = pathname
  const activeHref = (() => {
    let best: string | null = null
    for (const section of sections) {
      for (const item of section.items) {
        if (item.href === '/') continue
        // 統括の「店舗管理」(/hq) も完全一致にする。/hq/banners や /hq/members を
        // 開いたときに店舗管理が光ってしまうため。
        if (item.href === '/hq') {
          // 統括から開く LINEアカウントの登録（/accounts/new）も「アカウント」の中（パンくず）。
          if (activePathname === '/hq' || activePathname === '/accounts/new') best = '/hq'
          continue
        }
        const path = item.href.split('?')[0]
        if (activePathname !== path && !activePathname.startsWith(path + '/')) continue
        if (best === null || path.length > best.length) best = path
      }
    }
    return best
  })()

  /*
   * #984 LAY-15: URLの置き場とメニュー上の所属が違う画面は、
   * `SCREEN_MENU_OWNER`（lib/menu.ts が正本）が選ぶ項目を光らせる。
   * UID移行 `/accounts?tab=migration` は友だちタブの1枚なので、
   * 「LINEアカウント」ではなく「友だち」が選ばれる。
   * 宣言先の項目がメニューに無いときは通常のパス一致へ戻す。
   *
   * Issue #708: 宣言が複数候補を持つ画面（受付枠など）では、
   * いまの人に見えている項目のうち最初のものを選ぶ。見えている
   * 項目だけを対象にするのは、担当者専用項目（自分の勤務）が
   * 管理者のメニューには無いため。
   */
  const ownerItemId = menuOwnerForScreen(activePathname, currentSearch)
    ?.find((id) => visibleSections.some((section) => section.items.some((item) => item.id === id)))
  const hasOwnerItem = Boolean(ownerItemId)

  const isActive = (item: MenuItem) => {
    const href = item.href
    if (item.id === 'affiliates' && (activePathname === '/conversions' || activePathname.startsWith('/conversions/'))) return true
    if (hasOwnerItem) return item.id === ownerItemId
    if (href === '/') return activePathname === '/'
    const [path, query = ''] = href.split('?')
    if (path !== activeHref) return false

    const siblingQueries = sections
      .flatMap((section) => section.items)
      .filter((item) => item.href.split('?')[0] === path && item.href.includes('?'))
      .map((item) => item.href.split('?')[1])
    if (query) return currentSearch === `?${query}`
    return !siblingQueries.some((siblingQuery) => currentSearch === `?${siblingQuery}`)
  }

  /*
   * ★V8（夕41）：左メニューのいちばん下の「設定」（歯車）は、設定の組の
   * どこかの画面を開いているとき選ばれた形にする。
   */
  const hqSettingsActive = HQ_SETTINGS_PATHS.some((path) => activePathname === path || activePathname.startsWith(`${path}/`))
  const settingsActive = (
    activePathname === '/settings/customer-look'
    || activePathname.startsWith('/settings/customer-look/')
    || Boolean(sections.find((section) => section.id === 'settings')?.items.some((item) => isActive(item)))
  )

  /*
   * いまの画面の項目を、左メニューを開いたときに必ず全部見える位置へ巻く（2026-10-15 判定役）。
   * 項目が多いと、下の方の項目（NEN配信など）が巻く領域の下端で半分切れ、
   * 下に固定した「設定」の帯の陰に隠れて見えなかった。組を開く動き（--motion-base）が
   * 終わってからもう一度測り、領域の中だけを巻く（ページ全体は巻かない）。
   */
  const activeItemKey = visibleSections
    .flatMap((section) => section.items)
    .find((item) => isActive(item))?.id ?? ''
  // 機能の表示可否を読み終えて項目が増減したときも測り直す。
  const visibleItemCount = visibleSections.reduce((sum, section) => sum + section.items.length, 0)
  useEffect(() => {
    if (!activeItemKey) return
    const reveal = () => {
      for (const root of [desktopRef.current, drawerRef.current]) {
        const nav = root?.querySelector<HTMLElement>('[data-sidebar-scroll]')
        const item = nav?.querySelector<HTMLElement>('[data-nav-active]')
        if (nav && item) revealInScroller(nav, item, 8, item.closest<HTMLElement>(`.${styles.section}`))
      }
    }
    const frame = requestAnimationFrame(reveal)
    const timer = window.setTimeout(reveal, 320)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [activeItemKey, isOpen, visibleItemCount])

  /**
   * 中身は1つ。ドロワーでも常時表示でも同じものを出す。
   *
   * 幅で文字を出し分けていたのは 64px のアイコンレールがあったから。
   * レールをやめたので、出し分けも要らない。
   *
   * @param drawer ドロワーとして開いているか。先頭に共通ロゴを置く。
   */
  const showRailTip = (target: EventTarget) => {
    if (!collapsed || !(target instanceof Element)) return
    const item = target.closest<HTMLElement>('[data-rail-label]')
    if (!item) { setRailTip(null); return }
    const box = item.getBoundingClientRect()
    setRailTip({ label: item.dataset.railLabel ?? '', count: item.dataset.railCount ?? '', top: box.top + box.height / 2 })
  }

  const sidebarContent = (drawer: boolean) => (
    <>
      {drawer ? (
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-hairline px-4 pr-16">
          <SidebarIdentity compact />
        </div>
      ) : (
        null
      )}

      {drawer ? null : isHq ? (
        <>
          {/* 店舗と同じ共通ロゴ。統括名は上の切替表示に置く。 */}
          <div><SidebarIdentity /></div>
        </>
      ) : preview ? (
        <div className={`px-[12px] pb-[8px] pt-[16px] ${styles.collapseHide}`}>
          <p className="mb-[10px] text-caption font-normal text-ink-faint">現在のLINEアカウント</p>
          <div className="flex h-[66px] items-center rounded-card border border-hairline bg-canvas px-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-body font-semibold text-accent-deep">サ</div>
            <div className="ml-3 min-w-0 flex-1">
              {/* デザイン確認用の見本。特定の利用者の名前は書かない。 */}
              <p className="truncate text-body font-semibold text-ink">サンプルアカウント</p>
              <p className="mt-0.5 truncate text-micro text-ink-faint">コミュニケーション</p>
            </div>
          </div>
        </div>
      ) : <SidebarIdentity />}

      {/* ロゴとメニューの間の線。Pencil `J33xq/pN2aM`。 */}
      <div className={styles.identityRule} />

      {/* ナビゲーション */}
      <nav aria-busy={menuLoading || undefined} ref={watchNavOverflow} className={`${styles.nav} ${preview ? 'overflow-hidden' : ''}`} data-design-node="J33xq" data-sidebar-scroll="">
        {/*
          ★V7 `x63W5x`：補助のデータ（表示可否）の失敗は、その場所の
          小さい1行で伝える。全文の「もう一度読み込む」は一覧本体の
          失敗の1枚が使う言葉なので、ここは短い「もう一度」にして
          1画面に同じ読み直しボタンを2つ出さない。
        */}
        {(visibilityStatus === 'error' || accountStyle.error) && selectedAccountId && (
          <Notice
            tone="warn"
            className="mx-3 mb-2"
            action={(
              <SharedButton variant="text" size="inline" data-notice-inline-action
                type="button"
                onClick={() => { setVisibilityRetry((current) => current + 1); accountStyle.reload() }}
              >
                もう一度
              </SharedButton>
            )}
          >
            {accountStyle.error ? '使い方のスタイルを読み込めませんでした。' : '機能設定を読み込めませんでした。'}
          </Notice>
        )}
        {/* 前に読めたスタイルで出している時の 1 行。本文が同じ 1 行を出す画面（ホーム・予約台帳など）では出さない。 */}
        {accountStyle.stale && selectedAccountId ? <ShellStaleStyleNotice className="mx-3 mb-2" onRetry={accountStyle.reload} /> : null}
        {/* B-261: 設定の入口は下の歯車。定義と現在地の判定は残す。 */}
        {visibleSections.filter((section) => isHq || section.id !== 'settings').map((section) => {
          /*
           * ★V8（夕44-A）：組の見出しは押せる開閉。畳んだ組は見出しだけ
           * 残るので、組が丸ごと消えることはない。見出しの無い組（統括）は
           * 畳めない。いまいる画面の組は常に開く。アイコンだけの帯では
           * 見出し自体が無いので、畳みは効かせず全部のアイコンを出す。
           */
          const sectionLabel = section.label ?? (isHq ? HQ_V8_SECTION_LABEL : null)
          const collapsible = Boolean(sectionLabel)
          const sectionOpen =
            !collapsible || groupIsOpen(section) || section.items.some((item) => isActive(item))
          /*
           * 開閉で高さを滑らかに変える（触り心地 5 回目）。畳める組は項目を消さずに包みへ入れ、
           * 畳んだら高さ 0・押せない・読み上げない。動きを減らす設定では一瞬で開閉する。
           */
          const animatedGroup = collapsible && !(collapsed && !drawer)
          return (
          <div key={section.id} className={styles.section}>
            {sectionLabel && (
              (
                <button
                  type="button"
                  className={styles.sectionToggle}
                  onClick={() => toggleGroup(section)}
                  aria-expanded={sectionOpen}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{sectionLabel}</span>
                  <svg
                    className={`${styles.sectionChevron} ${sectionOpen ? '' : styles.sectionChevronClosed}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )
            )}
            {(() => {
              const links = section.items.map((item) => {
              const active = isActive(item)
              const isDanger = 'danger' in item && item.danger
              const visibleLabel = item.label
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  // V8は多数の別画面を先読みせず、選んだ画面だけ読み込む。
                  prefetch={false}
                  onClick={(event) => {
                    if (item.id === 'restaurant-delivery' && !restaurantTestUiEnabled()) { event.preventDefault(); return }
                    if (allowFeatureNavigation(event, item.href, item.label, preparing)) setCurrentSearch(item.href.includes('?') ? `?${item.href.split('?')[1]}` : '')
                  }}
                  title={collapsed && !drawer ? undefined : visibleLabel}
                  // 件数の札がある時は「名前、N件」と区切って読ませる（札の数字は読ませない）。
                  aria-label={badgeCount(item) > 0 ? `${visibleLabel}、${badgeCount(item)}件` : collapsed && !drawer ? visibleLabel : undefined}
                  data-rail-label={visibleLabel}
                  data-rail-count={badgeCount(item) > 0 ? (badgeCount(item) > 99 ? '99+' : String(badgeCount(item))) : undefined}
                  aria-current={active ? 'page' : undefined}
                  data-nav-active={active ? '' : undefined}
                  /*
                    いま開いている項目は、薄い緑の地に濃い緑の文字。設計も
                    この形。緑で塗りつぶして白抜きにすると、色の面積が大きく
                    なって一覧の中でそこだけ浮き、目が先にそこへ行く。
                    印は「いまここ」を示せれば足りる。
                  */
                  className={`${styles.item} ${item.id === 'restaurant-delivery' ? styles.deliveryItem : ''} ${
                    active
                      ? isDanger
                        ? `${styles.active} ${styles.danger}`
                        : styles.active
                      : isDanger
                        ? styles.danger
                        : ''
                  }`}
                >
                  <span className="shrink-0">{(() => {
                    const V8Icon = V8_NAV_ICONS[item.id]
                    return V8Icon ? <V8Icon className={styles.v8NavIcon} aria-hidden="true" /> : <NavIcon className={styles.v8NavIcon} d={item.iconV8 ? item.iconV8 : item.icon} />
                  })()}</span>
                  <span className={`${styles.itemLabel} min-w-0 flex-1 truncate`}>{visibleLabel}</span>
                  {item.id === 'restaurant-delivery' && <span className={styles.comingSoon}>Coming soon</span>}
                  {badgeCount(item) > 0 && (
                    <>
                      {/* レール幅では数字が入らないので点だけ。件数は名前と一緒に出す。 */}
                      {/* 地が薄い緑になったので、選ばれていても札の色は変えない。
                          緑ベタの上に置いていたころは白抜きにする必要があった。 */}
                      <span className={styles.badge} aria-hidden="true">
                        {badgeCount(item) > 99 ? '99+' : badgeCount(item)}
                      </span>
                    </>
                  )}
                </Link>
              )
            })
              if (!animatedGroup) return links
              return (
                <div
                  className={`${styles.sectionItems} ${sectionOpen ? '' : styles.sectionItemsClosed}`}
                  inert={!sectionOpen}
                  aria-hidden={sectionOpen ? undefined : true}
                  data-group-open={sectionOpen ? 'true' : 'false'}
                >
                  <div className={styles.sectionItemsInner}>{links}</div>
                </div>
              )
            })()}
          </div>
          )
        })}
      </nav>

      {/*
        ★V8（夕41・部品 njl8e）：左メニューのいちばん下、版の上に「設定」。
        オーナー・管理者にだけ出す（閲覧専用のオーナー・管理者にも出す。設定は見るだけで開ける）。
        設定の画面ではここが選ばれた形にする。
        nav は中身が多いときだけ縦に送り、この入口と版は下端に固定される。
      */}
      {!isHq && !preview && (canManageRole(staffReadRole)) && (
        <div className={styles.settingsEntry}>
          <Link
            href="/settings/customer-look"
            prefetch={false}
            title={collapsed ? undefined : "設定"}
            aria-label={collapsed ? "設定" : undefined}
            data-rail-label="設定"
            aria-current={settingsActive ? 'page' : undefined}
            data-nav-active={settingsActive ? '' : undefined}
            className={`${styles.item} ${settingsActive ? styles.active : ''}`}
          >
            <span className="shrink-0"><V8_SETTINGS_ICON className={styles.v8NavIcon} aria-hidden="true" /></span>
            <span className={`${styles.itemLabel} min-w-0 flex-1 truncate`}>設定</span>
          </Link>
        </div>
      )}
      {/*
        ★V8 統括（/hq）の左下は「統括の設定」（歯車）と版（絵 `V8-B/JKjsE`・`r4ARpV`、オーナー 2026-10-07）。
        統括の設定の中（メンバー・統括の情報・請求・お問い合わせ）を開いているとき選ばれた形にする。
        v7 の統括は今までどおり左下のアカウントの行から行く。
      */}
      {isHq && !preview && (
        <div className={styles.settingsEntry}>
          <Link
            href="/hq/settings"
            prefetch={false}
            title={collapsed ? undefined : "統括の設定"}
            aria-label={collapsed ? "統括の設定" : undefined}
            data-rail-label="統括の設定"
            aria-current={hqSettingsActive ? 'page' : undefined}
            data-nav-active={hqSettingsActive ? '' : undefined}
            className={`${styles.item} ${hqSettingsActive ? styles.active : ''}`}
          >
            <span className="shrink-0"><V8_SETTINGS_ICON className={styles.v8NavIcon} aria-hidden="true" /></span>
            <span className={`${styles.itemLabel} min-w-0 flex-1 truncate`}>統括の設定</span>
          </Link>
        </div>
      )}

      {/*
        メニューの下の版の表示（★V7 監査の直し E）。いま動いている版・
        commit・配備日時と環境。取れないときは「版の情報なし」。
        移行中の見た目承認（preview）は版の取得をしない。
        v7 の統括（/hq）には出さない。V8 の統括は店の画面と同じく出す（絵 `V8-B/JKjsE`）。
        V8 でメニューを畳んだときは枠ごと隠す（`styles.collapseHide`）。
      */}
      {preview ? null : <div className={styles.collapseHide}><SidebarVersion hqOrigin={isHq} /></div>}

      {/*
        名前・権限・ログアウトは、2026-08-26 に共通トップバーへ移した。
        ここに残すと二重に出る（`docs/v8-design-rules.md` §5）。
        枠だけ残すのは、下端の余白がメニューの最後の項目に食い込まないため。

        統括（/hq）だけは例外（2026-09-12、§1-2）。下端にログイン中のアカウントを置き、
        押すとメンバー管理・お問い合わせ・ログアウトのメニューが上に開く。
        正本は ★V6 36-1 `qAvlC`。中身は `components/hq/account-menu.tsx` が持つ。
        V8 の統括は店の画面と同じ形（名前・ログアウトは上の帯、メンバー・お問い合わせは「統括の設定」の中）。
      */}
      {<div className={styles.footer} />}
      {/*
        ★V8 左下の自分とメニュー（オーナー 2026-10-07・絵 `zUg8S/T7XSI6/shBJJ`・`ZBjxY/Xn3xt`）。
        店・統括の両方で版の下に置く。上の帯の名前・ログアウト・［統括へ］はここへまとめた。
        畳んだ左メニューでは顔だけ。v7 は上の行のまま（統括の HqAccountMenu・店は上の帯）。
      */}
      {!preview ? <SidebarAccountMenu hq={isHq} collapsed={collapsed && !drawer} /> : null}
    </>
  )

  return (
    <>
      {/*
        モバイル: ハンバーガーヘッダー。
        1280px 未満では PC の上部バー（画面名・アカウント切替）を畳み、
        現在地はここへ出す（U037）。2本のヘッダーを同時に占有させない。
      */}
      <div className={`${styles.mobileHeader} ${styles.mobileOnly}`}>
        <button
          ref={menuButtonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-control hover:bg-shell transition-colors"
          aria-label="メニュー"
          aria-expanded={isOpen}
          aria-controls="mobile-menu"
        >
          <svg className="w-6 h-6 text-ink-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {isOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 6h16M4 12h16M4 18h16" />
            }
          </svg>
        </button>
        {/* いま開いている画面の名前。取れない画面はアカウント名で埋める。
            1280px 未満では PC のトップバー（画面の唯一の <h1>）を畳むので、
            現在地を h1 で持つのはここ（#734: 390px で全画面 h1 が消えていた）。 */}
        <h1 className={styles.mobileTitle} title={mobileTitle || brand.name || undefined}>
          {mobileTitle || brand.name || 'musubo LINE管理システム'}
        </h1>
        {/* 公式アカウントの印。名前は画面名が持つので、ここはアイコンだけ。 */}
        <div className={styles.mobileBrand}>
          {brand.iconUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- LINE の CDN。静的アセットではない */
            <img width={28} height={28} src={brand.iconUrl} alt="" className="w-7 h-7 rounded-control object-cover" />
          ) : (
            <div className="w-7 h-7 rounded-control flex items-center justify-center text-on-accent font-medium text-xs" style={{ backgroundColor: 'var(--color-accent)' }}>{brandInitial(brand.name ?? '') || 'm'}</div>
          )}
        </div>
      </div>

      {/* オーバーレイ。ドロワーが開くのは xl 未満 */}
      {preparing.dialog}{isOpen && <div className={`${styles.scrim} ${styles.mobileOnly}`} onClick={() => setIsOpen(false)} />}

      {/*
        スライドインするメニュー。

        以前は 768px 未満だけで使っていた。768〜1279px は 64px の
        アイコンレールになるが、そこでは項目名もセクション見出しも
        消えるので、初めて触る人には「メニューが無くなった」ように見える。
        レールは残したまま、その幅でもここを開けるようにした。
      */}
      <aside
        id="mobile-menu"
        ref={drawerRef}
        aria-label="管理メニュー"
        inert={!isOpen}
        className={`${styles.drawer} ${styles.mobileOnly} ${isOpen ? '' : styles.drawerClosed}`}
      >
        <div className="absolute right-3 top-2.5 z-10">
          <button onClick={() => setIsOpen(false)} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-control hover:bg-shell" aria-label="閉じる">
            <svg className="w-5 h-5 text-ink-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {sidebarContent(true)}
      </aside>

      {/*
        常時出すのは 1280px 以上だけ。

        768〜1279px を 64px のアイコンレールにしていたが、その幅では絵しか
        残らず、何の項目かを覚えている人しか使えない。ハンバーガーから開けば
        名前は読めるものの、閉じている間ずっと読めない帯が場所を取り続ける。
        その幅は上のハンバーガーだけにそろえる。

        中身は常に展開表示。幅で文字を出し分ける必要がなくなった。
      */}
      <aside
        ref={desktopRef}
        className={styles.desktop}
        data-design-node="J33xq"
        data-collapsed={collapsed ? '' : undefined}
        onPointerOver={(event) => showRailTip(event.target)}
        onPointerLeave={() => setRailTip(null)}
        onFocus={(event) => showRailTip(event.target)}
        onBlur={() => setRailTip(null)}
      >
        {sidebarContent(false)}
      </aside>
      {collapsed && railTip ? (
        <div role="tooltip" className={styles.railTip} style={{ top: railTip.top }}>
          {railTip.label}
          {railTip.count ? <span className={styles.railTipCount}>{railTip.count}</span> : null}
        </div>
      ) : null}
    </>
  )
}
