import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatDetailMessage } from '@/lib/api'
import { InboxMessageRow } from './message-row'

describe('受信箱の自動送信の印', () => {
  const message = {
    id: 'message-1', direction: 'outgoing', messageType: 'text', content: 'こんにちは',
    isUnsent: false, source: 'auto_reply', originKind: null, sentByStaffId: null,
    sentByStaffName: null, scenarioName: null, quoted: null, createdAt: '2026-11-26T03:00:00Z',
  } as ChatDetailMessage

  it('既知の送信元を表示し、未知の送信元では印を出さず本文を表示する', () => {
    const render = (source: string) => {
      const item = { ...message, source } as ChatDetailMessage
      return renderToStaticMarkup(<InboxMessageRow msg={item} list={[item]} idx={0} sending={false} />)
    }
    expect(render('auto_reply')).toContain('自動応答')
    for (const source of ['constructor', 'toString', '__proto__', 'future']) {
      const html = render(source)
      expect(html).toContain('こんにちは')
      expect(html).not.toContain('自動応答')
      expect(html).not.toContain('function Object')
    }
  })
})
