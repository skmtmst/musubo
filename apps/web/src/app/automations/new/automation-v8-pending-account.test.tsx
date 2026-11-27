import { getPageAction } from '@/test-utils/page-action'

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import { notifyToast } from '@/components/shared/toast'
import { api } from '@/lib/api'
import { NewAutomationV8 } from '@/v8/automations/create/create'
// @vitest-environment happy-dom

// 実ブラウザではV8のガードが保存・送信中の切替を止める。
// それとは別に、Provider側の選択が変わった場合も遅い応答を他店へ混ぜない。
// V8本体と保存・送信の判断、タグの選ぶ窓は差し替えない。種類のSelectだけ素の欄へ置く。
const account = vi.hoisted(() => ({ id: 'account-1' }))
const routerPush = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))

vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: vi.fn(async () => ({ success: true, data: { items: [{ id: 'friend-1', displayName: '試験の友だち' }], total: 1 } })) },
      tags: { ...actual.api.tags, list: vi.fn() },
      scenarios: { ...actual.api.scenarios, list: vi.fn() },
      friendFields: { ...actual.api.friendFields, list: vi.fn() },
      supportMarks: { ...actual.api.supportMarks, list: vi.fn() },
      featureSettings: { ...actual.api.featureSettings, visibility: vi.fn() },
      segments: { ...actual.api.segments, count: vi.fn() },
      automations: {
        ...actual.api.automations,
        list: vi.fn(),
        draftResources: vi.fn(),
        createDraftFromTemplate: vi.fn(),
        updateDraft: vi.fn(),
        getDraft: vi.fn(),
        audiencePreview: vi.fn(),
        publishDraft: vi.fn(),
        test: vi.fn(),
        getRun: vi.fn(),
      },
    },
  }
})

vi.mock('@/components/shared/toast', () => ({ notifyToast: vi.fn() }))

