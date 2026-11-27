import { formatYen } from '@line-crm/shared';
import type { VisitStampSettings } from '@line-crm/shared';
import { formatDateTimeLong } from '../lib/datetime.js';

const hm = (minute: number) => `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
const day = (value: string, timeZone: string) => formatDateTimeLong(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`, timeZone);
export default function StampConditions({ settings: s }: { settings: VisitStampSettings }) {
  const rules: string[] = [s.mode === 'visit' ? '1回の来店で1個' : `お会計${formatYen(s.amountUnit).replace(/^¥/, '')}円ごとに1個`];
  if (s.receiptBonus) rules.push(`カードを受け取ると${s.receiptBonus}個`);
  if (s.firstVisitBonus) rules.push(`初回の来店は${s.firstVisitBonus}個追加`);
  for (const m of s.multipliers.filter(m => m.active !== false)) {
    const conditions = [
      m.from ? `${day(m.from, s.timezone)}から` : '', m.to ? `${day(m.to, s.timezone)}まで` : '',
      m.weekdays?.length ? m.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6) ? m.weekdays.map(d => '日月火水木金土'[d]).join('・') + '曜日' : '対象の曜日を確認できません' : '',
      m.startMinute != null && m.endMinute != null ? `${hm(m.startMinute)}〜${hm(m.endMinute)}` : '',
    ].filter(Boolean).join('・');
    rules.push(`${m.name || 'スタンプ倍率'}：${m.multiplier}倍${conditions ? `（${conditions}）` : ''}`);
  }
  for (const rank of s.rankMultipliers.filter(m => m.active !== false)) rules.push(`${rank.name || rank.tagName}の方は${rank.multiplier}倍`);
  if (s.multipliers.some(m => m.active !== false) || s.rankMultipliers.some(m => m.active !== false)) {
    rules.push(s.stackingOrder === 'multipliers_then_bonus' ? '倍率をかけてから初回ボーナスを足します' : s.stackingOrder == null || s.stackingOrder === 'bonus_then_multipliers' ? '初回ボーナスを足してから倍率をかけます' : '倍率と初回ボーナスの適用順を確認できません');
    rules.push('同時に当てはまる倍率は重ねます。ランクの倍率は一番高いものを使います');
  }
  if (s.maxStackedStamps != null) rules.push(`倍率前は1回${s.maxPerVisit}個まで、重ねたあとは${s.maxStackedStamps}個まで（端数は切り捨て）`);
  else rules.push(`1回の上限は${s.maxPerVisit}個（端数は切り捨て）`);
  if (s.stampInterval?.mode === 'same_day') rules.push('スタンプは1日1回まで');
  if (s.stampInterval?.mode === 'hours') rules.push(`次のスタンプまで${s.stampInterval.hours}時間空けてください`);
  return <section className="space-y-2" aria-label="スタンプがたまる条件">
    <h2 className="text-xs font-semibold text-ink">スタンプがたまる条件</h2>
    <ul className="space-y-0.5 text-xs text-ink-secondary">{rules.map((rule, i) => <li key={i}>{rule}</li>)}</ul>
    <p className="text-xs text-ink-secondary">曜日・時間は{ s.timezone === 'Asia/Tokyo' ? '日本時間' : s.timezone }で判定します</p>
  </section>;
}
