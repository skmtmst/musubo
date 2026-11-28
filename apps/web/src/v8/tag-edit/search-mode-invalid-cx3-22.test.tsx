import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 保存した検索の編集（XBkiQ）を描いて押す。
 * 保存・複製・削除はそれぞれの口へ今のアカウントで送る・使っている所と該当人数は読んだ値で出す・
 * 使用中は削除を押させず理由を言う・消せる時だけ確認の窓から削除の口を呼ぶ。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams('id=s1'), usePathname: () => '/tags/searches/edit' }))
const account = vi.hoisted(() => ({ id: 'acc' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { name: account.id === 'acc' ? '本店' : '別店' } }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))

const heldDelete = vi.hoisted(() => ({ confirm: null as null | (() => unknown) }))
vi.mock('@/components/shared/confirm-dialog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.description.includes('保存した条件だけを削除') && props.onConfirm) heldDelete.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})

const net = vi.hoisted(() => ({ detail: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn(), preview: vi.fn() }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  const list = async () => ({ success: true, data: [] })
  return {
    ...actual,
    api: {
      ...actual.api,
      savedSearches: {
        ...actual.api.savedSearches,
        list: async () => ({ success: true, items: [], summary: { total: 3 } }),
        detail: net.detail, update: net.update, create: net.create, delete: net.remove, preview: net.preview,
      },
      tags: { list }, supportMarks: { list }, scenarios: { list }, friendFields: { list }, forms: { list }, operators: { list },
    },
  }
})

import SearchEdit from './search-edit'

type Usage = { kind: 'broadcast' | 'automation' | 'scenario' | 'other'; id: string; name: string; mode: 'live' | 'fixed' }
function detail(overrides: { usedIn?: Usage[] | undefined; canDelete?: boolean; matchCount?: number | null } = {}) {
  return {
    id: 's1', name: 'VIPかつ未契約', scope: 'friends', lineAccountId: 'acc', isShared: false, revision: 4,
    conditions: { all: [{ kind: 'name', op: 'contains', value: 'VIP' }], any: [] },
    matchCount: 'matchCount' in overrides ? overrides.matchCount : 12,
    usedIn: 'usedIn' in overrides ? overrides.usedIn : [],
    canDelete: overrides.canDelete ?? true,
    match: { total: 12, byChannel: { line: 12, mail: 0 }, calculatedAt: '', error: null },
  }
}
const sideCount = () => screen.getByRole('heading', { name: '当てはまる人' }).parentElement!.nextElementSibling!.textContent
const deleteButton = () => screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement

beforeEach(() => {
  account.id = 'acc'
  net.detail.mockResolvedValue({ success: true, data: detail() })
  net.update.mockResolvedValue({ success: true, data: detail() })
  net.create.mockResolvedValue({ success: true, data: { id: 's9' } })
  net.remove.mockResolvedValue({ success: true, data: null })
  net.preview.mockResolvedValue({ success: true, data: { match: { total: 12, byChannel: { line: 12, mail: 0 }, calculatedAt: '2026-10-01T00:00:00.000Z', error: null } } })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('未知の参照方式を固定だと決めつけない', async () => {
  const data = detail({ usedIn: [{ kind: 'broadcast', id: 'b1', name: '秋の案内', mode: 'live' }], canDelete: false })
  data.usedIn![0].mode = 'unexpected' as Usage['mode']
  net.detail.mockResolvedValue({ success: true, data })
  render(<SearchEdit />)
  await screen.findByDisplayValue('VIPかつ未契約')
  expect(screen.getByText('秋の案内（固定か確認できません）')).toBeTruthy()
  expect(screen.queryByText('秋の案内（固定）')).toBeNull()
})
