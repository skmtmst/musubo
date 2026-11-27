// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AssetTemplatesList from './asset-list'
const fixture = vi.hoisted(() => ({ folders: vi.fn(), items: [] as unknown[] }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: { broadcastMessageAssets: { folders: { list: fixture.folders } } } }))
vi.mock('@/components/broadcasts/broadcast-asset-manager', () => ({ default: ({ renderLayout }: { renderLayout: (state: unknown) => React.ReactNode }) => renderLayout({
  items: fixture.items, loadState: 'ready', reload: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), editor: null, deleteDialog: null,
}) }))
const item = { id: 'one', name: '顧客アンケート', payload: {}, status: 'published', updatedAt: '2026-10-30', folderId: null }
beforeEach(() => { fixture.folders.mockResolvedValue({ success: true, data: [] }); fixture.items = [item] })
afterEach(() => { cleanup(); vi.clearAllMocks() })
function show() { render(<AssetTemplatesList kind="research" accountId="a" tabs={null} canMutate={false} onChanged={vi.fn()} query="" setQuery={vi.fn()} />) }
it('未知の公開状態を下書きと決めつけない', async () => {
  fixture.items = [{ ...item, status: 'future' }]
  show()
  await waitFor(() => expect(screen.getByText('顧客アンケート')).toBeTruthy())
  expect(screen.getByText('状態を確認できません')).toBeTruthy()
})
it('公開中の未公開変更は型の状態に従って表示する', async () => {
  fixture.items = [{ ...item, status: 'published_with_draft', hasDraft: true }]
  show()
  await waitFor(() => expect(screen.getByText('未公開の変更')).toBeTruthy())
  fireEvent.click(within(screen.getByRole('group', { name: '公開の状態' })).getByRole('button', { name: '公開中' }))
  expect(screen.getByText('顧客アンケート')).toBeTruthy()
})
it('内容が不正でも一覧を開き、確認できないと表示する', async () => {
  fixture.items = [{ ...item, payload: null }]
  show()
  await waitFor(() => expect(screen.getByText('内容を確認できません')).toBeTruthy())
  expect(screen.getByText('顧客アンケート')).toBeTruthy()
})
