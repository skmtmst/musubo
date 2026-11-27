import { beforeEach, describe, expect, it, vi } from 'vitest'
import { allAcked, loginChannelErrors, readDraft, stepLabel } from './logic'

describe('account-new/logic ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('stepLabel は NaN や小数を受け取っても Step NaN を出さず整数へ正規化する', () => {
    expect(stepLabel(2, Number.NaN)).toBe('Step 1 / 4')
    expect(stepLabel(2, 2.9)).toBe('Step 2 / 4')
    expect(stepLabel(3, Number.POSITIVE_INFINITY)).toBe('Step 1 / 2')
  })

  it('loginChannelErrors は Messaging API チャネルIDに前後空白があっても同一IDとして検出する', () => {
    const errs = loginChannelErrors({
      channelId: ' 1234567890 ',
      loginChannelId: '1234567890',
      loginChannelSecret: 'secret123456789012345678901234',
    })
    expect(errs.loginChannelId).toContain('Messaging APIと同じIDです')
  })

  it('allAcked と readDraft は継承プロパティや配列JSONを誤って承認・復元しない', () => {
    const inherited = Object.create({ ackKey: true }) as Record<string, boolean>
    expect(allAcked([{ key: 'ackKey' }], inherited)).toBe(false)
    expect(allAcked([{ key: 'ackKey' }], null as unknown as Record<string, boolean>)).toBe(false)

    const storage = { getItem: () => '[]' }
    expect(readDraft(storage)).toBeNull()
  })
})
