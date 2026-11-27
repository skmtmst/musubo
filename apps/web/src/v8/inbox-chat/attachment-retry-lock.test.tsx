// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AttachmentChip from './attachment-chip'

afterEach(cleanup)
const item = { kind: 'file' as const, name: '案内.pdf', size: 1024, status: 'failed' as const }

it('送信や予約処理中は添付の再試行を始めない', () => {
  const retry = vi.fn()
  render(<AttachmentChip item={item} busy onRemove={() => {}} onRetry={retry} />)
  const button = screen.getByRole('button', { name: 'もう一度試す' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(retry).not.toHaveBeenCalled()
})

it('再描画前に連打しても一度だけ再試行し、失敗後には再び試せる', async () => {
  const retry = vi.fn()
  const view = render(<AttachmentChip item={item} onRemove={() => {}} onRetry={retry} />)
  const button = screen.getByRole('button', { name: 'もう一度試す' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  view.rerender(<AttachmentChip item={{ ...item, status: 'uploading' }} onRemove={() => {}} onRetry={retry} />)
  view.rerender(<AttachmentChip item={item} onRemove={() => {}} onRetry={retry} />)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))
  expect(retry).toHaveBeenCalledTimes(2)
})


it('状態が変わらない場合も次の操作で再試行できる', async () => {
  const retry = vi.fn()
  render(<AttachmentChip item={item} onRemove={() => {}} onRetry={retry} />)
  const button = screen.getByRole('button', { name: 'もう一度試す' })
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(1)
  await Promise.resolve()
  fireEvent.click(button)
  expect(retry).toHaveBeenCalledTimes(2)
})
