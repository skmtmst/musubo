// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/transport/errors'
import type { Webinar } from '@/lib/api'
const mocks = vi.hoisted(() => ({ detail: vi.fn() }))
vi.mock('@/lib/api', async () => ({ ApiError: (await import('@/lib/api/transport/errors')).ApiError, api: { media: { detail: mocks.detail } } }))
import VideoMetadata from './video-metadata'
const webinar = { videoMediaId: 'video-a', accountId: 'account-a', durationSeconds: 60 } as Webinar
afterEach(() => { cleanup(); vi.resetAllMocks() })
it.each(['response', 'network'])('動画情報の%s失敗を知らせ、再取得できる', async failure => {
  if (failure === 'response') mocks.detail.mockResolvedValueOnce({ success: false })
  else mocks.detail.mockRejectedValueOnce(new Error('network'))
  mocks.detail.mockResolvedValueOnce({ success: true, data: { item: { filename: '動画.mp4', kind: 'video' } } })
  render(<VideoMetadata webinar={webinar} />)
  expect(await screen.findByText(/動画の情報を読み込めませんでした/)).toBeTruthy()
  expect(screen.getByText('設定済みの動画')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '動画情報を読み直す' }))
  expect(await screen.findByText('動画.mp4')).toBeTruthy()
  expect(mocks.detail).toHaveBeenCalledTimes(2)
})
it('切替前に遅れて届いた失敗を新しい動画に表示しない', async () => {
  let rejectOld!: (e: Error) => void
  mocks.detail.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
  mocks.detail.mockResolvedValueOnce({ success: true, data: { item: { filename: '新しい動画.mp4', kind: 'video' } } })
  const view = render(<VideoMetadata webinar={webinar} />)
  view.rerender(<VideoMetadata webinar={{ ...webinar, videoMediaId: 'video-b' }} />)
  expect(await screen.findByText('新しい動画.mp4')).toBeTruthy()
  await act(async () => { rejectOld(new Error('network')) })
  expect(screen.queryByText(/動画の情報を読み込めませんでした/)).toBeNull()
})

it('権限がなく動画情報を読めないときは再試行を案内しない', async () => {
  mocks.detail.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
  render(<VideoMetadata webinar={webinar} />)
  await act(async () => {})
  expect(screen.getByText('設定済みの動画')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '動画情報を読み直す' })).toBeNull()
})
