// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/rich-menus/edit/" }
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichMenuCreateV8 from '@/v8/rich-menus/new/create'

const net = vi.hoisted(() => ({ role: 'owner', account: { id: 'account-1', name: '店A' }, list: vi.fn(), cancel: vi.fn() }))
const group = {
  id: 'g1', accountId: 'account-1', name: 'メニュー', chatBarText: 'メニュー',
  size: 'large', defaultPageId: 'p1', isDefaultForAll: false, status: 'draft',
  targetingCondition: null, targetingPriority: 0, targetingEnabled: false,
  folderId: null, defaultOpen: true, version: 1,
  pages: [{ id: 'p1', orderIndex: 0, name: '1枚目', aliasId: '', lineRichmenuId: null, imageR2Key: 'img', imageContentType: 'image/jpeg', areas: [] }],
}
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: net.account, selectedAccountId: net.account.id, accounts: [net.account], loading: false }),
}))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    staff: { ...actual.api.staff, me: async () => ({ success: true, data: { id: 'owner-1', role: net.role } }) },
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) },
    templates: { ...actual.api.templates, list: async () => ({ success: true, data: [] }) },
    forms: { ...actual.api.forms, list: async () => ({ success: true, data: [] }) },
    trackedLinks: { ...actual.api.trackedLinks, list: async () => ({ success: true, data: [] }) },
    richMenuGroups: { ...actual.api.richMenuGroups,
      get: async () => ({ success: true, data: group }),
      list: async () => ({ success: true, data: [{ ...group, id: 'restore-1', status: 'published', name: '通常メニュー' }] }),
      previewTargets: async () => ({ success: true, data: null }),
      audienceSummary: async () => ({ success: true, data: null }),
      prepublishCheck: async () => ({ success: true, data: { selfCheck: { ok: true }, deviceConfirmed: false, deviceConfirmedAt: null, pageCount: 1, maxPages: 10 } }),
      listSchedules: net.list, cancelSchedule: net.cancel,
    },
  } }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
