// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SheetDialog from './sheet-dialog'

vi.mock('@/components/shared/dialog', () => ({
  default: ({
    title,
    description,
    onCancel,
    footer,
    children,
  }: {
    title: string
    description: string
    onCancel: () => void
    footer?: ReactNode
    children?: ReactNode
  }) => (
    <div role="dialog" aria-label={title}>
      <p>{description}</p>
      <button type="button" onClick={onCancel}>dialog-cancel</button>
      {children}
      <div>{footer}</div>
    </div>
  ),
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

afterEach(() => {
  cleanup()
})

describe('SheetDialog の処理中ガード', () => {
  it('処理中はキャンセル操作をコールバック側でも止める', () => {
    const onClose = vi.fn()

    render(
      <SheetDialog
        open
        title="このリマインダを削除しますか？"
        description="削除すると元に戻せません。"
        busy
        actions={<button type="button">削除する</button>}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'dialog-cancel' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('処理中でないときはキャンセル操作で閉じるコールバックを実行する', () => {
    const onClose = vi.fn()

    render(
      <SheetDialog
        open
        title="このリマインダを削除しますか？"
        description="削除すると元に戻せません。"
        busy={false}
        actions={<button type="button">削除する</button>}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'dialog-cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
