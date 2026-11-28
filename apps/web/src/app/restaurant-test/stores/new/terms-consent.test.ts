import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TERMS_DOCUMENT } from '@/content/terms/musubo-terms'
import { canSubmitTerms, hasReadTerms, initialWizardStep, STEP } from '@/v8/restaurant/store-new/terms-state'

const wizardSource = readFileSync(new URL('../../../../v8/restaurant/store-new/store-new.tsx', import.meta.url), 'utf8')
const legalSource = readFileSync(
  new URL('../../../../../../../docs/legal/musubo-terms-v0.1-draft.md', import.meta.url),
  'utf8',
)

describe('利用規約への同意ステップ', () => {
  it('スクロールが不要な高さでは初期表示で読了扱いになる', () => {
    expect(hasReadTerms({ scrollTop: 0, clientHeight: 420, scrollHeight: 420 })).toBe(true)
  })

  it('最下部へ届くまではチェックできず、8px以内まで読めば読了になる', () => {
    expect(hasReadTerms({ scrollTop: 300, clientHeight: 400, scrollHeight: 900 })).toBe(false)
    expect(hasReadTerms({ scrollTop: 493, clientHeight: 400, scrollHeight: 900 })).toBe(true)
  })

  it('読了後もチェックするまでは同意ボタンを有効にしない', () => {
    expect(canSubmitTerms(true, false)).toBe(false)
    expect(canSubmitTerms(true, true)).toBe(true)
  })

  it('現行版への同意だけSTEP2から開始し、旧版・未同意・取得失敗はSTEP1にする', () => {
    expect(initialWizardStep(TERMS_DOCUMENT.version)).toBe(STEP.BASICS)
    expect(initialWizardStep('v0.0-draft')).toBe(STEP.TERMS)
    expect(initialWizardStep(null)).toBe(STEP.TERMS)
    expect(wizardSource).toContain('.catch(() => {')
  })

  it('画面用データが原典の全26節を保持し、社内向け法務メモだけを表示しない', () => {
    expect(TERMS_DOCUMENT.sections).toHaveLength(26)
    for (const section of TERMS_DOCUMENT.sections) {
      expect(legalSource).toContain(section.heading)
      expect(legalSource).toContain(section.body)
    }
    expect(JSON.stringify(TERMS_DOCUMENT)).not.toContain('法務確認が必要な箇所')
    expect(legalSource).toContain('## 【法務確認が必要な箇所】')
  })
})
