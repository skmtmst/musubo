'use client'
import { useId, type ReactNode } from 'react'
import { Check, MessageCircle, Send } from 'lucide-react'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import HelpTip from '@/components/shared/help-tip'
import TextLink from '@/components/shared/text-link'
import { DisclosureItem } from '@/components/shared/disclosure'
import { ReservationSource } from '@/components/shared/booking-presentation'
import { formatCount } from '@/lib/format'
import type { IndustryStyle, StyleSideCard } from './model'
import { useNewBookingAck } from './use-new-booking-ack'
import { useTodayCheckOpen } from './use-today-check-open'
import styles from './style-dashboard.module.css'

/*
 * 業種ダッシュボードの右の列「今日の確認」。1枚の白いカードに項目（新着予約・お支払い・業種の項目）を並べ、項目ごとに開け閉めする。
 * 閉じていても見出しの下に件数・最新の予約・要点を出す（中身が無い時は灰色の「なし」「—」）。取れない値は「—」のまま（見本の値で埋めない）。
 * 行き先（一覧・準備中の窓）は開閉とは別の押し口。通常の書く操作は書ける人だけに出す。確認済みは閲覧のみの場合も理由付きで示す。
 * 開き方は useTodayCheckOpen が本人・アカウント・スタイルごとに覚える。
 */
export function TodayCheck({ cards, accountId, style, canWrite, onAction, extra, refresh, lockedReason, roleKnown = true }: {
  cards: StyleSideCard[]
  accountId: string | null
  style: IndustryStyle
  /** 書ける人か。役割が分からない間も false にする（書く操作を出さない）。 */
  canWrite: boolean
  refresh?: () => Promise<void>
  lockedReason?: string
  roleKnown?: boolean
  onAction: (card: StyleSideCard) => void
  /** 項目の中身の下に添える物（お支払いの試験モードの印など）。 */
  extra?: Partial<Record<string, ReactNode>>
}) {
  const titleId = useId()
  const ack = useNewBookingAck(accountId, refresh)
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
      <h3 id={titleId} className={styles.todayTitle}>今日の確認</h3>
      <div>
        {cards.map((original) => {
          const visibleBookings = original.bookings?.filter(b => !ack.pending.includes(b.id))
          const count = Math.max(0, (original.count ?? 0) - (original.bookings?.length ?? 0) + (visibleBookings?.length ?? 0))
          const latest = visibleBookings?.[0]
          const card = style === 'restaurant' && original.id === 'new' && ack.pending.length ? { ...original, bookings: visibleBookings, count, summary: latest ? { text: `${formatCount(count, '件')}・最新 ${latest.when} ${latest.name}` } : count ? { text: formatCount(count, '件') } : { text: 'なし', empty: true } } : original
          const showAck = style === 'restaurant' && card.id === 'new'
          return (
          <DisclosureItem key={card.id} id={`today-check-${card.id}`} title={showAck ? '新着予約（今日）' : card.title}
            summary={card.summary?.text} tone={card.summary?.tone} empty={card.summary?.empty}
            help={card.help ? <HelpTip label={`${card.title}の説明`}>{card.help}</HelpTip> : undefined}
            action={actionOf(card)} headerAction={showAck && isOpen(card.id) ? <Button variant="text" size="inline" disabled={!roleKnown || ack.busy || !card.bookings?.length} lockedReason={lockedReason} onClick={() => { if (canWrite) void ack.acknowledge(card.bookings ?? []) }}>すべて確認済み</Button> : undefined} open={isOpen(card.id)} onOpenChange={(next) => setOpen(card.id, next)}>
            {card.bookings ? <BookingRows card={card} showAck={showAck} canWrite={canWrite} roleKnown={roleKnown} lockedReason={lockedReason} busy={ack.busy} onAck={ack.acknowledge} /> : <ValueRows card={card} />}
            {extra?.[card.id] ?? null}
          </DisclosureItem>
        )})}
      </div>
    </Card>
  )
}

/** 新着予約の代表の行（入った新しい順）。名前と人数・予約の経路の札・来店の日時。総数より少なければ残りの件数を添える。 */
function BookingRows({ card, showAck, canWrite, roleKnown, lockedReason, busy, onAck }: { card: StyleSideCard; showAck: boolean; canWrite: boolean; roleKnown: boolean; lockedReason?: string; busy: boolean; onAck: (rows: NonNullable<StyleSideCard['bookings']>) => Promise<void> }) {
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
              {showAck ? <span className={styles.todayBookingAck}><Button variant="text" size="inline" disabled={!roleKnown || busy} lockedReason={lockedReason} aria-label={`${booking.name}を確認済みにする`} onClick={() => { if (canWrite) void onAck([booking]) }}><Check size={14} aria-hidden="true" />確認済み</Button></span> : null}
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
