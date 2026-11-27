// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatDetailMessage } from '@/lib/api'
import { InboxMessageRow } from './message-row'

const message: ChatDetailMessage = { id: 'm', direction: 'outgoing', messageType: 'text', content: 'こんにちは', isUnsent: false, source: null, originKind: null, sentByStaffId: null, sentByStaffName: null, scenarioName: null, quoted: null, createdAt: '2026-11-26T03:00:00Z' }
const renderMessage = (msg: ChatDetailMessage, onQuote = vi.fn()) => render(<InboxMessageRow msg={msg} list={[msg]} idx={0} sending={false} onQuote={onQuote} />)
afterEach(cleanup)

it('本文が文字でないときは画面を止めず引用を出さない', () => {
  renderMessage({ ...message, content: { text: '壊れた本文' } as unknown as string })
  expect(screen.getByText('メッセージを確認できません')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '引用' })).toBeNull()
})
it('取消状態が不正なときは取り消されたと決めつけない', () => {
  renderMessage({ ...message, isUnsent: 'false' as unknown as boolean })
  expect(screen.getByText('メッセージを確認できません')).toBeTruthy()
  expect(screen.queryByText('送信を取り消しました')).toBeNull()
  expect(screen.queryByRole('button', { name: '引用' })).toBeNull()
})
it('正常な本文と引用はこれまでどおり使える', () => {
  const quote = vi.fn()
  renderMessage(message, quote)
  expect(screen.getByText('こんにちは')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '引用' }))
  expect(quote).toHaveBeenCalledWith(message)
})
it('取消済みの本文はこれまでどおり表示しない', () => {
  renderMessage({ ...message, isUnsent: true })
  expect(screen.getByText('送信を取り消しました')).toBeTruthy()
  expect(screen.queryByText('こんにちは')).toBeNull()
  expect(screen.queryByRole('button', { name: '引用' })).toBeNull()
})
it('本文を使わないシナリオ開始の印は本文が空でも表示する', () => {
  renderMessage({ ...message, source: 'scenario', scenarioName: 'ご案内', content: null as unknown as string })
  expect(screen.getByText('シナリオ「ご案内」を開始')).toBeTruthy()
})
