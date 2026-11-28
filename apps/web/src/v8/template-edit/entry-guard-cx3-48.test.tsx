// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ query: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('./message', () => ({ default: () => <p>メッセージを作る</p> }))
vi.mock('./rich', () => ({ default: () => <p>リッチメッセージを作る</p> }))
vi.mock('./asset', () => ({ default: () => <p>資産を作る</p> }))
vi.mock('./rich-video', () => ({ default: () => <p>動画を作る</p> }))
import TemplateEditV8 from './edit'
afterEach(cleanup)

it('未知の種類を受けたとき別の新規画面へ進めない', () => {
  state.query = 'kind=future'
  render(<TemplateEditV8 />)
  expect(screen.getByText('テンプレートの種類を確認できません')).toBeTruthy()
  expect(screen.queryByText('メッセージを作る')).toBeNull()
  expect(screen.getByRole('link', { name: 'テンプレート一覧へ戻る' }).getAttribute('href')).toBe('/templates')
})
it('編集対象を伴うリッチメッセージを新規作成として開かない', () => {
  state.query = 'kind=rich_message&id=existing'
  render(<TemplateEditV8 />)
  expect(screen.getByText('テンプレートの種類を確認できません')).toBeTruthy()
  expect(screen.queryByText('リッチメッセージを作る')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: 'テンプレート一覧へ戻る' }))
})
it('通常のメッセージと新しいリッチメッセージは従来どおり開く', () => {
  state.query = 'id=existing'
  const view = render(<TemplateEditV8 />)
  expect(screen.getByText('メッセージを作る')).toBeTruthy()
  state.query = 'kind=rich_message'; view.rerender(<TemplateEditV8 />)
  expect(screen.getByText('リッチメッセージを作る')).toBeTruthy()
})
