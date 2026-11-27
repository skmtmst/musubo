// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: {
  starterSet: async () => ({ success: true, data: { definition: { items: [{ key: 'booking', kind: 'booking_menu', name: '見本の予約' }, { key: 'notice', kind: 'automation', name: 'お知らせ' }] } } }),
  starterItems: async () => ({ success: true, data: { items: [{ key: 'booking', target_id: 'missing', kind: 'booking_menu', status: 'missing', activationAllowed: false }, { key: 'notice', target_id: 'notice', kind: 'automation', status: 'draft', activationAllowed: true }] } }),
} }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', accounts: [{ id: 'a', name: '見本' }], selectedAccount: { id: 'a', name: '見本' } }) }))
vi.mock('@/hooks/use-account-style', () => ({ accountStyleUpdated: vi.fn() }))
vi.mock('@/components/shared/list-navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/shared/list-navigation')>(),
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
  useListNavigationRouter: () => ({ push: vi.fn() }),
}))
const { default: StyleSetupWizard } = await import('./wizard')
afterEach(cleanup)
it('見つからない予約メニューを表示し、有効化の候補には含めず、他の項目は表示する', async () => {
  render(<StyleSetupWizard accountId="a" state={{ style: 'salon', styleSelected: true, styleMode: 'configured', version: 1, answers: {} }} initialStep="summary" onClose={() => {}} />)
  const inserted = await screen.findByRole('region', { name: '入った物' })
  const name = await within(inserted).findByText('見本の予約')
  const row = name.closest('li')!
  expect(within(row).getByText('見つかりません')).toBeTruthy()
  expect(screen.getByText('お知らせ')).toBeTruthy()
  expect(screen.queryByRole('switch', { name: '見本の予約を動かす' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'お知らせを動かす' })).toBeTruthy()
})
