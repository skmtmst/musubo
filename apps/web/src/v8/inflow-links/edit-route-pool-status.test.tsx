// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import EditRouteModal from './edit-route-dialog'

const fixture = vi.hoisted(() => ({ listAccounts: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const real = await original<typeof import('@/lib/api')>()
  return { ...real, api: { ...real.api, pools: { ...real.api.pools, listAccounts: fixture.listAccounts } } }
})
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('所属の取得失敗を未所属と区別して表示する', async () => {
  fixture.listAccounts.mockRejectedValue(new Error('offline'))
  render(<EditRouteModal surface="inline" route={null} pools={[{ id: 'p1', name: '見本', slug: 'main' } as never]} scenarios={[]} templates={[]} tags={[]} existingGenres={[]} onClose={() => {}} onSaved={() => {}} />)
  expect(await screen.findByText(/所属を確認できませんでした/)).toBeTruthy()
  expect(screen.queryByText(/アカウント未所属/)).toBeNull()
})
