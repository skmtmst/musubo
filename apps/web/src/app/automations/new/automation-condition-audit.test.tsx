import { querySupplementaryPageAction } from '@/test-utils/page-action'
import { screen } from '@testing-library/react'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * 追加監査 AUTOMATION-02/03/04 の回帰テスト。
 * 本物のReactで新規作成ページをmountし、画面に出る言葉と
 * 保存へ送る形を見張る。
 *
 * - A02: 名前の条件を付けても要約は「条件なし」にならない。
 *         保存へ送るのと同じ条件から要約を作る。
 * - A03: 人数の確認に失敗しても、保存済みの下書きは保存済みのまま。
 *         「人数をもう一度数える」で保存した版へだけ再確認できる。
 * - A04: 名前の条件は `{ text, targets }` の形で保存する
 *         （計算側が読める正本の形）。古い形で保存された下書きは
 *         読み込み時に「読めない」と出して、付け直すまで保存しない。
 */

const account = vi.hoisted(() => ({ id: 'account-1' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

// 権限フックは happy-dom の localStorage を読むため、固定で通す。
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の条件の判断なので、素の <select> に置き換える。
 */
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
      tagGroups: { ...actual.api.tagGroups, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      // 条件部品が選択肢を読みに行く口。本物へ飛ばさない。
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
      },
    },
  }
})

import { api } from '@/lib/api'
import { NewAutomationV8 as NewAutomationPage } from '@/v8/automations/create/create'
import { pickAutomationTag, clickAutomationButton } from '@/test-utils/automation-v8-interactions'

const mockList = api.automations.list as unknown as ReturnType<typeof vi.fn>
const mockResources = api.automations.draftResources as unknown as ReturnType<typeof vi.fn>
const mockCreate = api.automations.createDraftFromTemplate as unknown as ReturnType<typeof vi.fn>
const mockUpdate = api.automations.updateDraft as unknown as ReturnType<typeof vi.fn>
const mockGet = api.automations.getDraft as unknown as ReturnType<typeof vi.fn>
const mockPreview = api.automations.audiencePreview as unknown as ReturnType<typeof vi.fn>
const mockPublish = api.automations.publishDraft as unknown as ReturnType<typeof vi.fn>
const mockTags = api.tags.list as unknown as ReturnType<typeof vi.fn>
const mockScenarios = api.scenarios.list as unknown as ReturnType<typeof vi.fn>
const mockFields = api.friendFields.list as unknown as ReturnType<typeof vi.fn>
const mockMarks = api.supportMarks.list as unknown as ReturnType<typeof vi.fn>
const mockVisibility = api.featureSettings.visibility as unknown as ReturnType<typeof vi.fn>
const mockSegmentCount = api.segments.count as unknown as ReturnType<typeof vi.fn>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function ok<T>(data: T) {
  return { success: true, data }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-1'
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/automations/new')
  for (const mock of [
    mockList, mockResources, mockCreate, mockUpdate, mockGet, mockPreview, mockPublish,
    mockTags, mockScenarios, mockFields, mockMarks, mockVisibility, mockSegmentCount,
  ]) mock.mockReset()
  mockList.mockResolvedValue(ok([]))
  mockResources.mockResolvedValue(ok({
    tags: [{ id: 'tag-1', name: '予約' }],
    scenarios: [{ id: 'scenario-1', name: '予約後' }],
    commonActions: [],
  }))
  mockTags.mockResolvedValue(ok([{ id: 'tag-1', name: '予約' }]))
  mockScenarios.mockResolvedValue(ok([{ id: 'scenario-1', name: '予約後' }]))
  mockFields.mockResolvedValue(ok([]))
  mockMarks.mockResolvedValue(ok([]))
  mockVisibility.mockResolvedValue(ok({ features: {} }))
  mockSegmentCount.mockResolvedValue({ success: true, count: 0 })
  mockCreate.mockResolvedValue(ok({ id: 'draft-9', draftVersionId: 'v1' }))
  mockUpdate.mockResolvedValue(ok({ draftVersionId: 'v2' }))
  mockGet.mockResolvedValue(ok({
    id: 'draft-9', draftVersionId: 'v2', name: '確認用', description: null,
    eventType: 'message_received', triggerConfig: {}, conditions: {},
    actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: 'tag-1' }, onFailure: 'stop' }],
  }))
  mockPreview.mockResolvedValue(ok({ automationId: 'draft-9', versionId: 'v2', matched: 3, total: 10, freshness: 'available', calculatedAt: '2026-09-14T00:00:00+09:00' }))
  mockPublish.mockResolvedValue(ok({ id: 'draft-9', versionId: 'v2', versionNumber: 1, status: 'active' }))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  if (container) container.remove()
  root = null
  container = null
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
  vi.clearAllMocks()
})

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

