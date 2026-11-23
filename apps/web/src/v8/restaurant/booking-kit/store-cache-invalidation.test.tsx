// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as readCache from '@/lib/api/transport/read-cache'
import RestaurantShell from './shell'
import RestaurantFrame from '../common-a/frame'
import { snapshotOf, store } from './test-data'

const fx = vi.hoisted(() => ({ snapshot: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { snapshot: fx.snapshot } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shared/entity-select', () => ({ entityOptionMetadata: () => ({}), default: ({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) => <select aria-label="店舗" value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))

beforeEach(() => { fx.snapshot.mockResolvedValue({ data: snapshotOf({ stores: [store, { ...store, id: 'store-2', name: '新宿店' }] }) }) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['shell', 'frame'] as const)('%s の店舗切替で共有データを即座に破棄する', async kind => {
  const clear = vi.spyOn(readCache, 'clearApiReadCache')
  if (kind === 'shell') render(<RestaurantShell boardId="test" title="店舗" description="説明" boundary={false}>{() => null}</RestaurantShell>)
  else render(<RestaurantFrame boardId="test" title="店舗" description="説明" banner={false}>{() => null}</RestaurantFrame>)
  const selector = await screen.findByRole('combobox', { name: '店舗' })
  await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('store-1'))
  clear.mockClear()
  fireEvent.change(selector, { target: { value: 'store-2' } })
  expect(clear).toHaveBeenCalledTimes(1)
  expect((selector as HTMLSelectElement).value).toBe('store-2')
})
