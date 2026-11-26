// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  accountId: 'acc-1' as string | null,
  foldersList: vi.fn(),
}))

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('./write-access', () => ({
  useScenarioWriteAccess: () => ({ allowed: true, known: true, reason: undefined }),
  captureScenarioWriteAccess: () => () => true,
}))
vi.mock('@/v8/autosave/public/use-scenario-draft/index', () => ({
  forgetNewScenarioDraftKey: vi.fn(),
  newScenarioDraftKey: () => null,
  scenarioDraftKey: () => null,
  useScenarioDraft: () => ({
    label: null,
    pendingAgo: null,
    conflictAgo: null,
    clear: vi.fn(),
    restore: vi.fn(),
    loadLatest: vi.fn(),
    overwrite: vi.fn(),
  }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: {
        ...actual.api.folders,
        list: (...args: unknown[]) => fixture.foldersList(...args),
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import ScenarioCreateV8 from './create'

const FOLDER_A: Folder = {
  id: 'fld-1',
  name: 'ウェルカム系',
  kind: 'scenario',
  color: '#3B82F6',
  parentId: null,
  displayOrder: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

beforeEach(() => {
  fixture.accountId = 'acc-1'
  fixture.foldersList.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('ScenarioCreateV8 のフォルダ読み込み失敗と再読み込み', () => {
  it('フォルダ取得に失敗したとき、入力済みのシナリオ名を残したままその場で再読み込みして選択可能に戻せる', async () => {
    fixture.foldersList
      .mockRejectedValueOnce(new ApiError(500, 'folders down'))
      .mockResolvedValueOnce({ success: true, data: [FOLDER_A] })

    render(<ScenarioCreateV8 />)

    await screen.findByText(/フォルダを確認できないため、いまは変更できません。/)
    const folderTrigger = screen.getByRole('button', { name: 'シナリオのフォルダ' }) as HTMLButtonElement
    expect(folderTrigger.disabled).toBe(true)

    const nameInput = screen.getByRole('textbox', { name: 'シナリオ名' }) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: '秋のフォロー配信' } })

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'シナリオのフォルダ' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect(screen.queryByText(/フォルダを確認できないため、いまは変更できません。/)).toBeNull()
    expect(nameInput.value).toBe('秋のフォロー配信')
    expect(fixture.foldersList).toHaveBeenCalledTimes(2)
    expect(fixture.foldersList).toHaveBeenLastCalledWith('scenario', 'acc-1')
  })

  it('フォルダ取得が success: false を返したときも再読み込みボタンから回復できる', async () => {
    fixture.foldersList
      .mockResolvedValueOnce({ success: false, error: 'temporary' })
      .mockResolvedValueOnce({ success: true, data: [FOLDER_A] })

    render(<ScenarioCreateV8 />)

    await screen.findByText(/フォルダを確認できないため、いまは変更できません。/)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'シナリオのフォルダ' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect(fixture.foldersList).toHaveBeenCalledTimes(2)
  })
})
