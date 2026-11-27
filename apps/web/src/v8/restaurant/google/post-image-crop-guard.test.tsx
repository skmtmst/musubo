// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { PostImageCrop } from './post-image-crop'

let resizeCallbacks: Array<() => void> = []

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resizeCallbacks.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubCanvas(toBlobImpl: (cb: (blob: Blob | null) => void) => void) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
    toBlobImpl(cb)
  })
}

function loadImageReady(container: HTMLElement) {
  const img = container.querySelector('img') as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1600 })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1200 })
  for (const el of container.querySelectorAll('div')) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
    })
  }
  act(() => {
    for (const cb of resizeCallbacks) cb()
  })
  fireEvent.load(img)
}

describe('PostImageCrop の画像切替リセット・離脱中断・権限エラー案内', () => {
  it('画像読み込みエラーやサイズ確定のあと別の画像へ切り替えるとエラーと確定可能状態を初期化する', () => {
    const sourceA = { url: 'https://example.test/a.jpg', name: 'a.jpg' }
    const sourceB = { url: 'https://example.test/b.jpg', name: 'b.jpg' }
    const { container, rerender } = render(
      <PostImageCrop target="google" source={sourceA} onClose={vi.fn()} onConfirm={vi.fn()} />,
    )

    loadImageReady(container)
    expect((screen.getByRole('button', { name: 'この位置で確定' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    expect(screen.getByRole('alert').textContent).toContain('画像を読み込めませんでした')

    rerender(<PostImageCrop target="google" source={sourceB} onClose={vi.fn()} onConfirm={vi.fn()} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'この位置で確定' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('切り取り生成（toBlob）の途中で窓を閉じたら onConfirm を呼ばない', async () => {
    let finishBlob!: (blob: Blob | null) => void
    stubCanvas((cb) => { finishBlob = cb })
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const { container, unmount } = render(
      <PostImageCrop target="google" source={{ url: 'https://example.test/a.jpg', name: 'a.jpg' }} onClose={vi.fn()} onConfirm={onConfirm} />,
    )

    loadImageReady(container)
    fireEvent.click(screen.getByRole('button', { name: 'この位置で確定' }))

    unmount()
    finishBlob(new Blob(['jpeg'], { type: 'image/jpeg' }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('確定保存が 403 を返したとき権限不足を案内する', async () => {
    stubCanvas((cb) => cb(new Blob(['jpeg'], { type: 'image/jpeg' })))
    const onConfirm = vi.fn().mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    const { container } = render(
      <PostImageCrop target="google" source={{ url: 'https://example.test/a.jpg', name: 'a.jpg' }} onClose={vi.fn()} onConfirm={onConfirm} />,
    )

    loadImageReady(container)
    fireEvent.click(screen.getByRole('button', { name: 'この位置で確定' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('権限がありません')
    })
  })
})