async function mountPage(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<NewAutomationPage />) })
  await act(async () => { await drainMicrotasks() })
  if (!container.textContent?.includes('きっかけ')) throw new Error('新規作成が出ませんでした')
  return container
}

async function typeText(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickButton(el: HTMLElement | Document, text: string): Promise<void> {
  const button = (Array.from(el.querySelectorAll('button')).find((node) => node.textContent?.trim() === text && !node.closest('[data-closing]')) ?? querySupplementaryPageAction(text))
  if (!button) throw new Error(`ボタンが見つかりません: ${text}`)
  await act(async () => { (button as HTMLButtonElement).click() })
}

/** 名前・すること・タグを埋めた、保存できる最小の入力。 */
async function fillMinimum(el: HTMLElement): Promise<void> {
  await typeText(el.querySelector('input[id="v8-rule-name"]') as HTMLInputElement, '監査確認ルール')
  await pickAutomationTag('予約')
}

/** 条件部品で「名前に『田中』を含む」を組み立てる。 */
async function addNameCondition(el: HTMLElement): Promise<void> {
  await act(async () => { el.querySelector<HTMLButtonElement>('[aria-label="動かす相手を変更する"]')!.click() })
  // 現役の条件の窓で、共通の検索できる足し口を操作する。
  const picker = document.querySelector('button[aria-label="追加する条件を選択する"]') as HTMLButtonElement
  expect(picker, '条件の足し口が出ていない').toBeTruthy()
  await act(async () => { picker.click() })
  await act(async () => { screen.getByRole('radio', { name: '名前' }).click() })
  await act(async () => { screen.getByRole('button', { name: '条件を足す' }).click() })
  const input = document.querySelector('input[aria-label="名前に含む文字"]') as HTMLInputElement
  expect(input, '名前の条件の入力欄が出ていない').toBeTruthy()
  await typeText(input, '田中')
  await clickAutomationButton('この条件にする')
  await act(async () => { await drainMicrotasks() })
}

describe('AUTOMATION-02/04: 条件は保存する形のまま要約へ出る', () => {
  it('名前の条件を付けると要約に出て、計算側が読める形で保存される', async () => {
    const el = await mountPage()
    await fillMinimum(el)
    await addNameCondition(el)

    // A02: 要約と条件の札が「条件なし」ではなく、条件の中身を言う。
    expect(el.textContent).toContain('名前に「田中」を含む人')
    expect(el.textContent).not.toContain('条件なし')

    await clickButton(el, '下書きを保存')
    await act(async () => { await drainMicrotasks() })

    // A04: 計算側（buildSegmentWhere）が読める { text, targets } の形で送る。
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const sent = mockUpdate.mock.calls[0][2] as { conditions: Record<string, unknown> }
    expect(sent.conditions).toMatchObject({
      operator: 'AND',
      rules: [{ type: 'name', value: { text: '田中', targets: ['display', 'real', 'system'] } }],
    })
  })

  it('正本の形で保存された下書きを再開すると、要約へ条件が戻る', async () => {
    mockGet.mockResolvedValue(ok({
      id: 'previous-draft', draftVersionId: 'v7', name: '途中のルール', description: null,
      eventType: 'message_received', triggerConfig: {},
      conditions: {
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '田中', targets: ['display'] } }],
      },
      actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: 'tag-1' }, onFailure: 'stop' }],
    }))
    window.history.pushState(null, '', '/automations/new?draft=previous-draft')
    const el = await mountPage()

    expect(el.textContent).toContain('名前に「田中」を含む人')
    expect(el.textContent).not.toContain('条件なし')
    // 読めた条件なら、読めなかった旨の案内は出ない。
    expect(el.textContent).not.toContain('保存されていた「だれに」の条件は古い形のため読めませんでした')
  })

  it('古い形（文字列のまま）の条件が保存された下書きは、読めないと出して付け直すまで保存しない', async () => {
    mockGet.mockResolvedValue(ok({
      id: 'broken-draft', draftVersionId: 'v3', name: '古い形のルール', description: null,
      eventType: 'message_received', triggerConfig: {},
      // 以前の保存口が書いた形。計算側は object を期待するので読めない。
      conditions: { operator: 'AND', rules: [{ type: 'name', value: '田中' }] },
      actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: 'tag-1' }, onFailure: 'stop' }],
    }))
    window.history.pushState(null, '', '/automations/new?draft=broken-draft')
    const el = await mountPage()

    // 読めない条件は黙って消さない。理由を出して、保存を止める。
    expect(el.textContent).toContain('保存されていた「だれに」の条件は古い形のため読めませんでした')
    await clickButton(el, '下書きを保存')
    await act(async () => { await drainMicrotasks() })
    expect(el.textContent).toContain('条件を付け直してください')
    expect(mockUpdate).not.toHaveBeenCalled()

    // 「外して付け直す」は本人の明示操作。押すと新しい条件を選べる。
    await clickButton(el, '以前の条件を外して付け直す')
    expect(el.textContent).not.toContain('保存されていた「だれに」の条件は古い形のため読めませんでした')

    await clickButton(el, '下書きを保存')
    await act(async () => { await drainMicrotasks() })
    // 条件を外す判断をしたあとなので、空の条件として保存できる。
    expect(mockUpdate).toHaveBeenCalledWith(
      'broken-draft', 'account-1',
      expect.objectContaining({ expectedDraftVersionId: 'v3', conditions: {} }),
    )
  })
})

