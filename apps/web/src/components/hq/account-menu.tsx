'use client'

import { knownValue } from '@/lib/known-value'

import { useStaffRole, useStaffIdentity } from '@/lib/staff-role'
import { Building2, ChevronsUpDown, CreditCard, LifeBuoy, LogOut, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { api } from '@/lib/api'
import MenuPortal from '@/components/shared/menu-portal'
import { billingChip, trialDaysLabel, type BillingSummary } from '@/lib/hq-billing'
import { logoutAndGoToLogin } from '@/lib/logout'
import { useAccount } from '@/contexts/account-context'
import { canReturnToHqFrom } from '@/lib/hq-return'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { notifyToast } from '@/components/shared/toast'
import { nameInitial } from '@/lib/name-initial'
import styles from './account-menu.module.css'

const ROLE_LABELS: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  staff: 'スタッフ',
  viewer: '閲覧のみ',
}

/* ===================================================================
 * ★V8 左下の自分とメニュー（オーナー 2026-10-07・絵 V8.pen `zUg8S/T7XSI6/shBJJ`、
 * 開いた形 `ZBjxY/Xn3xt`「G. 左下の自分とメニュー」）。
 *
 * 店の画面・統括の画面の両方で、左メニューのいちばん下に置く。上の帯の
 * 名前・ログアウト・［統括へ］は、ここへまとめる。
 *
 * 行の出し分け（絵の3つの形）：
 *   - 店の画面・オーナー/管理者：統括に戻る／メンバー／請求／お問い合わせ／ログアウト
 *   - 統括の画面：メンバー／請求（担当者には出さない）／お問い合わせ／ログアウト
 *   - 店の画面・スタッフ/閲覧のみ：お問い合わせ／ログアウト
 * 「統括に戻る」の権限と行き先は上の帯の切り替えと同じ（`canReturnToHqFrom`）。
 * =================================================================== */

export type SidebarAccountMenuProps = {
  /** 統括の画面（左メニューが統括のもの）か。 */
  hq: boolean
  /** 左メニューを畳んだ形（幅 64）。顔だけを出す。 */
  collapsed?: boolean
}

/** 店の画面で、どの行を出すか。統括の画面は `hq` で決める。 */
export function sidebarAccountRows({ hq, role, canReturnToHq }: { hq: boolean; role: string; canReturnToHq: boolean }): Array<'hq' | 'members' | 'billing' | 'support' | 'logout'> {
  if (hq) {
    // 担当者には請求を出さない（権限表: 課金プランは担当者 不可。管理画面 の統括と同じ）。
    return role === 'staff' ? ['members', 'support', 'logout'] : ['members', 'billing', 'support', 'logout']
  }
  if (role === 'owner' || role === 'admin') {
    return canReturnToHq ? ['hq', 'members', 'billing', 'support', 'logout'] : ['members', 'billing', 'support', 'logout']
  }
  return ['support', 'logout']
}

