// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoursWorkspace, OpeningDate, WeeklyOpeningHours } from '@line-crm/shared'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'
import { HoursTextProposal } from './hours-text-proposal'

afterEach(cleanup)

const weekly: WeeklyOpeningHours = {
  MONDAY: [{ open: '11:00', close: '22:00' }],
  TUESDAY: [{ open: '11:00', close: '22:00' }],
  WEDNESDAY: [{ open: '11:00', close: '22:00' }],
  THURSDAY: [{ open: '11:00', close: '22:00' }],
  FRIDAY: [{ open: '11:00', close: '22:00' }],
  SATURDAY: [{ open: '11:00', close: '22:00' }],
  SUNDAY: [{ open: '11:00', close: '22:00' }],
}

const data = {
  profile: { regularHours: weekly, specialHours: [] },
} as unknown as GoogleProfileData

const workspace = {
  holiday: { mode: 'same_as_weekday', periods: [] },
  draft: { weekly: null, days: [], holidayChanged: false, serviceIds: [], reviewIds: [] },
  services: [],
} as unknown as HoursWorkspace

describe('HoursTextProposal の重複日付と欠損データの守り', () => {
  it('special_hours で after が配列でなくても落ちずに要約だけを表示する', () => {
    const change = {
      id: 'chg-null',
      kind: 'special_hours',
      target: { kind: 'special_hours' },
      summary: '特別営業時間の変更案',
      before: [],
      after: null,
      reservationImpactCount: 0,
    } as unknown as GoogleChange

    render(
      <HoursTextProposal
        change={change}
        data={data}
        workspace={workspace}
        holidays={[]}
        onEditDates={vi.fn()}
      />,
    )

    expect(screen.getByText('特別営業時間の変更案')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '日付や時間を直す' })).toBeNull()
  })

  it('同じ日付が重複していても連日扱い・二重カウントせず、重複を除いた日付で編集を開く', () => {
    const onEditDates = vi.fn()
    const entries: OpeningDate[] = [
      { date: '2026-11-01', closed: true, periods: [] },
      { date: '2026-11-01', closed: true, periods: [] },
      { date: '2026-11-03', closed: true, periods: [] },
    ]
    const change = {
      id: 'chg-dup',
      kind: 'special_hours',
      target: { kind: 'special_hours' },
      summary: '臨時休業',
      before: [],
      after: entries,
      reservationImpactCount: 0,
    } as unknown as GoogleChange

    render(
      <HoursTextProposal
        change={change}
        data={data}
        workspace={workspace}
        holidays={[]}
        onEditDates={onEditDates}
      />,
    )

    expect(screen.getByText('2026年11月1日・2026年11月3日')).toBeTruthy()
    expect(screen.getByText('2日 休業')).toBeTruthy()
    expect(screen.queryByText(/3日間/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '日付や時間を直す' }))
    expect(onEditDates).toHaveBeenCalledTimes(1)
    expect(onEditDates).toHaveBeenCalledWith(['2026-11-01', '2026-11-03'])
  })
})
