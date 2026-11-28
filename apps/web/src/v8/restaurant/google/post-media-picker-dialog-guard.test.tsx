// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  contentUrl: vi.fn((id: string) => `https://example.test/media/${id}`),
}))

vi.mock('@/lib/api', () => ({
  api: { media: { list: fixture.list, contentUrl: fixture.contentUrl } },
  ApiError: class ApiError extends Error {},
}))

import { PostMediaPickerDialog } from './post-media-picker-dialog'

const media = (id: string, accountId: string): MediaItem => ({
  id,
  lineAccountId: accountId,
  folderId: null,
  kind: 'image',
  filename: `${id}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 100,
  width: 1200,
  height: 900,
  durationMs: null,
  url: '',
  uploadedBy: null,
  createdAt: '2026-10-29T00:00:00Z',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  fixture.list.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('PostMediaPickerDialog のアカウント切替・適用連打・押せない理由の制御', () => {
  it('未選択のあいだ「切り取り位置を確認」が押せない理由を1行出し、選ぶと消える', async () => {
    fixture.list.mockResolvedValueOnce({
      success: true,
      data: { items: [media('photo-a', 'account-1')], total: 1, limit: 20, offset: 0 },
    })

    render(<PostMediaPickerDialog target="google" accountId="account-1" onClose={vi.fn()} onSelect={vi.fn()} />)
    await screen.findByText('photo-a.jpg')

    const confirm = screen.getByRole('button', { name: '切り取り位置を確認' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('画像を選んでください。')).not.toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /photo-a\.jpg/ }))
    expect(confirm.disabled).toBe(false)
    expect(screen.queryByText('画像を選んでください。')).toBeNull()
  })

  it('アカウントを切り替えると選択とページを1ページ目へ初期化し、前の選択を引き継がない', async () => {
    fixture.list
      .mockResolvedValueOnce({
        success: true,
        data: { items: [media('a-page1', 'account-1')], total: 25, limit: 20, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { items: [media('a-page2', 'account-1')], total: 25, limit: 20, offset: 20 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { items: [media('b-page1', 'account-2')], total: 1, limit: 20, offset: 0 },
      })

    const view = render(
      <PostMediaPickerDialog target="google" accountId="account-1" onClose={vi.fn()} onSelect={vi.fn()} />,
    )
    await screen.findByText('a-page1.jpg')

    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    await screen.findByText('a-page2.jpg')
    expect(fixture.list).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ offset: 20 }))

    fireEvent.click(screen.getByRole('radio', { name: /a-page2\.jpg/ }))
    const confirm = screen.getByRole('button', { name: '切り取り位置を確認' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)

    view.rerender(
      <PostMediaPickerDialog target="google" accountId="account-2" onClose={vi.fn()} onSelect={vi.fn()} />,
    )

    expect(screen.queryByText('a-page2.jpg')).toBeNull()
    await screen.findByText('b-page1.jpg')
    expect(fixture.list).toHaveBeenLastCalledWith('account-2', expect.objectContaining({ offset: 0 }))
    expect((screen.getByRole('button', { name: '切り取り位置を確認' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('画像を選んでください。')).not.toBeNull()
  })

  it('適用を連打しても1回しか送らず、適用中のアカウント切替後に古い失敗で新画面を壊さない', async () => {
    const selectReq = deferred<void>()
    const onSelect = vi.fn().mockReturnValueOnce(selectReq.promise)
    fixture.list
      .mockResolvedValueOnce({
        success: true,
        data: { items: [media('a-1', 'account-1')], total: 1, limit: 20, offset: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { items: [media('b-1', 'account-2')], total: 1, limit: 20, offset: 0 },
      })

    const view = render(
      <PostMediaPickerDialog target="instagram" accountId="account-1" onClose={vi.fn()} onSelect={onSelect} />,
    )
    await screen.findByText('a-1.jpg')

    fireEvent.click(screen.getByRole('radio', { name: /a-1\.jpg/ }))
    const confirm = screen.getByRole('button', { name: '切り取り位置を確認' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onSelect).toHaveBeenCalledTimes(1)

    view.rerender(
      <PostMediaPickerDialog target="instagram" accountId="account-2" onClose={vi.fn()} onSelect={onSelect} />,
    )
    await screen.findByText('b-1.jpg')

    await act(async () => {
      selectReq.reject(new Error('old account failure'))
      try {
        await selectReq.promise
      } catch {
        // expected rejection
      }
    })

    expect(screen.queryByText(/画像を読み込めませんでした/)).toBeNull()
    expect(screen.getByText('b-1.jpg')).not.toBeNull()
  })
})
