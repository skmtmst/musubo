// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BASICS, reminderTemplatesV8, type BasicsValue, type ReminderTemplateV8 } from './basics-form'

vi.mock('./basics-form', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./basics-form')>()
  return {
    ...actual,
    ReminderBasicsFormV8: ({ onRequestTemplate }: { onRequestTemplate: (t: ReminderTemplateV8) => void }) => (
      <button type="button" onClick={() => onRequestTemplate(actual.reminderTemplatesV8[0])}>
        ひな形を選ぶ
      </button>
    ),
  }
})

import { BasicsStageV8 } from './edit-basics'

const frame = {
  boardId: 'test',
  title: '基本設定',
  identity: null,
  steps: null,
  help: null,
}

const value: BasicsValue = {
  ...EMPTY_BASICS,
  name: '来店リマインダ',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('リマインダ基本設定の保存中ひな形上書きガード', () => {
  it('保存中はひな形選択と上書き確認ダイアログからの上書きを止める', () => {
    const onChange = vi.fn()
    const onTemplate = vi.fn()
    const baseProps = {
      frame,
      notice: null,
      value,
      onChange,
      onTemplate,
      stepCount: 1,
      onSave: vi.fn(),
      onSaveDraft: vi.fn(),
      onCancel: vi.fn(),
    }

    // 保存中はひな形を押しても上書き確認が開かず反映もされない
    const view = render(<BasicsStageV8 {...baseProps} busy />)
    fireEvent.click(screen.getByRole('button', { name: 'ひな形を選ぶ' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onTemplate).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    // 平常時に上書き確認を開いたあとで保存中になったら、確定ボタンを無効化して上書きを止める
    view.rerender(<BasicsStageV8 {...baseProps} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'ひな形を選ぶ' }))
    expect(screen.getByText('ひな形の内容で上書きしますか？')).toBeTruthy()

    view.rerender(<BasicsStageV8 {...baseProps} busy />)
    const confirmButton = screen.getByRole('button', { name: /このひな形を使う|保存中/ }) as HTMLButtonElement
    expect(confirmButton.disabled || confirmButton.getAttribute('aria-busy') === 'true').toBe(true)
    fireEvent.click(confirmButton)
    expect(onTemplate).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()

    // 保存中でなければ確定して適用できる
    view.rerender(<BasicsStageV8 {...baseProps} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'このひな形を使う' }))
    expect(onTemplate).toHaveBeenCalledWith(reminderTemplatesV8[0])
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
