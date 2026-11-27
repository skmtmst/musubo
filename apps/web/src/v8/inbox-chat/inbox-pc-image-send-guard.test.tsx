// @vitest-environment happy-dom
import React, { useRef, useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { InsertTextFieldHandle } from '@/components/shared/insert-text-field'
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'sample', name: '見本' }] }) }))
vi.mock('@/components/chats/template-picker', () => ({ default: () => null }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: () => undefined }))
vi.mock('@/components/shared/sender-select', () => ({ default: () => null }))
vi.mock('./schedule-dialog', () => ({ default: () => null }))
import InboxReplyComposer from './inbox-reply-composer'
type Props = ComponentProps<typeof InboxReplyComposer>
const send = vi.fn(), keyDown = vi.fn()
function Demo({ uploading, mode = 'enter' }: { uploading: boolean; mode?: 'enter' | 'shift-enter' }) {
  const [messageContent, setMessageContent] = useState('見本の文章')
  const textareaRef = useRef<InsertTextFieldHandle>(null)
  const props = {
    staffRole: 'owner', scheduledSends: [], pendingPack: null, messageContent, messageLength: messageContent.length,
    pendingImage: null, pendingAttachment: null, quotedMessage: null, chatDetail: null, textareaRef,
    tokenNames: { vars: {}, varsComplete: true }, imageInputRef: { current: null }, isComposingRef: { current: false },
    memoPopoverRef: { current: null }, showTemplatePicker: false, setShowTemplatePicker: () => {}, setMessageContent,
    selectedChatId: 'sample-chat', selectedAccountId: 'sample-account', sendMode: mode, imageUploading: uploading,
    handleSendMessage: send, handleKeyDown: keyDown,
  } as unknown as Props
  return <InboxReplyComposer {...props} />
}
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('画像の読み込み中は理由を示して送信できず、完了後に送れる', () => {
  const view = render(<Demo uploading />)
  const button = screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-description')).toBe('画像を読み込み中')
  expect(screen.getByText('画像を読み込み中')).toBeTruthy()
  fireEvent.click(button)
  expect(send).not.toHaveBeenCalled()
  view.rerender(<Demo uploading={false} />)
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(['enter', 'shift-enter'] as const)('画像の読み込み中は %s の送信キーも止め、改行は使える', mode => {
  const view = render(<Demo uploading mode={mode} />)
  const editor = screen.getByRole('textbox', { name: 'メッセージを入力' })
  fireEvent.keyDown(editor, { key: 'Enter', shiftKey: mode === 'shift-enter' })
  expect(keyDown).not.toHaveBeenCalled()
  fireEvent.keyDown(editor, { key: 'Enter', shiftKey: mode !== 'shift-enter' })
  expect(keyDown).toHaveBeenCalledTimes(1)
  view.rerender(<Demo uploading={false} mode={mode} />)
  fireEvent.keyDown(editor, { key: 'Enter', shiftKey: mode === 'shift-enter' })
  expect(keyDown).toHaveBeenCalledTimes(2)
})
