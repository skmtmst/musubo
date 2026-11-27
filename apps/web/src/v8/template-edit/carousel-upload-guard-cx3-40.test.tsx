// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ prepare: vi.fn(), complete: vi.fn(), detail: vi.fn(), put: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { media: { prepareUploads: net.prepare, completeUpload: net.complete, detail: net.detail } } }))
vi.mock('@/v8/contents/public/media-direct-upload/index', () => ({ validateMediaFile: () => '', extractMediaMetadata: async () => ({}), putMediaFile: net.put }))
import { uploadCarouselImage } from './carousel-image-upload'

function Screen() {
  const [message, setMessage] = useState('')
  const upload = async () => {
    try { setMessage(await uploadCarouselImage(new File(['image'], 'test.png', { type: 'image/png' }), 'account')) }
    catch (error) { setMessage(error instanceof Error ? error.message : '失敗') }
  }
  return <><button onClick={() => void upload()}>画像を送る</button><p role="status">{message}</p></>
}
beforeEach(() => {
  vi.resetAllMocks()
  net.prepare.mockResolvedValue({ success: true, data: { sessions: [{ id: 'upload' }] } })
  net.put.mockResolvedValue('etag')
  net.complete.mockResolvedValue({ success: true, data: { status: 'completed', mediaId: 'media' } })
  net.detail.mockResolvedValue({ success: true, data: { item: { kind: 'image', url: 'https://example.test/image.png' } } })
})
afterEach(cleanup)

it('登録番号が文字でなければ画像の確認をせず失敗を伝える', async () => {
  net.complete.mockResolvedValueOnce({ success: true, data: { status: 'completed', mediaId: 123 } })
  render(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '画像を送る' }))
  expect(await screen.findByText(/画像の登録を完了できませんでした/)).toBeTruthy()
  expect(net.detail).not.toHaveBeenCalled()
})

it('画像URLが文字でなければ完了とせず失敗を伝える', async () => {
  net.detail.mockResolvedValueOnce({ success: true, data: { item: { kind: 'image', url: 123 } } })
  render(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '画像を送る' }))
  expect(await screen.findByText(/登録した画像を確認できませんでした/)).toBeTruthy()
})

it('正しい登録番号と画像URLなら画像を表示できる', async () => {
  render(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '画像を送る' }))
  expect(await screen.findByText('https://example.test/image.png')).toBeTruthy()
  expect(net.detail).toHaveBeenCalledWith('media', 'account')
})
