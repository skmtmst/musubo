// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { PageExplanationProvider } from '@/components/shared/page-explanation'
import FieldsTab from './fields-tab'
import { ApiError } from '@/lib/api'
const net = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    friendFields: { ...actual.api.friendFields, list: net.list, delete: net.remove, stats: async () => ({ success: true, data: null }) },
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
  } }
})
const item = { id: 'field', accountId: 'account', name: '好きな色', fieldKey: 'color', type: 'text', isInherited: false, usageCount: 0, formUsageCount: 0, displayTargets: [] }
beforeEach(() => { vi.clearAllMocks(); verifiedStaffRole('owner'); net.list.mockResolvedValue({ success: true, data: [item] }); net.remove.mockResolvedValue({ success: true, data: null }) })
afterEach(() => { cleanup(); verifiedStaffRole(null) })
function Host({ canEdit = true }: { canEdit?: boolean }) {
  return <PageExplanationProvider pageKey="tags:fields"><FieldsTab accountId="account" canEdit={canEdit} /></PageExplanationProvider>
}
async function openDelete() {
  const view = render(<Host />)
  fireEvent.click(await screen.findByRole('button', { name: '項目「好きな色」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '削除する' }))
  return { view, dialog: await screen.findByRole('alertdialog') }
}
it('不正な情報欄の種類を確認できないと表示する', async () => {
  net.list.mockResolvedValue({ success: true, data: [{ ...item, type: {} }, { ...item, id: 'known', name: '既存の欄', type: 'text' }] })
  render(<Host />)
  await screen.findByText('好きな色')
  expect(screen.getByText('種類を確認できません')).toBeTruthy()
  expect(screen.getByText('1行テキスト')).toBeTruthy()
})
