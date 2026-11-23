// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InboxSendPreview } from './send-preview'
import type { InboxPreview } from './use-reservation-warning'

afterEach(() => cleanup())

const ready = (preview: string): InboxPreview => ({ status: 'ready', preview, unresolved: [] })
const names = { vars: {}, varsComplete: true }

it('相手を移って戻っても、前に開いた全文の窓は勝手に開き直さない（A→B→A）', () => {
  const view = render(<InboxSendPreview scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  expect(screen.getByRole('dialog', { name: '送るとこうなります' })).toBeTruthy()
  view.rerender(<InboxSendPreview scope="chat-b" content="{{name}}様" preview={ready('佐藤様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  view.rerender(<InboxSendPreview scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
})

it('本文が変わって確かめ直している間に閉じ、同じ本文に戻っても開き直さない', () => {
  const view = render(<InboxSendPreview scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  view.rerender(<InboxSendPreview scope="chat-a" content="{{name}}様、" preview={{ status: 'loading' }} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  view.rerender(<InboxSendPreview scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  // 開き直す操作をすれば、改行ごと全文が出る。
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  expect(screen.getByRole('dialog', { name: '送るとこうなります' }).textContent).toContain('山田様')
})
