// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FriendAddLink } from './friend-add'

const fixture = vi.hoisted(() => ({
  replace: vi.fn(), account: 'account-a', search: '', renderedRoutes: [] as string[],
  routes: vi.fn(async () => ({ success: true, data: [{ id: 'route-a', name: '広告の経路', refCode: 'ad-a', isActive: true }] })),
}))
vi.mock('@/lib/api', () => ({ api: { entryRoutes: { list: fixture.routes } } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, selectedAccount: { channelId: fixture.account === 'account-a' ? 'channel-a' : 'channel-b' } }) }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(fixture.search) }))
vi.mock('@/lib/use-same-page-url', () => ({ useSamePageUrl: () => ({ replace: fixture.replace }) }))
vi.mock('@/components/dashboard/qr-dialog', () => ({ default: ({ open, initialRouteId, routes, routesPending, baseLink }: { open: boolean; initialRouteId: string; routes: { id: string }[]; routesPending: boolean; baseLink: string }) => { fixture.renderedRoutes.push(routes.map(r => r.id).join(',')); return open ? <div role="dialog" aria-label="QRの見本" data-route-id={initialRouteId} data-routes={routes.map(r => r.id).join(',')} data-pending={String(routesPending)} data-base={baseLink} /> : null } }))
afterEach(() => { cleanup(); vi.clearAllMocks(); fixture.account = 'account-a'; fixture.search = ''; fixture.renderedRoutes = [] })

it('経路は確定してからURLへ反映し、基本URLへ戻すとQRも基本のまま開く', async () => {
  render(<FriendAddLink officialProfileUrl={null} visualQa={{ friendAddUrl: 'https://example.test/auth/line?account=channel-a' }} canManage />)
  const url = screen.getByRole('textbox', { name: '友だち追加リンク' }) as HTMLInputElement
  expect(url.value).toBe('https://example.test/auth/line?account=channel-a')
  expect(fixture.routes).toHaveBeenCalledWith('account-a')
  const open = () => fireEvent.click(screen.getByRole('button', { name: '発行中の追加URL' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '発行中の追加URL' }) as HTMLButtonElement).disabled).toBe(false))
  const selectedName = () => screen.getByLabelText(/選択中の発行中の追加URL/).textContent
  expect(selectedName()).toBe('基本の追加URL')
  open()
  let dialog = await screen.findByRole('dialog', { name: '発行中の追加URLを選ぶ' })
  expect((within(dialog).getByRole('radio', { name: '基本の追加URL' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(within(dialog).getByRole('radio', { name: '広告の経路' }))
  expect(url.value).toContain('/auth/line?account=channel-a')
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  expect(url.value).toContain('/auth/line?account=channel-a')
  open()
  dialog = await screen.findByRole('dialog', { name: '発行中の追加URLを選ぶ' })
  fireEvent.click(within(dialog).getByRole('radio', { name: '広告の経路' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(url.value).toMatch(/\/r\/ad-a$/)
  expect(selectedName()).toBe('広告の経路')
  open()
  dialog = await screen.findByRole('dialog', { name: '発行中の追加URLを選ぶ' })
  fireEvent.click(within(dialog).getByRole('radio', { name: '基本の追加URL' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
  expect(url.value).toBe('https://example.test/auth/line?account=channel-a')
  expect(selectedName()).toBe('基本の追加URL')
  fireEvent.click(screen.getByRole('button', { name: 'QRを表示' }))
  expect(fixture.replace).toHaveBeenCalledWith('/?qr=base')
  expect(screen.getByRole('dialog', { name: 'QRの見本' }).getAttribute('data-route-id')).toBe('')
})

it('カードが無いホームでも同じQRを表示し、別アカウントの経路を残さない', async () => {
  fixture.search = 'qr=base'
  const view = render(<FriendAddLink dialogOnly officialProfileUrl={undefined} canManage={false} />)
  expect(screen.queryByRole('textbox')).toBeNull()
  await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-routes')).toBe('route-a'))
  fixture.routes.mockImplementationOnce(() => new Promise(() => {}))
  fixture.renderedRoutes = []
  fixture.account = 'account-b'
  view.rerender(<FriendAddLink dialogOnly officialProfileUrl={undefined} canManage={false} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('data-routes')).toBe('')
  expect(dialog.getAttribute('data-pending')).toBe('true')
  expect(dialog.getAttribute('data-base')).toContain('account=channel-b')
  expect(fixture.routes).toHaveBeenLastCalledWith('account-b')
  expect(fixture.renderedRoutes).not.toContain('route-a')
})
