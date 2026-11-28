// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BlockedDeleteDialog from './blocked-dialog'

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

describe('BlockedDeleteDialog の処理中ガード', () => {
  it('処理中は閉じる操作と行アクションをコールバック側でも止める', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()

    render(
      <BlockedDeleteDialog
        title="まだ消せません"
        description="このメニューは使われているため削除できません。"
        rows={[
          { key: 'default', text: '既定メニューとして公開中', action: { label: '外す', onSelect } },
        ]}
        busy
        error={null}
        footer={null}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'dialog-cancel' }))
    expect(onClose).not.toHaveBeenCalled()

    const actionButton = screen.getByRole('button', { name: '外す' }) as HTMLButtonElement
    expect(actionButton.disabled).toBe(true)
    actionButton.removeAttribute('disabled')
    fireEvent.click(actionButton)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('処理中でないときは閉じる操作と行アクションを実行する', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()

    render(
      <BlockedDeleteDialog
        title="まだ消せません"
        description="このメニューは使われているため削除できません。"
        rows={[
          { key: 'default', text: '既定メニューとして公開中', action: { label: '外す', onSelect } },
        ]}
        busy={false}
        error={null}
        footer={null}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'dialog-cancel' }))
    fireEvent.click(screen.getByRole('button', { name: '外す' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
