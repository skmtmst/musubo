import { expect, it } from 'vitest'
import { hasLineConnectionProblem, lineAccountConnectionState, tokenExpiryBadge, tokenExpiryNotice, tokenExpirySummary, tokenExpiryBreakdown, tokenExpiryBreakdownText } from './line-account-state'

it('稼働中の要確認だけを問題として数え、未確認・停止中・アーカイブを混ぜない', () => {
  const warning = { isActive: true, connection: { status: 'warn' as const } }
  expect(hasLineConnectionProblem(warning)).toBe(true)
  for (const account of [{ ...warning, connection: undefined }, { ...warning, isActive: false }, { ...warning, archivedAt: '2026-10-01' }]) {
    expect(hasLineConnectionProblem(account)).toBe(false)
    expect(lineAccountConnectionState(account).tone).toBe('idle')
  }
})

const expiry = (status: 'unknown' | 'expired' | 'expiring' | 'valid') => ({ status, label: `期限:${status}`, daysLeft: null })

it('期限切れの内訳は接続に問題の共通部分だけで、残りと未確認は分ける', () => {
  expect(tokenExpiryBreakdown([
    { isActive: true, connection: { status: 'warn' }, tokenExpiry: expiry('expired') },
    { isActive: true, connection: { status: 'ok' }, tokenExpiry: expiry('expired') },
    { isActive: false, connection: { status: 'warn' }, tokenExpiry: expiry('expired') },
    { isActive: true, connection: { status: 'warn' }, tokenExpiry: expiry('unknown') },
    { isActive: true, connection: { status: 'warn' } },
    { isActive: true, connection: { status: 'warn' }, tokenExpiry: expiry('expired'), archivedAt: '2026-10-01' },
  ])).toEqual({ inProblem: 1, outsideProblem: 2, unknown: 2 })
})

it('期限不明だけでは警告しないが、期限切れがある場合は不明も別に知らせる', () => {
  const unknown = { isActive: true, connection: { status: 'ok' as const }, tokenExpiry: expiry('unknown') }
  expect(tokenExpiryBreakdownText([unknown])).toBeNull()
  expect(tokenExpiryBreakdownText([unknown, { ...unknown, isActive: false, tokenExpiry: expiry('expired') }])).toContain('トークン期限未確認 1 件')
})

it('トークンの期限は切れた・近い時だけ行に出し、記録なし・余裕あり・アーカイブには出さない', () => {
  expect(tokenExpiryNotice({ tokenExpiry: expiry('expired') })).toBe('期限:expired')
  expect(tokenExpiryNotice({ tokenExpiry: expiry('expiring') })).toBe('期限:expiring')
  expect(tokenExpiryNotice({ tokenExpiry: expiry('unknown') })).toBeNull()
  expect(tokenExpiryNotice({ tokenExpiry: expiry('valid') })).toBeNull()
  expect(tokenExpiryNotice({ tokenExpiry: expiry('expired'), archivedAt: '2026-10-01' })).toBeNull()
})

it('表の期限の札は短い文字で、全文は title に持つ', () => {
  expect(tokenExpiryBadge({ tokenExpiry: expiry('expired') })).toEqual({ text: '期限切れ', title: '期限:expired' })
  expect(tokenExpiryBadge({ tokenExpiry: expiry('expiring') })).toEqual({ text: '期限が近い', title: '期限:expiring' })
  expect(tokenExpiryBadge({ tokenExpiry: expiry('valid') })).toBeNull()
  expect(tokenExpiryBadge({ tokenExpiry: expiry('expired'), archivedAt: '2026-10-01' })).toBeNull()
})

it('帯の下の期限の1行は、接続とは別に数え、0件なら出さない', () => {
  expect(tokenExpirySummary([{ tokenExpiry: expiry('unknown') }, { tokenExpiry: expiry('valid') }])).toBeNull()
  expect(tokenExpirySummary([
    { tokenExpiry: expiry('expired') },
    { tokenExpiry: expiry('expired'), archivedAt: '2026-10-01' },
    { tokenExpiry: expiry('expiring') },
  ])).toBe('期限切れ 1 件・期限が近い 1 件')
})
