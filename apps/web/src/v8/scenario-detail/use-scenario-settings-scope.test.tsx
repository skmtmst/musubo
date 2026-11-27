// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { ScenarioWithSteps } from './detail-model'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  get: vi.fn(),
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
        update: mocks.update,
        get: mocks.get,
      },
    },
  }
})
vi.mock('@/components/shared/toast', () => ({
  notifyToast: mocks.notifyToast,
}))

import { useScenarioSettings } from './use-scenario-settings'

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
    editForm: {
      name: `更新名-${id}`,
      description: '',
      triggerType: 'manual' as const,
      isActive: false,
      allowConcurrent: true,
      folderId: '',
    },
    setSaving: vi.fn(),
    id,
    setEditing: vi.fn(),
    setRenameOpen: vi.fn(),
    setSaveDone: vi.fn(),
    loadScenario: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    saveErrors: { capture: vi.fn(() => false), clear: vi.fn() } as never,
    setConflict: vi.fn(),
    setConflictLatest: vi.fn(),
    setCompareOpen: vi.fn(),
    scenario: makeScenario(id, `シナリオ-${id}`),
    conflictLatest: null,
    startBusy: false,
    startConfirmed: true,
    setStartBusy: vi.fn(),
    setStartError: vi.fn(),
    setStartOpen: vi.fn(),
    setJustStarted: vi.fn(),
    reloadStats: vi.fn(),
    stopBusy: false,
    stopConfirmation: { contentRevision: 1, activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 } as never,
    stopConfirmationValid: vi.fn(() => true),
    setStopBusy: vi.fn(),
    setStopError: vi.fn(),
    setStopOpen: vi.fn(),
    setDuplicateName: vi.fn(),
    setDuplicateOpen: vi.fn(),
    setEditForm: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('シナリオ詳細設定の切替時ガード', () => {
  it('設定保存の通信中に別シナリオへ切り替えると保存中を解除し、前のシナリオの409競合を新しい画面へ出さない', async () => {
    let rejectUpdate!: (reason: unknown) => void
    mocks.update.mockReturnValueOnce(new Promise((_, reject) => { rejectUpdate = reject }))

    const propsA = buildProps('sc-a')
    const { result, rerender } = renderHook((props) => useScenarioSettings(props), { initialProps: propsA })

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleSaveScenario()
    })
    expect(propsA.setSaving).toHaveBeenCalledWith(true)

    const propsB = { ...propsA, id: 'sc-b', scenario: makeScenario('sc-b', 'シナリオB') }
    rerender(propsB)
    expect(propsA.setSaving).toHaveBeenLastCalledWith(false)

    await act(async () => {
      rejectUpdate(new ApiError(409, 'conflict'))
      await pending
    })

    expect(propsA.setConflict).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(propsA.setError).not.toHaveBeenCalled()
  })

  it('配信開始・一時停止の通信中に別シナリオへ切り替えると、前の結果でトーストや再読込を起こさない', async () => {
    let resolveStart!: (value: unknown) => void
    mocks.update.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve }))

    const propsA = buildProps('sc-a')
    const { result, rerender } = renderHook((props) => useScenarioSettings(props), { initialProps: propsA })

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleStart()
    })
    expect(propsA.setStartBusy).toHaveBeenCalledWith(true)

    rerender({ ...propsA, id: 'sc-b', scenario: makeScenario('sc-b', 'シナリオB') })
    expect(propsA.setStartBusy).toHaveBeenLastCalledWith(false)

    await act(async () => {
      resolveStart({ success: true })
      await pending
    })

    expect(propsA.setStartOpen).not.toHaveBeenCalled()
    expect(propsA.setJustStarted).not.toHaveBeenCalled()
    expect(propsA.loadScenario).not.toHaveBeenCalled()
    expect(propsA.reloadStats).not.toHaveBeenCalled()
    expect(mocks.notifyToast).not.toHaveBeenCalled()
  })
})
