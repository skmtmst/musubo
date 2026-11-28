// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/' }))
import CommandPalette from './command-palette'
beforeEach(() => { push.mockClear(); document.documentElement.dataset.theme = 'v8' })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })
it.each([{ isComposing: true }, { keyCode: 229 }])('WEB009: IME %j のEnterは検索窓から移動しない。変換後のEnterでは移動する', (ime) => {
  render(<CommandPalette items={[{ href: '/templates', label: 'テンプレート' }]} />)
  fireEvent.keyDown(document, { key: 'k', metaKey: true })
  const input = screen.getByRole('textbox', { name: '機能と友だちを探す' })
  fireEvent.change(input, { target: { value: 'テンプレ' } })
  fireEvent.keyDown(input, { key: 'Enter', ...ime })
  expect(push).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(push).toHaveBeenCalledExactlyOnceWith('/templates')
})
