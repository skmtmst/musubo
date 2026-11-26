'use client'
import { useId, type ReactNode } from 'react'
import { MessageCircle, Send } from 'lucide-react'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import HelpTip from '@/components/shared/help-tip'
import TextLink from '@/components/shared/text-link'
import { DisclosureItem, DisclosureToggle } from '@/components/shared/disclosure'
import StatusBadge from '@/components/shared/status-badge'
import { ReservationSource } from '@/components/shared/booking-presentation'
import { formatCount } from '@/lib/format'
import type { IndustryStyle, StyleSideCard } from './model'
import { useTodayCheckFolded, useTodayCheckOpen } from './use-today-check-open'
import styles from './style-dashboard.module.css'

/*
 * 業種ダッシュボードの右の列「今日の確認」。1枚の白いカードに項目（新着予約・お支払い・業種の項目）を並べ、項目ごとに開け閉めする。
 * 閉じていても見出しの下に件数・最新の予約・要点を出す（中身が無い時は灰色の「なし」「—」）。取れない値は「—」のまま（見本の値で埋めない）。
 * 行き先（一覧・準備中の窓）は開閉とは別の押し口。書く操作は今までの右の列と同じく書ける人だけに出し、閲覧のみ・役割の確認中は出さない。
 * 開き方は useTodayCheckOpen が本人・アカウント・スタイルごとに覚える。
 */
export function TodayCheck({ cards, accountId, style, canWrite, onAction, extra }: {
  cards: StyleSideCard[]
  accountId: string | null
  style: IndustryStyle
  /** 書ける人か。役割が分からない間も false にする（書く操作を出さない）。 */
  canWrite: boolean
  onAction: (card: StyleSideCard) => void
  /** 項目の中身の下に添える物（お支払いの試験モードの印など）。 */
  extra?: Partial<Record<string, ReactNode>>
}) {
  const titleId = useId()
  const contentId = useId()
  const { folded, toggle } = useTodayCheckFolded(accountId, style)
  const { isOpen, setOpen } = useTodayCheckOpen(accountId, style, cards)
  const actionOf = (card: StyleSideCard): ReactNode => {
    if (card.link) return <TextLink href={card.link.href}>{card.link.label}</TextLink>
    if (!card.action || !canWrite) return null
    return (
      <Button variant="text" size="inline" onClick={() => onAction(card)}>
        {card.action.icon === 'line' ? <MessageCircle size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {card.action.label}
      </Button>
    )
  }
  return (
    <Card layout="vertical" className={styles.sideCard} contentPadding="var(--polish-space-card)" gap="var(--polish-space-card)" aria-labelledby={titleId} data-today-check>
      <div className={styles.todayHeader}>
        <h3 id={titleId} className={styles.todayTitle}>今日の確認</h3>
        {folded ? cards.map(card => {
          const badge = todayCheckBadge(card)
          return badge ? <StatusBadge key={card.id} tone="danger" size="micro" dot={false}>{badge}</StatusBadge> : null
        }) : null}
        <DisclosureToggle open={!folded} controls={contentId} onToggle={toggle} subject="今日の確認" />
      </div>
      <div id={contentId} hidden={folded}>
        {cards.map((card) => (
          <DisclosureItem key={card.id} id={`today-check-${card.id}`} title={card.title}
            summary={card.summary?.text} tone={card.summary?.tone} empty={card.summary?.empty}
            help={card.help ? <HelpTip label={`${card.title}の説明`}>{card.help}</HelpTip> : undefined}
            action={actionOf(card)} open={isOpen(card.id)} onOpenChange={(next) => setOpen(card.id, next)}>
            {card.bookings ? <BookingRows card={card} /> : <ValueRows card={card} />}
            {extra?.[card.id] ?? null}
          </DisclosureItem>
        ))}
      </div>
    </Card>
  )
}

/** 要約が明確な件数を持つ時だけ表示し、未取得・金額・曖昧な複数の数は数えない。 */
export function todayCheckBadge(card: StyleSideCard): string | null {
  const names: Record<string, string> = { new: '新着', pay: 'お支払い', care: '注意', waitlist: 'キャンセル待ち' }
  const label = names[card.id]
  if (!label || card.summary?.empty) return null
  let count = card.count
  if (count === undefined) {
    const text = card.summary?.text ?? ''
    if (/[—―−]/.test(text)) return null
    const matches = [...text.matchAll(/(?:^|[^\d,])(\d[\d,]*)\s*(?:件|人|名|組)/g)]
    if (matches.length !== 1) return null
    count = Number(matches[0][1].replaceAll(',', ''))
  }
  return Number.isSafeInteger(count) && (count ?? 0) > 0 ? `${label} ${count!.toLocaleString('ja-JP')}` : null
}

/** 新着予約の代表の行（入った新しい順）。名前と人数・予約の経路の札・来店の日時。総数より少なければ残りの件数を添える。 */
function BookingRows({ card }: { card: StyleSideCard }) {
  const bookings = card.bookings ?? []
  if (!bookings.length) return <p className={styles.todayNote}>まだありません</p>
  const rest = (card.count ?? bookings.length) - bookings.length
  return (
    <>
      <ul className={styles.todayBookings}>
        {bookings.map((booking) => {
          const who = [booking.name, booking.people === null ? null : formatCount(booking.people, '名')].filter(Boolean).join(' ')
          return (
            <li key={booking.id} className={styles.todayBooking}>
              <span className={styles.todayBookingName} title={who}>{who}</span>
              {/* 経路を返さない口（教室の申込など）の予約には札を出さない。「経路不明」を全部の行に並べない。 */}
              {booking.source ? <span className={styles.todayBookingSource}><ReservationSource value={booking.source} label={booking.sourceName} /></span> : null}
              <span className={styles.todayBookingWhen}>{booking.when}</span>
            </li>
          )
        })}
      </ul>
      {rest > 0 ? <p className={styles.todayNote}>ほか {formatCount(rest, '件')}は一覧で見られます</p> : null}
    </>
  )
}

/** 項目名と値の行（取れない値は「—」）。 */
function ValueRows({ card }: { card: StyleSideCard }) {
  return (
    <dl className={styles.todayValues}>
      {card.rows.map((row) => (
        <div key={row.label} className={styles.todayValue}>
          <dt className={styles.todayValueLabel} title={row.label}>{row.label}</dt>
          {row.value ? <dd className={styles.todayValueText} data-tone={row.tone}>{row.value}</dd> : null}
        </div>
      ))}
    </dl>
  )
}
