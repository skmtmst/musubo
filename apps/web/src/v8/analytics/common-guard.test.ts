import { describe, expect, it } from 'vitest'
import { shortDateTime, shortDay, shortWhen } from './common'

describe('analytics common date formatters defensive guards', () => {
  it('rejects impossible calendar dates instead of silently rolling over into the next month', () => {
    expect(shortDay('2026-02-31')).toBe('—')
    expect(shortWhen('2026-02-31')).toBe('—')
    expect(shortDateTime('2026-02-31 10:00:00')).toBe('—')
    expect(shortDay('2026-04-31')).toBe('—')
  })

  it('trims whitespace-padded date-only strings so shortWhen does not append a bogus 09:00 clock', () => {
    const padded = shortWhen(' 2026-09-30 ')
    expect(padded).toBe(shortWhen('2026-09-30'))
    expect(padded).not.toContain('09:00')
  })

  it('trims whitespace-padded SQLite UTC timestamps so shortDateTime normalizes them as UTC', () => {
    expect(shortDateTime(' 2026-09-30 10:00:00 ')).toBe(shortDateTime('2026-09-30 10:00:00'))
    expect(shortDateTime(' 2026-09-30 10:00:00 ')).toContain('19:00')
  })

  it('returns fallback for non-string or blank inputs', () => {
    expect(shortWhen('   ')).toBe('—')
    expect(shortDay(undefined as unknown as string)).toBe('—')
    expect(shortDateTime(123 as unknown as string)).toBe('—')
  })
})
