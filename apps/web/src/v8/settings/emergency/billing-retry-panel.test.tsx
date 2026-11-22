// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingRetryPanel } from './billing-retry-panel'
import { ApiError } from '@/lib/api'

const mock = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), retryBilling: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { auth: { session: mock.session } }, ApiError: class extends Error { constructor(public status: number, message: string, public code?: string) { super(message) } } }))
vi.mock('@/lib/api/helpers/security-monitor', () => ({ securityMonitorApi: mock }))
const alert = { id: 'alert-1', ruleKey: 'stripe_external_effect_review', summary: '決済操作の結果確認が必要', status: 'open', version: 3, lastDetectedAt: '2026-11-22T10:00:00Z' }
const reply = (items: unknown[]) => ({ success: true, data: { items, total: items.length, limit: 200 } })
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('決済通知の再処理', () => {
  it('運営の要確認だけを表示し、確認後に版を渡して再処理・再読込する', async () => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: true } })
    mock.list.mockResolvedValueOnce(reply([alert, { ...alert, id: 'other', ruleKey: 'login_failures' }])).mockResolvedValue(reply([]))
    mock.retryBilling.mockResolvedValue({ success: true, data: { status: 'retried' } })
    render(<BillingRetryPanel canManage sessionReady impersonating={false} />)
    fireEvent.click(await screen.findByRole('button', { name: '再処理する' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('再処理しますか？')).toBeTruthy()
    expect(within(dialog).getByText(/Stripe通知を再処理し/)).toBeTruthy()
    expect(mock.retryBilling).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '再処理する' }))
    await waitFor(() => expect(mock.retryBilling).toHaveBeenCalledWith('alert-1', 3))
    expect(await screen.findByText('要確認の通知はありません。')).toBeTruthy()
  })

  it.each([[false, false, '閲覧のみのため操作できません。'], [true, true, '代理ログイン中は操作できません。']] as const)('操作制限時は理由付きで押せない', async (canManage, impersonating, reason) => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: true } }); mock.list.mockResolvedValue(reply([alert]))
    render(<BillingRetryPanel canManage={canManage} sessionReady impersonating={impersonating} />)
    const button = await screen.findByRole('button', { name: '再処理する' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.pointerEnter(button, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain(reason)
    fireEvent.pointerLeave(button, { pointerType: 'mouse' })
    fireEvent.focus(button)
    expect((await screen.findByRole('tooltip')).textContent).toContain(reason)
    fireEvent.click(button)
    expect(mock.retryBilling).not.toHaveBeenCalled()
  })

  it('他の種類が200件あっても、次のページにある決済通知を表示する', async () => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: true } })
    const others = Array.from({ length: 200 }, (_, i) => ({ ...alert, id: `other-${i}`, ruleKey: 'login_failures' }))
    mock.list.mockResolvedValueOnce({ success: true, data: { items: others, total: 201, limit: 200 } })
      .mockResolvedValueOnce({ success: true, data: { items: [alert], total: 201, limit: 200 } })
    render(<BillingRetryPanel canManage sessionReady impersonating={false} />)
    expect(await screen.findByRole('button', { name: '再処理する' })).toBeTruthy()
    expect(mock.list).toHaveBeenNthCalledWith(2, undefined, 200)
  })

  it('失敗時は確認窓を開いたまま理由を表示する', async () => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: true } }); mock.list.mockResolvedValue(reply([alert])); mock.retryBilling.mockRejectedValue(new Error('failed'))
    render(<BillingRetryPanel canManage sessionReady impersonating={false} />)
    fireEvent.click(await screen.findByRole('button', { name: '再処理する' }))
    const dialog=screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '再処理する' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('再処理できませんでした')
  })

  it('別の人が処理中ならその理由を表示する', async () => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: true } }); mock.list.mockResolvedValue(reply([alert]))
    mock.retryBilling.mockRejectedValue(new ApiError(409, 'ほかの人が処理しています', 'BILLING_RETRY_BUSY'))
    render(<BillingRetryPanel canManage sessionReady impersonating={false} />)
    fireEvent.click(await screen.findByRole('button', { name: '再処理する' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '再処理する' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('ほかの人が処理しています')
  })

  it('運営権限がなければ一覧APIを呼ばない', async () => {
    mock.session.mockResolvedValue({ success: true, data: { platformAdmin: false } })
    render(<BillingRetryPanel canManage sessionReady impersonating={false} />)
    await waitFor(() => expect(mock.session).toHaveBeenCalled())
    expect(mock.list).not.toHaveBeenCalled()
  })
})
