// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonVarDeleteImpact } from '@line-crm/shared'
import CommonVarDeleteFields from './delete-fields'

const IMPACT: CommonVarDeleteImpact = {
  canDelete: true,
  activeUsageCount: 0,
  totalUsageCount: 0,
  usages: [],
  variable: {
    id: 'cv-1',
    varKey: 'shop_tel',
    name: '電話番号',
    value: '03-0000-0000',
  },
} as unknown as CommonVarDeleteImpact

describe('CommonVarDeleteFields の送信後 typedKey エラー表示', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('送信エラー発生時は未フォーカスだった差し込みキー欄にも検証エラーを出す', () => {
    render(
      <CommonVarDeleteFields
        impact={IMPACT}
        reason="不要になったため"
        typedKey=""
        onReasonChange={vi.fn()}
        onTypedKeyChange={vi.fn()}
        error="入力内容を確認してください"
      />,
    )
    expect(screen.getByText(/差し込みキー/)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
