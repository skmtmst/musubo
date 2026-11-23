// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { forgetStaffIdentity, rememberStaffIdentity } from './staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { consumeRegistrationWelcome, prepareRegistrationWelcome } from './registration-welcome'

function signIn(id: string) {
  rememberStaffIdentity({ id, tenantId: 'company', role: 'owner' } as StaffMember)
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  forgetStaffIdentity()
})

test('同じ本人は別のLINEアカウントの登録でも一度だけ表示する', () => {
  signIn('first-staff')
  expect(consumeRegistrationWelcome()).toBe(false)
  prepareRegistrationWelcome()
  expect(consumeRegistrationWelcome()).toBe(true)
  expect(window.localStorage.getItem('musubo:registration-welcome:company:first-staff')).toBe('1')

  prepareRegistrationWelcome()
  expect(consumeRegistrationWelcome()).toBe(false)

  signIn('second-staff')
  prepareRegistrationWelcome()
  expect(consumeRegistrationWelcome()).toBe(true)
})

test('前回表示済みの控えがあれば再読込しても表示しない', () => {
  signIn('returning-staff')
  window.localStorage.setItem('musubo:registration-welcome:company:returning-staff', '1')
  prepareRegistrationWelcome()
  expect(consumeRegistrationWelcome()).toBe(false)
})

test('統括へ移動するまでにログインが切り替わると表示しない', () => {
  signIn('departing-staff')
  prepareRegistrationWelcome()
  signIn('arriving-staff')
  expect(consumeRegistrationWelcome()).toBe(false)
  expect(window.localStorage.length).toBe(0)
})
