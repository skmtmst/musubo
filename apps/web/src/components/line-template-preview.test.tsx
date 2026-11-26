import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FlexPreview, { sampleFlexText } from './flex-preview'
import { LinePreviewFlex } from './shared/line-preview'
import { fillPreviewSample, PREVIEW_SAMPLE } from './shared/preview-sample'

describe('LINE メッセージの下見', () => {
  it('予約日時を見本にし、未知の差し込みは名前の分かる札にする', () => {
    const value = fillPreviewSample('{{name}}さん {{var.reservation_datetime}} {{var.unknown}}')
    expect(value.text).toContain(PREVIEW_SAMPLE.name)
    expect(value.text).toContain(PREVIEW_SAMPLE.dateTime)
    expect(value.text).toContain('［差し込みの値］')
    expect(fillPreviewSample('{{var.guest_count}}名 {{var.course_name}}').text).toBe('2名 おまかせコース')
  })
  it('Flex のプレビューだけで差し込みを置き換え、保存内容と履歴を変えない', () => {
    const content = JSON.stringify({ type: 'bubble', body: { type: 'box', contents: [{ type: 'text', text: '{{var.reservation_datetime}}' }, { type: 'button', action: { type: 'uri', label: '詳細', uri: 'https://example.com' } }] } })
    expect(renderToStaticMarkup(<FlexPreview content={content} sample />)).toContain(PREVIEW_SAMPLE.dateTime)
    expect(renderToStaticMarkup(<FlexPreview content={content} />)).toContain('{{var.reservation_datetime}}')
    expect(content).toContain('{{var.reservation_datetime}}')
  })
  it('表示の差し込みだけを変え、送信先と元データを保つ', () => {
    const source = { type: 'button', action: { label: '{{name}}', uri: 'https://example.com/{{name}}', data: '{{var.restaurant_going}}' } }
    const sampled = sampleFlexText(source) as typeof source
    expect(sampled.action.label).toBe(PREVIEW_SAMPLE.name)
    expect(sampled.action.uri).toBe('https://example.com/{{name}}')
    expect(sampled.action.data).toBe('{{var.restaurant_going}}')
    expect(source.action.label).toBe('{{name}}')
  })
  it.each(['buttons', 'confirm'])('%s の本文と選択肢を表示する', type => {
    const content = JSON.stringify({ type: 'template', template: { type, text: '{{name}}さん', actions: [{ label: 'はい' }, { label: 'いいえ' }] } })
    const html = renderToStaticMarkup(<LinePreviewFlex content={content} />)
    expect(html).toContain(PREVIEW_SAMPLE.name)
    expect(html).toContain('はい')
    expect(html).toContain('いいえ')
    expect(html).toContain(type === 'confirm' ? 'flex-direction:row' : 'flex-direction:column')
  })
  it('テンプレートのカルーセルに入力した題と操作を表示する', () => {
    const content = JSON.stringify({ type: 'template', template: { type: 'carousel', columns: [{ title: '{{name}}さん', text: '予約案内', actions: [{ label: '確認' }] }] } })
    const html = renderToStaticMarkup(<LinePreviewFlex content={content} />)
    expect(html).toContain(PREVIEW_SAMPLE.name)
    expect(html).toContain('予約案内')
    expect(html).toContain('確認')
  })

})
