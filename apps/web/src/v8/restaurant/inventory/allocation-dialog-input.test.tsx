// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AllocationDialog } from './allocation-controls'
import type { Alloc } from './stock-types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function ControlledDialog({
  initial = { ota: 8, line: 6, walkin: 6 },
  totalSeats = 20,
  reload,
  onChangeSpy,
  onSave = vi.fn(),
}: {
  initial?: Alloc
  totalSeats?: number
  reload?: () => void
  onChangeSpy?: (next: Alloc) => void
  onSave?: () => void
}) {
  const [allocation, setAllocation] = useState<Alloc>(initial)
  return (
    <AllocationDialog
      scope="standard"
      dateLabel="10月10日（土）"
      allocation={allocation}
      totalSeats={totalSeats}
      busy={false}
      error=""
      reload={reload}
      canRestore={false}
      restoreLabel="基本配分に戻す"
      onChange={(next) => {
        onChangeSpy?.(next)
        setAllocation(next)
      }}
      onClose={vi.fn()}
      onSave={onSave}
      onRestore={vi.fn()}
    />
  )
}

describe('AllocationDialog の数値入力と保存ボタンの制御', () => {
  it('数値欄を空にしたとき 0 に変換せず保存を止めて理由を出し、再入力で保存できる', () => {
    const onChangeSpy = vi.fn()
    const onSave = vi.fn()
    render(<ControlledDialog onChangeSpy={onChangeSpy} onSave={onSave} />)
    const dialog = screen.getByRole('dialog', { name: '営業日の基本配分を変更' })
    const otaInput = within(dialog).getByRole('spinbutton', { name: '予約サイト（グルメサイト）' }) as HTMLInputElement
    const saveButton = within(dialog).getByRole('button', { name: '基本配分を保存' }) as HTMLButtonElement

    fireEvent.change(otaInput, { target: { value: '' } })

    expect(otaInput.value).toBe('')
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(saveButton.disabled).toBe(true)
    expect(within(dialog).getByText('すべての項目に0以上の整数を入力し、合計を総数以内にしてください。')).not.toBeNull()

    fireEvent.change(otaInput, { target: { value: '7' } })

    expect(otaInput.value).toBe('7')
    expect(onChangeSpy).toHaveBeenLastCalledWith({ ota: 7, line: 6, walkin: 6 })
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('非数値が渡っても NaN を欄に表示せず保存を止め、外からの値変更に追従する', () => {
    const onChange = vi.fn()
    const view = render(
      <AllocationDialog
        scope="standard"
        dateLabel="10月10日（土）"
        allocation={{ ota: Number.NaN, line: 6, walkin: 6 }}
        totalSeats={20}
        busy={false}
        error=""
        canRestore={false}
        restoreLabel="基本配分に戻す"
        onChange={onChange}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onRestore={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: '営業日の基本配分を変更' })
    const otaInput = within(dialog).getByRole('spinbutton', { name: '予約サイト（グルメサイト）' }) as HTMLInputElement
    const saveButton = within(dialog).getByRole('button', { name: '基本配分を保存' }) as HTMLButtonElement

    expect(otaInput.value).toBe('')
    expect(saveButton.disabled).toBe(true)

    fireEvent.change(otaInput, { target: { value: '' } })
    view.rerender(
      <AllocationDialog
        scope="standard"
        dateLabel="10月10日（土）"
        allocation={{ ota: 5, line: 6, walkin: 6 }}
        totalSeats={20}
        busy={false}
        error=""
        canRestore={false}
        restoreLabel="基本配分に戻す"
        onChange={onChange}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onRestore={vi.fn()}
      />,
    )

    expect(otaInput.value).toBe('5')
    expect(saveButton.disabled).toBe(false)
  })

  it('最新配分の確認が必要なときは保存できない理由を出す', () => {
    render(<ControlledDialog reload={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: '営業日の基本配分を変更' })
    const saveButton = within(dialog).getByRole('button', { name: '基本配分を保存' }) as HTMLButtonElement

    expect(saveButton.disabled).toBe(true)
    expect(within(dialog).getByText('最新の配分を確認してから保存してください。')).not.toBeNull()
  })
})
