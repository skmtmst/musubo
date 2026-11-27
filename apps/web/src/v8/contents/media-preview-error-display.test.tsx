// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MediaPreviewOverlay from './media-preview-overlay'

afterEach(cleanup)
it('画像のプレビューに失敗したら理由を表示する', () => {
  render(<MediaPreviewOverlay filename="見本.png" kind="image" src="/missing.png" onClose={vi.fn()} />)
  fireEvent.error(screen.getByAltText('見本.png'))
  expect(screen.getByText('画像を表示できませんでした。')).toBeTruthy()
})

it.each(['video', 'audio'] as const)('%sのプレビューに失敗したら理由を表示する', (kind) => {
  const { container } = render(<MediaPreviewOverlay filename="見本" kind={kind} src="/missing" onClose={vi.fn()} />)
  fireEvent.error(container.querySelector(kind) ?? document.querySelector(kind)!)
  expect(screen.getByText('メディアを再生できませんでした。')).toBeTruthy()
})
