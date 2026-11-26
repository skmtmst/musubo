// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PhoneDatetimeStep, formatJpDay, phoneTime } from '@/v8/booking-staff/phone'
import { LiffPhoneDatetimeStep } from '@/v8/booking-menus/liff-phone'
import type { BookingMenu } from '@/lib/api'
import type { BookingAvailabilitySlot } from '@/lib/api'

/**
 * Issue #643: 予約設定の右パネルプレビューが、実際のLIFF
 * （apps/liff/src/components/date-time-picker.tsx）と同じ構造かを
 * 実Reactで確かめる。
 *
 * 実LIFF（★V8・//）: 「日時を選んでください」の下に
 * 「週で見る／カレンダー」の切り替え。週は5日の並び（空き・満・休み）、
 * カレンダーは月の表（●空きあり／灰色は満席・休み）。
 * どちらも選んだ日の時刻ボタンが3列（grid-cols-3）で並ぶ。
 * 空きが無い週は「この週は空きがありません」＋次の手の案内を出す。
 * 「空き枠の内訳」は実画面に無い。
 */

const DIR = dirname(fileURLToPath(import.meta.url))
// shifts → staff → booking → app → src → web → apps → リポジトリ根
const REPO_ROOT = join(DIR, '../../../../../../..')
const LIFF_SOURCE = readFileSync(
  join(REPO_ROOT, 'apps/liff/src/components/date-time-picker.tsx'),
  'utf8',
)
const LIFF_USER_MESSAGE_SOURCE = readFileSync(
  join(REPO_ROOT, 'apps/liff/src/lib/user-message.ts'),
  'utf8',
)
const PAGE_SOURCE = readFileSync(join(DIR, '../../../../v8/booking-staff/shifts.tsx'), 'utf8')

function slot(date: string, start: string): BookingAvailabilitySlot {
  return {
    date,
    start,
    end: '10:30',
    timeZone: 'Asia/Tokyo',
    startUtc: `${date}T${start}:00+09:00`,
    endUtc: `${date}T10:30:00+09:00`,
    capacity: 1,
    remaining: 1,
    state: 'available',
  }
}

afterEach(cleanup)

describe('前提: 実LIFFが「日時を選んでください」＋週／カレンダー切替＋3列時刻ボタンの構造', () => {
  it('LIFF側の文言と構造が変わっていない（変わったらプレビューも追随が必要）', () => {
    expect(LIFF_SOURCE).toContain('日時を選んでください')
    // LIFF は週の空きなし、月の受付期間内の空きなし、月全体が受付期間外をそれぞれ案内する（両文が同時表示される場合もある）。
    // 管理画面の携帯見本は別の「この期間に空きはありません。」を実DOMで確認する。
    expect(LIFF_SOURCE).toContain('この週は空きがありません')
    // 読み込み中・失敗は共通部品（LoadingView・LoadErrorView）で出す。
    expect(LIFF_SOURCE).toContain('LoadingView')
    expect(LIFF_SOURCE).toContain('LoadErrorView')
    // 読み込み中の言葉は LIFF の user-message.test.ts が値で見張る。
    // 失敗は題「読み込めませんでした」＋本文 LOAD_FAILED_MESSAGE。
    expect(LIFF_USER_MESSAGE_SOURCE).toContain(
      '電波のよいところで、もう一度お試しください。',
    )
    expect(LIFF_USER_MESSAGE_SOURCE).toContain('もう一度読み込む')
    // 旧い見せ方（枠ごとの文言・赤いそのまま表示・題と本文の重ね）が復活していない。
    expect(LIFF_SOURCE).not.toContain('空き枠を取得中…')
    expect(LIFF_SOURCE).not.toContain('text-red-600')
    // ★V8: 「週で見る」は5日の並び（空き・満・休み）、時刻は選んだ日の3列。
    expect(LIFF_SOURCE).toContain('grid-cols-5')
    expect(LIFF_SOURCE).toContain('grid-cols-3')
    expect(LIFF_SOURCE).toContain('満席')
    expect(LIFF_SOURCE).toContain('aria-label="日付"')
    expect(LIFF_SOURCE).not.toContain('grid-cols-4')
    // カレンダーは月の表（7列・●空きあり／灰色は満席・休みの印の見方）。
    expect(LIFF_SOURCE).toContain('grid-cols-7')
    expect(LIFF_SOURCE).toContain('お休み')
  })

  it('管理画面側に実LIFFと違う見せ方が残っていない', () => {
    expect(PAGE_SOURCE).not.toContain('ご希望の日をえらんでください')
    expect(PAGE_SOURCE).not.toContain('空き枠の内訳')
    // 月の表（7列）はプレビュー部品だけが持つ。設定画面本体には置かない。
    expect(PAGE_SOURCE).not.toContain('grid-cols-7')
  })
})

