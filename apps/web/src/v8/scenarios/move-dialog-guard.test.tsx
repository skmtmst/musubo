// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, Scenario } from '@line-crm/shared'
import type { ConfirmedUndoHandle } from '@/lib/undoable'
import ScenarioMoveDialog from './move-dialog'

const scenarios = [{ id: 'sc-1', name: '来店フォロー' }] as Scenario[]
const folders = [{ id: 'f-1', name: '運用中' }] as Folder[]

function makePending(): ConfirmedUndoHandle {
  return {
    undo: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    undoWindowClosed: new Promise(() => {}),
  } as unknown as ConfirmedUndoHandle
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('シナリオ移動ダイアログの空対象・実行中ガード', () => {
  it('移動対象が空のときと実行中(pending)のときは確定を止め、対象がある平常時だけ実行できる', () => {
    const onConfirm = vi.fn()
    const baseProps = {
      scenarios,
      folders,
      accountTargets: { accounts: [{ id: 'acc-1' }], allAccounts: false },
      disabled: false,
      sameScope: true,
      draft: 'f-1',
      onDraftChange: vi.fn(),
      onConfirm,
      onClose: vi.fn(),
    }

    // 1. ids が空配列のときは移動ボタンが無効で理由が出る
    const view = render(<ScenarioMoveDialog {...baseProps} ids={[]} pending={null} />)
    const moveButton = screen.getByRole('button', { name: '移動する' }) as HTMLButtonElement
    expect(moveButton.disabled).toBe(true)
    expect(screen.getByText('移動するシナリオを選んでください。')).toBeTruthy()
    fireEvent.click(moveButton)
    expect(onConfirm).not.toHaveBeenCalled()

    // 2. pending 実行中は移動ボタンが無効で実行できない
    view.rerender(<ScenarioMoveDialog {...baseProps} ids={['sc-1']} pending={makePending()} />)
    const pendingButton = screen.getByRole('button', { name: '移動する' }) as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    fireEvent.click(pendingButton)
    expect(onConfirm).not.toHaveBeenCalled()

    // 3. 対象があり実行中でなければ移動できる
    view.rerender(<ScenarioMoveDialog {...baseProps} ids={['sc-1']} pending={null} />)
    const activeButton = screen.getByRole('button', { name: '移動する' }) as HTMLButtonElement
    expect(activeButton.disabled).toBe(false)
    fireEvent.click(activeButton)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