function ok<T>(data: T) { return { success: true as const, data } }
function draft(accountId = 'account-1') {
  return {
    id: `draft-${accountId}`, draftVersionId: 'v2', name: `ルール-${accountId}`,
    description: null, eventType: 'message_received' as const, triggerConfig: {}, conditions: {},
    actions: [{ id: 'step-1', type: 'add_tag' as const, params: { tagId: 'tag-1' }, onFailure: 'stop' as const }],
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.resetAllMocks()
  account.id = 'account-1'
  window.sessionStorage.clear()
  vi.stubGlobal('sessionStorage', window.sessionStorage)
  window.history.replaceState(null, '', '/automations/new?draft=draft-account-1')
  document.documentElement.dataset.theme = 'v8'
  vi.mocked(api.automations.list).mockResolvedValue(ok([]) as never)
  vi.mocked(api.automations.draftResources).mockResolvedValue(ok({ tags: [{ id: 'tag-1', name: 'VIP' }], scenarios: [] }) as never)
  vi.mocked(api.tags.list).mockResolvedValue(ok([{ id: 'tag-1', name: 'VIP' }]) as never)
  vi.mocked(api.scenarios.list).mockResolvedValue(ok([]) as never)
  vi.mocked(api.friendFields.list).mockResolvedValue(ok([]) as never)
  vi.mocked(api.supportMarks.list).mockResolvedValue(ok([]) as never)
  vi.mocked(api.featureSettings.visibility).mockResolvedValue(ok({ features: {} }) as never)
  vi.mocked(api.segments.count).mockResolvedValue({ success: true, count: 0 } as never)
  vi.mocked(api.automations.getDraft).mockImplementation(async (_id, accountId) => ok(draft(accountId)) as never)
  vi.mocked(api.automations.createDraftFromTemplate).mockImplementation(async (_template, accountId) => ok({ id: `draft-${accountId}`, draftVersionId: 'v1' }) as never)
  vi.mocked(api.automations.updateDraft).mockResolvedValue(ok({ updated: true, draftVersionId: 'v2' }) as never)
  vi.mocked(api.automations.audiencePreview).mockResolvedValue(ok({ matched: 3, total: 10, freshness: 'available' }) as never)
  vi.mocked(api.automations.getRun).mockResolvedValue(ok({ status: 'queued' }) as never)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

async function mount() {
  const view = render(<NewAutomationV8 chrome="create" />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('ルール-account-1'))
  return view
}
async function changeProvider(view: ReturnType<typeof render>, id: string) {
  account.id = id
  view.rerender(<NewAutomationV8 chrome="create" />)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '1人テストの確認' })).toBeNull())
}
async function fillTagRule(name: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '名前', exact: true }), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: '1つ目の行うことのその他操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '設定を変更する' }))
  await pickEntity('自動化で付けるタグ', 'VIP')
  fireEvent.click(screen.getByRole('button', { name: '1つ目の行うことのその他操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '設定を閉じる' }))

}
async function save() {
  const calls = vi.mocked(api.automations.updateDraft).mock.calls.length
  fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
  await waitFor(() => expect(api.automations.updateDraft).toHaveBeenCalledTimes(calls + 1))
  await waitFor(() => expect((getPageAction({ name: '下書きを保存', exact: true }) as HTMLButtonElement).disabled).toBe(false))
}

describe('V8本体の遅延応答と店舗の分離', () => {
  it('新規Bの保存応答がAへ戻った後に来ても、Aの既存下書きとBの新規下書きを保つ', async () => {
    const view = await mount()
    await changeProvider(view, 'account-2')
    await fillTagRule('新規B')
    const pending = deferred<ReturnType<typeof ok<{ id: string; draftVersionId: string }>>>()
    vi.mocked(api.automations.createDraftFromTemplate).mockReturnValueOnce(pending.promise as never)
    fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    await waitFor(() => expect(api.automations.createDraftFromTemplate).toHaveBeenCalledTimes(1))
    await changeProvider(view, 'account-1')
    expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('ルール-account-1')
    await act(async () => pending.resolve(ok({ id: 'draft-account-2', draftVersionId: 'v1' })))
    await waitFor(() => expect(api.automations.updateDraft).toHaveBeenCalledWith('draft-account-2', 'account-2', expect.objectContaining({ name: '新規B' })))
    expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('ルール-account-1')
    await save()
    expect(api.automations.updateDraft).toHaveBeenLastCalledWith('draft-account-1', 'account-1', expect.anything())
    await changeProvider(view, 'account-2')
    await save()
    expect(api.automations.updateDraft).toHaveBeenLastCalledWith('draft-account-2', 'account-2', expect.anything())
    expect(api.automations.createDraftFromTemplate).toHaveBeenCalledTimes(1)
  })

  it.each(['成功', '失敗'])('1人テストの%s応答が店舗切替後に来ても、別店舗と戻った店舗へ成否を残さない', async (outcome) => {
    const view = await mount()
    await pickEntity('試す友だち', '試験の友だち')
    fireEvent.click(screen.getByRole('button', { name: '1人で試す', exact: true }))
    const dialog = await screen.findByRole('dialog', { name: '1人テストの確認' })
    const pending = deferred<unknown>()
    vi.mocked(api.automations.test).mockReturnValueOnce(pending.promise as never)
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で送る' }))
    await waitFor(() => expect(api.automations.test).toHaveBeenCalledTimes(1))
    await changeProvider(view, 'account-2')
    vi.mocked(notifyToast).mockClear()
    await act(async () => {
      if (outcome === '成功') pending.resolve(ok({ runId: 'run-1', status: 'queued', versionId: 'v2' }))
      else pending.reject(new Error('テストする友だちが見つかりません'))
    })
    expect(notifyToast).not.toHaveBeenCalledWith(expect.stringMatching(/1人テストを受け付けました/))
    expect(screen.queryByText(/テストする友だちが見つかりません/)).toBeNull()
    expect((screen.getByRole('button', { name: '1人で試す', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    await changeProvider(view, 'account-1')
    expect(notifyToast).not.toHaveBeenCalledWith(expect.stringMatching(/1人テストを受け付けました/))
    expect(screen.queryByText(/テストする友だちが見つかりません/)).toBeNull()
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
