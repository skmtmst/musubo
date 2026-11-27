import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/*
 * 来店スタンプ（V8 w4SBbv）の見せ方の決まり。画面から切り離した純粋な関数だけを置く（試験は display.test.ts）。
 * 設定の形は @line-crm/shared の VisitStampSettings（サーバと同じ）。ここで形を変えない。
 */
import type { VisitStampEntry, VisitStampMultiplier, VisitStampReward, VisitStampSettings } from '@line-crm/shared'
import { formatDate as polishFormatDate } from '@/lib/format'


export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const
const TZ = 'Asia/Tokyo'

/** 新しいカードの最初の設定。サーバの検査（特典1つ以上・上限1以上）を通る形。 */
export function defaultSettings(): VisitStampSettings {
  return {
    mode: 'visit', amountUnit: 1000, maxPerVisit: 5, firstVisitBonus: 0, expiryMonths: 6, timezone: TZ,
    slotCount: 10, stackingOrder: 'bonus_then_multipliers',
    expiryBasis: 'last_visit', expiryReminder: 'none', completion: 'repeat', receiptBonus: 0,
    instructions: '', stampInterval: { mode: 'same_day' },
    multipliers: [], rankMultipliers: [],
    rewards: [{ id: 'reward-1', name: 'ドリンク 1杯', stamps: 10 }],
  }
}

/** マスの数。カードの設定（slotCount）を使う。無い古いカードは、いちばん大きい特典の個数。 */
export function slotCount(settings: VisitStampSettings): number {
  return settings.slotCount ?? Math.max(0, ...settings.rewards.map((r) => r.stamps))
}

/** マスの数を変える。特典の個数とは別に持つ（マスより大きい特典は、マスの数に詰める）。 */
export function withSlotCount(settings: VisitStampSettings, count: number): VisitStampSettings {
  return {
    ...settings,
    slotCount: count,
    rewards: settings.rewards.map((r) => (r.stamps > count ? { ...r, stamps: count } : r)),
  }
}

/** 重ねたときの順番（口の stackingOrder）。 */
export const STACKING_ORDERS = [
  { value: 'bonus_then_multipliers', label: '初回ボーナスを足してから倍率' },
  { value: 'multipliers_then_bonus', label: '倍率のあとで初回ボーナス' },
] as const

/** 重ねたときの上限。設定が無い古いカードは「1回の上限」がそのまま重ねた後にかかる。 */
export function stackedCap(settings: VisitStampSettings): number {
  return settings.maxStackedStamps ?? settings.maxPerVisit
}

export function sortedRewards(rewards: VisitStampReward[]): VisitStampReward[] {
  return [...rewards].sort((a, b) => a.stamps - b.stamps)
}

/**
 * 特典の下の1行。サーバは使うと特典の個数だけスタンプを減らす。
 * いちばん大きい特典はカードが空になる＝「新しいカードへ」。途中の特典は減る数をそのまま書く。
 */
export function rewardNote(reward: VisitStampReward, settings: VisitStampSettings): string {
  return reward.stamps >= Math.max(...settings.rewards.map(r => r.stamps))
    ? settings.completion === 'next_card' ? '使ったら次のカードへ' : '使ったら新しいカードへ'
    : `使うとスタンプが ${reward.stamps} 個へる`
}

export function expiryLabel(months: number | null, basis: VisitStampSettings['expiryBasis'] = 'last_visit'): string {
  return months === null || basis === 'none' ? '期限なし' : `${basis === 'first_visit' ? '最初' : '最後'}の来店から ${months}か月`
}
export function previewExpiry(months: number | null, basis: VisitStampSettings['expiryBasis'], at = new Date()): string {
  if(months === null || basis === 'none') return '期限なし'
  const date = japanCalendar(at), day = date.getUTCDate()
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months)
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()))
  const label = polishFormatDate(new Date(date.getTime() - 9 * 3_600_000), { style: 'list-day' })
  return `有効期限 ${label}（${expiryLabel(months, basis)}）`
}

