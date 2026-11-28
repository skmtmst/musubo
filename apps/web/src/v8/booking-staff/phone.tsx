'use client'

import LiffPhoneFrame from '@/components/shared/liff-phone-frame'

/**
 * 予約スタッフの画面の右の列に出す「お客さまの予約画面」の写し（押せない見本）。
 * 実 LIFF（apps/liff）の並び「①メニュー → ②担当 → ③日時 → ④確認」の②と③。
 *   ② 担当を選ぶ … 予約スタッフを登録
 *   ③ 日時を選ぶ … 勤務とシフト・自分の勤務
 * 中身は実データ（作り物の名前は置かない）。今までの app/booking/menus/liff-phone-v8.tsx から写した。
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import type { ReactNode } from 'react'
import type { BookingAvailabilitySlot, BookingMenu, BookingStaff } from '@/lib/api'
import StatusBadge from '@/components/shared/status-badge'
import Button from '@/components/shared/button'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import styles from './phone.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'


const WEEKDAY_JP = '日月火水木金土'

function isValidYmd(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

function addDaysStr(date: string, days: number): string {
  const base = isValidYmd(date) ? date : jstDate()
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function formatJpDay(date: string): string {
  return polishFormatDate(date, { style: 'day' })
}

/** LINE の予約画面の時刻は先頭の0を落とす（09:00 → 9:00。絵の）。 */
export function phoneTime(time: string): string {
  if (typeof time !== 'string') return ''
  return time.replace(/^0(\d:)/, '$1')
}

function durationLabel(minutes: unknown): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return emptyValue('unknown')
  return `${polishFormatNumber(minutes)}分`
}

export function priceLabel(menu: Pick<BookingMenu, 'price_mode' | 'base_price'>): string {
  if (menu.price_mode === 'inquiry') return 'お問い合わせ'
  if (menu.price_mode === 'free' || menu.base_price === 0) return '無料'
  if (typeof menu.base_price !== 'number' || !Number.isFinite(menu.base_price) || menu.base_price < 0) {
    return emptyValue('unknown')
  }
  return `¥${polishFormatNumber(menu.base_price)}`
}

function PhoneChrome({ step, children, foot, interactive = false, bodyScroll = false }: { step: number; children: React.ReactNode; foot: React.ReactNode; interactive?: boolean; bodyScroll?: boolean }) {
  return <LiffPhoneFrame role={interactive ? 'group' : undefined} step={step} footer={<div className={styles.foot}>{foot}</div>}><div className={styles.body} data-body-scroll={bodyScroll || undefined}>{children}</div></LiffPhoneFrame>
}

function CheckMark() {
  return (
    <svg className={styles.check} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6.5 10.2 8.9 12.6 13.5 7.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
  )
}

function ListSkeleton() {
  return (
    <span className={styles.skeleton} aria-hidden="true">
      {[0, 1].map((i) => <Skeleton key={i} width="100%" height={76} />)}
    </span>
  )
}

function StaffPreviewCard({ person, draft = false }: { person: BookingStaff; draft?: boolean }) {
  const displayName = person.display_name || person.name || ''
  const fee = typeof person.nomination_fee === 'number' && Number.isFinite(person.nomination_fee) ? person.nomination_fee : 0
  return <div className={styles.card}>
    <span className={styles.avatar} aria-hidden="true">{displayName.slice(0, 1)}</span>
    <span className={styles.cardText}>
      {draft ? <StatusBadge tone="neutral" dot={false}>入力中・未保存</StatusBadge> : null}
      <span className={styles.cardName}>{displayName}</span>
      <span className={styles.cardDesc}>{person.role ?? 'スタッフ'}・{draft && !person.is_active ? '登録後は非表示' : fee > 0 ? `指名料 +¥${polishFormatNumber(fee)}` : '指名料なし'}</span>
    </span>
  </div>
}

/** ② 担当を選ぶ。指名なしを受ける担当がいれば、先頭に「指名なし」を選んだ形で出す。 */
export function PhoneStaffStep({ menu, staff, draft, designationFree, status = 'ready' }: {
  menu: BookingMenu | null
  staff: BookingStaff[]
  draft?: BookingStaff | null
  designationFree: boolean
  status?: 'loading' | 'ready' | 'error'
}) {
  const safeStaff = Array.isArray(staff) ? staff : []
  const shown = safeStaff.filter((s) => s.is_active).sort((a, b) => a.sort_order - b.sort_order)
  const people = shown
  const empty = shown.length === 0 && !designationFree && !draft?.is_active
  return (
    <PhoneChrome
      step={2}
      bodyScroll
      foot={<>
        <span className={styles.cta} data-off={status !== 'ready' || empty || undefined}>日時を選ぶ</span>
        <span className={styles.back}>← メニューを選び直す</span>
      </>}
    >
      <h3 className={styles.title}>担当を選んでください</h3>
      {menu ? <p className={styles.sub}>{menu.name}・{durationLabel(menu.duration_minutes)}・{priceLabel(menu)}</p> : null}
      {draft !== undefined ? (draft ? <StaffPreviewCard person={draft} draft /> : <p className={styles.sub}>表示名を入れるとここに出ます</p>) : null}
      {status === 'loading' ? <DelayedSkeleton loading skeleton={<ListSkeleton />} />
        : status === 'error' ? <p className={styles.sub}>読み込めませんでした。</p>
          : (
            <>
              {designationFree ? (
                <div className={styles.card} data-picked="true">
                  <span className={styles.avatar} data-plain="true" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="8" cy="7" r="3" /><path d="M2.5 16c.9-2.6 2.9-4 5.5-4s4.6 1.4 5.5 4" /><path d="M13 4.2a3 3 0 0 1 0 5.6M15 12.4c1.2.6 2 1.8 2.5 3.6" /></svg>
                  </span>
                  <span className={styles.cardText}>
                    <span className={styles.cardName}>指名なし</span>
                    <span className={styles.cardDesc}>いちばん早く空いている人</span>
                  </span>
                  <CheckMark />
                </div>
              ) : null}
              {empty ? (draft ? null : <p className={styles.sub}>担当できるスタッフはまだいません。</p>) : people.map((person) => (
                <StaffPreviewCard key={person.id} person={person} />
              ))}
            </>
          )}
    </PhoneChrome>
  )
}

