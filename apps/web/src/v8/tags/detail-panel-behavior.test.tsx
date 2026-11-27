// @vitest-environment happy-dom
/*
 * タグ・対応マーク・保存した検索・友だち情報欄の4つの一覧で共通の動き。
 * 行を押すと右の詳細パネルが開き、URL に残り、↑↓で前・次の行へ移る。
 * 右クリックで行の「…」と同じ操作が出る。名前の欄はその場で書き換えられる（タグ名は単独の更新口が無いので編集画面へ）。
 * 削除・保管は確認の窓を通し、選んだだけでは口を叩かない。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import { PageExplanationProvider } from '@/components/shared/page-explanation'

const calls = vi.hoisted(() => ({
  markUpdate: vi.fn(async () => ({ success: true, data: null })),
  searchUpdate: vi.fn(async () => ({ success: true, data: null })),
  fieldUpdate: vi.fn(async () => ({ success: true, data: null })),
  tagUpdate: vi.fn(async () => ({ success: true, data: null })),
  remove: vi.fn(async () => ({ success: true, data: null })),
  archiveImpact: vi.fn(async () => ({ success: true, data: { friendCount: 0, usedIn: [], version: 1 } })),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/tags',
}))
vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: 'テスト店' } }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner', useStaffIdentity: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const list = async () => ({ success: true, data: [] })
  const mark = (id: string, name: string) => ({ id, name, color: '#fbbf24', friendCount: 1, isDefault: false, automationRules: [], usedIn: [], isInherited: false, version: 1 })
  const search = (id: string, name: string) => ({ id, name, lineAccountId: 'acc-1', conditions: { all: [], any: [] }, isShared: true, usedIn: [], canDelete: true })
  const field = (id: string, name: string) => ({ id, name, fieldKey: `key_${id}`, type: 'text', options: [], isInherited: false, version: 1, usageCount: 0, formUsageCount: 0, displayTargets: [] })
  return { ...actual, api: { ...actual.api,
    tagGroups: { ...actual.api.tagGroups, list },
    tags: { ...actual.api.tags, list, update: calls.tagUpdate },
    folders: { ...actual.api.folders, list },
    friendFields: { ...actual.api.friendFields, stats: async () => ({ success: false, error: '集計なし' }), list: async () => ({ success: true, data: [field('field-1', '来店日'), field('field-2', '好きな色')] }), update: calls.fieldUpdate, delete: calls.remove },
    supportMarks: { ...actual.api.supportMarks, list: async () => ({ success: true, data: [mark('mark-1', '要確認'), mark('mark-2', '対応中')] }), update: calls.markUpdate, archiveImpact: calls.archiveImpact, archive: calls.remove },
    listStats: { ...actual.api.listStats, get: async () => ({ success: false, error: '集計なし' }) },
    scenarios: { ...actual.api.scenarios, list },
    savedSearches: { ...actual.api.savedSearches, list: async () => ({ success: true, items: [search('search-1', '来店した人'), search('search-2', '未来店の人')], summary: { total: 2 } }), update: calls.searchUpdate, delete: calls.remove },
  } }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import { FRIEND_ATTRIBUTES_QA_GROUPS, FRIEND_ATTRIBUTES_QA_TAGS } from '@/components/friend-fields/tags-page-v4'
import TagsTab from './tags-tab'
import MarksTab from './marks-tab'
import SearchesTab from './searches-tab'
import FieldsTab from './fields-tab'

beforeEach(() => { window.history.replaceState(null, '', '/tags'); flushListUrlState(); document.documentElement.dataset.theme = 'v8' })
afterEach(() => { cleanup(); clearToastsForTest(); vi.clearAllMocks(); delete document.documentElement.dataset.theme })

const [tagA, tagB] = FRIEND_ATTRIBUTES_QA_TAGS
const cases = [
  {
    title: 'タグ', key: 'tag', ids: [tagA.id, tagB.id], names: [tagA.name, tagB.name], menu: 'タグ', removeLabel: '保管する',
    view: () => <TagsTab accountId="acc-1" fixture={{ items: [tagA, tagB].map((tag) => ({ ...tag, groupId: null })), groups: FRIEND_ATTRIBUTES_QA_GROUPS }} canEdit narrow={false} csvOpen={false} onCsvClose={() => {}} />,
    inline: null,
  },
  {
    title: '対応マーク', key: 'mark', ids: ['mark-1', 'mark-2'], names: ['要確認', '対応中'], menu: '対応マーク', removeLabel: '保管する',
    view: () => <MarksTab accountId="acc-1" canEdit />, inline: { label: 'マーク名', update: calls.markUpdate, args: ['mark-1', 'acc-1', { name: '要確認（済）', expectedVersion: 1 }] },
  },
  {
    title: '保存した検索', key: 'search', ids: ['search-1', 'search-2'], names: ['来店した人', '未来店の人'], menu: '保存した検索', removeLabel: '削除する',
    view: () => <SearchesTab accountId="acc-1" canEdit />, inline: { label: '検索名', update: calls.searchUpdate, args: ['search-1', 'acc-1', { name: '来店した人（済）' }] },
  },
  {
    title: '友だち情報欄', key: 'field', ids: ['field-1', 'field-2'], names: ['来店日', '好きな色'], menu: '項目', removeLabel: '削除する',
    view: () => <PageExplanationProvider pageKey="tags:fields"><FieldsTab accountId="acc-1" canEdit /></PageExplanationProvider>, inline: { label: '項目名', update: calls.fieldUpdate, args: ['field-1', 'acc-1', { name: '来店日（済）' }] },
  },
] as const

const rowOf = (container: HTMLElement, name: string) => [...container.querySelectorAll('tbody tr')].find((row) => row.textContent?.includes(name)) as HTMLElement
/** 名前のリンクや「…」でなく、行の地（操作列の手前のセル）を押す。 */
const openRow = (container: HTMLElement, name: string) => fireEvent.click(rowOf(container, name).querySelector('td:last-child')!.previousElementSibling!)
const param = (key: string) => new URLSearchParams(window.location.search).get(key)
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '')

