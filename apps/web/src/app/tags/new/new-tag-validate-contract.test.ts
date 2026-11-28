// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import type { Tag } from '@line-crm/shared'
import { TagEditForm } from '@/v8/tag-edit/edit-form'
import { getPageAction } from '@/test-utils/page-action'
import { readUiSource } from '../../../../scripts/test-ui-source.mjs'
const fs = { readFileSync: readUiSource }
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROUTE = fs.readFileSync(path.join(process.cwd(), 'src/app/tags/new/page.tsx'), 'utf8')
const API = fs.readFileSync(path.join(process.cwd(), 'src/lib/api.ts'), 'utf8')


vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement('a', { href }, children) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    commonActions: { ...actual.api.commonActions, resources: async () => ({ success: false, error: 'not configured' }) },
    tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) },
  } }
})
afterEach(cleanup)

function renderCopyAction() {
  const save = vi.fn(), remove = vi.fn()
  render(React.createElement(TagEditForm, {
    tag: { id: 'copy-source', name: '会員', status: 'active', linkedEnabled: false } as Tag,
    groups: [], dependencies: null, accountId: 'account-1', readOnly: false, conflict: false, compareBusy: false,
    onCompare: vi.fn(), onReloadLatest: vi.fn(), retroactiveReference: false, initialActions: [], saving: false,
    error: '', onCancel: vi.fn(), onSave: save, onDelete: remove,
  }))
  return { action: getPageAction({ name: '複製して作る', exact: true }), save, remove }
}

describe('タグ作成の名前検査の契約', () => {
  it('タグの更新に色を渡さない', () => {
    /* タグ自身は色を持たない。色は分類(フォルダ)に付ける。版付き(#715)。 */
    expect(API).toContain('update: (id: string, data: { lineAccountId: string | null; expectedVersion: number; isStarred: boolean })')
    expect(API).not.toContain('color?: string; isStarred?: boolean')
  })

  it('旧作成画面を残さず、一覧と複製から現役V8作成画面へ進む', () => {
    expect(ROUTE).not.toContain('LegacyNewTagPage')
    const { action, save, remove } = renderCopyAction()
    expect(action.getAttribute('href')).toBe('/tags/new?copy=copy-source')
    expect(save).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

})
