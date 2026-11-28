// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoReplyDryRunResult } from '@line-crm/shared'
import type { WizardForm } from './wizard-model'
import { renderWizardPreview } from './wizard-preview'

function baseContext(overrides: Partial<Parameters<typeof renderWizardPreview>[0]> = {}): Parameters<typeof renderWizardPreview>[0] {
  return {
    conflictsReadable: true,
    acknowledged: new Set<string>(),
    autoReplyId: 'rule-self',
    conflicts: [],
    dryRun: null,
    form: {
      mode: 'inline-text',
      responseContent: 'ご案内いたします',
      actions: [],
    } as unknown as WizardForm,
    imageContent: null,
    isActive: false,
    matchedLast28Days: 12,
    myIndex: 0,
    myPositionLabel: '上から1番目',
    orderedRules: [],
    previewAccountName: 'テスト店',
    replyPreviewText: 'ご案内いたします',
    selectedTemplate: null,
    setAcknowledged: vi.fn(),
    step: 'priority',
    testMessage: 'こんにちは',
    triggerSamples: [{ text: '予約したい', hit: true }],
    ...overrides,
  }
}

describe('wizard-preview ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('試し送信でどのルールにも当たらなかったとき「別のルールが先に動く」と誤表示せず返信吹き出しも出さない', () => {
    const noHit: AutoReplyDryRunResult = {
      draftWon: false,
      winner: null,
      candidates: [],
    } as unknown as AutoReplyDryRunResult
    render(<>{renderWizardPreview(baseContext({ step: 'priority', dryRun: noHit }), true)}</>)

    expect(screen.getAllByText(/どのルールにも当たりませんでした/).length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('ご案内いたします')).toBeNull()
    expect(screen.queryByText(/別のルール/)).toBeNull()
    expect(screen.queryByText('このルールが返します')).toBeNull()
  })

  it('triggerSamples が空配列かつ matchedLast28Days が負数・NaN でも落ちず未取得表示になる', () => {
    render(<>{renderWizardPreview(baseContext({ step: 'trigger', triggerSamples: [], matchedLast28Days: -5 }), true)}</>)
    expect(screen.queryByText(/-5/)).toBeNull()
    expect(screen.getByLabelText('当たった受信（過去28日）').textContent).toContain('—')

    cleanup()
    render(<>{renderWizardPreview(baseContext({ step: 'confirm', triggerSamples: [] }), true)}</>)
    expect(screen.getByText('ご案内いたします')).toBeTruthy()
  })
})
