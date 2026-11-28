// @vitest-environment happy-dom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MediaItem } from '@line-crm/shared'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))

const mocked = vi.hoisted(() => ({ update: vi.fn(), impact: vi.fn() }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, media: { ...actual.api.media, update: mocked.update, deleteImpact: mocked.impact } } }
})
import MediaDetailDialog from './media-detail-dialog'

const item = { id: 'sample', lineAccountId: 'account-a', revision: 3, folderId: null, filename: '見本.pdf', kind: 'file', mimeType: 'application/pdf', sizeBytes: 100, width: null, height: null, durationMs: null, usageCount: 0, url: 'https://example.test/sample', archivedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' } as MediaItem
beforeEach(() => {
  mocked.update.mockReset()
  mocked.impact.mockResolvedValue({ success: true, data: { media: { id: 'sample', filename: '見本.pdf', kind: 'file' }, usageCount: 0, references: [], checkedAt: '2026-09-01T00:00:00Z', verified: true, canDelete: true, recommendedAction: 'delete', versions: [] } })
})
afterEach(() => { cleanup(); clearToastsForTest() })

it('利用期限と同意を保存したら完了を知らせる', async () => {
  mocked.update.mockResolvedValue({ success: true, data: { ...item, revision: 4, usageConsentNote: '確認済み' } })
  const onItemUpdated = vi.fn()
  render(<><MediaDetailDialog item={item} accountId="account-a" folderName="未分類" canManage onClose={vi.fn()} onVersionCreated={vi.fn()} onItemUpdated={onItemUpdated} /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: '記録する' }))
  fireEvent.change(screen.getByPlaceholderText(/例：出演者/), { target: { value: '確認済み' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText('利用期限と同意の記録を保存しました。')).toBeTruthy()
  expect(onItemUpdated).toHaveBeenCalledOnce()
})

it('保存に失敗したら完了を知らせず入力を残す', async () => {
  mocked.update.mockRejectedValue(new Error('failed'))
  render(<><MediaDetailDialog item={item} accountId="account-a" folderName="未分類" canManage onClose={vi.fn()} onVersionCreated={vi.fn()} /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: '記録する' }))
  const input = screen.getByPlaceholderText(/例：出演者/) as HTMLInputElement
  fireEvent.change(input, { target: { value: '入力中' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(mocked.update).toHaveBeenCalledOnce())
  expect(screen.queryByText('利用期限と同意の記録を保存しました。')).toBeNull()
  expect(input.value).toBe('入力中')
})

it('別のアカウントに移った後は、前の保存結果を表示しない', async () => {
  let complete!: (value: unknown) => void
  mocked.update.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const onItemUpdated = vi.fn()
  const view = render(<><MediaDetailDialog item={item} accountId="account-a" folderName="未分類" canManage onClose={vi.fn()} onVersionCreated={vi.fn()} onItemUpdated={onItemUpdated} /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('button', { name: '記録する' }))
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  view.rerender(<><MediaDetailDialog item={{ ...item, id: 'other' }} accountId="account-b" folderName="未分類" canManage onClose={vi.fn()} onVersionCreated={vi.fn()} onItemUpdated={onItemUpdated} /><ToastHost /></>)
  await act(async () => { complete({ success: true, data: { ...item, revision: 4 } }) })
  expect(mocked.update).toHaveBeenCalledOnce()
  expect(screen.queryByText('利用期限と同意の記録を保存しました。')).toBeNull()
  expect(onItemUpdated).not.toHaveBeenCalled()
})
