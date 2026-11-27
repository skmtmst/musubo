// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRestaurantReservationForm } from '@line-crm/shared'
import { ReservationFormEditor } from './reservation-form-editor'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('予約回答フォーム編集の確認エラー解除', () => {
  it('確認エラーが出たあとに題名・項目名・完了後の文を直し始めるとエラー帯を消す', async () => {
    const definition = defaultRestaurantReservationForm()
    const onConfirm = vi.fn()

    render(
      <ReservationFormEditor
        definition={definition}
        storeName="テスト店"
        pageDirty={false}
        pageBusy={false}
        onDiscardPage={() => {}}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    )

    const titleField = screen.getByRole('textbox', { name: /題名/ })
    const completionField = screen.getByRole('textbox', { name: /完了後の文/ })
    const firstField = definition.fields[0]
    const firstLabelField = screen.getByRole('textbox', { name: `${firstField.label}の項目名` })

    // 1. 題名を空にしてエラーを出し、入力を直し始めたら消える
    fireEvent.change(titleField, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(titleField, { target: { value: 'ご予約フォーム' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    // 2. 項目名を空にしてエラーを出し、入力を直し始めたら消える
    fireEvent.change(firstLabelField, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(firstLabelField, { target: { value: firstField.label } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    // 3. 完了後の文を空にしてエラーを出し、入力を直し始めたら消えて確定できる
    fireEvent.change(completionField, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(completionField, { target: { value: 'ご予約を受け付けました。' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'この内容にする' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
