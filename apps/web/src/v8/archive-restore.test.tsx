// @vitest-environment happy-dom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { flushListUrlState } from '@/components/shared/list-url-state'

const state = vi.hoisted(() => ({ canEdit: true, path: '/tags', marks: [] as unknown[], rules: [] as unknown[] }))
const calls = vi.hoisted(() => ({ tag: vi.fn(), mark: vi.fn(), rule: vi.fn(), status: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => state.path, useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('./automations/shell', async original => ({
  ...await original<typeof import('./automations/shell')>(), useAutomationManage: () => state.canEdit,
  useAutomationTabCounts: () => ({ rules: 1, commonActions: 0, templates: 0 }),
}))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: {
    ...actual.api,
    tags: { ...actual.api.tags, restore: calls.tag },
    supportMarks: { ...actual.api.supportMarks, list: vi.fn(async () => ({ success: true, data: state.marks })), restore: calls.mark },
    automations: { ...actual.api.automations, list: vi.fn(async () => ({ success: true, data: state.rules })), restore: calls.rule, setStatus: calls.status },
    folders: { ...actual.api.folders, list: vi.fn(async () => ({ success: true, data: [] })) },
    listStats: { get: vi.fn(async () => ({ success: false })) },
  } }
})
import TagsTab from './tags/tags-tab'
import MarksTab from './tags/marks-tab'
import AutomationList from './automations/list'
import { FRIEND_ATTRIBUTES_QA_TAGS } from '@/components/friend-fields/tags-page-v4'

beforeEach(() => {
  state.canEdit = true
  window.history.replaceState(null, '', '/tags')
  flushListUrlState()
  state.marks = [{ id: 'old', name: '保管したマーク', color: '#94a3b8', archivedAt: '2026-10-09', version: 2, friendCount: 0, automationRules: [], isDefault: false, isInherited: false }]
  state.rules = [{ id: 'old', name: '保管したルール', status: 'archived', isActive: false, confirmationRevision: 2, eventType: 'message_received', triggerConfig: {}, conditions: {}, actions: [], executionCount30d: 0, failureCount30d: 0, updatedAt: '2026-10-09' }]
  for (const call of Object.values(calls)) { call.mockReset(); call.mockResolvedValue({ success: true, data: { restored: true, version: 3, status: 'stopped' } }) }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: '未取得' }), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); flushListUrlState(); vi.unstubAllGlobals() })

const cases = [
  { name: 'タグ', id: 'tag-old', title: '保管したタグ', menu: 'タグ「保管したタグ」の操作', call: calls.tag,
    node: () => <TagsTab accountId="account-1" fixture={{ items: [{ ...FRIEND_ATTRIBUTES_QA_TAGS[0], id: 'tag-old', name: '保管したタグ', status: 'archived', version: 2 }], groups: [] }} canEdit={state.canEdit} narrow={false} csvOpen={false} onCsvClose={() => {}} /> },
  { name: '対応マーク', id: 'old', title: '保管したマーク', menu: '対応マーク「保管したマーク」の操作', call: calls.mark,
    node: () => <MarksTab accountId="account-1" canEdit={state.canEdit} /> },
  { name: 'ルール', id: 'old', title: '保管したルール', menu: 'ルール「保管したルール」の操作', call: calls.rule,
    node: () => <AutomationList /> },
]

describe('一覧の保管から戻す操作', () => {
  it('ルールの保管は「保管する」と表示し、確認後に保管状態を送る', async () => {
    state.rules = (state.rules as Array<Record<string, unknown>>).map(rule => ({ ...rule, status: 'stopped' }))
    render(<AutomationList />)
    await screen.findByText('保管したルール')
    fireEvent.click(screen.getByRole('button', { name: 'ルール「保管したルール」の操作' }))
    expect(screen.queryByRole('menuitem', { name: '削除する' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '保管する' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('通常の一覧から外します。動いた記録と設定は残り、「保管したもの」の絞り込みから戻せます。')
    expect(calls.status).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '保管する' }))
    await waitFor(() => expect(calls.status).toHaveBeenCalledWith('old', 'archived', 2))
  })
  for (const entry of cases) {
    it(`${entry.name}を保管の札で探し、確認後だけ戻すAPIを呼ぶ`, async () => {
      render(entry.node())
      expect(screen.queryByText(entry.title)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: entry.name === 'ルール' ? '保管したもの' : '保管', exact: true }))
      await screen.findByText(entry.title)
      fireEvent.click(screen.getByRole('button', { name: entry.menu }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '保管から戻す' }))
      const dialog = await screen.findByRole('dialog')
      expect(entry.call).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole('button', { name: '保管から戻す' }))
      await waitFor(() => expect(entry.call).toHaveBeenCalledWith(entry.id, 'account-1', ...(entry.name === 'ルール' ? [] : [2])))
    })

    it(`${entry.name}の失敗は確認窓に残り、再試行できる`, async () => {
      entry.call.mockResolvedValueOnce({ success: false, error: '状態が変わりました' })
      render(entry.node())
      fireEvent.click(screen.getByRole('button', { name: entry.name === 'ルール' ? '保管したもの' : '保管', exact: true }))
      await screen.findByText(entry.title)
      fireEvent.click(screen.getByRole('button', { name: entry.menu }))
      fireEvent.click(await screen.findByRole('menuitem', { name: '保管から戻す' }))
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: '保管から戻す' }))
      await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy())
      expect(screen.queryByText(entry.title)).not.toBeNull()
      fireEvent.click(within(dialog).getByRole('button', { name: '保管から戻す' }))
      await waitFor(() => expect(entry.call).toHaveBeenCalledTimes(2))
    })

    it(`${entry.name}を閲覧のみで見ると戻す操作を出さない`, async () => {
      state.canEdit = false
      render(entry.node())
      fireEvent.click(screen.getByRole('button', { name: entry.name === 'ルール' ? '保管したもの' : '保管', exact: true }))
      await screen.findByText(entry.title)
      const menu = screen.queryByRole('button', { name: entry.menu })
      if (menu) fireEvent.click(menu)
      expect(screen.queryByRole('menuitem', { name: '保管から戻す' })).toBeNull()
      expect(entry.call).not.toHaveBeenCalled()
    })
  }
})
