// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const apiMocks = vi.hoisted(() => ({
  comments: vi.fn(),
  saveComments: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      comments: apiMocks.comments,
      saveComments: apiMocks.saveComments,
    },
  }
})
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import { ApiError, type Webinar, type WebinarEditor } from '@/lib/api'
import { webinarDetailChrome, webinarEditContext } from '@/test-utils/webinar-edit'
import CommentsPane from './comments'

beforeEach(() => {
  vi.resetAllMocks()
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('ウェビナーコメント演出：読み込み失敗時の0件誤表示防止と赤帯・再読み込み回復', () => {
  it('コメント読み込み失敗時は「いま 0 件」と出さず赤帯で理由と再読み込みを示し、回復後に実件数を表示する', async () => {
    apiMocks.comments
      .mockRejectedValueOnce(new ApiError(500, '一時エラー'))
      .mockResolvedValueOnce({ data: [{ atSeconds: 15, authorName: '佐藤', body: '楽しみです' }] })

    render(
      <CommentsPane
        ctx={webinarEditContext({ id: 'webinar-1' } as Webinar, {} as WebinarEditor)}
        chrome={webinarDetailChrome}
        onDirtyChange={() => {}}
        registerSave={() => {}}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('コメントを読み込めませんでした')
    expect(alert.textContent).toContain('コメントの読み込みに失敗しました')
    expect(screen.getByText(/いま —/)).toBeTruthy()
    expect(screen.queryByText(/いま 0 件/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => expect(screen.getByText(/いま 1 件/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(apiMocks.comments).toHaveBeenCalledTimes(2)
  })
})
