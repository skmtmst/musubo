// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ enabled: () => true }),
}))

vi.mock('@/components/shared/date-field', () => ({
  default: ({
    'aria-label': ariaLabel,
    value,
    onChange,
  }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  ),
}))

import InsertRow from './insert-row'

afterEach(cleanup)

const REFERENCES = {
  friendFields: [{ fieldKey: 'birthday', name: '誕生日' }],
  commonVars: [{ varKey: 'shop_url', name: '店舗URL' }],
} as Parameters<typeof InsertRow>[0]['references']

describe('InsertRow の目標日未入力・無効化・アカウント切替ガード', () => {
  it('目標日が空のあいだは「差し込む」ボタンを押せず理由を出し、選ぶと差し込める', () => {
    const onInsert = vi.fn()
    render(
      <InsertRow
        accountId="acc-a"
        state="ready"
        references={REFERENCES}
        length={0}
        onInsert={onInsert}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'その他' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '目標日までの日数' }))

    const confirmButton = screen.getByRole('button', { name: '差し込む' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('目標日を選んでから差し込んでください')

    fireEvent.click(confirmButton)
    expect(onInsert).not.toHaveBeenCalled()

    const dateInput = screen.getByLabelText('日数を数える目標日')
    fireEvent.change(dateInput, { target: { value: '2026-12-31' } })
    expect(confirmButton.disabled).toBe(false)

    fireEvent.click(confirmButton)
    expect(onInsert).toHaveBeenCalledWith('{{days_until:2026-12-31}}')
  })

  it('差し込みメニューや目標日ダイアログを開いた後に disabled またはアカウント切替になったら閉じる', () => {
    const view = render(
      <InsertRow
        accountId="acc-a"
        state="ready"
        references={REFERENCES}
        length={0}
        disabled={false}
        onInsert={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '友だち情報' }))
    expect(screen.getByRole('menu', { name: '差し込む友だち情報' })).toBeTruthy()

    view.rerender(
      <InsertRow
        accountId="acc-b"
        state="ready"
        references={REFERENCES}
        length={0}
        disabled={false}
        onInsert={() => {}}
      />,
    )
    expect(screen.queryByRole('menu', { name: '差し込む友だち情報' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'その他' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '目標日までの日数' }))
    expect(screen.getByRole('dialog', { name: '目標日までの日数を差し込む' })).toBeTruthy()

    view.rerender(
      <InsertRow
        accountId="acc-b"
        state="ready"
        references={REFERENCES}
        length={0}
        disabled={true}
        onInsert={() => {}}
      />,
    )
    expect(screen.queryByRole('dialog', { name: '目標日までの日数を差し込む' })).toBeNull()
  })
})
