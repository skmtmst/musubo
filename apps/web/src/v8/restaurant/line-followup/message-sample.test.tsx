import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FollowupMessageSample } from './message-sample'

it('予約前日の案内に自動で加わる確認メッセージを見せる', () => {
 const html = renderToStaticMarkup(<FollowupMessageSample trigger="reservation_24h" storeName="店" bubbles={[{ id: 'text', type: 'text', content: { text: '{{name}}さん {{var.reservation_datetime}}' } }]} />)
 expect(html).toContain('行きます')
 expect(html).toContain('変更したい')
 expect(html).toContain('取り消す')
 expect(html).not.toContain('{{var.reservation_datetime}}')
})
