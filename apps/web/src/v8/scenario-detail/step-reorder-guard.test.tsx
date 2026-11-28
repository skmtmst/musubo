// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const account = vi.hoisted(() => ({ selectedAccountId: 'account-a', loading: false }))
const calls = vi.hoisted(() => ({
  update: vi.fn(),
  add: vi.fn(),
  reorder: vi.fn(),
  remove: vi.fn(),
  listActions: vi.fn(),
  removeAction: vi.fn(),
  createAction: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
vi.mock('@/v8/scenarios', async () => await import('@/v8/scenarios/write-access'))
vi.mock('./step-validation', () => ({ validateScenarioStep: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      scenarios: {
        ...actual.api.scenarios,
        updateStep: calls.update,
        addStep: calls.add,
        reorderSteps: calls.reorder,
        deleteStep: calls.remove,
        actions: {
          ...actual.api.scenarios.actions,
          list: calls.listActions,
          remove: calls.removeAction,
          create: calls.createAction,
        },
      },
    },
  }
})

import { useScenarioStepActions } from './use-scenario-step-actions'
import { emptyStepForm } from './detail-model'
import { emptyMessageKindState } from '@/components/scenarios/message-kind-fields'

const step1 = { id: 'step-1', stepOrder: 1, messageType: 'text', messageContent: '1通目', offsetDays: 0, deliveryTime: '10:00', afterSend: 'continue' }
const step2 = { id: 'step-2', stepOrder: 2, messageType: 'text', messageContent: '2通目', offsetDays: 1, deliveryTime: '10:00', afterSend: 'continue' }

function makeProps(id = 'scenario-a') {
  return {
    scenario: { id, lineAccountId: 'account-a', steps: [step1, step2] },
    id,
    stepForm: emptyStepForm(1),
    kindState: emptyMessageKindState(),
    editingStepId: null,
    deliveryMode: 'absolute_time',
    sortedSteps: [step1, step2],
    insertAfter: null,
    templates: [],
    duplicatingStepId: null,
    deletingStepId: null,
    deleteStepTarget: null,
    deleteStepRevision: 1,
    deleteStepConfirmationValid: () => true,
    saveErrors: { capture: vi.fn(() => false) },
    stepFields: { reset: vi.fn() },
    stepDraft: { clear: vi.fn() },
    failStep: vi.fn(),
    loadScenario: vi.fn(async () => {}),
    reloadStats: vi.fn(),
    setStepForm: vi.fn(),
    setEditingStepId: vi.fn(),
    setShowStepForm: vi.fn(),
    setInsertAfter: vi.fn(),
    setStepError: vi.fn(),
    setStepFormNonce: vi.fn(),
    setKindState: vi.fn(),
    setStepSaving: vi.fn(),
    setDuplicatingStepId: vi.fn(),
    setDeletingStepId: vi.fn(),
    setDeleteStepError: vi.fn(),
    setDeleteStepTarget: vi.fn(),
    setError: vi.fn(),
  } as unknown as Parameters<typeof useScenarioStepActions>[0] & {
    setError: ReturnType<typeof vi.fn>
    loadScenario: ReturnType<typeof vi.fn>
    reloadStats: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  forgetSessionSnapshot()
  rememberStaffIdentity({ id: 'owner-1', role: 'owner', permissionKeys: [] } as unknown as StaffMember)
  account.selectedAccountId = 'account-a'
  account.loading = false
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
})

describe('シナリオのステップ並べ替えの保護', () => {
  it('reorderSteps が success:false を返したら失敗として理由を出し、並びを元に戻して stats は更新しない', async () => {
    calls.reorder.mockResolvedValueOnce({ success: false, error: '並び順が古くなっています' })
    const p = makeProps()
    const { result } = renderHook(() => useScenarioStepActions(p))

    await act(async () => {
      await result.current.handleMoveStep('step-1', 'down')
    })

    expect(p.setError).toHaveBeenCalledWith('並び順が古くなっています')
    expect(p.loadScenario).toHaveBeenCalledWith(true)
    expect(p.reloadStats).not.toHaveBeenCalled()
    expect(result.current.movingStep).toBe(false)
  })

  it('並べ替え通信中はもう一度押しても二重送信せず、完了後に再実行できる', async () => {
    let resolveFirst!: (value: unknown) => void
    calls.reorder
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ success: true })

    const p = makeProps()
    const { result } = renderHook(() => useScenarioStepActions(p))

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleMoveStep('step-1', 'down')
    })
    expect(result.current.movingStep).toBe(true)

    await act(async () => {
      await result.current.handleMoveStep('step-1', 'down')
    })
    expect(calls.reorder).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst({ success: true })
      await pending
    })
    expect(result.current.movingStep).toBe(false)

    await act(async () => {
      await result.current.handleMoveStep('step-1', 'down')
    })
    expect(calls.reorder).toHaveBeenCalledTimes(2)
  })

  it('並べ替え通信中に別シナリオへ切り替えると移動中を解除し、古い失敗を新しい画面へ出さない', async () => {
    let resolveOld!: (value: unknown) => void
    calls.reorder.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))

    let currentProps = makeProps('scenario-a')
    const firstProps = currentProps
    const { result, rerender } = renderHook(() => useScenarioStepActions(currentProps))

    let pending!: Promise<void>
    act(() => {
      pending = result.current.handleMoveStep('step-1', 'down')
    })
    expect(result.current.movingStep).toBe(true)

    currentProps = makeProps('scenario-b')
    rerender()
    expect(result.current.movingStep).toBe(false)

    await act(async () => {
      resolveOld({ success: false, error: '古いシナリオのエラー' })
      await pending
    })

    expect(firstProps.setError).not.toHaveBeenCalledWith('古いシナリオのエラー')
    expect(firstProps.loadScenario).not.toHaveBeenCalled()
    expect(firstProps.reloadStats).not.toHaveBeenCalled()
  })
})
