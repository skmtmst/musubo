import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ruleText, waitLabel } from './words'

describe('ec-auto-line/words の非有限時間・非配列メッセージ保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('waitLabel は NaN・Infinity・null で異常表示や「すぐ」を出さず — を返す', () => {
    expect(waitLabel(Number.NaN)).toBe('—')
    expect(waitLabel(Number.POSITIVE_INFINITY)).toBe('—')
    expect(waitLabel(null as unknown as number)).toBe('—')
    expect(waitLabel(0)).toBe('すぐ')
    expect(waitLabel(1440)).toBe('1 日')
  })

  it('ruleText は messages が非配列・null でも落ちずに空文字を返す', () => {
    expect(ruleText(null as unknown as unknown[])).toBe('')
    expect(ruleText(undefined as unknown as unknown[])).toBe('')
    expect(ruleText([{ type: 'text', text: 'ご案内です' }])).toBe('ご案内です')
  })
})
