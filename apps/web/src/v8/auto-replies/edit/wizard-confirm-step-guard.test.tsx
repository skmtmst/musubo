// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_FORM, type WizardForm } from './wizard-model'
import { WizardConfirmStep } from './wizard-confirm-step'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

const emptyOptions = {
  tags: [],
  fields: [],
  marks: [],
  scenarios: [],
  vars: [],
}

describe('auto-replies/edit/wizard-confirm-step ガード', () => {
  it('待ち時間・連投抑止が不正値や未設定でも壊れた文字列を出さず、安全な要約を表示する', () => {
    const form: WizardForm = {
      ...EMPTY_FORM,
      replyDelaySeconds: 'Infinity',
      cooldownOn: true,
      cooldownMinutes: 'abc',
      actions: null as unknown as WizardForm['actions'],
    }
    render(
      <WizardConfirmStep
        actionOptions={emptyOptions}
        autoReplyId="ar-1"
        confirmState="ready"
        effectiveKeywords={[]}
        folders={[]}
        form={form}
        goToStep={vi.fn()}
        loadValidation={vi.fn().mockResolvedValue(undefined)}
        myPositionLabel="1番目"
        selectedTemplate={null}
        thisRuleName="テストルール"
        v8Checks={[
          { label: '重なり', state: 'ok', detail: '問題なし', back: 'priority' },
          { label: '重なり', state: 'ok', detail: '問題なし2', back: 'trigger' },
        ]}
      />,
    )
    expect(screen.queryByText(/Infinity|NaN|同じ人へはabc分/)).toBeNull()
    expect(screen.getByText(/すぐ返す/)).toBeTruthy()
    expect(screen.getByText(/同じ人へは間をあける（時間未設定）/)).toBeTruthy()
  })

  it('確認読み込み失敗時の「読み直す」連打で loadValidation が二重起動しない', async () => {
    let resolveLoad!: () => void
    const loadValidation = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    render(
      <WizardConfirmStep
        actionOptions={emptyOptions}
        autoReplyId="ar-1"
        confirmState="error"
        effectiveKeywords={[]}
        folders={[]}
        form={EMPTY_FORM}
        goToStep={vi.fn()}
        loadValidation={loadValidation}
        myPositionLabel="1番目"
        selectedTemplate={null}
        thisRuleName="テストルール"
        v8Checks={[]}
      />,
    )
    const retry = screen.getByRole('button', { name: '読み直す' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(loadValidation).toHaveBeenCalledTimes(1)
    expect((retry as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })
    expect((retry as HTMLButtonElement).disabled).toBe(false)
  })
})
