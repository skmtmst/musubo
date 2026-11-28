// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PageExplanationProvider } from '@/components/shared/page-explanation'
import FieldsTab from './fields-tab'
import { ApiError } from '@/lib/api'
const net = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), folders: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    friendFields: { ...actual.api.friendFields, list: net.list, delete: net.remove, stats: async () => ({ success: true, data: null }) },
    folders: { ...actual.api.folders, list: net.folders },
  } }
})
const item = { id: 'field', accountId: 'account', name: '好きな色', fieldKey: 'color', type: 'text', isInherited: false, usageCount: 0, formUsageCount: 0, displayTargets: [] }
beforeEach(() => { vi.clearAllMocks(); verifiedStaffRole('owner'); net.list.mockResolvedValue({ success: true, data: [item] }); net.remove.mockResolvedValue({ success: true, data: null }); net.folders.mockResolvedValue({ success: true, data: [] }) })
afterEach(() => { cleanup(); verifiedStaffRole(null) })
function Host({ canEdit = true }: { canEdit?: boolean }) {
  return <PageExplanationProvider pageKey="tags:fields"><FieldsTab accountId="account" canEdit={canEdit} /></PageExplanationProvider>
}
it('情報欄の応答が配列でなければ失敗を知らせ、再読み込みできる', async () => {
  net.list.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [item] })
  render(<Host />)
  await screen.findByText('友だち情報欄を読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('好きな色')).toBeTruthy()
})
it('フォルダの応答が配列でなければ失敗を知らせ、再読み込みできる', async () => {
  net.folders.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [{ id: 'folder', name: 'お客様' }] })
  render(<Host />)
  await screen.findByText('フォルダを読み込めませんでした。')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
  expect(await screen.findByText('お客様')).toBeTruthy()
})
