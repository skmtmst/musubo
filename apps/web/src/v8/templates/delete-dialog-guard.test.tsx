// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import TemplateDeleteDialog from './delete-dialog'

afterEach(cleanup)

describe('TemplateDeleteDialog の確定・キャンセルのコールバック守り', () => {
  it('処理中は確定もキャンセルも呼ばない', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <TemplateDeleteDialog
        open={true}
        title="テンプレートを削除しますか？"
        description="削除すると戻せません。"
        busy={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルテスト' }))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('閉じている・無効・権限ロックでは確定を止め、通常時だけ実行する', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const base = {
      open: true,
      title: 'テンプレートを削除しますか？',
      description: '削除すると戻せません。',
      busy: false,
      onConfirm,
      onCancel,
    }

    const { rerender } = render(<TemplateDeleteDialog {...base} open={false} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<TemplateDeleteDialog {...base} confirmDisabled={true} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    rerender(<TemplateDeleteDialog {...base} confirmLockedReason="権限がありません" />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))

    expect(onConfirm).not.toHaveBeenCalled()

    rerender(<TemplateDeleteDialog {...base} />)
    fireEvent.click(screen.getByRole('button', { name: '確定テスト' }))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルテスト' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