/** ③ 日時を選ぶ（週で見る）。空きのある先頭の日から5日を並べ、その日の時刻を出す。 */
export function PhoneDatetimeStep({ menu, staffName, slots, closedDates, closedWeekdays, status = 'ready', onRetry }: {
  menu: BookingMenu | null
  /** 指名したときの担当の名前。無ければ「指名なし」。 */
  staffName: string | null
  slots: BookingAvailabilitySlot[]
  closedDates: string[]
  closedWeekdays: number[]
  onRetry?: () => void
  status?: 'loading' | 'ready' | 'error'
}) {
  const safeSlots = Array.isArray(slots) ? slots : []
  const byDate = new Map<string, BookingAvailabilitySlot[]>()
  for (const slot of status === 'ready' ? safeSlots : []) {
    if (!slot || !isValidYmd(slot.date)) continue
    const list = byDate.get(slot.date) ?? []
    list.push(slot)
    byDate.set(slot.date, list)
  }
  const openDates = [...byDate.keys()].sort()
  const selected = openDates[0] ?? null
  const anchor = selected ?? jstDate()
  const days = Array.from({ length: 5 }, (_, i) => addDaysStr(anchor, i))
  const closed = new Set(Array.isArray(closedDates) ? closedDates : [])
  const closedDow = new Set(Array.isArray(closedWeekdays) ? closedWeekdays : [])
  const selectedSlots = selected ? (byDate.get(selected) ?? []) : []
  const picked = selectedSlots.find((slot) => slot.remaining > 0) ?? null
  return (
    <PhoneChrome
      step={3}
      interactive
      foot={<>
        {picked && selected ? <span className={styles.footPick}>{formatJpDay(selected)}{phoneTime(picked.start)}〜{phoneTime(picked.end)}</span> : null}
        <span className={styles.cta} data-off={picked ? undefined : true}>内容を確かめる</span>
      </>}
    >
      <h3 className={styles.title}>日時を選んでください</h3>
      {menu ? <p className={styles.sub}>{menu.name}・{staffName ?? '指名なし'}</p> : null}
      <div className={styles.seg} aria-hidden="true">
        <span className={styles.segItem} data-now="true">週で見る</span>
        <span className={styles.segItem}>カレンダー</span>
      </div>
      {status === 'ready' ? <div className={styles.week}>
        <svg className={styles.nav} data-off="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
        <div className={styles.days}>
          {days.map((date) => {
            const d = new Date(`${date}T00:00:00Z`)
            const has = (byDate.get(date) ?? []).some((slot) => slot.remaining > 0)
            const isClosed = closed.has(date) || closedDow.has(d.getUTCDay())
            const state = isClosed ? '休み' : has ? '空き' : '満'
            return (
              <span key={date} className={styles.day} data-now={date === selected || undefined} data-closed={isClosed || undefined}>
                <span className={styles.dow}>{WEEKDAY_JP[d.getUTCDay()]}</span>
                <span className={styles.num}>{d.getUTCDate()}</span>
                <span className={styles.dayState} data-tone={isClosed ? 'off' : has ? 'open' : 'full'}>{state}</span>
              </span>
            )
          })}
        </div>
        <svg className={styles.nav} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      </div> : null}
      {selected ? <p className={styles.dayLabel}>{formatJpDay(selected)}の空き</p> : null}
      {status === 'loading' ? (
        <DelayedSkeleton loading skeleton={<span className={styles.slots} aria-hidden="true">{[0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={44} />)}</span>} />
      ) : status === 'error' ? <>
        <p className={styles.sub}>読み込めませんでした</p>
        <Button onClick={onRetry} disabled={!onRetry}>もう一度読み込む</Button>
      </>
        : selected === null ? <p className={styles.sub}>この期間に空きはありません。</p>
          : (
            <div className={styles.slots}>
              {selectedSlots.slice(0, 6).map((slot) => (
                <span key={`${slot.date}-${slot.start}`} className={styles.slot} data-now={slot === picked || undefined} data-off={slot.remaining <= 0 || undefined}>{phoneTime(slot.start)}</span>
              ))}
            </div>
          )}
    </PhoneChrome>
  )
}
