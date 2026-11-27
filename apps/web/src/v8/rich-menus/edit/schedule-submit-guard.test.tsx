// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type RichMenuScheduleInput } from '@/lib/api'
import { useScheduleSubmit } from './schedule-submit'

const mocks = vi.hoisted(() => ({
  persistDraft: vi.fn(),
  schedule: vi.fn(),
  onSaved: vi.fn(),
  onFailed: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        schedule: mocks.schedule,
      },
    },
  }
})

const sampleInput: RichMenuScheduleInput = {
  mode: 'publish',
  startsAt: '2026-12-01T10:00:00+09:00',
  endsAt: null,
  restoreGroupId: null,
}

function Harness({ groupId }: { groupId: string }) {
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [failedMsg, setFailedMsg] = useState('')
  const submit = useScheduleSubmit({
    groupId,
    persistDraft: mocks.persistDraft,
    onSaving: setSaving,
    onSaved: (msg) => { setSavedMsg(msg); mocks.onSaved(groupId, msg) },
    onFailed: (msg) => { setFailedMsg(msg); mocks.onFailed(groupId, msg) },
  })
  return (
    <div>
      <output data-testid="saving">{String(saving)}</output>
      <output data-testid="saved">{savedMsg}</output>
      <output data-testid="failed">{failedMsg}</output>
      <button type="button" onClick={() => void submit(sampleInput)}>予約する</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.persistDraft.mockResolvedValue(undefined)
  mocks.schedule.mockResolvedValue({ success: true, data: { id: 'sched-1', status: 'scheduled' } })
})

afterEach(() => {
  cleanup()
})

describe('useScheduleSubmit の二重送信・対象切替・権限エラーの守り', () => {
  it('送信中にもう一度呼んでも persistDraft と schedule を二重に実行しない', async () => {
    let resolveDraft!: () => void
    mocks.persistDraft.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDraft = resolve }))
    render(<Harness groupId="menu-a" />)

    const button = screen.getByRole('button', { name: '予約する' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(mocks.persistDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('saving').textContent).toBe('true')

    resolveDraft()
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'))
    expect(mocks.schedule).toHaveBeenCalledTimes(1)
  })

  it('下書き保存の途中で対象メニューが切り替わったら、古いメニューの公開予約を送らない', async () => {
    let resolveDraft!: () => void
    mocks.persistDraft.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDraft = resolve }))
    const view = render(<Harness groupId="menu-a" />)

    fireEvent.click(screen.getByRole('button', { name: '予約する' }))
    expect(mocks.persistDraft).toHaveBeenCalledTimes(1)

    view.rerender(<Harness groupId="menu-b" />)

    resolveDraft()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(mocks.onSaved).not.toHaveBeenCalled()
    expect(mocks.onFailed).not.toHaveBeenCalled()
  })

  it('公開予約 API が 403 を返したとき権限不足を案内する', async () => {
    mocks.schedule.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    render(<Harness groupId="menu-a" />)

    fireEvent.click(screen.getByRole('button', { name: '予約する' }))

    await waitFor(() => {
      expect(screen.getByTestId('failed').textContent).toContain('権限がありません')
    })
  })
})
