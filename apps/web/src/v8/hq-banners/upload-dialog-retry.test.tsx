// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UploadDialogV8 } from './dialogs'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL ||= 'http://worker.test'
  return { list: vi.fn(), upload: vi.fn() }
})

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      hqBanners: {
        ...actual.api.hqBanners,
        projects: { ...actual.api.hqBanners.projects, list: mocks.list, upload: mocks.upload },
      },
    },
  }
})

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  mocks.list.mockReset()
  mocks.upload.mockReset()
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('UploadDialogV8 のプロジェクト一覧読み込み失敗', () => {
  it('一覧の取得に失敗しても空の案内を出さず、その場でもう一度読み込める', async () => {
    mocks.list
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'p1', name: '春の感謝祭' }] })

    render(<UploadDialogV8 open onClose={vi.fn()} onDone={vi.fn()} />)

    await screen.findByText('プロジェクトを読み込めませんでした。')
    expect(screen.queryByText(/まずプロジェクトを作ってください/)).toBeNull()

    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    await screen.findByLabelText('選択中の入れるプロジェクト：春の感謝祭')
    expect(screen.queryByText('プロジェクトを読み込めませんでした。')).toBeNull()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
})
