// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InboxResolvedText } from './send-preview'
import type { InboxPreview } from './use-reservation-warning'

afterEach(() => cleanup())

const ready = (preview: string): InboxPreview => ({ status: 'ready', preview, unresolved: [] })
const names = { vars: {}, varsComplete: true }

it('相手を移って戻っても、前に開いた全文の窓は勝手に開き直さない（A→B→A）', () => {
  const view = render(<InboxResolvedText scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  expect(screen.getByRole('dialog', { name: '送るとこうなります' })).toBeTruthy()
  view.rerender(<InboxResolvedText scope="chat-b" content="{{name}}様" preview={ready('佐藤様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  view.rerender(<InboxResolvedText scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
})

it('本文が変わって確かめ直している間に閉じ、同じ本文に戻っても開き直さない', () => {
  const view = render(<InboxResolvedText scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  view.rerender(<InboxResolvedText scope="chat-a" content="{{name}}様、" preview={{ status: 'loading' }} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  view.rerender(<InboxResolvedText scope="chat-a" content="{{name}}様" preview={ready('山田様')} tokenNames={names} />)
  expect(screen.queryByRole('dialog', { name: '送るとこうなります' })).toBeNull()
  // 開き直す操作をすれば、改行ごと全文が出る。
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  expect(screen.getByRole('dialog', { name: '送るとこうなります' }).textContent).toContain('山田様')
})

it('会話を読む場所を残すため、［全文を見る］は見出しの行に置き、本文は改行を保って短く見せる', () => {
  render(<InboxResolvedText scope="chat-a" content={'{{name}}様\n1行目\n2行目\n3行目'} preview={ready('山田様\n1行目\n2行目\n3行目')} tokenNames={names} />)
  const notice = screen.getByText('送るとこうなります：').closest('[data-design-part="notice"]')!
  // 操作の列（右や下の段）を作らず、見出しの中に置く。
  expect(notice.hasAttribute('data-has-action')).toBe(false)
  expect(screen.getByRole('button', { name: '全文を見る' }).closest('[data-notice-heading]')).not.toBeNull()
  // 見せる本文は改行を保つ（切るのは見た目だけで、全文は窓で読める）。
  expect(notice.querySelector('[data-send-preview]')?.textContent).toBe('山田様\n1行目\n2行目\n3行目')
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  expect(screen.getByRole('dialog', { name: '送るとこうなります' }).querySelector('[data-detail-value]')?.textContent).toBe('山田様\n1行目\n2行目\n3行目')
})
