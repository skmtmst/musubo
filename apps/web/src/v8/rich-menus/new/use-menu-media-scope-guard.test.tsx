// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingImage } from './create-types'
import { useMenuMediaScope } from './use-menu-media-scope'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useMenuMediaScope 非blob URLとhosted切替時の防御', () => {
  it('blob: 以外の通常 URL を URL.revokeObjectURL に渡さず、同一 blob URL の重複解放も防ぐ', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { result, rerender } = renderHook(
      ({ id, hosted }) => {
        const [images, setImages] = useState<Array<PendingImage | null>>([])
        const [open, setOpen] = useState(false)
        useMenuMediaScope(id, hosted, setImages, setOpen)
        return { images, setImages, open, setOpen }
      },
      { initialProps: { id: 'store-a', hosted: false } },
    )

    act(() => {
      result.current.setImages([
        { url: 'https://cdn.example.test/menu.png' } as PendingImage,
        { url: 'blob:store-a/1' } as PendingImage,
        { url: 'blob:store-a/1' } as PendingImage,
      ])
      result.current.setOpen(true)
    })

    rerender({ id: 'store-b', hosted: false })

    expect(result.current.images).toEqual([])
    expect(result.current.open).toBe(false)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:store-a/1')
  })

  it('hosted 中に accountId が変わったあと hosted が false に戻っても、その時点のアカウント画像を誤消去しない', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const { result, rerender } = renderHook(
      ({ id, hosted }) => {
        const [images, setImages] = useState<Array<PendingImage | null>>([])
        const [open, setOpen] = useState(false)
        useMenuMediaScope(id, hosted, setImages, setOpen)
        return { images, setImages, open, setOpen }
      },
      { initialProps: { id: 'store-a', hosted: true } },
    )

    rerender({ id: 'store-b', hosted: true })
    act(() => {
      result.current.setImages([{ url: 'blob:store-b/1' } as PendingImage])
      result.current.setOpen(true)
    })

    rerender({ id: 'store-b', hosted: false })
    expect(result.current.images).toHaveLength(1)
    expect(result.current.open).toBe(true)
    expect(revoke).not.toHaveBeenCalled()
  })
})
