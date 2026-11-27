// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useInboxDraft } from './use-inbox-draft'

function Composer() {
  const draft = useInboxDraft({ selectedAccountId: 'account-1', selectedChatId: 'chat-1' })
  return <><label>ファイルを選ぶ<input type="file" onChange={event => { const file = event.target.files?.[0]; if (file) void draft.handlePickAttachment(file, 'file') }} /></label>
    {draft.imageError ? <p role="alert">{draft.imageError}</p> : null}
    {draft.pendingAttachment ? <p>添付を準備しています</p> : null}</>
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('大きさを確認できない添付はアップロードせず、理由を表示する', async () => {
  const upload = vi.spyOn(api.chats.attachments, 'upload').mockResolvedValue({ success: false, error: 'offline' } as never)
  const file = new File(['内容'], '案内.pdf', { type: 'application/pdf' })
  Object.defineProperty(file, 'size', { value: NaN })
  render(<Composer />)
  fireEvent.change(screen.getByLabelText('ファイルを選ぶ'), { target: { files: [file] } })
  expect((await screen.findByRole('alert')).textContent).toContain('大きさを確認できません')
  expect(upload).not.toHaveBeenCalled()
})

it('対応外の種類はアップロードせず、送れない理由を表示する', async () => {
  const upload = vi.spyOn(api.chats.attachments, 'upload').mockResolvedValue({ success: false, error: 'offline' } as never)
  const file = new File(['内容'], '案内.unknown', { type: 'constructor' })
  render(<Composer />)
  fireEvent.change(screen.getByLabelText('ファイルを選ぶ'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('送れない形式'))
  expect(upload).not.toHaveBeenCalled()
})
