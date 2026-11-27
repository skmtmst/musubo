// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantCoursePhoto } from '@line-crm/shared'

vi.mock('./course-photo-picker', () => ({
  default: () => <div data-testid="photo-picker">picker</div>,
}))

import CoursePhotos from './course-photos'

afterEach(cleanup)

const PHOTOS: RestaurantCoursePhoto[] = [
  { mediaId: 'media-1', x: 50, y: 50 },
]

describe('CoursePhotos のアカウント切替・無効化ガード', () => {
  it('前のアカウントで読めなかった画像の警告を、別のアカウントへ切り替えた後に引きずらない', () => {
    const view = render(
      <CoursePhotos
        accountId="acc-a"
        photos={PHOTOS}
        disabled={false}
        error={null}
        onChange={() => {}}
      />,
    )

    const img = view.container.querySelector('img')!
    fireEvent.error(img)
    expect(screen.getByText(/画像を読めません/)).toBeTruthy()
    expect(screen.getByText('画像なし')).toBeTruthy()

    view.rerender(
      <CoursePhotos
        accountId="acc-b"
        photos={PHOTOS}
        disabled={false}
        error={null}
        onChange={() => {}}
      />,
    )

    expect(screen.queryByText(/画像を読めません/)).toBeNull()
    expect(screen.queryByText('画像なし')).toBeNull()
    const nextImg = view.container.querySelector('img')
    expect(nextImg).not.toBeNull()
    expect(nextImg?.getAttribute('src')).toContain('acc-b')
  })

  it('表示範囲の調整ダイアログを開いた後に操作不可またはアカウント切替になったらダイアログを閉じ、変更させない', () => {
    const onChange = vi.fn()
    const view = render(
      <CoursePhotos
        accountId="acc-a"
        photos={PHOTOS}
        disabled={false}
        error={null}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '写真 1 の表示範囲を調整' }))
    expect(screen.getByRole('dialog', { name: '写真の表示範囲を調整' })).toBeTruthy()

    view.rerender(
      <CoursePhotos
        accountId="acc-a"
        photos={PHOTOS}
        disabled={true}
        error={null}
        onChange={onChange}
      />,
    )
    expect(screen.queryByRole('dialog', { name: '写真の表示範囲を調整' })).toBeNull()

    view.rerender(
      <CoursePhotos
        accountId="acc-a"
        photos={PHOTOS}
        disabled={false}
        error={null}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '写真 1 の表示範囲を調整' }))
    expect(screen.getByRole('dialog', { name: '写真の表示範囲を調整' })).toBeTruthy()

    view.rerender(
      <CoursePhotos
        accountId="acc-b"
        photos={PHOTOS}
        disabled={false}
        error={null}
        onChange={onChange}
      />,
    )
    expect(screen.queryByRole('dialog', { name: '写真の表示範囲を調整' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
})
