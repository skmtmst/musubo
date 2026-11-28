// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
import TopBar from './top-bar'
afterEach(cleanup)

const props = { accounts: [{ id: 'acc', label: '店舗名' }], selectedAccountId: 'acc', onAccountChange: vi.fn(), roleLabel: '', userName: '', onLogout: vi.fn(), v8Chrome: true, showAccountSwitcher: false }

it.each(['詳細', ''])('先頭のホームは1回、題 %j でも重ねない', (title) => {
  render(<TopBar {...props} title={title} crumbs={[{ label: 'ホーム', href: '/' }, { label: '一覧', href: '/items' }]} />)
  const nav = screen.getByRole('navigation', { name: 'パンくず' })
  expect(within(nav).getAllByText('ホーム')).toHaveLength(1)
  expect(within(nav).getAllByText('一覧')).toHaveLength(1)
  expect(within(nav).getByText(title || '一覧').closest('[aria-current]')?.getAttribute('aria-current')).toBe('page')
})

it('段を渡さない場合に選択アカウントをパンくずへ加えない', () => {
  render(<TopBar {...props} title="詳細" crumbs={null} />)
  const nav = screen.getByRole('navigation', { name: 'パンくず' })
  expect(within(nav).getAllByText('ホーム')).toHaveLength(1)
  expect(within(nav).queryByText('店舗名')).toBeNull()
  expect(within(nav).getByText('詳細')).toBeTruthy()
})

it('題が空でホームのみ渡された場合もホームを重ねない', () => {
  render(<TopBar {...props} title="" crumbs={[{ label: 'ホーム', href: '/' }]} />)
  const nav = screen.getByRole('navigation', { name: 'パンくず' })
  expect(within(nav).getAllByText('ホーム')).toHaveLength(1)
  expect(nav.querySelector('[aria-current="page"]')).toBeNull()
})
