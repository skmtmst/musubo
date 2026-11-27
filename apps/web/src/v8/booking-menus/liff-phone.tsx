'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import LiffPhoneFrame from '@/components/shared/liff-phone-frame'
import { CircleCheck, Users } from 'lucide-react'

/**
 * 予約設定の右欄に出す「お客さまの予約画面」の写し（★V8  右のスマホ）。
 *
 * 実LIFF（apps/liff）の並びにそろえた、押せない見本。予約は
 * 「①メニュー → ②担当 → ③日時 → ④確認」の順なので、タブごとに
 * 対応する段を出す：
 *   メニュー → ①、担当スタッフ → ②、受付枠・休業日・予約のルール → ③。
 *
 * 中身は実データを使う（設定しているものがそのままお客さまの画面に
 * 出ることを確かめるための見本なので、作り物の名前は置かない）。
 * 選ぶ中身が無いときは空き枠の代わりにその旨を出す。
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import type { BookingAvailabilitySlot, BookingMenu, BookingStaff } from '@/lib/api'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import styles from './settings.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'


const WEEKDAY_JP = '日月火水木金土'

export type LiffPhoneStep = 'menu' | 'staff' | 'datetime'

function isValidYmd(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const d = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date
}

/** `YYYY-MM-DD` に n 日足す（実LIFFの addDays と同じ計算）。 */
function addDaysStr(date: string, days: number): string {
  const base = isValidYmd(date) ? date : jstDate()
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 月曜はじまりの週の7日を返す。 */
/** LIFF の週の並び（apps/liff DateTimePicker の WEEK_DAYS）と同じ5日ぶん。選んだ日から始める。 */
const WEEK_DAYS = 5

function daysFrom(date: string): string[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDaysStr(date, i))
}

function formatJpDay(date: string): string {
  return polishFormatDate(date, { style: 'day' })
}

function durationLabel(minutes: unknown): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return emptyValue('unknown')
  return `${polishFormatNumber(minutes)}分`
}

function priceLabel(menu: Pick<BookingMenu, 'price_mode' | 'base_price'>): string {
  if (menu.price_mode === 'free') return '無料'
  if (menu.price_mode === 'inquiry') return 'お問い合わせ'
  if (typeof menu.base_price !== 'number' || !Number.isFinite(menu.base_price) || menu.base_price < 0) {
    return emptyValue('unknown')
  }
  return `¥${polishFormatNumber(menu.base_price)}`
}

/** 写しの中の読み込み待ちの骨組み（札2枚の形。写し全体が role="img" のため読み上げは付けない）。 */
function PhoneListSkeleton() {
  return (
    <span aria-hidden="true">
      {[0, 1].map((i) => (
        <span key={i} className={styles.phoneCard}>
          <Skeleton width={48} height={48} />
          <span className={styles.phoneCardBody}>
            <Skeleton width="70%" height={15} />
            <Skeleton width="90%" height={12} />
          </span>
        </span>
      ))}
    </span>
  )
}

function PhoneChrome({ step, accountName, children }: { step: number; accountName?: string; children: React.ReactNode }) {
  return <LiffPhoneFrame accountName={accountName} step={step}>{children}</LiffPhoneFrame>
}

/** 写しのメニューカード。作りかけ（Pick だけ）でも描けるよう、使う欄だけを要求する。 */
type PhoneMenuCard = Pick<BookingMenu, 'id' | 'name' | 'description' | 'duration_minutes' | 'base_price' | 'price_mode'>

