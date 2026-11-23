import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FlexPreview from './flex-preview'

const node = { type: 'text', text: '1,000 円' }
const bubble = (text: Record<string, unknown>) => JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [text] } })
const html = (text: Record<string, unknown>) => renderToStaticMarkup(<FlexPreview content={bubble(text)} />)

describe('LINE本文の打消し線', () => {
  it.each(['line-through', 'underline'])('既存LINE属性 %s を描画する', decoration => {
    expect(html({ ...node, decoration })).toContain(`text-decoration:${decoration}`)
  })
  it('未指定は従来の本文HTMLを保持し、未知の指定は追加しない', () => {
    const unchanged = html(node)
    expect(unchanged).not.toContain('text-decoration')
    expect(unchanged).toMatchInlineSnapshot(`"<div style="width:300px;background-color:var(--color-canvas);border-radius:var(--radius-card);overflow:hidden;box-shadow:var(--shadow-card);font-size:14px;position:relative"><div style="background-color:transparent;padding:16px"><div style="min-width:0"><p style="font-size:14px;font-weight:400;color:#111;margin:0;line-height:1.4;word-break:break-word">1,000 円</p></div></div></div>"`)
    for (const decoration of ['blink', 'url(https://example.com)', { style: 'line-through' }, null]) expect(html({ ...node, decoration })).toBe(unchanged)
  })
})
