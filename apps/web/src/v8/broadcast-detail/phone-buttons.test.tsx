import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import BroadcastPhone from './phone'

const buttons = [{ label: '予約する', type: 'url' as const, value: 'https://example.com' }]
it.each([
  ['image', JSON.stringify({ originalContentUrl: 'https://example.com/photo.png' })],
  ['carousel', JSON.stringify([{ title: '店の案内', text: '本文', actions: [{ label: '詳細' }] }])],
])('%s の後に別のボタンメッセージを出す', (messageType, messageContent) => {
  const html = renderToStaticMarkup(<BroadcastPhone accountName="お店" time="10:00" broadcast={{ messageType, messageContent, messageOptions: { buttons } }} />)
  expect(html).toContain('予約する')
  expect(html.indexOf('予約する')).toBeGreaterThan(html.indexOf(messageType === 'image' ? '送る写真' : '店の案内'))
})