function item(status = 'scheduled') {
  return { id: 'schedule-1', mode: 'scheduled' as 'scheduled' | 'period', startsAt: '2026-10-20T01:00:00Z', endsAt: null as string | null,
    restoreGroupId: null as string | null, restoreDefaultState: null as 'captured' | 'no_default' | null,
    status, attemptCount: 0, nextRetryAt: null as string | null, lastErrorCode: null, createdAt: '2026-10-01T00:00:00Z' }
}
async function openSchedules() {
  await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
  fireEvent.click(await screen.findByRole('button', { name: '公開予約の一覧' }))
  await waitFor(() => expect(net.list).toHaveBeenCalled())
  return screen.getByRole('dialog', { name: '公開予約の一覧' })
}
beforeEach(() => {
  net.role = 'owner'; net.account = { id: 'account-1', name: '店A' }
  net.list.mockReset().mockResolvedValue({ success: true, data: [item()] })
  net.cancel.mockReset().mockImplementation(async () => {
    net.list.mockResolvedValue({ success: true, data: [item('cancelled')] })
    return { success: true, data: { id: 'schedule-1', status: 'cancelled' } }
  })
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/rich-menus/edit?id=g1&step=publish')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); delete document.documentElement.dataset.theme })

describe('現役V8の公開予約の確認と取消', () => {
  it('全状態を区別し、まだ始まっていない予約だけ取り消せる', async () => {
    net.list.mockResolvedValue({ success: true, data: ['scheduled', 'publishing', 'published', 'restoring', 'completed', 'cancelled', 'failed'].map((status, i) => ({ ...item(status), id: `schedule-${i}` })) })
    const dialog = await openSchedules()
    for (const text of ['予約中', '公開処理中', '期間公開中', '復元処理中', '完了', '取消済み', '失敗・要対応']) expect(await within(dialog).findByText(text)).toBeTruthy()
    expect(within(dialog).getAllByRole('button', { name: '予約を取り消す' })).toHaveLength(1)
  })
  it('取消は一度送信し、最新一覧を読み直して取消済みにする', async () => {
    const dialog = await openSchedules()
    fireEvent.click(await within(dialog).findByRole('button', { name: '予約を取り消す' }))
    await within(dialog).findByText('予約を取り消しました。')
    await within(dialog).findByText('取消済み')
    expect(net.cancel).toHaveBeenCalledExactlyOnceWith('g1', 'schedule-1')
    expect(net.list).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('button', { name: '予約を取り消す' })).toBeNull()
  })
  it('取消が実行開始と競ったら失敗の理由を出し、最新状態で取消口を隠す', async () => {
    net.cancel.mockImplementation(async () => { net.list.mockResolvedValue({ success: true, data: [item('publishing')] }); throw new Error('already started') })
    const dialog = await openSchedules()
    fireEvent.click(await within(dialog).findByRole('button', { name: '予約を取り消す' }))
    await within(dialog).findByText('予約を取り消せませんでした。実行が始まっている可能性があります。')
    await within(dialog).findByText('公開処理中')
    expect(net.list).toHaveBeenCalledTimes(2)
    expect(within(dialog).queryByRole('button', { name: '予約を取り消す' })).toBeNull()
  })
  it('取消の二重押下は要求を増やさない', async () => {
    let resolve!: (value: unknown) => void
    net.cancel.mockReturnValue(new Promise(r => { resolve = r }))
    const dialog = await openSchedules()
    const button = await within(dialog).findByRole('button', { name: '予約を取り消す' })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(net.cancel).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ success: true, data: { id: 'schedule-1', status: 'cancelled' } }) })
  })
  it.each([
    ['explicit', '戻し先 通常メニュー'], ['captured', '戻し先確定済み（切替前の表示へ戻す）'],
    ['no_default', '戻し先なし（終了時に表示を外す）'], ['pending', '戻し先は実行開始時に確定'],
  ])('期間の戻し先 %s と再試行予定を示す', async (restore, message) => {
    const schedule = item('published'); schedule.mode = 'period'; schedule.endsAt = '2026-10-21T01:00:00Z'; schedule.nextRetryAt = '2026-10-21T02:00:00Z'
    if (restore === 'explicit') schedule.restoreGroupId = 'restore-1'
    if (restore === 'captured' || restore === 'no_default') schedule.restoreDefaultState = restore
    net.list.mockResolvedValue({ success: true, data: [schedule] })
    const dialog = await openSchedules()
    expect(await within(dialog).findByText(message)).toBeTruthy()
    expect(within(dialog).getByText(/次回/)).toBeTruthy()
  })
  it('取得失敗を空一覧にせず、押し直して取得できる', async () => {
    net.list.mockRejectedValueOnce(new Error('down'))
    const dialog = await openSchedules()
    await within(dialog).findByText('公開予約の一覧を読み込めませんでした。時間をおいて、もう一度お試しください。')
    expect(within(dialog).queryByText(/まだ公開予約はありません/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: '再試行' }))
    await within(dialog).findByText('予約中')
  })
  it('本当に空の時は予約なしと案内する', async () => {
    net.list.mockResolvedValue({ success: true, data: [] })
    const dialog = await openSchedules()
    expect(await within(dialog).findByText('まだ公開予約はありません。日時を決めて予約するとここに出ます。')).toBeTruthy()
  })
  it('閲覧のみでは取消の口を灰色で出し、押しても取り消さない', async () => {
    net.role = 'viewer'
    const dialog = await openSchedules()
    await within(dialog).findByText('予約中')
    const cancel = within(dialog).getByRole('button', { name: '予約を取り消す' })
    expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(cancel)).toBe(true)
    fireEvent.click(cancel)
    expect(net.cancel).not.toHaveBeenCalled()
  })
  it('店切替では前の一覧と取消の口を破棄する', async () => {
    await openSchedules()
    await screen.findByRole('button', { name: '予約を取り消す' })
    net.account = { id: 'account-2', name: '店B' }
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    expect(screen.queryByRole('dialog', { name: '公開予約の一覧' })).toBeNull()
    expect(net.cancel).not.toHaveBeenCalled()
  })
})
