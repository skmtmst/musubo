// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scenario } from '@line-crm/shared'

vi.mock('@/components/shared/confirm-dialog', () => ({
  default: ({
    onConfirm,
    onCancel,
    children,
  }: {
    onConfirm?: () => void
    onCancel: () => void
    children?: React.ReactNode
  }) => (
    <div>
      <button type="button" onClick={() => onConfirm?.()}>確定テスト</button>
      <button type="button" onClick={() => onCancel()}>キャンセルテスト</button>
      {children}
    </div>
  ),
}))

vi.mock('@/components/shared/operation-target-summary', () => ({
  default: () => null,
}))

vi.mock('@/components/scenarios/scenario-dialogs', () => ({
  MoveReferrersNotice: () => null,
}))

import ScenarioDeleteDialog from './delete-dialog'

afterEach(cleanup)

const sampleScenario = {
  id: 'sc-1',
  name: '来店お礼シナリオ',
  lineAccountId: 'acc-1',
  stepCount: 3,
} as unknown as Scenario & { subscriberCount?: number | null; stepCount?: number }

describe('ScenarioDeleteDialog の確定・キャンセルのコールバック守り', () => {
  it('処理中は確定もキャンセルも呼ばない', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ScenarioDeleteDialog
        target={sampleScenario}
        busy={true}
        summary={null}
        error=""
        disabled={false}
        targetStillListed={true}
        sameScope={true}
        countLabel={() => '0人'}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルテスト' }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('無効・一覧外・別アカウント・権限ロック・対象なしでは確定を止め、通常時だけ実行する', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const base = {
      target: sampleScenario,
      busy: false,
      summary: null,
      error: '',
      disabled: false,
      targetStillListed: true,
      sameScope: true,
      countLabel: () => '0人',
      onConfirm,
      onCancel,
    }

    const { rerender } = render(<ScenarioDeleteDialog {...base} disabled={true} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<ScenarioDeleteDialog {...base} targetStillListed={false} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<ScenarioDeleteDialog {...base} sameScope={false} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<ScenarioDeleteDialog {...base} lockedReason="権限がありません" />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<ScenarioDeleteDialog {...base} target={null} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    expect(onConfirm).not.toHaveBeenCalled()

    rerender(<ScenarioDeleteDialog {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルテスト' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
