// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioWithSteps } from './detail-model'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  addStep: vi.fn(),
  del: vi.fn(),
  triggersList: vi.fn(),
  triggersAdd: vi.fn(),
  actionsList: vi.fn(),
  actionsCreate: vi.fn(),
  notifyToast: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      scenarios: {
        ...actual.api.scenarios,
        create: mocks.create,
        update: mocks.update,
        get: mocks.get,
        addStep: mocks.addStep,
        delete: mocks.del,
        triggers: { list: mocks.triggersList, add: mocks.triggersAdd },
        actions: { list: mocks.actionsList, create: mocks.actionsCreate },
      },
    },
  }
})
vi.mock('@/components/shared/toast', () => ({
  notifyToast: mocks.notifyToast,
}))

import { useScenarioCopy } from './use-scenario-copy'

const makeScenario = (id: string, name: string): ScenarioWithSteps => ({
  id,
  name,
  description: null,
  triggerType: 'manual',
  triggerTagId: null,
  lineAccountId: 'acc-1',
  isActive: false,
  deliveryMode: 'relative',
  allowConcurrent: true,
  folderId: null,
  steps: [],
} as unknown as ScenarioWithSteps)

function buildProps(id: string) {
  return {
    scenario: makeScenario(id, `シナリオ-${id}`),
    duplicating: false,
    setDuplicating: vi.fn(),
    setError: vi.fn(),
    duplicateRemainder: null,
    saveErrors: { capture: vi.fn(() => false), clear: vi.fn() } as never,
    sortedSteps: [],
    deliveryMode: 'relative' as const,
    id,
    setDuplicateRemainder: vi.fn(),
    setDuplicateOpen: vi.fn(),
    discardingDuplicate: false,
    setDiscardingDuplicate: vi.fn(),
    setDiscardDuplicateError: vi.fn(),
    setDiscardDuplicateOpen: vi.fn(),
    deletingScenario: false,
    setDeletingScenario: vi.fn(),
    setDeleteScenarioError: vi.fn(),
    deleteConfirmation: { contentRevision: 1 } as never,
    deleteConfirmationValid: vi.fn(() => true),
    refreshDeleteConfirmation: vi.fn().mockResolvedValue(undefined),
    setDeleteScenarioOpen: vi.fn(),
    router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() } as never,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('シナリオ複製・削除の切替時ガード', () => {
  it('削除通信中に別シナリオへ切り替えると削除中を解除し、前の削除完了で一覧へ誤遷移しない', async () => {
    let resolveDelete!: (value: unknown) => void
    mocks.del.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve }))

    const propsA = buildProps('sc-a')
    const { result, rerender } = renderHook((props) => useScenarioCopy(props), { initialProps: propsA })

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleDeleteScenario()
    })
    expect(propsA.setDeletingScenario).toHaveBeenCalledWith(true)

    rerender({ ...propsA, id: 'sc-b', scenario: makeScenario('sc-b', 'シナリオB') })
    expect(propsA.setDeletingScenario).toHaveBeenLastCalledWith(false)

    await act(async () => {
      resolveDelete({ success: true })
      await pending
    })

    expect(propsA.setDeleteScenarioOpen).not.toHaveBeenCalled()
    expect((propsA.router as unknown as { push: ReturnType<typeof vi.fn> }).push).not.toHaveBeenCalled()
  })

  it('複製通信中に別シナリオへ切り替えると後続の更新を止め、前の複製結果やエラーを新しい画面へ出さない', async () => {
    let resolveCreate!: (value: unknown) => void
    mocks.create.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve }))

    const propsA = buildProps('sc-a')
    const { result, rerender } = renderHook((props) => useScenarioCopy(props), { initialProps: propsA })

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleDuplicate('コピーA')
    })
    expect(propsA.setDuplicating).toHaveBeenCalledWith(true)

    rerender({ ...propsA, id: 'sc-b', scenario: makeScenario('sc-b', 'シナリオB') })
    expect(propsA.setDuplicating).toHaveBeenLastCalledWith(false)

    await act(async () => {
      resolveCreate({ success: true, data: { id: 'copy-a' } })
      await pending
    })

    expect(mocks.update).not.toHaveBeenCalled()
    expect(propsA.setDuplicateOpen).not.toHaveBeenCalled()
    expect(propsA.setDuplicateRemainder).not.toHaveBeenCalled()
    expect(propsA.setError).not.toHaveBeenCalledWith(expect.stringContaining('失敗'))
    expect(mocks.notifyToast).not.toHaveBeenCalled()
  })
})
