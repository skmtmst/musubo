// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import AttachmentMessage from './attachment-message'

afterEach(cleanup)
const video = (id: string) => JSON.stringify({ originalContentUrl: `https://example.test/${id}.mp4` })

it('動画を読み込めない場合に理由を出して再読み込みできる', () => {
  const view = render(<AttachmentMessage messageType="video" content={video('one')} />)
  fireEvent.error(view.container.querySelector('video')!)
  expect(screen.getByText('動画を読み込めませんでした').getAttribute('title')).toBe('動画を読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: '動画を読み込み直す' }))
  expect(view.container.querySelector('video')?.getAttribute('src')).toBe('https://example.test/one.mp4')
})

it('失敗した後に別の動画を表示すると前の失敗を引き継がない', () => {
  const view = render(<AttachmentMessage messageType="video" content={video('one')} />)
  fireEvent.error(view.container.querySelector('video')!)
  expect(screen.getByText('動画を読み込めませんでした')).toBeTruthy()
  view.rerender(<AttachmentMessage messageType="video" content={video('two')} />)
  expect(view.container.querySelector('video')?.getAttribute('src')).toBe('https://example.test/two.mp4')
})
