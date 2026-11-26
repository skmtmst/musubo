'use client'
import { ArrowRight, Ban, CalendarClock, Copy, CreditCard, MessageCircle, PanelLeftOpen, Send, Timer, Undo2, UserRoundCog, UserRoundX, Armchair, Check, CircleX, ListChecks } from 'lucide-react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import Card from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Button from '@/components/shared/button'
import StatusBadge from '@/components/shared/status-badge'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import type { IndustryStyle, StyleBadge, StyleRow, StyleSideCard } from './model'
import styles from './style-dashboard.module.css'

/** 支払い・状態などの丸い札。 */
export function StatusOrDash({ badge }: { badge?: StyleBadge | null }) {
  if (!badge) return <span className={styles.muted}>—</span>
  return <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
}

/** 右の列のカード（頭：題・「？」・行き先／中：左右の行）。 */
export function SideCard({ card, canWrite, onAction, children }: { card: StyleSideCard; canWrite: boolean; onAction?: (card: StyleSideCard) => void; children?: ReactNode }) {
  return (
    <Card layout="vertical" className={styles.sideCard} contentPadding="var(--polish-space-card)" gap="var(--tpl-sd-side-gap)" aria-label={card.title}>
      <div className={styles.sideHead}>
        <h3 className={styles.sideTitle}>{card.title}</h3>
        {card.help ? <HelpTip label={`${card.title}の説明`}>{card.help}</HelpTip> : null}
        <span className={styles.grow} />
        {card.link ? <Link className={styles.sideLink} href={card.link.href}>{card.link.label}<ArrowRight size={16} aria-hidden="true" /></Link> : null}
      </div>
      {card.rows.map((row) => (
        <div key={row.label} className={styles.sideRow}>
          <span className={styles.sideLabel}>{row.label}</span>
          <span className={styles.grow} />
          <strong className={styles.sideValue} data-tone={row.tone}>{row.value}</strong>
        </div>
      ))}
      {children}
      {card.more ? <Link className={styles.sideMore} href={card.more.href}>{card.more.label}</Link> : null}
      {card.action && canWrite ? (
        <div className={styles.sideAction}>
          <Button size="compact" onClick={() => onAction?.(card)}>
            {card.action.icon === 'line' ? <MessageCircle size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {card.action.label}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}

/** カードの外枠だけ（中身を渡す）。 */
export function SideFrame({ title, children }: { title: string; children: ReactNode }) {
  return <Card layout="vertical" className={styles.sideCard} contentPadding="var(--polish-space-card)" gap="var(--tpl-sd-side-gap)" aria-label={title}>{children}</Card>
}

type MenuHandlers = {
  open: (row: StyleRow) => void
  visit: (row: StyleRow) => void
  line: (row: StyleRow) => void
  pay: (row: StyleRow) => void
  copy: (row: StyleRow) => void
  roster: (row: StyleRow) => void
  noShow: (row: StyleRow) => void
  cancel: (row: StyleRow) => void
  refund: (row: StyleRow) => void
  cancelClass: (row: StyleRow) => void
}

/** 決済の口（Stripe・API 組3）ができるまで、押したときに出す案内。 */
export const PAY_NOTE = 'お支払い（Stripe）をつなぐと使えます。設定の「お支払い」からつなげます。'

/**
 * 行の「…」（・）。業種ごとに絵の並び。
 * 決済の口（支払いのリンク・返金）は Stripe をつなぐまで押せない形で置く（理由つき）。
 */
export function rowMenuItems(style: IndustryStyle, row: StyleRow, canWrite: boolean, h: MenuHandlers): ActionMenuItem[] {
  const detail: ActionMenuItem = { id: 'detail', label: '詳細を開く', icon: <PanelLeftOpen size={16} />, onSelect: () => h.open(row) }
  if (!canWrite) return [detail]
  const payLink: ActionMenuItem = { id: 'pay-link', label: '支払いのリンクを送る', icon: <CreditCard size={16} />, dividerBefore: true, onSelect: () => h.pay(row) }
  const refund: ActionMenuItem = { id: 'refund', label: '返金する', icon: <Undo2 size={16} />, onSelect: () => h.refund(row) }
  const line: ActionMenuItem = { id: 'line', label: 'LINE を送る', icon: <MessageCircle size={16} />, dividerBefore: true, onSelect: () => h.line(row) }
  // 無断・欠席の印は開始の時刻を過ぎた予約にだけ出す。あとで戻せるので赤にしない。
  const noShowItems: ActionMenuItem[] = row.past && row.live !== false ? [{ id: 'no-show', label: style === 'consult' ? '欠席にする（あとで戻せる）' : '無断にする（あとで戻せる）', icon: <UserRoundX size={16} />, group: 'destructive', onSelect: () => h.noShow(row) }] : []
  const cancelItem: ActionMenuItem = { id: 'cancel', label: '取り消す', icon: <CircleX size={16} />, tone: 'danger', dividerBefore: true, onSelect: () => h.cancel(row) }
  const cancel = row.live === false ? [] : [cancelItem]
  if (style === 'restaurant') return [
    detail,
    { id: 'seat', label: '卓を変更する', icon: <Armchair size={16} />, onSelect: () => h.open(row) },
    { id: 'time', label: '時間を変更する', icon: <Timer size={16} />, onSelect: () => h.open(row) },
    payLink, refund, line,
    { id: 'remind', label: '前日の確認をもう一度送る', icon: <Send size={16} />, onSelect: () => h.open(row) },
    ...noShowItems, ...cancel,
  ]
  if (style === 'salon') return [
    detail,
    { id: 'visit', label: '来店にする', icon: <Check size={16} />, onSelect: () => h.visit(row) },
    { id: 'time', label: '時間を変更する', icon: <Timer size={16} />, onSelect: () => h.open(row) },
    { id: 'staff', label: '担当を移す', icon: <UserRoundCog size={16} />, onSelect: () => h.open(row) },
    payLink, { ...line, dividerBefore: false }, ...noShowItems, ...cancel,
  ]
  if (style === 'consult') return [
    detail,
    { id: 'time', label: '日程を変更する', icon: <CalendarClock size={16} />, onSelect: () => h.open(row) },
    { id: 'staff', label: '担当を変更する', icon: <UserRoundCog size={16} />, onSelect: () => h.open(row) },
    payLink, refund, line,
    { id: 'copy', label: '予約 URL をコピー', icon: <Copy size={16} />, onSelect: () => h.copy(row) },
    ...noShowItems, ...cancel,
  ]
  return [
    { id: 'roster', label: '名簿を開く', icon: <ListChecks size={16} />, onSelect: () => h.roster(row) },
    { id: 'line', label: 'この回の人に LINE を送る', icon: <MessageCircle size={16} />, onSelect: () => h.line(row) },
    payLink,
    { id: 'cancel', label: '休講にする', icon: <Ban size={16} />, tone: 'danger', dividerBefore: true, onSelect: () => h.cancelClass(row) },
  ]
}