describe('AUTOMATION-03: 人数の確認は保存とは別の成否', () => {
  it('人数の確認に失敗しても「保存できませんでした」にはならず、人数だけ再試行できる', async () => {
    mockPreview.mockRejectedValue(new Error('server error'))
    const el = await mountPage()
    await fillMinimum(el)
    await clickButton(el, '下書きを保存')
    await act(async () => { await drainMicrotasks() })

    // 保存は済んでいる。失敗しているのは人数の確認だけ。
    expect(el.textContent).toContain('下書きに保存しました')
    expect(el.textContent).toContain('人数の確認に失敗しました。通信を確かめて、もう一度お試しください。')
    expect(el.textContent).not.toContain('保存できませんでした')
    expect(el.textContent).toContain('人数を数えられませんでした（下書きは保存済み）')

    // 再試行は保存済みの版へだけ問い合わせる。下書きは作り直さない。
    mockPreview.mockResolvedValue(ok({ automationId: 'draft-9', versionId: 'v2', matched: 7, total: 10, freshness: 'available', calculatedAt: '2026-09-22T00:00:00+09:00' }))
    await clickButton(el, '人数をもう一度数える')
    await act(async () => { await drainMicrotasks() })
    expect(mockPreview).toHaveBeenCalledTimes(2)
    expect(mockPreview).toHaveBeenLastCalledWith('draft-9', 'account-1', 'v2')
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(el.textContent).toContain('7 人')
  })
})
