// @vitest-environment happy-dom
/*
 * タグの編集フォーム（TagEditForm）を描いて押す。
 * マイルの欄の言葉・遡及は初期オフで専用の確認窓を通す・題はトップの見出しだけ・
 * 連動の行は複製でき、対象を選ぶ種類だけ対象の欄を出す・消す前の注意を右に出す。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag } from '@line-crm/shared'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
const net = vi.hoisted(() => ({ preview: vi.fn(), list: vi.fn() }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    commonActions: { ...actual.api.commonActions, resources: async () => ({ success: false, error: 'not configured' }) },
    tags: { ...actual.api.tags, list: net.list, retroactivePreview: net.preview },
  } }
})
import { TagEditForm } from './edit-form'
import { RetroactiveDialog, type LinkedAction, type TagEditorValues } from '@/components/friend-fields/tag-editor-v4'

type Props = Partial<React.ComponentProps<typeof TagEditForm>>
function renderForm(props: Props = {}) {
  const onSave = vi.fn()
  const tag = { id: 't1', name: 'VIP', status: 'active', linkedEnabled: false, friendCount: 5 } as Tag
  render(<TagEditForm tag={tag} groups={[]} dependencies={null} accountId="a1" readOnly={false} conflict={false} compareBusy={false} onCompare={vi.fn()} onReloadLatest={vi.fn()} retroactiveReference={false} initialActions={[]} saving={false} error="" onCancel={vi.fn()} onSave={onSave} onDelete={vi.fn()} {...props} />)
  return onSave
}
const openRegion = (name: string) => fireEvent.click(within(screen.getByRole('region', { name })).getByRole('button', { name: '開く' }))

beforeEach(() => {
  net.list.mockReset().mockResolvedValue({ success: true, data: [] })
  net.preview.mockResolvedValue({ success: true, data: { selfTargets: 4, referralTargets: 1, selfMiles: 400, referralMiles: 0, selfExcluded: 1, referralExcluded: 0, previewToken: 'pt-1' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('不正な使用件数を「なし」と見せない', () => {
  renderForm({ dependencies: { referenceCounts: { broadcasts: NaN, forms: 0, automations: 0 }, references: [] } as never })
  const label = screen.getByText('一斉配信')
  expect(label.nextElementSibling?.textContent).toBe('—')
})
it('使用先のリンク一覧が不正でも使っている件数を表示する', () => {
  renderForm({ dependencies: { referenceCounts: { broadcasts: 3, forms: 0, automations: 0 }, references: null } as never })
  const label = screen.getByText('一斉配信')
  expect(label.nextElementSibling?.textContent).toContain('3 件')
  expect(label.nextElementSibling?.querySelector('a')).toBeNull()
})
it('使用件数が null なら保存済みの件数で表示する', () => {
  const tag = { id: 't1', name: 'VIP', status: 'active', friendCount: 5, usedIn: { broadcasts: 4 } } as Tag
  renderForm({ tag, dependencies: { referenceCounts: { broadcasts: null, forms: 0, automations: 0 }, references: [] } as never })
  expect(screen.getByText('一斉配信').nextElementSibling?.textContent).toContain('4 件')
})
it('普段は使用中だけ出る項目も不正な件数なら不明と表示する', () => {
  renderForm({ dependencies: { referenceCounts: { broadcasts: 0, forms: 0, automations: 0, scenarios: -1 }, references: [] } as never })
  expect(screen.getByText('シナリオ').nextElementSibling?.textContent).toBe('—')
})
