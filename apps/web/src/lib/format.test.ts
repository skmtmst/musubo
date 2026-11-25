import { describe, expect, it } from 'vitest'
import {
  formatBig,
  formatDashRange,
  formatListDateTime,
  formatListDay,
  formatCount,
  formatDay,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatPointDiff,
  formatRange,
  formatRelative,
  formatTime,
  formatYen,
} from './format'

// 2026-09-30 00:48 JST = 2026-09-29 15:48 UTC
const NOW = '2026-09-29T15:48:00Z'

describe('★管理画面 日付と数の書き方（板 ZzBqa §2）', () => {
  it('日時は今年なら M月D日 H:mm、秒も年も出さない', () => {
    expect(formatDateTime('2026-09-29T15:48:00Z', '—', NOW)).toBe('9月30日 00:48')
    expect(formatDateTime('2026-09-29T15:48:59Z', '—', NOW)).toBe('9月30日 00:48')
  })

  it('今年と前年は年を省き、それより古い年には YYYY年 を付ける', () => {
    expect(formatDateTime('2025-04-03T01:00:00Z', '—', NOW)).toBe('4月3日 10:00')
    expect(formatDateTime('2024-04-03T01:00:00Z', '—', NOW)).toBe('2024年4月3日 10:00')
  })

  it('PCの地域に左右されない（UTC入力が必ずJSTで出る）', () => {
    expect(formatDateTime('2026-09-30T15:00:00Z', '—', NOW)).toBe('10月1日 00:00')
  })

  it('日付だけは M月D日（曜）', () => {
    expect(formatDay('2026-10-03T15:00:00Z', '—', NOW)).toBe('10月4日（日）')
    expect(formatDay('2025-04-03T01:00:00Z', '—', NOW)).toBe('4月3日（木）')
    expect(formatDay('2024-04-03T01:00:00Z', '—', NOW)).toBe('2024年4月3日（水）')
  })

  it('近い時刻: 24時間以内は たった今・◯分前・◯時間前、それより前は M月D日 H:mm', () => {
    expect(formatRelative('2026-09-29T15:48:00Z', NOW)).toBe('たった今')
    expect(formatRelative('2026-09-29T15:45:00Z', NOW)).toBe('3分前')
    expect(formatRelative('2026-09-29T10:48:00Z', NOW)).toBe('5時間前')
    expect(formatRelative('2026-09-28T15:49:00Z', NOW)).toBe('23時間前')
    expect(formatRelative('2026-09-28T15:48:00Z', NOW)).toBe('24時間前')
    expect(formatRelative('2026-09-28T15:47:59Z', NOW)).toBe('9月29日 00:47')
    expect(formatRelative('2026-09-28T15:47:00Z', NOW)).toBe('9月29日 00:47')
    expect(formatRelative('2026-09-28T15:10:00Z', NOW)).toBe('9月29日 00:10')
    expect(formatRelative('2025-09-20T15:48:00Z', NOW)).toBe('9月21日 00:48')
    expect(formatRelative('2024-09-20T15:48:00Z', NOW)).toBe('2024年9月21日 00:48')
  })

  it('期間は同じ月なら後ろの月を省く', () => {
    expect(formatRange('2026-09-01', '2026-09-30')).toBe('9月1日〜9月30日')
    expect(formatRange('2026-09-28', '2026-10-03')).toBe('9月28日〜10月3日')
  })

  it('件数・人数は3桁カンマ＋単位、0は「0件」', () => {
    expect(formatCount(12480, '人')).toBe('12,480 人')
    expect(formatCount(3, '件')).toBe('3 件')
    expect(formatCount(0, '件')).toBe('0 件')
  })

  it('大きな数は1万2千以上で △△万（目盛り用）', () => {
    expect(formatBig(11999)).toBe('11,999')
    expect(formatBig(12480)).toBe('1.2万')
    expect(formatBig(20000)).toBe('2万')
    expect(formatBig(125000)).toBe('12.5万')
  })

  it('割合は小数1桁、差はpt', () => {
    expect(formatPercent(48.2)).toBe('48.2%')
    expect(formatPercent(48)).toBe('48.0%')
    expect(formatPointDiff(-1.1)).toBe('-1.1pt')
    expect(formatPointDiff(2)).toBe('+2.0pt')
  })

  it('お金は ¥＋3桁カンマ', () => {
    expect(formatYen(12400)).toBe('¥12,400')
    expect(formatYen(0)).toBe('¥0')
  })

  it('請求と同じく1円未満を切り捨て、取消料の端数を上乗せしない', () => {
    expect(formatYen(1001 * 33 / 100)).toBe('¥330')
    expect(formatYen(1001 * 50 / 100)).toBe('¥500')
    expect(formatYen(12400.99)).toBe('¥12,400')
  })

  it('読めない値はフォールバック、numberは有限だけ', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('not-a-date', '?')).toBe('?')
    expect(formatNumber(NaN)).toBe('—')
    expect(formatRelative(undefined, NOW, '未実施')).toBe('未実施')
  })

  it('ダッシュでつなぐ時刻・日付の範囲は左右に半角の空白を入れる', () => {
    expect(formatDashRange('17:00', '翌0:00')).toBe('17:00 – 翌0:00')
    expect(formatDashRange('11:00', '15:00')).toBe('11:00 – 15:00')
    expect(formatDashRange('12/31', '1/3')).toBe('12/31 – 1/3')
  })

  it('formatTime は秒を出さない', () => {
    expect(formatTime('2026-09-29T15:48:59Z')).toBe('00:48')
  })
})

// UTCの日付とJSTの日付が違う境界・前年・無効値を守る。
describe('一覧と詳細の書式', () => {
  it('一覧は今年だけ年を省き、前年も含めた別年は年を出す', () => {
    expect(formatListDateTime('2026-10-08T01:12:00Z', '—', NOW)).toBe('10/08 10:12')
    expect(formatListDateTime('2025-10-08T01:12:00Z', '—', NOW)).toBe('2025/10/08 10:12')
    expect(formatListDateTime('2024-10-08T01:12:00Z', '—', NOW)).toBe('2024/10/08 10:12')
    expect(formatListDay('2026-10-07T15:00:00Z', '—', NOW)).toBe('10/08')
    expect(formatListDateTime('invalid')).toBe('—')
  })
})


it('来年以降の予約も、一覧で開始時刻を確認できる', () => {
  expect(formatListDateTime('2027-01-02T01:12:00Z', '—', NOW)).toBe('2027/01/02 10:12')
})