export function SidebarAccountMenu({ hq, collapsed = false }: SidebarAccountMenuProps) {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const { selectedAccountId, clearSelectedAccountId } = useAccount()
  const menuId = useId()
  const [name, setName] = useState('')
  const role = useStaffRole()
  const staffIdentity = useStaffIdentity()
  const [billing, setBilling] = useState<BillingSummary | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const returning = useRef(false)

  // AuthGuard が保存した値を読む（上の帯と同じ。ここでは取りに行かない）。
  useEffect(() => {
    try {
      setName(localStorage.getItem('lh_staff_name') ?? '')
    } catch {
      // ストレージが使えなくても、名前が空になるだけ
    }
  }, [pathname])

  // プランの一言はオーナー・管理者にだけ出す（請求を見られる人）。取れなければ出さないだけ。
  const seesBilling = role === 'owner' || role === 'admin'
  useEffect(() => {
    if (!seesBilling) return
    let cancelled = false
    void api.hqBilling.summary().then((res) => {
      if (!cancelled && res.success) setBilling(res.data)
    }).catch(() => {
      // 課金の状態が取れなければ一言を出さないだけ
    })
    return () => { cancelled = true }
  }, [seesBilling])

  // 画面が変わったら閉じる。外を押したときは器（`MenuPortal`）が閉じる。
  useEffect(() => setOpen(false), [pathname])
  // 開いたら最初の行へ。Esc は閉じて枠へ戻す。
  useEffect(() => {
    if (!open) return
    // 器（`MenuPortal`）は開いた次の描画で中身を出すので、1こま待ってから移す。
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const canReturnToHq = canReturnToHqFrom(role, pathname, hq, staffIdentity?.accountScope)
  const rows = sidebarAccountRows({ hq, role: role ?? '', canReturnToHq }).filter((row) => row !== 'billing' || staffIdentity?.accountScope !== 'accounts')
  const roleLabel = role ? knownValue(ROLE_LABELS, role, role) : ''
  const chip = seesBilling && billing ? billingChip(billing) : null
  const daysLeft = seesBilling && billing ? trialDaysLabel(billing) : null
  const planNote = chip ? `${chip.label}${daysLeft ? ` ${daysLeft}` : ''}` : ''
  const headNote = [roleLabel, planNote].filter(Boolean).join('・')
  const shownName = name || '—'
  const initial = nameInitial(shownName).toUpperCase() || '?'

  const close = () => setOpen(false)
  const returnToHq = () => {
    requestUnsavedAction(() => {
      if (returning.current) return
      const finish = () => { close(); clearSelectedAccountId(); router.push('/hq') }
      if (!selectedAccountId || !pathname.startsWith('/restaurant-test/')) { finish(); return }
      returning.current = true
      void restaurantTestApi.clearStoreSelection(selectedAccountId).then(() => {
        finish()
      }).catch(() => {
        notifyToast('統括へ戻れませんでした。もう一度お試しください。', { tone: 'error' })
      }).finally(() => { returning.current = false })
    })
  }

  return (
    <div className={styles.root} data-design-node="shBJJ" data-collapsed={collapsed ? '' : undefined}>
      {open ? (
        <MenuPortal open={open} align="start" gap={8} getAnchor={() => triggerRef.current} onClose={close}>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="自分のメニュー"
            data-design-node="Xn3xt"
            className={styles.menu}
            onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
              if (items.length === 0) return
              event.preventDefault()
              const current = items.indexOf(document.activeElement as HTMLElement)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
              items[next].focus()
            }}
          >
            <div className={styles.head}>
              <p className={styles.headName} title={shownName}>{shownName}</p>
              {headNote ? <p className={styles.headNote} title={headNote}>{headNote}</p> : null}
            </div>
            <div className={styles.rule} role="separator" />
            {rows.includes('hq') ? (
              <>
                <button type="button" role="menuitem" className={styles.row} onClick={returnToHq}>
                  <Building2 aria-hidden="true" className={styles.rowIcon} />
                  統括に戻る
                </button>
                <div className={styles.rule} role="separator" />
              </>
            ) : null}
            {rows.includes('members') ? <SidebarMenuLink href={hq ? '/hq/members' : '/staff'} icon={Users} onSelect={close}>メンバー</SidebarMenuLink> : null}
            {rows.includes('billing') ? <SidebarMenuLink href="/hq/billing" icon={CreditCard} onSelect={close}>請求</SidebarMenuLink> : null}
            <SidebarMenuLink href="/hq/support" icon={LifeBuoy} onSelect={close}>お問い合わせ</SidebarMenuLink>
            <div className={styles.rule} role="separator" />
            <button type="button" role="menuitem" className={styles.row} onClick={() => void logoutAndGoToLogin()}>
              <LogOut aria-hidden="true" className={styles.rowIcon} />
              ログアウト
            </button>
          </div>
        </MenuPortal>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={`自分のメニュー（${shownName}${roleLabel ? `・${roleLabel}` : ''}）`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={shownName}
        // Enter・Space はボタンそのものが開く。矢印でも開けるようにする（メニューの決まり）。
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className={styles.face} aria-hidden="true">{initial}</span>
        <span className={styles.text} aria-hidden="true">
          <span className={styles.name}>{shownName}</span>
          {roleLabel ? <span className={styles.role}>{roleLabel}</span> : null}
        </span>
        <ChevronsUpDown aria-hidden="true" className={styles.chevron} />
      </button>
    </div>
  )
}

/** ★V8 メニューの1行（高さ40・角丸8・左右10・アイコン16）。右に説明の字は置かない。 */
function SidebarMenuLink({ href, icon: Icon, onSelect, children }: { href: string; icon: typeof Users; onSelect: () => void; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} role="menuitem" className={styles.row} onClick={onSelect}>
      <Icon aria-hidden="true" className={styles.rowIcon} />
      {children}
    </Link>
  )
}
