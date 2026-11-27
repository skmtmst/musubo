// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PoolNewPage from './page'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('プール作成時のアカウント取得', () => {
  it.each(['failure', 'throw'] as const)('%s の後、再読込で選択候補が表示される', async (mode) => {
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      count += 1
      if (count === 1 && mode === 'throw') throw new TypeError('offline')
      if (count === 1) return new Response(JSON.stringify({ success: false, error: 'private' }), { status: 200 })
      return new Response(JSON.stringify({ success: true, data: [{ id: 'a1', name: '本店', isActive: true }] }), { status: 200 })
    }))
    render(<PoolNewPage />)
    await waitFor(() => expect(screen.getByText(/LINEアカウントを読み込めませんでした/)).toBeTruthy())
    expect(screen.queryByText('本店')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.getAllByText(/本店/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/LINEアカウントを読み込めませんでした/)).toBeNull()
    expect(count).toBe(2)
  })
})
