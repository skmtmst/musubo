'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { CalendarDays, ClipboardCheck, Ellipsis, MessageCircle } from 'lucide-react'
import AuthGuard from '@/components/auth-guard'
import SessionLostNotice from '@/components/session-lost-notice'
import ImpersonationNotice from '@/components/ops/impersonation-notice'
import UnfamiliarLoginNotice from '@/components/unfamiliar-login-notice'
import AccountSwitchMenu from '@/components/shared/account-switch-menu'
import Button from '@/components/shared/button'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import TruncatedText from '@/components/shared/truncated-text'
import type { MobileFrameTab } from '@/components/templates'
import { AccountProvider, useAccount } from '@/contexts/account-context'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { MOBILE_TABS, mobileTabForPath, visibleMobileTabs, type MobileTabId } from '@/lib/mobile-shell'
import { canViewFeature } from '@/lib/staff-capability'
import { useStaffRole } from '@/lib/staff-role'
import { requestUnsavedAction } from '@/lib/unsaved-action'

/*
 * 電話の専用の画面（/m）の外枠。ログインの確認・アカウント・代理ログインの帯・セッション切れは
 * PC と同じ部品を中に入れる（守りは Worker。ここは見せ方だけ）。
 * PC の左メニュー・上の帯・⌘K・先読みは入れない。
 */

const TAB_ICONS: Record<MobileTabId, ReactNode> = {
  today: <CalendarDays aria-hidden="true" />,
  talk: <MessageCircle aria-hidden="true" />,
  todo: <ClipboardCheck aria-hidden="true" />,
  more: <Ellipsis aria-hidden="true" />,
}

export type MobileShellParts = {
  /** 見せてよいタブ。権限の確認が済むまでは空。 */
  tabs: MobileFrameTab[]
  /** 権限の確認が済んだか。済むまで画面は中身を出さない。 */
  ready: boolean
  /** 見る権限（PC の画面の鍵）。確認が済むまでは false。 */
  canView: (permission: string) => boolean
  /** 閲覧のみ。返信欄など変える操作を隠す。 */
  readOnly: boolean
  banner: ReactNode
  band: ReactNode
  headerEnd: ReactNode
  /** 店を選んでいない（統括で店を選ぶ前など）。 */
  needsAccount: boolean
  /** 選べるアカウントが 1 つ以上ある（無い時は「登録されていません」）。 */
  hasAccounts: boolean
}

const MobileShellContext = createContext<MobileShellParts | null>(null)

export function useMobileShell(): MobileShellParts {
  const parts = useContext(MobileShellContext)
  if (!parts) throw new Error('useMobileShell は MobileShell の中で使う')
  return parts
}

export default function MobileShell({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <AccountProvider>
        <MobileShellState>{children}</MobileShellState>
      </AccountProvider>
    </AuthGuard>
  )
}

function MobileShellState({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/m'
  const router = useRouter()
  const role = useStaffRole()
  const { accounts, selectedAccountId, setSelectedAccountId, loading } = useAccount()
  const [menuOpen, setMenuOpen] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)

  const canView = useMemo(() => (permission: string) => (role ? canViewFeature(permission, role) : false), [role])
  const visible = useMemo(() => visibleMobileTabs(role ? canView : null), [role, canView])
  const talkVisible = visible.some((tab) => tab.id === 'talk')

  /* トークの数の丸。PC の左メニューの「受信箱」と同じ数（未対応）。店を選んでいない・見られない時は出さない。 */
  const [unanswered, setUnanswered] = useState<number | null>(null)
  useEffect(() => {
    setUnanswered(null)
    if (!selectedAccountId || !talkVisible) return
    let live = true
    let seq = 0
    const load = async () => {
      const mine = ++seq
      try {
        const { api } = await import('@/lib/api')
        const res = await api.inbox.unanswered.count()
        if (live && mine === seq && res.success) setUnanswered(res.data.total)
      } catch {
        // 数が取れなくてもタブは使える。
      }
    }
    void load()
    const timer = window.setInterval(load, 5 * 60_000)
    const refresh = () => { void load() }
    window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    }
  }, [selectedAccountId, talkVisible])

  const current = mobileTabForPath(pathname)
  const tabs: MobileFrameTab[] = visible.map((tab) => ({
    href: tab.href,
    label: tab.label,
    icon: TAB_ICONS[tab.id],
    current: current?.id === tab.id,
    badge: tab.id === 'talk' ? unanswered : null,
  }))

  const selected = accounts.find((account) => account.id === selectedAccountId) ?? null
  const options = useMemo(
    () => accounts.map((a) => ({ id: a.id, label: a.displayName || a.name, iconUrl: a.iconUrl || a.pictureUrl || null, basicId: a.basicId ?? null })),
    [accounts],
  )
  /* 切り替えたら、そのタブの一覧へ戻る（前の店の会話を開いたままにしない）。 */
  const changeAccount = (accountId: string) => {
    requestUnsavedAction(() => {
      setSelectedAccountId(accountId)
      setMenuOpen(false)
      router.replace((current ?? visible[0] ?? MOBILE_TABS.find(tab => tab.id === 'more')!).href)
    })
  }
  const accountLabel = selected ? (selected.displayName || selected.name) : loading ? '読み込み中…' : '店を選ぶ'
  const headerEnd = accounts.length > 0 ? (
    <div ref={chipRef}>
      <Button variant="secondary" size="compact" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`アカウントを切り替える（今は${accountLabel}）`} onClick={() => setMenuOpen((open) => !open)}>
        <TruncatedText value={accountLabel} />
      </Button>
      <AccountSwitchMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        getAnchor={() => chipRef.current?.querySelector('button') ?? null}
        accounts={options}
        selectedAccountId={selectedAccountId ?? ''}
        onSelect={changeAccount}
      />
    </div>
  ) : null

  const readOnly = role === 'viewer'
  const parts: MobileShellParts = {
    tabs,
    ready: role !== null,
    canView,
    readOnly,
    banner: <><SessionLostNotice /><ImpersonationNotice /><UnfamiliarLoginNotice /></>,
    band: readOnly ? <ReadOnlyNotice /> : null,
    headerEnd,
    needsAccount: !loading && !selectedAccountId,
    hasAccounts: accounts.length > 0,
  }
  return <MobileShellContext.Provider value={parts}>{children}</MobileShellContext.Provider>
}