function MenuCard({ menu, picked, check }: { menu: PhoneMenuCard; picked?: boolean; check?: boolean }) {
  return (
    <div className={`${styles.phoneCard} ${picked ? styles.phoneCardPicked : ''}`}>
      <span className={styles.phoneThumb} aria-hidden="true" />
      <span className={styles.phoneCardBody}>
        <span className={styles.phoneCardName}>{menu.name}</span>
        {/* 説明が無くても1行ぶん空ける（カードの高さをそろえる。絵 owaS3 のシャンプーのみ）。 */}
        <span className={styles.phoneCardDesc}>{menu.description ?? ''}</span>
        <span className={styles.phoneCardMeta}>
          <span className={styles.phoneCardMin}>{durationLabel(menu.duration_minutes)}</span>
          <span className={styles.phoneCardPrice}>{priceLabel(menu)}</span>
        </span>
      </span>
      {check ? (
        <svg className={styles.phoneCardCheck} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M7 10 9 12 13 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg className={styles.phoneCardNext} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
    </div>
  )
}

/** ① メニューを選ぶ。draft は作りかけのメニュー（作る・直す画面から）。 */
export function LiffPhoneMenuStep({
  accountName,
  menus,
  draft,
  status = 'ready',
  categoryTone,
}: {
  menus: BookingMenu[]
  /** 作りかけ・直しかけのメニュー。先頭に選ばれた状態で出す（ の写し）。 */
  draft?: Pick<BookingMenu, 'id' | 'name' | 'category_label' | 'description' | 'duration_minutes' | 'base_price' | 'price_mode' | 'sort_order' | 'is_active' | 'auto_tag_id'> | null
  accountName?: string
  status?: 'loading' | 'ready' | 'error'
  categoryTone?: 'customer'
}) {
  const shown = menus.filter((m) => m.is_active).sort((a, b) => a.sort_order - b.sort_order)
  const list = draft ? [draft, ...shown.filter((m) => m.id !== draft.id)] : shown
  const categories = [...new Set(list.map((m) => m.category_label).filter((c): c is string => Boolean(c)))]
  return (
    <PhoneChrome accountName={accountName} step={1}>
      <div className={styles.phoneBody}>
        <h3 className={styles.phoneTitle}>メニューを選んでください</h3>
        {status === 'loading' ? (
          <DelayedSkeleton loading skeleton={<PhoneListSkeleton />} />
        ) : status === 'error' ? (
          <p className={styles.phoneSub}>読み込めませんでした。</p>
        ) : list.length === 0 ? (
          <p className={styles.phoneSub}>受付中のメニューはまだありません。</p>
        ) : (
          <>
            {categories.length > 0 && (
              <div className={styles.phoneCats}>
                <span className={`${styles.phoneCat} ${styles.phoneCatNow}`} data-category-tone={categoryTone}>すべて</span>
                {categories.slice(0, 3).map((c) => <span key={c} className={styles.phoneCat}>{c}</span>)}
              </div>
            )}
            {list.slice(0, 4).map((menu, i) => (
              <MenuCard key={menu.id} menu={menu} picked={draft ? menu.id === draft.id : i === 0} check={draft ? menu.id === draft.id : i === 0} />
            ))}
          </>
        )}
      </div>
      <div className={styles.phoneFoot}>
        <span className={`${styles.phoneCta} ${list.length === 0 ? styles.phoneCtaOff : ''}`}>
          担当を選ぶ
        </span>
      </div>
    </PhoneChrome>
  )
}

/** ② 担当を選ぶ。 */
export function LiffPhoneStaffStep({
  accountName,
  menu,
  staff,
  designationFree,
  status = 'ready',
}: {
  menu: BookingMenu | null
  staff: BookingStaff[]
  designationFree: boolean
  accountName?: string
  status?: 'loading' | 'ready' | 'error'
}) {
  const safeStaff = Array.isArray(staff) ? staff : []
  const shown = safeStaff.filter((s) => s.is_active).sort((a, b) => a.sort_order - b.sort_order)
  return (
    <PhoneChrome accountName={accountName} step={2}>
      <div className={styles.phoneBody}>
        <h3 className={styles.phoneTitle}>担当を選んでください</h3>
        {menu && (
          <p className={styles.phoneSub}>{menu.name}・{durationLabel(menu.duration_minutes)}・{priceLabel(menu)}</p>
        )}
        {status === 'loading' ? (
          <DelayedSkeleton loading skeleton={<PhoneListSkeleton />} />
        ) : status === 'error' ? (
          <p className={styles.phoneSub}>読み込めませんでした。</p>
        ) : (
          <>
            {designationFree && (
              <div className={`${styles.phoneCard} ${styles.phoneCardPicked}`}>
                <span className={`${styles.phoneAvatar} ${styles.phoneAvatarPlain}`} aria-hidden="true">
                  <Users size={20} aria-hidden="true" />
                </span>
                <span className={styles.phoneCardBody}>
                  <span className={styles.phoneCardName}>指名なし</span>
                  <span className={styles.phoneCardDesc}>いちばん早く空いている人</span>
                </span>
                <CircleCheck className={styles.phoneCardCheck} size={20} aria-hidden="true" />
              </div>
            )}
            {shown.length === 0 && !designationFree ? (
              <p className={styles.phoneSub}>担当できるスタッフはまだいません。</p>
            ) : (
              shown.slice(0, 3).map((person) => {
                const displayName = person.display_name || person.name || ''
                const fee = typeof person.nomination_fee === 'number' && Number.isFinite(person.nomination_fee) ? person.nomination_fee : 0
                return (
                  <div key={person.id} className={styles.phoneCard}>
                    <span className={`${styles.phoneThumb} ${styles.phoneAvatar}`} aria-hidden="true">{displayName.slice(0, 1)}</span>
                    <span className={styles.phoneCardBody}>
                      <span className={styles.phoneCardName}>{displayName}</span>
                      <span className={styles.phoneCardDesc}>{`${person.role ?? 'スタッフ'}・${fee > 0 ? `指名料 +¥${polishFormatNumber(fee)}` : '指名料なし'}`}</span>
                    </span>
                  </div>
                )
              })
            )}
          </>
        )}
      </div>
      <div className={styles.phoneFoot}>
        <span className={`${styles.phoneCta} ${status !== 'ready' || (shown.length === 0 && !designationFree) ? styles.phoneCtaOff : ''}`}>
          日時を選ぶ
        </span>
      </div>
    </PhoneChrome>
  )
}

/** ③ 日時を選ぶ。週の札＋その日の時刻。 */
export function LiffPhoneDatetimeStep({
  accountName,
  menu,
  staffName,
  slots,
  closedDates,
  closedWeekdays,
  view,
  status = 'ready',
}: {
  menu: BookingMenu | null
  staffName: string | null
  slots: BookingAvailabilitySlot[]
  closedDates: string[]
  /** 定休日（毎週の休み）。開ける時間が未設定なら空。 */
  closedWeekdays: number[]
  /** 設定画面の「最初の形」。 */
  view: 'list' | 'calendar'
  accountName?: string
  status?: 'loading' | 'ready' | 'error'
}) {
  const safeSlots = Array.isArray(slots) ? slots : []
  const byDate = new Map<string, BookingAvailabilitySlot[]>()
  for (const slot of safeSlots) {
    if (!slot || !isValidYmd(slot.date)) continue
    const list = byDate.get(slot.date) ?? []
    list.push(slot)
    byDate.set(slot.date, list)
  }
  const openDates = [...byDate.keys()].sort()
  // 見本は「空きのある先頭の日」から5日（LIFF で日を選んで戻ってきたときと同じ並び）。無ければ今日から。
  const anchor = openDates[0] ?? jstDate()
  const days = daysFrom(anchor)
  const closed = new Set(Array.isArray(closedDates) ? closedDates : [])
  const closedDow = new Set(Array.isArray(closedWeekdays) ? closedWeekdays : [])
  const selected = status === 'ready' ? (openDates[0] ?? null) : null
  const selectedSlots = selected ? (byDate.get(selected) ?? []) : []
  const pickedSlot = selectedSlots.find((slot) => slot.remaining > 0) ?? selectedSlots[0] ?? null

  return (
    <PhoneChrome accountName={accountName} step={3}>
      <div className={styles.phoneBody}>
        <h3 className={styles.phoneTitle}>日時を選んでください</h3>
        {menu && (
          <p className={styles.phoneSub}>{menu.name}・{staffName ?? '指名なし'}</p>
        )}
        <div className={styles.phoneViewSwitch} aria-hidden="true">
          <span className={`${styles.phoneViewItem} ${view === 'list' ? styles.phoneViewItemNow : ''}`}>週で見る</span>
          <span className={`${styles.phoneViewItem} ${view === 'calendar' ? styles.phoneViewItemNow : ''}`}>カレンダー</span>
        </div>
        <div className={styles.phoneDays}>
          <ChevronLeft className={styles.phoneDayNav} aria-hidden="true" />
          {days.map((date) => {
            const d = new Date(`${date}T00:00:00Z`)
            const hasSlots = status === 'ready' && (byDate.get(date)?.length ?? 0) > 0
            const isClosed = closed.has(date) || closedDow.has(d.getUTCDay())
            const isNow = date === selected
            const state = isClosed ? '休み' : status !== 'ready' ? emptyValue('unknown') : hasSlots ? '空き' : '満'
            return (
              <span
                key={date}
                className={`${styles.phoneDay} ${isNow ? styles.phoneDayNow : ''} ${isClosed ? styles.phoneDayOff : status === 'ready' && !hasSlots ? styles.phoneDayFull : ''}`}
              >
                <span className={styles.phoneDayDow}>{WEEKDAY_JP[d.getUTCDay()]}</span>
                <span className={styles.phoneDayNum}>{d.getUTCDate()}</span>
                <span className={styles.phoneDayState}>{state}</span>
              </span>
            )
          })}
          <ChevronRight className={styles.phoneDayNav} aria-hidden="true" />
        </div>
        {selected && (
          <p className={styles.phoneSectionLabel}>{formatJpDay(selected)}の空き</p>
        )}
        {selected && selectedSlots.length > 0 && (
          <div className={styles.phoneSlots}>
            {selectedSlots.slice(0, 6).map((slot) => (
              <span
                key={`${slot.date}-${slot.start}`}
                className={`${styles.phoneSlot} ${slot === pickedSlot ? styles.phoneSlotNow : ''} ${slot.remaining <= 0 ? styles.phoneSlotOff : ''}`}
              >
                {slot.start}
              </span>
            ))}
          </div>
        )}
        {status === 'loading' ? (
          <DelayedSkeleton
            loading
            skeleton={
              <span className={styles.phoneSlots} aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} width="100%" height={36} />
                ))}
              </span>
            }
          />
        ) : status === 'error' ? (
          <p className={styles.phoneSub}>空きを読み込めませんでした。</p>
        ) : selected === null ? (
          <p className={styles.phoneSub}>この期間に空きはありません。</p>
        ) : null}
      </div>
      <div className={styles.phoneFoot}>
        {pickedSlot && selected && (
          <span className={styles.phoneFootPick}>
            {formatJpDay(selected)}{pickedSlot.start}〜{pickedSlot.end}
          </span>
        )}
        <span className={`${styles.phoneCta} ${pickedSlot ? '' : styles.phoneCtaOff}`}>
          内容を確かめる
        </span>
      </div>
    </PhoneChrome>
  )
}
