// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ChatImageMessage, StickerMessageImage } from './screen-gap-parts'

afterEach(cleanup)
const image = (id: string) => JSON.stringify({ originalContentUrl: `https://example.test/${id}.png` })
const sticker = (id: string) => JSON.stringify({ type: 'sticker', stickerId: id, stickerUrl: `https://stickershop.line-scdn.net/stickershop/v1/sticker/${id}/iPhone/sticker@2x.png`, fallback: '[スタンプ]' })

it('画像の失敗後に別の画像へ切り替えたら新しい画像を読み込む', () => {
  const view = render(<ChatImageMessage content={image('first')} />)
  fireEvent.error(screen.getByRole('img', { name: '画像' }))
  expect(screen.getByText('画像を読み込めませんでした')).toBeTruthy()
  view.rerender(<ChatImageMessage content={image('second')} />)
  expect(screen.getByRole('img', { name: '画像' }).getAttribute('src')).toBe('https://example.test/second.png')
})

it('スタンプの失敗後に別のスタンプへ切り替えたら新しいスタンプを読み込む', () => {
  const view = render(<StickerMessageImage content={sticker('1')} />)
  fireEvent.error(screen.getByRole('img', { name: '[スタンプ]' }))
  expect(screen.getByRole('button', { name: '画像を読み込み直す' })).toBeTruthy()
  view.rerender(<StickerMessageImage content={sticker('2')} />)
  expect(screen.getByRole('img', { name: '[スタンプ]' }).getAttribute('src')).toContain('/sticker/2/')
})

it('同じ画像の読み込み直しは従来どおり使える', () => {
  render(<ChatImageMessage content={image('first')} />)
  fireEvent.error(screen.getByRole('img', { name: '画像' }))
  fireEvent.click(screen.getByRole('button', { name: '画像を読み込み直す' }))
  expect(screen.getByRole('img', { name: '画像' }).getAttribute('src')).toBe('https://example.test/first.png')
})
