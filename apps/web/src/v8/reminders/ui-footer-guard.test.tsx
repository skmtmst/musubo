// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WizardFooterV8 } from './ui'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => {
  cleanup()
})

describe('WizardFooterV8 の処理中・無効ガード', () => {
  it('下書き保存中は全ボタンを無効化し、コールバック側でも実行を止める', () => {
    const onCancel = vi.fn()
    const onDraft = vi.fn()
    const onNext = vi.fn()

    render(
      <WizardFooterV8
        onCancel={onCancel}
        onDraft={onDraft}
        draftBusy
        onNext={onNext}
        nextLabel="次へ"
      />,
    )

    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true)
      button.removeAttribute('disabled')
      fireEvent.click(button)
    }

    expect(onCancel).not.toHaveBeenCalled()
    expect(onDraft).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('次へ処理中はキャンセルと下書き保存も含めて無効化し、コールバック側でも止める', () => {
    const onCancel = vi.fn()
    const onDraft = vi.fn()
    const onNext = vi.fn()

    render(
      <WizardFooterV8
        onCancel={onCancel}
        onDraft={onDraft}
        onNext={onNext}
        nextBusy
        nextLabel="有効にする"
      />,
    )

    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true)
      button.removeAttribute('disabled')
      fireEvent.click(button)
    }

    expect(onCancel).not.toHaveBeenCalled()
    expect(onDraft).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('個別無効のキャンセル・次へはコールバック側でも止め、通常時は全操作を実行する', () => {
    const onCancel = vi.fn()
    const onDraft = vi.fn()
    const onNext = vi.fn()

    const { rerender } = render(
      <WizardFooterV8
        onCancel={onCancel}
        cancelDisabled
        onDraft={onDraft}
        onNext={onNext}
        nextDisabled
        nextLabel="次へ"
      />,
    )

    const cancelBtn = screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement
    const nextBtn = screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement
    expect(cancelBtn.disabled).toBe(true)
    expect(nextBtn.disabled).toBe(true)
    cancelBtn.removeAttribute('disabled')
    nextBtn.removeAttribute('disabled')
    fireEvent.click(cancelBtn)
    fireEvent.click(nextBtn)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()

    rerender(
      <WizardFooterV8
        onCancel={onCancel}
        onDraft={onDraft}
        onNext={onNext}
        nextLabel="次へ"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onDraft).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})