describe.each(cases)('$title の一覧', (testCase) => {
  it('行を押すと右の詳細パネルが開いて URL に残り、↓↑で前・次の行へ移る', async () => {
    const { container } = render(testCase.view())
    await screen.findAllByText(testCase.names[1])
    openRow(container, testCase.names[0])
    const panel = await screen.findByRole('dialog', { name: testCase.names[0] })
    expect(panel.getAttribute('data-design-part')).toBe('detail-panel')
    expect(param(testCase.key)).toBe(testCase.ids[0])
    expect((screen.getByRole('button', { name: '前の行' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { fireEvent.keyDown(document, { key: 'ArrowDown' }) })
    await screen.findByRole('dialog', { name: testCase.names[1] })
    expect(param(testCase.key)).toBe(testCase.ids[1])
    await act(async () => { fireEvent.keyDown(document, { key: 'ArrowUp' }) })
    await screen.findByRole('dialog', { name: testCase.names[0] })
    expect(param(testCase.key)).toBe(testCase.ids[0])
  })

  it('右クリックで、行の「…」と同じ操作が出る', async () => {
    const { container } = render(testCase.view())
    await screen.findAllByText(testCase.names[1])
    fireEvent.click(screen.getByRole('button', { name: `${testCase.menu}「${testCase.names[0]}」の操作` }))
    await screen.findAllByRole('menuitem')
    const rowMenu = menuLabels()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    const nameNode = [...rowOf(container, testCase.names[0]).querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent === testCase.names[0])!
    fireEvent.contextMenu(nameNode, { clientX: 200, clientY: 120 })
    const contextMenu = await screen.findByRole('menu')
    expect(contextMenu.getAttribute('aria-label')).toBe(`${testCase.menu}「${testCase.names[0]}」の操作`)
    const contextLabels = menuLabels()
    expect(rowMenu.length).toBeGreaterThan(0)
    for (const label of rowMenu.filter((label) => !label.includes('移す'))) expect(contextLabels).toContain(label)
  })

  it(`「${testCase.removeLabel}」は確認の窓を通し、選んだだけでは消さない`, async () => {
    render(testCase.view())
    await screen.findAllByText(testCase.names[1])
    fireEvent.click(screen.getByRole('button', { name: `${testCase.menu}「${testCase.names[0]}」の操作` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: testCase.removeLabel }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm.textContent).toContain(testCase.names[0])
    expect(calls.remove).not.toHaveBeenCalled()
  })

  if (testCase.inline) {
    const inline = testCase.inline
    it('名前を編集中の行送りは確認し、編集を続ければ入力を保つ', async () => {
      const { container } = render(testCase.view())
      await screen.findAllByText(testCase.names[1])
      openRow(container, testCase.names[0])
      const panel = await screen.findByRole('dialog', { name: testCase.names[0] })
      fireEvent.click(panel.querySelector(`button[aria-label="${inline.label}を変更する"]`)!)
      const input = panel.querySelector(`input[aria-label="${inline.label}"]`) as HTMLInputElement
      fireEvent.change(input, { target: { value: '編集中の名前' } }); fireEvent.blur(input)
      fireEvent.click(screen.getByRole('button', { name: '次の行' }))
      expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
      expect((screen.getByRole('textbox', { name: inline.label }) as HTMLInputElement).value).toBe('編集中の名前')
      expect(param(testCase.key)).toBe(testCase.ids[0])
    })
    it('名前の欄は詳細パネルの中でその場で書き換えられ、その項目の更新口へ送る', async () => {
      const { container } = render(testCase.view())
      await screen.findAllByText(testCase.names[1])
      openRow(container, testCase.names[0])
      const panel = await screen.findByRole('dialog', { name: testCase.names[0] })
      fireEvent.click(panel.querySelector(`button[aria-label="${inline.label}を変更する"]`)!)
      const input = panel.querySelector(`input[aria-label="${inline.label}"]`) as HTMLInputElement
      fireEvent.change(input, { target: { value: `${testCase.names[0]}（済）` } })
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
      await waitFor(() => expect(inline.update).toHaveBeenCalledTimes(1))
      expect(inline.update).toHaveBeenCalledWith(...inline.args)
    })
  } else {
    it('タグ名には単独の更新口が無いので、その場の書き換えは置かず編集画面へ行く', async () => {
      const { container } = render(testCase.view())
      await screen.findAllByText(testCase.names[1])
      openRow(container, testCase.names[0])
      const panel = await screen.findByRole('dialog', { name: testCase.names[0] })
      expect(panel.querySelector('button[aria-label$="を変更する"]')).toBeNull()
      expect(panel.querySelector('input')).toBeNull()
      const edit = new URL([...panel.querySelectorAll('a')].find((link) => link.textContent === '編集する')!.getAttribute('href')!, 'https://app.test')
    expect(edit.pathname).toBe('/tags/edit')
    expect(edit.searchParams.get('id')).toBe(testCase.ids[0])
      expect(calls.tagUpdate).not.toHaveBeenCalled()
    })
  }
})


it('友だち情報欄の名前を保存すると完了を知らせる', async () => {
  const { container } = render(<><PageExplanationProvider pageKey="tags:fields"><FieldsTab accountId="acc-1" canEdit /></PageExplanationProvider><ToastHost /></>)
  await screen.findAllByText('好きな色')
  openRow(container, '来店日')
  const panel = await screen.findByRole('dialog', { name: '来店日' })
  fireEvent.click(panel.querySelector('button[aria-label="項目名を変更する"]')!)
  const input = screen.getByRole('textbox', { name: '項目名' })
  fireEvent.change(input, { target: { value: '来店日（済）' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(await screen.findByText('友だち情報欄の名前を保存しました。')).toBeTruthy()
})

it('友だち情報欄の名前の保存に失敗したら通知せず入力を残す', async () => {
  calls.fieldUpdate.mockResolvedValueOnce({ success: false, error: '保存できませんでした' } as never)
  const { container } = render(<><PageExplanationProvider pageKey="tags:fields"><FieldsTab accountId="acc-1" canEdit /></PageExplanationProvider><ToastHost /></>)
  await screen.findAllByText('好きな色')
  openRow(container, '来店日')
  const panel = await screen.findByRole('dialog', { name: '来店日' })
  fireEvent.click(panel.querySelector('button[aria-label="項目名を変更する"]')!)
  const input = screen.getByRole('textbox', { name: '項目名' })
  fireEvent.change(input, { target: { value: '新しい名前' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(screen.queryByText('友だち情報欄の名前を保存しました。')).toBeNull()
  expect(screen.getByDisplayValue('新しい名前')).toBeTruthy()
})
