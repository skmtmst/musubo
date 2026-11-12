// @vitest-environment happy-dom
/*
 * 監査 WEB192：つなぎ先の設定で、B に切り替えたあとに A の遅い応答が届いても、
 * A の設定を B の欄へ入れない。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ pending: new Map<string, (v: unknown) => void>(), save: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/settings',
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ...actual.api, ecCommerce: { ...actual.api.ecCommerce, updateConnector: fx.save, connector: (accountId: string) => new Promise((resolve) => { fx.pending.set(accountId, resolve) }) } } }
})
import EcConnector from './connector'
afterEach(cleanup)

const overview = (domain: string) => ({
  success: true,
  data: {
    configured: true,
    health: { status: 'ok' },
    connector: { provider: 'shopify', shopDomain: domain, status: 'connected', secretConfigured: true, eventTypes: [], identityRules: [], version: 1 },
  },
})

it('B に切り替えたあとに A の応答が届いても、B のつなぎ先のまま', async () => {
  const view = render(<EcConnector accountId="acc-a" />)
  view.rerender(<EcConnector accountId="acc-b" />)
  await act(async () => { fx.pending.get('acc-b')?.(overview('b-shop.myshopify.com')) })
  await act(async () => { fx.pending.get('acc-a')?.(overview('a-shop.myshopify.com')) })
  const input = document.querySelector('#ec-connector-domain') as HTMLInputElement | null
  expect(input?.value).toBe('b-shop.myshopify.com')
})

it('止める確認を開いた後にアカウントを切り替えても、古い確認で保存しない', async () => {
  fx.save.mockClear()
  const view = render(<EcConnector accountId="acc-a" />)
  await act(async () => { fx.pending.get('acc-a')?.(overview('a-shop.myshopify.com')) })
  const input = document.querySelector('#ec-connector-domain') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'changed.myshopify.com' } })
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  const dialog = screen.getByRole('alertdialog')
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: '止めて保存する' }).querySelector('.lucide-trash-2')).toBeNull()
  view.rerender(<EcConnector accountId="acc-b" />)
  await act(async () => { fx.pending.get('acc-b')?.(overview('b-shop.myshopify.com')) })
  fireEvent.change(document.querySelector('#ec-connector-domain') as HTMLInputElement, { target: { value: 'changed-b.myshopify.com' } })
  const old = screen.queryByRole('alertdialog')
  if (old) fireEvent.click(within(old).getByRole('button', { name: '止めて保存する' }))
  expect(fx.save).not.toHaveBeenCalled()
  view.rerender(<EcConnector accountId="acc-a" />)
  await act(async () => { fx.pending.get('acc-a')?.(overview('a-shop.myshopify.com')) })
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('確認したアカウントと版で設定を保存する', async () => {
  fx.save.mockReset().mockResolvedValue({ success: true, data: { version: 2 } })
  render(<EcConnector accountId="acc-a" />)
  await act(async () => { fx.pending.get('acc-a')?.(overview('a-shop.myshopify.com')) })
  fireEvent.change(document.querySelector('#ec-connector-domain') as HTMLInputElement, { target: { value: 'changed.myshopify.com' } })
  fireEvent.click(screen.getByRole('button', { name: '設定を保存する' }))
  const dialog = screen.getByRole('alertdialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '止めて保存する' })) })
  expect(fx.save).toHaveBeenCalledExactlyOnceWith('acc-a', expect.objectContaining({ expectedVersion: 1, shopDomain: 'changed.myshopify.com' }))
})