describe('現役V8の携帯見本のデータ・失敗・読み直し', () => {
  const menu = { id: 'menu-1', name: 'カット' } as BookingMenu
  const slots = [slot('2026-10-01', '10:00'), slot('2026-10-01', '10:30'), slot('2026-10-01', '11:00'), slot('2026-10-01', '11:30'), slot('2026-10-01', '13:00'), slot('2026-10-03', '09:00')]
  const props = { menu, staffName: '田中', slots, closedDates: [], closedWeekdays: [] }

  it('勤務画面と予約設定が、現役の見本を実データで描く', () => {
    expect(PAGE_SOURCE).toContain('<PhoneDatetimeStep')
    expect(PAGE_SOURCE).toContain('slots={slots}')
    const { unmount } = render(<PhoneDatetimeStep {...props} />)
    expect(screen.getByText('日時を選んでください')).toBeTruthy()
    expect(screen.getByText('カット・田中')).toBeTruthy()
    unmount()
    render(<LiffPhoneDatetimeStep {...props} view="list" />)
    expect(screen.getByText('カット・田中')).toBeTruthy()
  })

  it('先頭の日の時刻だけを表示し、満・休みを区別する', () => {
    const { container } = render(<PhoneDatetimeStep {...props} closedDates={['2026-10-02']} />)
    expect(formatJpDay('2026-10-01')).toBe('10月1日（木）')
    expect(formatJpDay('2026-10-03')).toBe('10月3日（土）')
    expect(screen.getByText('10月1日（木）の空き')).toBeTruthy()
    expect(container.querySelectorAll('[data-tone="off"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-tone="full"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-tone="open"]')).toHaveLength(2)
    for (const time of ['10:00', '10:30', '11:00', '11:30', '13:00']) expect(within(container).getAllByText(time).length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain(phoneTime('09:00'))
  })

  it('予約設定の見本も先頭の日だけを示し、別の日の枠を混ぜない', () => {
    const { container } = render(<LiffPhoneDatetimeStep {...props} view="list" />)
    expect(screen.getByText('10月1日（木）の空き')).toBeTruthy()
    expect(container.textContent).not.toContain('09:00')
    expect(container.textContent).not.toContain('空き枠の内訳')
    expect(container.querySelector('details')).toBeNull()
  })

  // 未使用の旧見本の「カレンダーなら月の表が7列」の外見契約1件は削除。
  // 現役の採用済み携帯見本の骨格を旧コードの月表へ戻す要求にしない。

  it('空きがないときは空きなしを示し、日時を選択済みにしない', () => {
    render(<PhoneDatetimeStep {...props} slots={[]} />)
    expect(screen.getByText('この期間に空きはありません。')).toBeTruthy()
    expect(screen.getByText('内容を確かめる').getAttribute('data-off')).toBe('true')
    expect(screen.queryByText('10月1日（木）の空き')).toBeNull()
  })

  it('取得中・失敗は満席と断定せず、失敗から読み直せる', () => {
    const onRetry = vi.fn()
    const { unmount } = render(<PhoneDatetimeStep {...props} status="loading" onRetry={onRetry} />)
    expect(screen.queryAllByText('満')).toHaveLength(0)
    expect(screen.getByText('内容を確かめる').getAttribute('data-off')).toBe('true')
    unmount()
    render(<PhoneDatetimeStep {...props} status="error" onRetry={onRetry} />)
    expect(screen.getByText('読み込めませんでした')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(PAGE_SOURCE).toContain('onRetry={selectedAccountId && menuId')
    expect(PAGE_SOURCE).toContain('void loadAvailability(selectedAccountId, menuId')
  })

  it('どのメニュー・担当の見本かを示し、指名なしも区別する', () => {
    const { unmount } = render(<PhoneDatetimeStep {...props} />)
    expect(screen.getByText('カット・田中')).toBeTruthy()
    unmount()
    render(<PhoneDatetimeStep {...props} staffName={null} />)
    expect(screen.getByText('カット・指名なし')).toBeTruthy()
  })
})
