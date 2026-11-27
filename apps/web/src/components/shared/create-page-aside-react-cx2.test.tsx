// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import CreatePage from './create-page'
afterEach(cleanup)

it('渡された右欄は入力欄と分かれたプレビューに出る', () => {
  const { container } = render(<CreatePage title="作成" parent={['一覧', '/items']} onSave={async () => {}} aside={<p>右側の内容</p>}><p>入力の内容</p></CreatePage>)
  const preview = container.querySelector<HTMLElement>('[data-template-region="preview"]')
  const content = container.querySelector<HTMLElement>('[data-template-region="content"]')
  expect(preview).not.toBeNull()
  expect(content).not.toBeNull()
  expect(within(preview!).getByText('右側の内容')).toBeTruthy()
  expect(within(content!).getByText('入力の内容')).toBeTruthy()
  expect(within(content!).queryByText('右側の内容')).toBeNull()
  expect(screen.getByRole('link', { name: 'キャンセル' }).getAttribute('href')).toBe('/items')
})

it('右欄を渡さなければプレビュー領域を表示しない', () => {
  const { container } = render(<CreatePage title="作成" parent={['一覧', '/items']} onSave={async () => {}}><p>入力の内容</p></CreatePage>)
  expect(container.querySelector('[data-template-region="preview"]')).toBeNull()
  expect(screen.getByText('入力の内容')).toBeTruthy()
})
