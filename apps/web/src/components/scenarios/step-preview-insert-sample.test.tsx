// @vitest-environment happy-dom
import React from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import StepPreview from './step-preview'
import BroadcastMessagePreview from '@/components/broadcasts/broadcast-message-preview'
import { LinePreviewCard, LinePreviewMessage } from '@/components/shared/line-preview'

afterEach(cleanup)
const base = { deliveryMode: 'elapsed' as const, offsetDays: 1, deliveryTime: '09:00', offsetHours: 0, kind: 'text' as const, templateName: null, imageUrl: null, question: null, audienceLabel: '全員' }

it('シナリオの両方の見本で名前と日付を実際の例にする', () => {
  const input = '{{name}}さん、{{date}}に予約 {予約日時}'
  const { container } = render(<StepPreview {...base} body={input} />)
  const phone = container.querySelector('[data-line-preview-part="talk"]')!
  expect(phone.textContent).toContain('見本 143さん、10月2日')
  expect(container.textContent).not.toContain('{{date}}')
  expect(input).toBe('{{name}}さん、{{date}}に予約 {予約日時}')
})
it('シナリオの質問文と選択肢も見本の値にする', () => {
  const question = { intro: 'こんにちは {{name}}', text: '{{date}}はいかがですか', choices: [{ label: '{{name}}の予約' }] } as never
  const { container } = render(<StepPreview {...base} kind="question" body="" question={question} />)
  expect(container.textContent).toContain('こんにちは 見本 143')
  expect(container.textContent).toContain('10月2日はいかがですか')
  expect(container.textContent).toContain('見本 143の予約')
  expect(container.textContent).not.toContain('{{')
})
it('装飾のない吹き出しにも見本の値を表示する', () => {
  render(<LinePreviewMessage bare accountName="店" avatar={null} time="">{'{{name}}さま'}</LinePreviewMessage>)
  expect(screen.getByText('見本 143さま')).toBeTruthy()
})
it('カードの表示文字も見本の値にし、元の入力を変えない', () => {
  const title = '{{name}}の商品'
  render(<LinePreviewCard imageUrl="" title={title} description="{{date}}まで" price="100円" time="" actions={[{ label: '{{name}}の詳細', onClick: () => {} }]} />)
  expect(screen.getByText('見本 143の商品')).toBeTruthy()
  expect(screen.getByText('10月2日まで')).toBeTruthy()
  expect(screen.getByText('見本 143の詳細')).toBeTruthy()
  expect(title).toBe('{{name}}の商品')
})
it('複数メッセージの見本の中の位置情報も差し込みを変換する', () => {
  render(<LinePreviewMessage bare accountName="店" avatar={null} time=""><div><p>{'{{name}}の店'}</p><p>{'{{date}}に来店'}</p></div></LinePreviewMessage>)
  expect(screen.getByText('見本 143の店')).toBeTruthy()
  expect(screen.getByText('10月2日に来店')).toBeTruthy()
})

it('一斉配信の位置情報を表示だけ見本にし、保存された内容を変えない', () => {
  const content = JSON.stringify({ title: '{{name}}の店', address: '{{date}}に来店', latitude: 35, longitude: 139 })
  render(<BroadcastMessagePreview messageType="location" messageContent={content} />)
  expect(screen.getByText('見本 143の店')).toBeTruthy()
  expect(screen.getByText('10月2日に来店')).toBeTruthy()
  expect(JSON.parse(content).title).toBe('{{name}}の店')
})
