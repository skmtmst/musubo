// @vitest-environment happy-dom
import React, { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyMessageKindState } from '@/components/scenarios/message-kind-fields'
import type { InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import { useFormErrors } from '@/lib/use-form-errors'
import { emptyStepForm, type StepFormState } from './detail-model'
import { ScenarioStepForm } from './scenario-step-form'

vi.mock('@/lib/use-insert-token-names', () => ({
  useInsertTokenNames: () => [],
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: { id: 'account-a', name: '本店' },
    accounts: [{ id: 'account-a', name: '本店' }],
    loading: false,
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function Harness({
  initialOrder = 2,
  stepSaving = false,
  onSave = vi.fn(async () => {}),
  onClearDraft = vi.fn(),
  onClose = vi.fn(),
  onStepFormChange,
}: {
  initialOrder?: number
  stepSaving?: boolean
  onSave?: () => Promise<void>
  onClearDraft?: () => void
  onClose?: () => void
  onStepFormChange?: (next: StepFormState) => void
}) {
  const [stepForm, setStepFormState] = useState<StepFormState>(() => ({
    ...emptyStepForm(initialOrder),
    messageContent: 'こんにちは',
  }))
  const [kindState, setKindState] = useState(emptyMessageKindState)
  const stepFields = useFormErrors()
  const stepBodyRef = useRef<HTMLTextAreaElement | InsertTextFieldHandle | null>(null)

  const setStepForm: React.Dispatch<React.SetStateAction<StepFormState>> = (updater) => {
    setStepFormState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      onStepFormChange?.(next)
      return next
    })
  }

  return (
    <ScenarioStepForm
      editingStepId={null}
      stepDraft={{
        pendingAgo: null,
        conflictAgo: null,
        label: null,
        clear: onClearDraft,
        overwrite: vi.fn(),
        restore: vi.fn(),
        loadLatest: vi.fn(),
      } as unknown as Parameters<typeof ScenarioStepForm>[0]['stepDraft']}
      restoreStepDraft={vi.fn()}
      loadLatestStepDraft={vi.fn()}
      stepForm={stepForm}
      setStepForm={setStepForm}
      stepFields={stepFields}
      deliveryMode="absolute_time"
      scenario={null}
      setActionTarget={vi.fn()}
      templates={[]}
      folderAccountId="account-a"
      kindState={kindState}
      setKindState={setKindState}
      stepBodyRef={stepBodyRef}
      setStepTargetOpen={vi.fn()}
      tags={[]}
      stepError=""
      handleSaveStep={onSave}
      stepSaving={stepSaving}
      closeStepForm={onClose}
      accountName="本店"
      stepFormPreview={{ offsetDays: 0, offsetHours: 0, offsetMinutes: 0 }}
    />
  )
}

describe('ScenarioStepForm のステップ順序入力と保存中キャンセル制御', () => {
  it('ステップ順序を空にしても 0 に跳ねず保存を止め、1以上の整数を入れ直すと保存できる', () => {
    const onSave = vi.fn(async () => {})
    const onStepFormChange = vi.fn()
    render(<Harness initialOrder={2} onSave={onSave} onStepFormChange={onStepFormChange} />)

    const orderInput = screen.getByLabelText('ステップ順序') as HTMLInputElement
    const saveButton = screen.getByRole('button', { name: '追加する' }) as HTMLButtonElement

    fireEvent.change(orderInput, { target: { value: '' } })

    expect(orderInput.value).toBe('')
    expect(onStepFormChange).not.toHaveBeenCalled()
    expect(saveButton.disabled).toBe(true)
    expect(screen.getByText('ステップ順序は1以上の整数で入力してください。')).not.toBeNull()

    fireEvent.change(orderInput, { target: { value: '0' } })
    expect(onStepFormChange).not.toHaveBeenCalled()
    expect(saveButton.disabled).toBe(true)

    fireEvent.change(orderInput, { target: { value: '3' } })
    expect(orderInput.value).toBe('3')
    expect(onStepFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ stepOrder: 3 }))
    expect(saveButton.disabled).toBe(false)

    fireEvent.click(saveButton)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('保存中はキャンセルを押せず、下書き削除もフォーム終了も起きない', () => {
    const onClearDraft = vi.fn()
    const onClose = vi.fn()
    render(<Harness stepSaving onClearDraft={onClearDraft} onClose={onClose} />)

    const cancelButton = screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement
    expect(cancelButton.disabled).toBe(true)

    fireEvent.click(cancelButton)

    expect(onClearDraft).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
