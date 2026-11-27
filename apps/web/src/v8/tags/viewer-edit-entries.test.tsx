// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { getPageAction, queryPageAction } from '@/test-utils/page-action'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageExplanationProvider } from '@/components/shared/page-explanation'

const state = vi.hoisted(() => ({ role: 'owner', query: '', searchEmpty: true }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
  usePathname: () => '/tags',
}))
vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: 'テスト店' } }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role, useStaffIdentity: () => null }))
vi.mock('./list', () => ({ default: () => <div>タグ一覧</div> }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const list = async () => ({ success: true, data: [] })
  return { ...actual, api: { ...actual.api,
    tagGroups: { ...actual.api.tagGroups, list },
    tags: { ...actual.api.tags, list },
    folders: { ...actual.api.folders, list },
    friendFields: { ...actual.api.friendFields, stats: async () => ({ success: false, error: '集計なし' }), list: async () => ({ success: true, data: [{ id: 'field-1', name: '来店日', fieldKey: 'visit', type: 'text', options: [], isInherited: false, version: 1 }] }), migrationPreview: async () => ({ success: false, error: '見本なし' }) },
    supportMarks: { ...actual.api.supportMarks, list: async () => ({ success: true, data: [{ id: 'mark-1', name: '要確認', color: '#fbbf24', friendCount: 1, isDefault: false, automationRules: [], usedIn: [], isInherited: false }] }) },
    listStats: { ...actual.api.listStats, get: async () => ({ success: false, error: '集計なし' }) },
    scenarios: { ...actual.api.scenarios, list },
    forms: { ...actual.api.forms, list },
    operators: { ...actual.api.operators, list },
    savedSearches: { ...actual.api.savedSearches,
      list: async () => ({ success: true, items: state.searchEmpty ? [] : [{ id: 'search-1', name: '来店した人', lineAccountId: 'acc-1', conditions: { all: [], any: [] }, isShared: true, usedIn: [], canDelete: true }], summary: { total: state.searchEmpty ? 0 : 1 } }),
      detail: async () => ({ success: true, data: { id: 'search-1', name: '来店した人', lineAccountId: 'acc-1', conditions: { all: [{ type: 'tag', tagId: 'tag-1' }], any: [] }, isShared: true, revision: 1, match: { count: 1, error: null }, canDelete: true, usedIn: [] } }),
      preview: async () => ({ success: true, data: { match: { count: 1, error: null } } }),
    },
  } }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import TagCreate from './create'
import FieldNew from './field-new'
import FieldEdit from './field-edit'
import FieldMigrate from './field-migrate'
import FolderPage from './folder-page'
import FieldsTab from './fields-tab'
import MarksTab from './marks-tab'
import SearchesTab from './searches-tab'
import SearchEdit from '../tag-edit/search-edit'

beforeEach(() => { window.history.replaceState(null, '', '/tags'); flushListUrlState(); state.query = ''; state.searchEmpty = true; document.documentElement.dataset.theme = 'v8' })
afterEach(() => { cleanup(); vi.clearAllMocks(); delete document.documentElement.dataset.theme })

const entries = [
  ['タグを作る', TagCreate, '', ['タグを作る', '保存して続けて作る']],
  ['情報欄を作る', FieldNew, '', ['項目を作る']],
  ['情報欄を編集', FieldEdit, 'id=field-1', ['保存する']],
  ['情報欄の種類を変える', FieldMigrate, 'id=field-1', ['項目を作って事前確認']],
  ['フォルダを作る', FolderPage, '', ['フォルダを作る']],
  ['保存した検索を編集', SearchEdit, 'id=search-1', ['保存する', '複製して保存する', '削除する']],
] as const

for (const [title, Component, query, actions] of entries) {
  it.each(['staff', 'owner', 'admin'])(`${title}の変更口は閲覧のみで隠す（%s）`, async role => {
    state.role = verifiedStaffRole(role)
    state.query = query
    render(<Component />)
    if (role === 'staff') {
      await screen.findByText(/^(閲覧のみで見ています。(変える操作は|変えたい時は)(オーナーか)?管理者に頼んでください。|この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。)$/)
      for (const name of actions) expect(queryPageAction({ name, exact: true })).toBeNull()
    } else {
      await waitFor(() => {
        for (const name of actions) expect(getPageAction({ name, exact: true })).toBeTruthy()
      })
    }
  })
}

for (const [title, Component, name, menuTitle] of [
  ['友だち情報欄', FieldsTab, '来店日', '項目'],
  ['対応マーク', MarksTab, '要確認', '対応マーク'],
  ['保存した検索', SearchesTab, '来店した人', '保存した検索'],
] as const) {
  it.each(['staff', 'owner', 'admin'])(`${title}の詳細と行の編集リンクは閲覧のみで隠す（%s）`, async role => {
    state.role = verifiedStaffRole(role)
    state.searchEmpty = false
    const view = <Component accountId="acc-1" canEdit={role !== 'staff'} />
    const { container } = render(title === '友だち情報欄' ? <PageExplanationProvider pageKey="tags:fields">{view}</PageExplanationProvider> : view)
    await screen.findAllByText(name)
    if (title === '保存した検索') {
      const open = screen.getByRole('link', { name: `「${name}」で友だち一覧を開く` })
      expect(open.getAttribute('href')).toBe('/friends?savedSearch=search-1')
      expect(open.querySelector('svg.lucide-arrow-right')).not.toBeNull()
    }
    expect(screen.queryByRole('link', { name, exact: true }) !== null).toBe(role !== 'staff')
    fireEvent.click(container.querySelector('tbody tr')!)
    await screen.findByRole('dialog', { name })
    expect(screen.queryByRole('link', { name: '編集する' }) !== null).toBe(role !== 'staff')
    if (role === 'staff') {
      expect(screen.queryByRole('button', { name: '削除する' })).toBeNull()
      expect(screen.queryByRole('button', { name: /名前を変更する|複製して保存/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true }))
      fireEvent.click(screen.getByRole('button', { name: `${menuTitle}「${name}」の操作`, exact: true }))
      await screen.findByRole('menuitem', { name: title === '保存した検索' ? '友だち一覧へ' : '詳しく見る' })
      for (const label of ['編集', '複製して保存', '削除する', '保管する', '移行（種類を変える）']) expect(screen.queryByRole('menuitem', { name: label, exact: true })).toBeNull()
    }
  })
}

it.each(['staff', 'owner', 'admin'])('保存した検索が0件でも作成リンクは権限で隠す（%s）', async role => {
  state.role = verifiedStaffRole(role)
  render(<SearchesTab accountId="acc-1" canEdit={role !== 'staff'} />)
  await screen.findByText('まだ保存した検索はありません')
  expect(screen.queryByRole('link', { name: '友だち一覧で条件を作る' }) !== null).toBe(role !== 'staff')
})

afterEach(() => { verifiedStaffRole(null) })

it('項目IDがない編集画面は取得を待たずに見出しと一覧への戻り先を出す', async () => {
  state.role = verifiedStaffRole('owner')
  state.query = ''
  const { api } = await import('@/lib/api')
  const list = vi.spyOn(api.friendFields, 'list')
  render(<main><FieldEdit /></main>)
  expect(screen.getByRole('heading', { level: 1, name: '編集する友だち情報欄が指定されていません' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '友だち情報欄の一覧へ戻る' }).getAttribute('href')).toBe('/tags?tab=fields')
  expect(list).not.toHaveBeenCalled()
})
