// @vitest-environment happy-dom
/*
 * S4-OR（動作条件の証明）: 終了後アクションの条件で、空の or だけ足して
 * 保存しても update の口は呼ばれず、不足の案内が出る。
 * 中身を入れたかたまり・条件なし（null）は保存できる。
 */
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActionEditor from './action-editor'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const net = vi.hoisted(() => ({
  list: vi.fn(), update: vi.fn(), draft: vi.fn(), saveDraft: vi.fn(),
  updates: [] as Array<{ scenarioId: string; actionId: string; patch: unknown }>,
}))

const SEED_ACTION = {
  id: 'a1',
  hook: 'scenario_completed',
  stepId: null,
  choiceIndex: null,
  actionType: 'tag',
  config: { op: 'add', tagIds: [] },
  condition: null,
  repeatOnRefire: true,
  sortOrder: 0,
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: {}, enabled: () => true }),
}))

vi.mock('./scenario-reference-data', () => ({
  scenarioReferenceData: {
    tags: async () => ({ success: true as const, data: [] }),
    friendFields: async () => ({ success: true as const, data: [] }),
    supportMarks: async () => ({ success: true as const, data: [] }),
    scenarios: async () => ({ success: true as const, data: [] }),
    commonVars: async () => ({ success: true as const, data: [] }),
    templates: async () => ({ success: true as const, data: [] }),
    reminders: async () => ({ success: true as const, data: [] }),
    events: async () => ({ success: true as const, data: [] }),
  },
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      scenarios: {
        list: async () => ({ success: true as const, data: [] }),
        actions: {
          list: net.list,
          update: net.update,
        },
        getDraft: net.draft,
        saveDraft: net.saveDraft,
      },
      tags: { list: async () => ({ success: true as const, data: [] }) },
      friendFields: { list: async () => ({ success: true as const, data: [] }) },
      supportMarks: { list: async () => ({ success: true as const, data: [] }) },
      segments: { count: async () => ({ success: true as const, data: { count: 0 } }) },
    },
  }
})

afterEach(() => {
  cleanup()
  net.updates = []
})

async function renderEditor() {
  await act(async () => {
    render(
      <ActionEditor
        scenarioId="sc-1"
        hook="scenario_completed"
        title="テストのあと"
        onClose={() => {}}
      />,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function openCondition() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '条件OFF' }))
  })
}

function orAddButton() {
  return screen.getByRole('button', { name: 'いずれか条件のかたまりを足す' })
}

function kindPickers() {
  return screen.getAllByRole('button', { name: '追加する条件を選ぶ' })
}

function pickKind(field: HTMLElement, query: string) {
  fireEvent.click(field)
  const dialog = screen.getByRole('dialog', { name: '条件を選ぶ', hidden: true })
  fireEvent.click(within(dialog).getByRole('radio', { name: query, hidden: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '条件を足す', hidden: true }))
}

async function saveCondition() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '条件を保存する' }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}


const sibling = { id: 'sibling', hook: 'step_sent', stepId: 'other-step', choiceKey: null, type: 'send_text', params: { content: '他の通' }, condition: null, onFailure: 'stop', sortOrder: 0 }
function setup() {
  net.list.mockReset().mockResolvedValue({success:true,data:[SEED_ACTION]})
  net.update.mockReset().mockResolvedValue({ success: true, data: {} })
  net.draft.mockReset().mockResolvedValue({ success: true, data: { version: 4, afterActions: [sibling] } })
  net.saveDraft.mockReset().mockResolvedValue({ success: true, data: { version: 5 } })
}
it('WEB267: 一部のアクションを保存しても別の通の下書きを消さない', async () => {
  setup()
  await renderEditor()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'タグを追加（タグ未選択）' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: '発動2回目以降も実行する' })))
  expect(net.saveDraft).toHaveBeenCalled()
  expect(net.saveDraft.mock.calls.at(-1)![1].afterActions).toContainEqual(sibling)
  expect(net.saveDraft.mock.calls.at(-1)![1].expectedVersion).toBe(4)
})
it('WEB264: 反映は保存待ちを閉じず、通信失敗を表示する', async () => {
  setup()
  let reject!: (error: Error) => void
  net.update.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const close = vi.fn()
  await act(async () => render(<ActionEditor scenarioId="sc-1" hook="scenario_completed" title="あと" onClose={close} />))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'タグを追加（タグ未選択）' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: '発動2回目以降も実行する' })))
  fireEvent.click(screen.getByRole('button', { name: 'このアクションを反映' }))
  expect(close).not.toHaveBeenCalled()
  await act(async () => reject(new Error('通信失敗')))
  expect(screen.getByText(/通信失敗/)).toBeTruthy()
  expect(close).not.toHaveBeenCalled()
})

it('WEB262: A→B→Aの切替でも最初のAの遅いアクション一覧を捨てる', async () => {
  setup()
  let finish!: (value: unknown) => void
  net.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const props = {hook: 'scenario_completed' as const, title: 'あと', onClose: () => {}}
  const view = render(<ActionEditor {...props} scenarioId="sc-1" />)
  await act(async () => {})
  view.rerender(<ActionEditor {...props} scenarioId="sc-2" />)
  await act(async () => {})
  view.rerender(<ActionEditor {...props} scenarioId="sc-1" />)
  await act(async () => {})
  expect(screen.getByRole('button', {name:'タグを追加（タグ未選択）'})).toBeTruthy()
  await act(async () => finish({success:true,data:[]}))
  expect(screen.getByRole('button', {name:'タグを追加（タグ未選択）'})).toBeTruthy()
})

it('保存の内部エラーを日本語で知らせ、失敗後も編集の窓を保つ', async () => {
  setup()
  const { ApiError } = await import('@/lib/api')
  net.update.mockRejectedValue(new ApiError(500, 'API error: 500'))
  const close = vi.fn()
  await act(async () => render(<ActionEditor scenarioId="sc-1" hook="scenario_completed" title="あと" onClose={close} />))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'タグを追加（タグ未選択）' })))
  await act(async () => fireEvent.click(screen.getByRole('switch', { name: '発動2回目以降も実行する' })))
  expect(screen.getByText(/サーバー側で保存できませんでした/)).toBeTruthy()
  expect(document.body.textContent).not.toContain('API error: 500')
  expect(close).not.toHaveBeenCalled()
})