export type Slot = { n: number; state: 'done' | 'reward' | 'empty' }
/** お客さまの見え方のマス。filled 個まで済み、特典のマスは「特典」。 */
export function previewSlots(settings: VisitStampSettings, filled: number): Slot[] {
  const total = slotCount(settings)
  const rewardAt = new Set(settings.rewards.map((r) => r.stamps))
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1
    return { n, state: n <= filled ? 'done' : rewardAt.has(n) ? 'reward' : 'empty' }
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
export const minuteLabel = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

function monthDay(iso: string, minusDay = false): string {
  return polishFormatDate(new Date(Date.parse(iso) - (minusDay ? 86_400_000 : 0)), { style: 'list-day' })
}

/** 倍率の名前。付けた名前があればそれ。無ければ「2倍デー」（曜日か時間）・「2倍の期間」（期間だけ）・「いつも 2倍」。 */
export function multiplierName(m: VisitStampMultiplier): string {
  if (m.name?.trim()) return m.name.trim()
  const n = trimNumber(m.multiplier)
  if (m.weekdays?.length || m.startMinute !== undefined) return `${n}倍デー`
  if (m.from || m.to) return `${n}倍の期間`
  return `いつも ${n}倍`
}

/** 「毎週 火曜 17:00〜19:00 ・ 1/1〜3/31」。to はその日を含まない時刻なので1日戻して見せる。 */
export function multiplierDetail(m: VisitStampMultiplier): string {
  const when: string[] = []
  if (m.weekdays?.length) when.push(`毎週 ${[...m.weekdays].sort().map((d) => `${WEEKDAYS[d]}曜`).join('・')}`)
  if (m.startMinute !== undefined && m.endMinute !== undefined) when.push(`${minuteLabel(m.startMinute)}〜${minuteLabel(m.endMinute)}`)
  const parts = when.length ? [when.join(' ')] : []
  if (m.from || m.to) parts.push(`${m.from ? monthDay(m.from) : ''}〜${m.to ? monthDay(m.to, true) : ''}`)
  return parts.join('・') || 'いつでも'
}

export function rankDetail(settings: VisitStampSettings): string {
  return settings.rankMultipliers.length
    ? settings.rankMultipliers.map((r) => `${r.name?.trim() || r.tagName} ${trimNumber(r.multiplier)}倍${r.active === false ? '（止めています）' : ''}`).join('・')
    : 'タグごとに倍率を決めます'
}

export function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/** 日付と時刻「1/13 18:40」（店の暦＝日本時間）。 */
export function shortDateTime(iso: string): string {
  return polishFormatDate(iso, { style: 'list', fallback: '—' })
}

export type HistoryRow = { id: string; friendId: string; at: string; count: string; why: string; actor: string; reversible: boolean; reversed: boolean }

/**
 * 記録の行。取り消し（reverse）は元の行にまとめて「+1 個 → 取り消し」と書く（理由と誰が は取り消しのもの）。
 * name は担当者の ID → 名前。読めない ID はそのまま出さず「担当者」にする。
 */
export function historyRows(entries: VisitStampEntry[], name: (id: string) => string | undefined): HistoryRow[] {
  const reversedBy = new Map(entries.filter((e) => e.kind === 'reverse' && e.originalId).map((e) => [e.originalId!, e]))
  const who = (id: string | null) => (id ? name(id) ?? '担当者' : '自動')
  return entries
    .filter((e) => e.kind !== 'reverse')
    .map((e) => {
      const reverse = reversedBy.get(e.id)
      const sign = e.delta >= 0 ? '+' : '−'
      const amount = `${sign}${Math.abs(e.delta)} 個`
      const count = reverse ? `${amount} → 取り消し` : e.kind === 'redeem' ? `${amount}（特典）` : amount
      let why = e.reason || KIND_LABEL[e.kind] || e.kind
      if (e.kind === 'redeem') why = `${e.reason}を使った`
      if (e.kind === 'paper') why = '紙のカードから移行'
      if (e.kind === 'visit' && !e.reason) why = '来店'
      let actor = who(e.actorId)
      if (e.kind === 'redeem' && e.actorId) actor = `店員：${actor}（暗証番号）`
      else if (e.kind === 'visit' && e.actorId) actor = `店員：${actor}`
      else if (e.kind === 'paper' && e.actorId) actor = `${actor}（承認）`
      if (reverse) { why = reverse.reason; actor = who(reverse.actorId) }
      return {
        id: e.id, friendId: e.friendId, at: e.createdAt, count, why, actor,
        reversed: !!reverse,
        reversible: !reverse && e.delta !== 0 && ['visit', 'manual', 'paper', 'redeem'].includes(e.kind),
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
}

const KIND_LABEL: Record<string, string> = Object.assign(Object.create(null), {
  visit: '来店', manual: '店で手入力', paper: '紙のカードから移行', redeem: '特典を使った', restore: '取り消しを戻した', expire: '期限切れ',
})

/** 手入力の理由。紙のカードからのものは台帳で「紙」として残す（source: paper）。 */
export const MANUAL_REASONS = [
  { value: 'paper', label: '紙のカードから移す' },
  { value: 'forgot', label: '押し忘れ' },
  { value: 'apology', label: 'おわび' },
  { value: 'other', label: 'そのほか' },
] as const
export type ManualReason = (typeof MANUAL_REASONS)[number]['value']

export function manualReasonText(reason: ManualReason, memo: string): string {
  const label = MANUAL_REASONS.find((r) => r.value === reason)?.label ?? 'そのほか'
  return memo.trim() ? `${label}：${memo.trim()}` : label
}

/** 友だちの見せ方。氏名（友だち情報の name）があれば「氏名（LINE：表示名）」、無ければ表示名だけ。 */
export function friendNames(friend: { displayName?: string | null; metadata?: Record<string, unknown> | null }): { name: string; line: string | null } {
  const meta = friend.metadata?.name ?? friend.metadata?.氏名
  const display = friend.displayName?.trim() || '名前なし'
  return typeof meta === 'string' && meta.trim() ? { name: meta.trim(), line: display } : { name: display, line: null }
}

export function friendLabel(friend: { displayName?: string | null; metadata?: Record<string, unknown> | null }): string {
  const n = friendNames(friend)
  return n.line ? `${n.name}（LINE：${n.line}）` : n.name
}

/** 設定の検査（サーバと同じ境目）。保存の前に、どこを直せばよいかを日本語で返す。 */
export type StampSettingField = 'name' | 'instructions' | 'receiptBonus' | 'intervalHours' | 'nextCardId' | 'rewards' | 'amountUnit' | 'maxPerVisit'
export function settingsRangeIssues(s: VisitStampSettings): Partial<Record<'receiptBonus' | 'intervalHours', string>> {
  const result: Partial<Record<'receiptBonus' | 'intervalHours', string>> = {}
  if (s.receiptBonus !== undefined && (!Number.isInteger(s.receiptBonus) || s.receiptBonus < 0 || s.receiptBonus > 50)) result.receiptBonus = '受け取りボーナスは0〜50個です。'
  if (s.stampInterval?.mode === 'hours' && (!Number.isInteger(s.stampInterval.hours) || s.stampInterval.hours! < 1 || s.stampInterval.hours! > 23)) result.intervalHours = '押印の間隔は1〜23時間です。'
  return result
}
export function settingsIssue(name: string, s: VisitStampSettings): { field: StampSettingField; message: string } | null {
  if (!name.trim()) return { field: 'name', message: 'カードの名前を入れてください。' }
  if (s.instructions !== undefined && [...s.instructions].length > 500) return { field: 'instructions', message: '使い方の説明は500字までです。' }
  const ranges = settingsRangeIssues(s)
  if (ranges.receiptBonus) return { field: 'receiptBonus', message: ranges.receiptBonus }
  if (ranges.intervalHours) return { field: 'intervalHours', message: ranges.intervalHours }
  if (s.completion === 'next_card' && !s.nextCardId) return { field: 'nextCardId', message: '次のカードを選んでください。' }
  if (!s.rewards.length) return { field: 'rewards', message: '特典を1つ以上足してください。' }
  if (s.rewards.some((r) => !r.name.trim() || !Number.isInteger(r.stamps) || r.stamps < 1)) return { field: 'rewards', message: '特典の名前と個数を確かめてください。' }
  if (s.mode === 'amount' && (!Number.isInteger(s.amountUnit) || s.amountUnit < 1)) return { field: 'amountUnit', message: '何円ごとに 1個 かを入れてください。' }
  if (!Number.isInteger(s.maxPerVisit) || s.maxPerVisit < 1) return { field: 'maxPerVisit', message: '1回の上限を 1個 以上にしてください。' }
  if (s.slotCount !== undefined && s.rewards.some((r) => r.stamps > (s.slotCount ?? 0))) return { field: 'rewards', message: '特典の個数をマスの数以下にしてください。' }
  return null
}
export function settingsProblem(name: string, s: VisitStampSettings): string | null {
  return settingsIssue(name, s)?.message ?? null
}
