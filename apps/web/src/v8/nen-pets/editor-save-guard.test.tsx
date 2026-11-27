// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { NenPetRow } from '@/lib/nen-pets-api'

const mocks = vi.hoisted(() => ({
  updatePet: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      nenCampaigns: {
        ...actual.api.nenCampaigns,
        updatePet: mocks.updatePet,
      },
    },
  }
})

import PetEditorV8 from './editor'

const makePet = (id: string, name: string): NenPetRow => ({
  id,
  name,
  callName: name,
  animalType: 'dog',
  gender: 'male',
  birthday: '2021-05-10',
  breed: '柴犬',
  weightKg: 8.5,
  updatedAt: `2026-11-27T00:00:00Z-${id}`,
  owner: {
    id: 'owner-1',
    name: '山田 太郎',
    customerId: '1001',
  },
} as unknown as NenPetRow)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('ペット編集ダイアログの保存中ロックと切替ガード', () => {
  it('保存通信中にアカウントや対象ペットが切り替わると、古い保存完了や競合エラーを新しい対象へ反映しない', async () => {
    let rejectOld!: (reason: unknown) => void
    mocks.updatePet.mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject }))

    const onSaved = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(
      <PetEditorV8 accountId="account-a" pet={makePet('pet-a', 'ポチ')} onSaved={onSaved} onClose={onClose} />,
    )

    fireEvent.change(screen.getByLabelText('ペットの名前'), { target: { value: 'ポチ改' } })
    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
    fireEvent.click(saveButton)
    await waitFor(() => expect(mocks.updatePet).toHaveBeenCalledTimes(1))
    expect(saveButton.disabled).toBe(true)

    rerender(
      <PetEditorV8 accountId="account-b" pet={makePet('pet-b', 'タマ')} onSaved={onSaved} onClose={onClose} />,
    )

    await waitFor(() => expect((screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement).disabled).toBe(false))

    await act(async () => {
      rejectOld(new ApiError(409, 'conflict', 'VERSION_CONFLICT', { latest: { updatedAt: '2026-11-27T01:00:00Z' } }))
    })

    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText(/ほかの人が先にペットの情報を変えました/)).toBeNull()
  })

  it('保存通信中に続けて保存を押しても二重送信しない', async () => {
    let resolveSave!: (value: unknown) => void
    mocks.updatePet.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve }))

    const onSaved = vi.fn()
    const onClose = vi.fn()
    render(<PetEditorV8 accountId="account-a" pet={makePet('pet-a', 'ポチ')} onSaved={onSaved} onClose={onClose} />)

    const saveButton = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
    fireEvent.click(saveButton)
    fireEvent.click(saveButton)
    expect(mocks.updatePet).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveSave({ success: true })
    })

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
