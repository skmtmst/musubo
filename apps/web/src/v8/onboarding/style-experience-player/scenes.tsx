'use client'

import { Check, CircleCheck, Minus, Plus } from 'lucide-react'
import type { AccountStyle, IndustryStyle, ReservationBoardEntry } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import LiffPhoneFrame from '@/components/shared/liff-phone-frame'
import MusuboMark from '@/components/shared/musubo-mark'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import ReservationBoard from '@/components/shared/reservation-board'
import RestaurantFloorMap from '@/components/shared/restaurant-floor-map'
import { Tabs } from '@/components/shared/tabs'
import { formatDate } from '@/lib/format'
import { jstDateOffset } from '@/lib/jst-datetime'
import { styleTerm } from '@/lib/terms'
import { LiffPhoneDatetimeStep, LiffPhoneMenuStep, LiffPhoneStaffStep } from '@/v8/booking-menus/public/liff-phone/index'
import { FormPhone } from '@/v8/form-edit/public/phone/index'
import { SideCard, StaffBoard, STYLE_CONFIG, styleMetricLabel, TodayList, type TodayListColumn } from '@/v8/style-dashboard/public/sample-parts/index'
import { SampleMenuTiles } from '../sample-menu'
import sampleStyles from '../sample-menu.module.css'
import type { BoardScene, CommonMetricId, DashboardScene, PhoneScene, RelativeTime, SampleKpi, SampleReservation, StyleExperienceStyle } from './script-types'
import styles from './player.module.css'

/*
 * 3 つの画面（お客さまのスマホ・管理のダッシュボード・予約の盤）。全部、本線の部品に作り物のデータを渡すだけ。
 * 押す口は空の関数・書ける形にしない（器の inert で押せない）。
 */

const noop = () => {}
const INDUSTRY: ReadonlySet<AccountStyle> = new Set(['restaurant', 'salon', 'consult', 'lesson'])
export const isIndustryStyle = (style: AccountStyle): style is IndustryStyle => INDUSTRY.has(style)

const COMMON_LABEL: Record<CommonMetricId, string> = { friends: '友だち', unreplied: '返していない', deliveries: '今月の配信', orders: '今日の注文' }

