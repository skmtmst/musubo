// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqStoreList, { type HqStoreListProps } from './store-list'
import type { HqTemplate } from '@/lib/hq-templates-api'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/hq/friend-attributes' }))
afterEach(cleanup)
function show(count: unknown, type: 'tag' | 'template' | 'rich_menu' = 'tag') {
  const row = { id: 't1', name: '会員', description: null, template_type: type, folder_id: null, revision: 1, updated_at: '2026-09-30T01:00:00.000Z', content_summary: 'タグ', distributed_account_count: 1, distributed_account_names: ['本店'], distributed_account_more: 0, friend_count: count, this_month_sent_count: count, tap_count: count, assignment_method: '手動' } as HqTemplate
  const props: HqStoreListProps = { type, ...(type === 'template' ? { kind: 'message' as const } : {}), rows: [row], ready: true, busy: false, canEdit: true, accountTotal: 1, folders: [], folderLoadFailed: false, folderFilter: 'all', onFolderFilter: vi.fn(), onAddFolder: vi.fn(async () => {}), onRenameFolder: vi.fn(async () => {}), onDeleteFolder: vi.fn(async () => {}), onCreate: vi.fn(), onEdit: vi.fn(), onDistribute: vi.fn(), onDuplicate: vi.fn(), onRemove: vi.fn() }
  render(<HqStoreList {...props} />)
}
function card(title: string) { return screen.getByText(title, { selector: '[data-kpi-label] span' }).closest('[data-kpi-presentation]')! }

it('人数が負数なら未使用・整理候補・友だちの合計を確定した数にしない', () => {
  show(-1)
  for (const title of ['未使用', '整理の候補', '付けている友だち']) expect(card(title).querySelector('[data-kpi-fit]')?.textContent).toContain('—')
})

it('人数が数値以外なら未使用や整理候補を確定した数にしない', () => {
  show('不明')
  for (const title of ['未使用', '整理の候補', '付けている友だち']) expect(card(title).querySelector('[data-kpi-fit]')?.textContent).toContain('—')
})

it('0人は未使用として数え、通常の人数もそのまま合計する', () => {
  show(0)
  expect(card('未使用').querySelector('[data-kpi-fit]')?.textContent).toContain('1')
  expect(card('付けている友だち').querySelector('[data-kpi-fit]')?.textContent).toContain('0')
})


it('配信数が不正な場合は合計を確定した数にしない', () => {
  show(-1, 'template')
  expect(card('今月送った数').querySelector('[data-kpi-fit]')?.textContent).toContain('—')
})

it('タップ数が不正な場合は合計を確定した数にしない', () => {
  show(1.5, 'rich_menu')
  expect(card('今月押された').querySelector('[data-kpi-fit]')?.textContent).toContain('—')
})
