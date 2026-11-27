// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { columnPreferenceKey, readColumnPreference } from './column-preference'

afterEach(() => localStorage.clear())
it('店舗・利用者・統括ごとに分け、壊れた選択は使わない', () => {
  const key = columnPreferenceKey('tenant-a', 'user-a', 'account-a')
  localStorage.setItem(key, JSON.stringify(['visits', 'bookings']))
  expect(readColumnPreference(localStorage, key)).toEqual(['visits', 'bookings'])
  expect(readColumnPreference(localStorage, columnPreferenceKey('tenant-a', 'user-a', 'account-b'))).toBeNull()
  expect(readColumnPreference(localStorage, columnPreferenceKey('tenant-b', 'user-a', 'account-a'))).toBeNull()
  expect(readColumnPreference(localStorage, columnPreferenceKey('tenant-a', 'user-b', 'account-a'))).toBeNull()
  for (const value of ['{', '[]', '["constructor"]', '["visits","visits"]']) {
    localStorage.setItem(key, value)
    expect(readColumnPreference(localStorage, key)).toBeNull()
  }
})
