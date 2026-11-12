import { describe, expect, it } from 'vitest'
import type { LineAccount } from '@line-crm/shared'
import { accountKpis, matchesFilter, orderAccounts, type AccountWithStats } from './view'

const account = (id: string, options: Partial<AccountWithStats> = {}): AccountWithStats => ({
  id, channelId: `ch-${id}`, name: id, isActive: true, archivedAt: null, isDefault: false, displayOrder: 0,
  parentLineAccountId: null, webhook: { status: 'matched' }, stats: { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0 },
  ...options,
} as unknown as AccountWithStats)

describe('★V8 LINEアカウント一覧（V7vn3）の数と並び', () => {
  it('数の4枚：つないでいる・有効・接続に問題・友だちの合計はアーカイブを数えない', () => {
    const kpis = accountKpis([
      account('a', { stats: { friendCount: 1284, activeScenarios: 0, messagesThisMonth: 0 } }),
      account('b', { isActive: false, webhook: { status: 'mismatched' } as LineAccount['webhook'], stats: { friendCount: 14, activeScenarios: 0, messagesThisMonth: 0 } }),
      account('c', { isActive: false, archivedAt: '2026-04-01T00:00:00.000Z', webhook: { status: 'mismatched' } as LineAccount['webhook'], stats: { friendCount: 900, activeScenarios: 0, messagesThisMonth: 0 } }),
    ])
    expect(kpis).toEqual({ connected: 2, active: 1, problem: 0, friends: 1298 })
  })

  it('並びは「並び順と親子を変える」で決めた順（displayOrder）。同じ値は届いた順のまま', () => {
    const ordered = orderAccounts([
      account('test', { displayOrder: 2 }),
      account('main', { displayOrder: 0 }),
      account('shop', { displayOrder: 1 }),
      account('same', { displayOrder: 2 }),
    ])
    expect(ordered.map((a) => a.id)).toEqual(['main', 'shop', 'test', 'same'])
  })

  it('絞り込み：アーカイブは「停止中」に入れない', () => {
    const archived = account('old', { isActive: false, archivedAt: '2026-04-01T00:00:00.000Z' })
    expect(matchesFilter(archived, 'inactive')).toBe(false)
    expect(matchesFilter(archived, 'archived')).toBe(true)
  })
})

it('接続の問題はWebhookの補足でなく保存したconnectionを使う', () => {
  expect(accountKpis([account('warning', { connection: { status: 'warn' } }), account('unknown'), account('old-hook', { connection: { status: 'ok' }, webhook: { status: 'mismatched' } as LineAccount['webhook'] })]).problem).toBe(1)
})

it('友だちの合計は不明な店があれば不明、全店0なら0。保管済みの不明は含めない', () => {
  expect(accountKpis([account('unknown', { stats: undefined }), account('zero')]).friends).toBeNull()
  expect(accountKpis([account('zero')]).friends).toBe(0)
  expect(accountKpis([account('zero'), account('old', { archivedAt: '2026-01-01', stats: undefined })]).friends).toBe(0)
})
