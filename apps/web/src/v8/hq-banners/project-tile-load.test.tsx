// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BannerImage } from '@/lib/hq-banners'
import { Thumb } from './project-tiles'

afterEach(cleanup)
function image(url: string): BannerImage {
  return { id: 'image', projectId: 'project', generationId: null, sequence: 1, source: 'upload', parentImageId: null, isFavorite: false, createdBy: null, createdAt: '', media: { id: 'media', filename: 'banner.png', mimeType: 'image/png', sizeBytes: 1, width: 10, height: 10, url }, generation: null, deliveredAccountIds: [] }
}

it('画像が読み込めないとき空白にせず理由を表示する', () => {
  const view = render(<Thumb image={image('https://example.test/a.png')} />)
  fireEvent.error(view.container.querySelector('img')!)
  expect(screen.getByText('画像を表示できません').parentElement?.getAttribute('title')).toBe('画像を表示できません')
})

it('画像が切り替わると古い読み込み失敗を引き継がず表示する', () => {
  const view = render(<Thumb image={image('https://example.test/a.png')} />)
  fireEvent.error(view.container.querySelector('img')!)
  view.rerender(<Thumb image={image('https://example.test/b.png')} />)
  expect(screen.queryByText('画像を表示できません')).toBeNull()
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/b.png')
})
