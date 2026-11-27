// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HoursWorkspace, WeeklyOpeningHours } from '@line-crm/shared'
import type { GoogleChange, GoogleProfileData } from '@/lib/restaurant-google-api'
import { HoursServiceConfirm } from './hours-service-confirm'

afterEach(cleanup)

const emptyWeekly: WeeklyOpeningHours = {
  MONDAY: [],
  TUESDAY: [],
  WEDNESDAY: [],
  THURSDAY: [],
  FRIDAY: [],
  SATURDAY: [],
  SUNDAY: [],
}

const baseWorkspace = {
  services: [{ id: 'lunch', kind: 'lunch', label: 'ランチ', googleTypeId: 'LUNCH', sameWeekdays: false, weekdays: [], periods: [], orderDeadline: '', menu: '' }],
} as unknown as HoursWorkspace

const baseData = {
  profile: {
    moreHours: [],
    moreHoursTypes: [{ id: 'LUNCH', label: 'ランチ' }],
  },
} as unknown as GoogleProfileData

describe('HoursServiceConfirm の欠損データと空曜日の守り', () => {
  it('before が未設定（null）の初回追加でも落ちずに変更前を「未設定」として描画する', () => {
    const change: GoogleChange = {
      id: 'chg-1',
      target: { kind: 'profile', field: 'moreHours' },
      summary: 'ランチの営業時間を追加',
      before: null,
      after: [{ hoursTypeId: 'LUNCH', weekly: { ...emptyWeekly, MONDAY: [{ open: '11:30', close: '14:00' }] } }],
      reservationImpactCount: 0,
    } as unknown as GoogleChange

    render(<HoursServiceConfirm changes={[change]} workspace={baseWorkspace} data={baseData} />)

    expect(screen.getByText('ランチの営業時間')).toBeTruthy()
    expect(screen.getByText('提供する曜日：月曜日')).toBeTruthy()
    expect(screen.getByText('未設定')).toBeTruthy()
    expect(screen.getByText('11:30–14:00')).toBeTruthy()
  })

  it('変更後の全曜日が空・一部曜日が欠けていても落ちず「未設定」と表示する', () => {
    const partialWeekly = { MONDAY: [] } as unknown as WeeklyOpeningHours
    const change: GoogleChange = {
      id: 'chg-2',
      target: { kind: 'profile', field: 'moreHours' },
      summary: 'ランチの営業時間を更新',
      before: [{ hoursTypeId: 'LUNCH', weekly: { ...emptyWeekly, TUESDAY: [{ open: '11:30', close: '14:00' }] } }],
      after: [{ hoursTypeId: 'LUNCH', weekly: partialWeekly }],
      reservationImpactCount: 0,
    } as unknown as GoogleChange

    render(<HoursServiceConfirm changes={[change]} workspace={baseWorkspace} data={baseData} />)

    expect(screen.getByText('提供する曜日：未設定')).toBeTruthy()
    expect(screen.getByText('11:30–14:00')).toBeTruthy()
    expect(screen.getByText('未設定')).toBeTruthy()
  })
})
