// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_DRAFT_ACTION_OPTIONS,
  AUTOMATION_DRAFT_TRIGGER_OPTIONS,
} from '@line-crm/shared'

/*
 * #734・#942 N-355: 新規作成の選択肢は共有の正本から描く。下書き編集と同じ一覧。
 * 本物のReactで新規作成ページをmountし、共有を本物で import して見張る。
 *
 * - N1: きっかけの行が共有の全件と一致する（#942で全10種へ）
 * - N2: することの選択肢が共有の全件と一致する（#942で共通アクションを追加）
 * - N3: シナリオ開始を選んで保存すると、scenarioId付きで送る
 */

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

// 権限フックは happy-dom の localStorage を読むため、固定で通す。
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の自動化の判断なので、素の <select> に置き換える。
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

const mockList = api.automations.list as unknown as ReturnType<typeof vi.fn>
const mockResources = api.automations.draftResources as unknown as ReturnType<typeof vi.fn>
const mockCreate = api.automations.createDraftFromTemplate as unknown as ReturnType<typeof vi.fn>
const mockUpdate = api.automations.updateDraft as unknown as ReturnType<typeof vi.fn>
const mockGet = api.automations.getDraft as unknown as ReturnType<typeof vi.fn>
const mockPreview = api.automations.audiencePreview as unknown as ReturnType<typeof vi.fn>
const mockPublish = api.automations.publishDraft as unknown as ReturnType<typeof vi.fn>

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function ok<T>(data: T) {
  return { success: true, data }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  mockList.mockReset()
  mockResources.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockGet.mockReset()
  mockPreview.mockReset()
  mockPublish.mockReset()
  mockList.mockResolvedValue(ok([]))
  mockResources.mockResolvedValue(ok({
    tags: [{ id: 'tag-1', name: '予約' }],
    scenarios: [{ id: 'scenario-1', name: '予約後' }],
  }))
  ;(api.tags.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([{ id: 'tag-1', name: '予約' }]))
  ;(api.scenarios.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([{ id: 'scenario-1', name: '予約後' }]))
  ;(api.friendFields.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([]))
  ;(api.supportMarks.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok([]))
  ;(api.featureSettings.visibility as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok({ features: {} }))
  ;(api.segments.count as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, count: 0 })
  mockCreate.mockResolvedValue(ok({ id: 'draft-9', draftVersionId: 'v1' }))
  mockUpdate.mockResolvedValue(ok({ draftVersionId: 'v2' }))
  mockGet.mockResolvedValue(ok({
    id: 'draft-9', draftVersionId: 'v2', name: '確認用', description: null,
    eventType: 'message_received', triggerConfig: {}, conditions: {},
    actions: [{ id: 'step-1', type: 'start_scenario', params: { scenarioId: 'scenario-1' }, onFailure: 'stop' }],
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
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
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

async function clickButton(el: HTMLElement, text: string): Promise<void> {
  const button = Array.from(el.querySelectorAll('button')).find((node) => node.textContent?.trim() === text && !node.closest('[data-closing]'))
  if (!button) throw new Error(`ボタンが見つかりません: ${text}`)
  await act(async () => { (button as HTMLButtonElement).click() })
}

describe('新規作成の選択可能一覧(#734)', () => {
  it('N1: きっかけの行が共有の全件と一致する', async () => {
    // #942 N-355: 以前は設計の6種だけで、残りは下書き編集でしか作れなかった。
    // 共有へ無い値を足す・共有から値が消える逆変異はここで赤になる。
    // #975 U061: 初回は代表3件だけを出すため、「すべて見る」を開いてから拾う。
    const el = await mountPage()
    await clickButton(el, `ほかのきっかけもすべて見る（あと${AUTOMATION_DRAFT_TRIGGER_OPTIONS.length - 3} 件）`)
    const radios = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="v8-trigger"]'))
    expect(radios.map(input => input.value)).toEqual(AUTOMATION_DRAFT_TRIGGER_OPTIONS.map(option => option.value))
    for (const option of AUTOMATION_DRAFT_TRIGGER_OPTIONS) expect(radios.find(input => input.value === option.value)?.parentElement?.textContent).toContain(option.label)
  })

  it('N2: することの選択肢が共有の正本の編集可能な処理と一致する', async () => {
    const el = await mountPage()
    await clickButton(el, '行うことを足す')
    const values = Array.from(document.querySelectorAll('[role="menuitem"]')).map(option => option.textContent)
    // 既存の通知の保存は仕上げの実描画試験で保持する。新規の選び口では本文に化ける旧不具合へ戻さない。
    expect(values).toEqual(AUTOMATION_DRAFT_ACTION_OPTIONS.filter(option => option.value !== 'notify_staff').map(option => option.label))
  })

  it('N3: シナリオ開始を選んで保存するとscenarioId付きで送る', async () => {
    const el = await mountPage()
    const name = el.querySelector('#v8-rule-name') as HTMLInputElement
    await typeText(name, '確認用ルール')
    await act(async () => { el.querySelector<HTMLButtonElement>('[aria-label="1つ目の行うことのその他操作"]')!.click() })
    await clickButton(document.body, '削除する')
    await clickButton(document.body, '削除する')
    await clickButton(el, '行うことを足す')
    await clickButton(document.body, 'シナリオを始める')
    const candidate = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(input => input.value === 'scenario-1')!
    await act(async () => { candidate.click() })
    await clickButton(document.body, '選択する')
    // #975 U073: 動かし始める前に確認ダイアログを挟む。
    await clickButton(el, 'つくって動かす')
    await act(async () => { await drainMicrotasks() })
    expect(mockPublish).not.toHaveBeenCalled()
    const confirmation = document.querySelector('[role="dialog"]')!
    expect(confirmation.querySelector('[title="確認用ルール"]')).toBeTruthy()
    expect(confirmation.querySelectorAll('dd [title]')).toHaveLength(5)
    await clickButton(document.body, '保存して動かし始める')
    await act(async () => { await drainMicrotasks() })
    expect(mockUpdate).toHaveBeenCalled()
    const sent = mockUpdate.mock.calls[0][2] as { actions: Array<{ type: string; params: Record<string, string> }> }
    expect(sent.actions[0]).toMatchObject({ type: 'start_scenario', params: { scenarioId: 'scenario-1' } })
    expect(mockPublish).toHaveBeenCalled()
  })
})


it('きっかけを検索すると一致する物だけ出し、選んだ物の設定だけを開く', async () => {
  const el = await mountPage()
  await clickButton(el, `ほかのきっかけもすべて見る（あと${AUTOMATION_DRAFT_TRIGGER_OPTIONS.length - 3} 件）`)
  const query = el.querySelector('input[aria-label="きっかけを探す"]') as HTMLInputElement
  await typeText(query, '曜日')
  const radios = Array.from(el.querySelectorAll<HTMLInputElement>('input[name="v8-trigger"]'))
  expect(radios.map(input => input.value)).toEqual(['weekly'])
  await act(async () => { radios[0].click() })
  expect(el.querySelector('[aria-label="実行時刻"]')).toBeTruthy()
  expect(el.querySelector('[aria-label="実行日時"]')).toBeNull()
  expect(mockUpdate).not.toHaveBeenCalled()
  expect(mockPublish).not.toHaveBeenCalled()
})