/** 「何日後・何時」を日本時間の瞬間（ISO）へ。読めない日時は例外を投げず空文字を返す。 */
export function relativeIso(at: RelativeTime, base: Date): string {
  if (!(base instanceof Date) || !Number.isFinite(base.getTime())) return ''
  if (!Number.isFinite(at.day) || typeof at.time !== 'string') return ''
  const match = /^(\d{1,2}):(\d{2})$/.exec(at.time.trim())
  if (!match) return ''
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return ''
  const date = new Date(`${jstDateOffset(Math.trunc(at.day), base)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function relativeLabel(at: RelativeTime, base: Date) {
  const iso = relativeIso(at, base)
  if (!iso) return '日時を確認できません'
  return `${formatDate(iso, { style: 'day', now: base })} ${at.time.trim()}`
}

/* ── 左：お客さまのスマホ ───────────────────────────────── */

export function PhonePane({ phone, style, look, base }: { phone: PhoneScene; style: AccountStyle; look: StyleExperienceStyle; base: Date }) {
  switch (phone.part) {
    case 'seat-pick': {
      const data = phone.data
      return <LiffPhoneFrame title={phone.title} accountName={look.account} step={phone.step} steps={['人数・日時・コース', '確認']}
        footer={<div className={styles.liffFoot}><span className={styles.liffCta}>確認へ進む</span></div>}>
        <div className={styles.liffBody}>
          <div className={styles.liffRow}><span className={styles.liffLabel}>人数</span><span className={styles.liffStepper}><Minus aria-hidden="true" /><strong>{`${data.guestCount}名`}</strong><Plus aria-hidden="true" /></span></div>
          <div className={styles.liffRow}><span className={styles.liffLabel}>日にち</span><strong>{formatDate(relativeIso(data.date, base), { style: 'day', now: base })}</strong></div>
          <div className={styles.liffTimes}>{data.times.map(slot => <span key={slot.time} className={styles.liffTime} data-picked={slot.time === data.picked || undefined} data-full={!slot.available || undefined}>{slot.available ? slot.time : `${slot.time} 満席`}</span>)}</div>
          <div className={styles.liffRow}><span className={styles.liffLabel}>コース</span><strong>{data.course}</strong></div>
        </div>
      </LiffPhoneFrame>
    }
    case 'booking-facts': {
      const data = phone.data
      return <LiffPhoneFrame title={phone.title} accountName={look.account} step={phone.step} steps={phone.steps}>
        <div className={styles.liffBody}>
          <div className={styles.liffDone}>{data.done ? <CircleCheck aria-hidden="true" className={styles.liffDoneIcon} /> : null}<strong>{data.heading}</strong>{data.body ? <span className={styles.liffSub}>{data.body}</span> : null}</div>
          <dl className={styles.liffFacts}>{data.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{'at' in fact ? relativeLabel(fact.at, base) : fact.label === 'お店' ? look.account : fact.value}</dd></div>)}</dl>
        </div>
      </LiffPhoneFrame>
    }
    case 'booking-menu': return <LiffPhoneMenuStep {...phone.data} accountName={look.account} />
    case 'booking-staff': return <LiffPhoneStaffStep {...phone.data} accountName={look.account} />
    case 'booking-datetime': return <LiffPhoneDatetimeStep {...phone.data} accountName={look.account} slots={phone.data.slots.map(({ day, ...slot }) => {
      const date = jstDateOffset(day, base)
      return { ...slot, date, startUtc: `${date}T${slot.start}:00+09:00`, endUtc: `${date}T${slot.end}:00+09:00` }
    })} />
    case 'form': return <FormPhone {...phone.data} accountName={look.account} />
    case 'line-talk': {
      const data = phone.data
      const avatar = <span className={sampleStyles.avatar}><MusuboMark /></span>
      return <LinePreview title={null} accountName={look.account} caption={data.caption}
        richMenu={data.richMenu && look.richMenu ? <SampleMenuTiles style={style} buttons={look.richMenu} size="phone" /> : undefined}>
        {data.messages.map((message, index) => message.from === 'shop'
          ? <LinePreviewMessage key={index} accountName={look.account} avatar={avatar} time={message.time}>{message.text}</LinePreviewMessage>
          : <LinePreviewMessage key={index} accountName="" avatar={null} time={message.time} direction="outgoing">{message.text}</LinePreviewMessage>)}
      </LinePreview>
    }
  }
}

/* ── 中：管理のダッシュボード ───────────────────────────── */

/** 縮めた中で 1 行に入る列だけ（業種ダッシュボードの一覧と同じ列の名前・幅）。 */

const ROW_COLUMNS: Record<IndustryStyle, TodayListColumn[]> = {
  restaurant: [{ key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' }, { key: 'name', label: '名前' }, { key: 'seat', label: '卓', width: 'var(--tpl-sd-col-seat)' }, { key: 'state', label: '状態', width: 'var(--tpl-sd-col-state)' }],
  salon: [{ key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' }, { key: 'name', label: '名前' }, { key: 'state', label: '状態', width: 'var(--tpl-sd-col-state)' }],
  consult: [{ key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' }, { key: 'name', label: '相談者' }, { key: 'state', label: '状態', width: 'var(--tpl-sd-col-state)' }],
  lesson: [{ key: 'time', label: '時刻', width: 'var(--tpl-sd-col-time)' }, { key: 'name', label: 'クラス' }, { key: 'fill', label: '予約／定員', width: 'var(--tpl-sd-col-fill)' }],
}

function kpiLabel(kpi: SampleKpi, style: AccountStyle) {
  return isIndustryStyle(style) && !(kpi.metric in COMMON_LABEL) ? styleMetricLabel(kpi.metric, style) : COMMON_LABEL[kpi.metric as CommonMetricId]
}

/** 数の帯。全部版のダッシュボードと最小版で同じ物を使う。 */
export function SampleKpiBand({ kpis, style }: { kpis: SampleKpi[]; style: AccountStyle }) {
  return <KpiBand maxColumns={3} frame="card">
    {kpis.map(kpi => <KpiCard key={kpi.metric} presentation="band" title={kpiLabel(kpi, style)} value={kpi.value} valueText={kpi.valueText} unit={kpi.unit} detail="" />)}
  </KpiBand>
}

export function DashboardPane({ dashboard, style }: { dashboard: DashboardScene; style: AccountStyle }) {
  const industry = isIndustryStyle(style) ? STYLE_CONFIG[style] : null
  const title = industry?.title ?? styleTerm(style, 'V02')
  return <div className={styles.dashboard}>
    <div className={styles.dashHead}>
      <h3 className={styles.dashTitle}>{title}</h3>
      {industry ? <Button variant="primary" size="compact"><Plus size={16} aria-hidden="true" />{industry.primary}</Button> : null}
    </div>
    <SampleKpiBand kpis={dashboard.kpis} style={style} />
    {industry ? <Tabs label="ダッシュボードの切り替え" items={Object.values(industry.tabs).map((label, index) => ({ label, current: index === 0, onClick: noop }))} /> : null}
    {industry && isIndustryStyle(style) && dashboard.rows?.length ? <TodayList style={style} rows={dashboard.rows} note="" canWrite={false} busyId="" menuFor={() => []} onVisit={noop} onUndo={noop} columnsOverride={ROW_COLUMNS[style]} /> : null}
    {dashboard.side?.map(card => <SideCard key={card.id} card={card} canWrite={false} />)}
    {dashboard.cards?.length ? <div className={styles.dashCards}>{dashboard.cards.map(({ card }) => <SideCard key={card.id} card={card} canWrite={false} />)}</div> : null}
  </div>
}

/* ── 右：予約の盤 ─────────────────────────────────── */

function toEntry({ day, start, end, ...entry }: SampleReservation, base: Date): ReservationBoardEntry {
  return { ...entry, startsAt: relativeIso({ day, time: start }, base), endsAt: relativeIso({ day, time: end }, base) }
}

export function BoardPane({ board, base }: { board: BoardScene; base: Date }) {
  switch (board.kind) {
    case 'reservation-board': return <ReservationBoard kind="seats" axis="resource" entries={board.data.entries.map(entry => toEntry(entry, base))} resources={board.data.resources} selectedId={board.selectedId} onOpen={noop} />
    case 'floor-map': return <Card layout="vertical" aria-label="座席表" contentPadding="var(--polish-space-card)" gap="var(--polish-space-field)">
      <h3 className={styles.dashTitle}>座席表</h3>
      <RestaurantFloorMap floor={board.data.floor} labels={board.data.resources} onSelect={noop} />
    </Card>
    case 'staff-board': return <StaffBoard board={board.data} search="" onSearch={noop} canWrite={false} entryItems={() => []} onSlot={noop} />
    case 'cards': return <div className={styles.dashCards}>{board.data.map(card => <SideCard key={card.id} card={card} canWrite={false} />)}</div>
  }
}

/** できること 3 行（外の画面が持つ時は出さない）。 */
export function CanList({ look }: { look: StyleExperienceStyle }) {
  return <ul className={styles.can} aria-label={`${look.label}でできること`}>
    {look.can.map(can => <li key={can.text}><Check aria-hidden="true" className={styles.canIcon} />{can.text}</li>)}
  </ul>
}
