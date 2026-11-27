// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasEditKey } from './nav'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('hasEditKey guards', () => {
  it('rejects empty, whitespace-only, or non-string permission keys even if storage contains them', () => {
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['', '   ', null, 123, '/friends']))
    expect(hasEditKey('')).toBe(false)
    expect(hasEditKey('   ')).toBe(false)
    expect(hasEditKey(null as unknown as string)).toBe(false)
    expect(hasEditKey(123 as unknown as string)).toBe(false)
  })

  it('returns true for exact valid stored permission strings and false on malformed JSON', () => {
    window.localStorage.setItem('lh_staff_permissions', JSON.stringify(['/friends', '/chats']))
    expect(hasEditKey('/friends')).toBe(true)
    expect(hasEditKey('/broadcasts')).toBe(false)

    window.localStorage.setItem('lh_staff_permissions', '{broken-json')
    expect(hasEditKey('/friends')).toBe(false)
  })
})
