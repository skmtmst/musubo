import { describe, expect, it } from 'vitest'
import type { LineAccountConnectData } from '@/lib/api'
import { allV8RowsPassed, canSave, toSteps, toV8CheckRows } from './connection-check'

describe('account-new/connection-check ガード', () => {
  it('空配列や不足した段数では canSave / allV8RowsPassed を true にしない', () => {
    expect(canSave([])).toBe(false)
    expect(canSave([{ order: 1, message: 'ok', state: 'passed' }])).toBe(false)
    expect(allV8RowsPassed([])).toBe(false)
    expect(allV8RowsPassed(null as unknown as ReturnType<typeof toV8CheckRows>)).toBe(false)
  })

  it('steps 非配列・空白のみの basicId・sameProvider 不一致を安全に扱う', () => {
    const malformedSteps = toSteps({ steps: null as unknown as [] })
    expect(malformedSteps).toHaveLength(5)
    expect(malformedSteps.every((s) => s.state === 'skipped')).toBe(true)

    const mismatchedProvider: LineAccountConnectData = {
      steps: [1, 2, 3, 4, 5].map((order) => ({ order: order as 1, message: `段${order}`, state: 'passed' })),
      verification: {
        tokenOk: true,
        loginOk: true,
        sameProvider: false,
        webhook: { expectedUrl: 'https://x/webhook', registeredUrl: 'https://x/webhook', active: true, testPassed: true },
        followerTotal: 0,
      },
      pictureUrl: null,
      basicId: '   ',
      followerImport: { capability: 'available', phase: 'not_started' },
      remainingActions: [],
    }
    const rows = toV8CheckRows(mismatchedProvider)
    expect(rows[1].state).toBe('todo')
    expect(rows[3].state).toBe('todo')
    expect(rows[4].state).toBe('todo')
    expect(allV8RowsPassed(rows)).toBe(false)
  })
})
