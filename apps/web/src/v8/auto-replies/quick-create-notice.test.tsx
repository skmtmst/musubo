// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
const apiMock = vi.hoisted(() => ({ createDraft: vi.fn(), saveDraft: vi.fn(), conflicts: vi.fn(), publishDraft: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { autoReplies: apiMock }, describeSaveFailure: () => '保存失敗' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import QuickCreate from './quick-create'
const created = vi.fn()
beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot()
  document.documentElement.dataset.theme = 'v8'
  vi.clearAllMocks()
  apiMock.createDraft.mockResolvedValue({ success: true, data: { autoReplyId: 'draft-1', versionNumber: 1 } })
  apiMock.saveDraft.mockResolvedValue({ success: true, data: { autoReplyId: 'draft-1', versionNumber: 2 } })
  apiMock.conflicts.mockResolvedValue({ success: true, data: { conflicts: [{ autoReplyId: 'rule-1', name: '既存ルール' }] } })
  apiMock.publishDraft.mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); clearToastsForTest(); forgetStaffIdentity(); forgetSessionSnapshot() })

async function fillForm() {
  render(<><QuickCreate accountId="account-1" onClose={vi.fn()} onCreated={created} /><ToastHost /></>)
  fireEvent.change(screen.getByLabelText('追加する言葉'), { target: { value: '営業時間' } })
  fireEvent.keyDown(screen.getByLabelText('追加する言葉'), { key: 'Enter' })
  fireEvent.change(screen.getByLabelText('返す文'), { target: { value: '10時からです' } })
}
it('自動応答を有効にすると完了を知らせる', async () => {
  apiMock.conflicts.mockResolvedValue({ success: true, data: { conflicts: [] } })
  await fillForm()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有効にして保存' })) })
  expect(await screen.findByText('自動応答を有効にしました。')).toBeTruthy()
  expect(created).toHaveBeenCalledOnce()
})
it('有効化に失敗したら完了を知らせず入力を残す', async () => {
  apiMock.conflicts.mockResolvedValue({ success: true, data: { conflicts: [] } })
  apiMock.publishDraft.mockResolvedValueOnce({ success: false, error: '有効にできませんでした' })
  await fillForm()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有効にして保存' })) })
  expect(screen.queryByText('自動応答を有効にしました。')).toBeNull()
  expect(screen.getByDisplayValue('10時からです')).toBeTruthy()
  expect(created).not.toHaveBeenCalled()
})
