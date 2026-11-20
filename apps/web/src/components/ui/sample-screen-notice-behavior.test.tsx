// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SampleScreenNotice from './sample-screen-notice'
import V8PartsPage from '@/app/visual-qa/v8-parts/page'
import { HQ_MENU_SECTIONS, MENU_SECTIONS } from '@/lib/menu'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
afterEach(cleanup)

it('見本の帯は固定データの説明と通常画面への戻り口を出す', () => {
  render(<SampleScreenNotice what="表示" backHref="/settings" backLabel="設定へ戻る" />)
  const notice = screen.getByRole('note')
  expect(notice.hasAttribute('data-sample-screen')).toBe(true)
  expect(notice.textContent).toContain('表示の見本です')
  expect(notice.textContent).toContain('固定の例データを表示しています')
  expect(within(notice).getByRole('link', { name: '設定へ戻る' }).getAttribute('href')).toBe('/settings')
})

it('部品の比較画面は見本の帯と設定への戻り口を表示する', () => {
  render(<V8PartsPage />)
  const notice = screen.getByRole('note')
  expect(notice.hasAttribute('data-sample-screen')).toBe(true)
  expect(notice.textContent).toContain('V8 で新たに生えた部品の見本です')
  expect(within(notice).getByRole('link', { name: '設定へ戻る' }).getAttribute('href')).toBe('/settings')
})

it('通常メニューに比較画面を載せない', () => {
  const links = [...MENU_SECTIONS, ...HQ_MENU_SECTIONS].flatMap(section => section.items.map(item => item.href))
  expect(links).not.toContain('/tags-v3')
  expect(links.some(href => href.startsWith('/visual-qa'))).toBe(false)
})
