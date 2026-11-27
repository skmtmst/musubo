// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FileDropzone, { AttachmentRow } from './file-drop'

const reason = '閲覧のみのため変更できません'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const file = () => new File(['old_uid,new_uid'], '対応表.csv', { type: 'text/csv' })

function attemptSelection(zone: HTMLElement, input: HTMLInputElement) {
  fireEvent.click(zone)
  fireEvent.keyDown(zone, { key: 'Enter' })
  fireEvent.keyDown(zone, { key: ' ' })
  fireEvent.drop(zone, { dataTransfer: { files: [file()], items: [] } })
  fireEvent.paste(zone)
  fireEvent.change(input, { target: { files: [file()] } })
}

function expectReason(button: HTMLElement) {
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(button.hasAttribute('data-permission-locked')).toBe(true)
  const ids = button.getAttribute('aria-describedby')!.split(' ')
  expect(ids.some(id => document.getElementById(id)?.textContent === reason)).toBe(true)
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
}

describe('ファイル操作の権限拒否', () => {
  it.each(['default', 'video', 'composer', 'upload'] as const)('%s は選択・drop・paste・遅いinput変更を拒み理由へ焦点で届く', variant => {
    const onFiles = vi.fn(), onPaste = vi.fn()
    const { container } = render(<FileDropzone variant={variant} title="対応表" disabled lockedReason={reason} onFiles={onFiles} onPaste={onPaste} />)
    const zone = container.firstElementChild as HTMLElement
    const input = zone.querySelector('input')!
    const opened = vi.fn(); input.addEventListener('click', opened)
    const button = screen.getByRole('button', { name: variant === 'default' || variant === 'video' ? 'ファイルを選択する' : '対応表' })
    expectReason(button)
    if (variant === 'upload' || variant === 'composer') expect(button.tabIndex).toBe(0)
    else fireEvent.click(button)
    attemptSelection(zone, input)
    expect(opened).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
    expect(onPaste).not.toHaveBeenCalled()
    expect(input.disabled).toBe(true)
    expect(zone.getAttribute('data-drag')).toBe('idle')
  })

  it('通常のdrop・paste・ファイル選択を保ち、権限切替後はすべて拒む', () => {
    const onFiles = vi.fn(), onPaste = vi.fn()
    const { container, rerender } = render(<FileDropzone title="対応表" onFiles={onFiles} onPaste={onPaste} multiple />)
    const zone = container.firstElementChild as HTMLElement
    const input = zone.querySelector('input')!
    const opened = vi.fn(); input.addEventListener('click', opened)
    fireEvent.click(screen.getByRole('button', { name: 'ファイルを選択する' }))
    fireEvent.drop(zone, { dataTransfer: { files: [file(), file()], items: [] } })
    fireEvent.paste(zone)
    fireEvent.change(input, { target: { files: [file(), file()] } })
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(onFiles.mock.calls.map(call => call[0].length)).toEqual([2, 2])
    expect(onPaste).toHaveBeenCalledTimes(1)
    fireEvent.dragEnter(zone, { dataTransfer: { items: [] } })
    expect(zone.getAttribute('data-drag')).toBe('active')
    rerender(<FileDropzone title="対応表" lockedReason={reason} onFiles={onFiles} onPaste={onPaste} multiple />)
    expect(screen.getByRole('button', { name: 'ファイルを選択する' })).toBeTruthy()
    attemptSelection(zone, input)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(onPaste).toHaveBeenCalledTimes(1)
    rerender(<FileDropzone title="対応表" onFiles={onFiles} onPaste={onPaste} multiple />)
    expect(zone.getAttribute('data-drag')).toBe('idle')
    fireEvent.click(screen.getByRole('button', { name: 'ファイルを選択する' }))
    expect(opened).toHaveBeenCalledTimes(2)
  })

  it('入力・状態によるdisabledは通常disabledのまま権限の印と理由を足さない', () => {
    const { container } = render(<FileDropzone title="対応表" disabled onFiles={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'ファイルを選択する' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(container.querySelector('[data-permission-locked]')).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it.each(['remove', 'retry'] as const)('%s は権限理由で拒み、解除後に一度だけ動く。既存の説明も保つ', operation => {
    const action = vi.fn()
    const props = operation === 'remove' ? { onRemove: action } : { status: 'error' as const, errorText: 'CSVを選び直してください', onRetry: action }
    const { rerender } = render(<AttachmentRow name="対応表.csv" {...props} lockedReason={reason} />)
    const button = screen.getByRole('button')
    expectReason(button)
    if (operation === 'retry') {
      expect(button.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent)).toContain('CSVを選び直してください')
    }
    fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' })
    expect(action).not.toHaveBeenCalled()
    rerender(<AttachmentRow name="対応表.csv" {...props} />)
    fireEvent.click(screen.getByRole('button'))
    expect(action).toHaveBeenCalledTimes(1)
    rerender(<AttachmentRow name="対応表.csv" {...props} disabled />)
    fireEvent.click(screen.getByRole('button'))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button').hasAttribute('data-permission-locked')).toBe(false)
  })
})
