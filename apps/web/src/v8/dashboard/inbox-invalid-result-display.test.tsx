// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }))

const fetchApi = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), fetchApi, ApiError: class extends Error { status = 0 } }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<object>()), useStaffIdentity: () => ({ id: 'staff-1' }) }))
vi.mock('@/components/shared/list-url-state', async (importOriginal) => ({ ...(await importOriginal<object>()), useListUrlValue: (_: string, fallback: number) => [fallback, vi.fn()], useListUrlParam: () => [''] }))
vi.mock('@/components/shared/pagination', () => ({ default: () => <nav aria-label="受信一覧のページ送り" /> }))
vi.mock('@/components/shared/list-navigation', async (importOriginal) => ({ ...(await importOriginal<object>()), default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

import { InboxSection, isEmojiOnly } from './inbox'

afterEach(() => { cleanup(); fetchApi.mockReset() })

const item = (id: string, preview: string) => ({ id, channel: 'line' as const, customerName: `友だち${id}`, preview, lastIncomingAt: '2026-10-20T00:00:00Z', friendId: id })

it('不正な受信一覧は空一覧と見せず、読み直せる', async () => {
  const changed = vi.fn()
  fetchApi.mockResolvedValueOnce({ success: true, data: { items: null, summary: { total: 1 } } })
    .mockResolvedValue({ success: true, data: { items: [], summary: { total: 0 } } })
  render(<InboxSection onSummaryChange={changed} />)
  expect(await screen.findByText(/データを読み込めませんでした/)).toBeTruthy()
  expect(screen.queryByText('返信を待っている問い合わせはありません。')).toBeNull()
  expect(changed).toHaveBeenCalledWith(null, false)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('返信を待っている問い合わせはありません。')).toBeTruthy()
})
