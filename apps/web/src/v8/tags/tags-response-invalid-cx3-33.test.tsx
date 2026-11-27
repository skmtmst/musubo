// @vitest-environment happy-dom
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushListUrlState } from '@/components/shared/list-url-state'

const mutations = vi.hoisted(() => ({ remove: vi.fn(), restore: vi.fn(), notify: vi.fn() }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: mutations.notify, notifySaved: mutations.notify }))
const net = vi.hoisted(() => ({ tags: vi.fn(), groups: vi.fn(), marks: vi.fn(), searches: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'A' }) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    tags: { ...actual.api.tags, list: net.tags, restore: mutations.restore }, tagGroups: { ...actual.api.tagGroups, list: net.groups },
    supportMarks: { ...actual.api.supportMarks, list: net.marks }, savedSearches: { ...actual.api.savedSearches, list: net.searches, delete: mutations.remove },
    listStats: { get: async () => ({ success: false }) },
    scenarios: { list: async () => ({ success: true, data: [] }) }, friendFields: { list: async () => ({ success: true, data: [] }) },
  } }
})
import { ApiError } from '@/lib/api'
import TagsTab from './tags-tab'
import MarksTab from './marks-tab'
import SearchesTab from './searches-tab'

const variants = [
  { name: 'タグ', load: net.tags, component: (accountId: string, canEdit = false) => <TagsTab accountId={accountId} canEdit={canEdit} narrow={false} csvOpen={false} onCsvClose={() => {}} />, empty: 'まだタグがありません', row: { id: 'tag-a', name: 'Aのタグ', friendCount: 5, displayOrder: 0 }, create: '最初のタグを作る' },
  { name: '対応マーク', load: net.marks, component: (accountId: string, canEdit = false) => <MarksTab accountId={accountId} canEdit={canEdit} />, empty: 'まだ対応マークはありません', row: { id: 'mark-a', name: 'Aの対応マーク', color: '#888', friendCount: 5, displayOrder: 0, automationRules: [] }, create: 'マークを作る' },
  { name: '保存した検索', load: net.searches, component: (accountId: string, canEdit = false) => <SearchesTab accountId={accountId} canEdit={canEdit} />, empty: 'まだ保存した検索はありません', row: { id: 'search-a', name: 'Aの保存した検索', matchCount: 5, conditions: { all: [] }, usedIn: [], displayOrder: 0 }, create: '友だち一覧で条件を作る' },
]
const answer = (items: unknown[]) => ({ success: true, data: items, items, summary: { total: items.length, usedInBroadcasts: 0, zeroMatches: 0, callsThisMonth: 0 } })
function deferred() {
  let resolve!: (value: ReturnType<typeof answer>) => void
  const promise = new Promise<ReturnType<typeof answer>>(yes => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  flushListUrlState()
  window.history.replaceState(null, '', '/tags')
  for (const load of Object.values(net)) load.mockReset().mockResolvedValue(answer([]))
  for (const operation of Object.values(mutations)) operation.mockReset().mockResolvedValue({ success: true, data: { version: 2 } })
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

it('タグ一覧が不正な応答なら失敗を知らせ、再読み込みできる', async () => {
  net.tags.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue(answer([variants[0].row]))
  render(<TagsTab accountId="A" canEdit={false} narrow={false} csvOpen={false} onCsvClose={() => {}} />)
  await screen.findByText('タグを読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('Aのタグ')).toBeTruthy()
})
it.each([{ success: false, error: 'offline' }, { success: true, data: {} }])('フォルダが取得できないとき一覧は残し、失敗と再読み込みを示す', async response => {
  net.tags.mockResolvedValue(answer([{ ...variants[0].row, groupId: 'group-a' }]))
  net.groups.mockResolvedValueOnce(response).mockResolvedValue(answer([{ id: 'group-a', name: '予約' }]))
  render(<TagsTab accountId="A" canEdit={false} narrow={false} csvOpen={false} onCsvClose={() => {}} />)
  const tagName = await screen.findByText('Aのタグ')
  expect(tagName.closest('tr')?.querySelectorAll('td').length).toBeGreaterThan(1)
  await screen.findByText('フォルダを読み込めませんでした。')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度' }))
  expect(await screen.findByText('予約')).toBeTruthy()
  expect(screen.getByText('Aのタグ').closest('tr')?.querySelectorAll('td').length).toBeGreaterThan(1)
})
