// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HqTemplate } from '@/lib/hq-templates-api'
import HqStoreList, { type HqStoreListProps } from './store-list'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/templates',
}))

const row = {
  id: 't1', name: 'お知らせ', description: null, template_type: 'template', folder_id: null,
  revision: 1, updated_at: '2026-09-30T01:00:00Z', kind: 'message', content_summary: '本文',
  distributed_account_count: 2, distributed_account_names: ['本店'], distributed_account_more: 1,
} as HqTemplate

function show(item: HqTemplate) {
  const props: HqStoreListProps = {
    type: 'template', rows: [item], ready: true, busy: false, canEdit: true, accountTotal: 4,
    kind: 'message', kindCounts: { message: 1 }, folders: [], folderLoadFailed: false, folderFilter: 'all',
    onKindChange: vi.fn(), onFolderFilter: vi.fn(), onAddFolder: vi.fn(), onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(), onCreate: vi.fn(), onEdit: vi.fn(), onDistribute: vi.fn(), onDuplicate: vi.fn(), onRemove: vi.fn(),
  }
  render(<HqStoreList {...props} />)
  return props
}

afterEach(cleanup)

it('要約が不正でも一覧を開け、内容を確認できないと表示する', () => {
  const props = show({ ...row, content_summary: { invalid: true } } as unknown as HqTemplate)
  expect(screen.getByText('お知らせ')).toBeTruthy()
  expect(screen.getByText('内容を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'お知らせ' }))
  expect(props.onEdit).toHaveBeenCalledOnce()
})

it('配布先の名前が不正でも一覧を開け、確認できないと表示する', () => {
  const props = show({ ...row, distributed_account_names: '本店' } as unknown as HqTemplate)
  expect(screen.getByText('お知らせ')).toBeTruthy()
  expect(screen.getByText('配布先を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'お知らせ' }))
  expect(props.onEdit).toHaveBeenCalledOnce()
})
