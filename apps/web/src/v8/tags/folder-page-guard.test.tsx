// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  push: vi.fn(),
  params: new URLSearchParams(),
  accountId: 'acc-1' as string | null,
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  listGroups: vi.fn(),
  deleteGroup: vi.fn(),
  createFolder: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: fx.push }),
  useSearchParams: () => fx.params,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fx.accountId }),
}))

vi.mock('@/lib/staff-role', async (original) => ({
  ...(await original<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'owner',
}))

vi.mock('./list', () => ({ default: () => <div>友だち属性の一覧</div> }))

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      tagGroups: {
        create: fx.createGroup,
        update: fx.updateGroup,
        list: fx.listGroups,
        delete: fx.deleteGroup,
      },
      folders: {
        ...actual.api.folders,
        create: fx.createFolder,
      },
    },
  }
})

import FolderPage from './folder-page'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  fx.params = new URLSearchParams()
  fx.accountId = 'acc-1'
})

afterEach(() => {
  cleanup()
})

describe('TagFolderPageV8 の連打二重作成防止・アカウント未選択・配列異常の守り', () => {
  it('「フォルダを作る」を連打しても作成APIは1回しか呼ばれず、アンマウント後は遷移しない', async () => {
    const req = deferred<{ success: true; data: { id: string } }>()
    fx.createGroup.mockReturnValueOnce(req.promise)

    const view = render(<FolderPage />)
    fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '常連客' } })

    const submit = screen.getByRole('button', { name: 'フォルダを作る' })
    fireEvent.click(submit)
    fireEvent.click(submit)

    expect(fx.createGroup).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      req.resolve({ success: true, data: { id: 'g-1' } })
      await req.promise
    })
    expect(fx.push).not.toHaveBeenCalled()
  })

  it('新規作成時にアカウント未選択なら作成ボタンを止めて理由を出し、APIを呼ばない', () => {
    fx.accountId = null
    render(<FolderPage />)

    const submit = screen.getByRole('button', { name: 'フォルダを作る' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText('アカウントを選んでください。')).not.toBeNull()

    fireEvent.click(submit)
    expect(fx.createGroup).not.toHaveBeenCalled()
  })

  it('編集時に一覧応答の data が配列でなくても落ちずにエラー表示と再試行へ切り替える', async () => {
    fx.params = new URLSearchParams('id=g-1')
    fx.listGroups
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({ success: true, data: [{ id: 'g-1', name: '回復済み', color: '#123456', accountId: 'acc-1' }] })

    render(<FolderPage />)
    await screen.findByRole('button', { name: 'もう一度読み込む' })

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'フォルダ名' }) as HTMLInputElement).value).toBe('回復済み'))
  })
})
