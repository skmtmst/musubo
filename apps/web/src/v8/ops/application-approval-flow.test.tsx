// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { OpsApplication } from '@/lib/api'

const state = vi.hoisted(() => ({
  get: vi.fn(), contact: vi.fn(), approve: vi.fn(), resendInvite: vi.fn(),
  access: 'writer' as 'unknown' | 'readonly' | 'writer',
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => new URLSearchParams('id=application-1'),
}))
vi.mock('./use-ops-read-only', async (importOriginal) => ({ ...(await importOriginal<typeof import('./use-ops-read-only')>()), useOpsReadOnlyState: () => state.access }))
vi.mock('@/lib/api', () => ({ api: {
  ops: { applications: state },
  pricingConditions: { list: () => Promise.resolve({ success: true, data: [{
    id: 'normal', conditionKey: 'normal', internalName: '通常条件', status: 'active',
    trialPeriod: { unit: 'days', value: 30 }, lineBasicDiscountPercent: 0,
  }] }) },
} }))

import OpsApplicationDetail from './application-detail'

const initial = {
  id: 'application-1', company_name: '申込会社', contact_name: '担当者',
  email: 'applicant@example.com', phone: '03-0000-5678', referral_source: 'SNS',
  status: 'pending', contact_note: null, contacted_at: null, approved_at: null,
  invite_sent_at: null, tenant_id: null, created_at: '2026-10-29T01:40:00.000Z',
} as OpsApplication

afterEach(() => { cleanup(); vi.clearAllMocks(); state.access = 'writer' })

describe('申込詳細の連絡から承認まで', () => {
  it('連絡内容を保存した後だけ承認確認を開き、確定すると招待結果を表示する', async () => {
    state.get.mockResolvedValue({ success: true, data: initial })
    state.contact.mockResolvedValue({ success: true, data: { ...initial, status: 'contacted', contact_note: '電話で内容を確認', contacted_at: '2026-10-29T02:30:00.000Z' } })
    state.approve.mockResolvedValue({ success: true, data: { mailSent: true, application: { ...initial, status: 'approved', contact_note: '電話で内容を確認', contacted_at: '2026-10-29T02:30:00.000Z', approved_at: '2026-10-29T02:31:00.000Z' } } })
    render(<OpsApplicationDetail />)
    const approve = await screen.findByRole('button', { name: '承認して招待メールを送る' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    const save = screen.getByRole('button', { name: '連絡済みとして保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '担当者からの連絡メモ' }), { target: { value: '電話で内容を確認' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(state.contact).toHaveBeenCalledWith('application-1', '電話で内容を確認'))
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(approve)
    expect(screen.getByRole('dialog', { name: 'この申込を承認しますか？' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '承認して招待を送る' }))
    await waitFor(() => expect(state.approve).toHaveBeenCalledWith('application-1', 'normal'))
    expect(await screen.findByText('承認し、招待メールを送りました')).not.toBeNull()
  })

  it('閲覧のみは保存も承認も押せない形＋理由で出し、処理も止める', async () => {
    state.access = 'readonly'
    state.get.mockResolvedValue({ success: true, data: initial })
    render(<OpsApplicationDetail />)
    const save = await screen.findByRole('button', { name: '連絡済みとして保存' })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(save.getAttribute('aria-describedby') ?? '')?.textContent).toContain('閲覧のみ')
    const approve = screen.getByRole('button', { name: '承認して招待メールを送る' })
    expect(approve.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(approve.getAttribute('aria-describedby') ?? '')?.textContent).toContain('閲覧のみ')
    fireEvent.click(save)
    fireEvent.click(approve)
    expect(state.contact).not.toHaveBeenCalled()
    expect(state.approve).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'この申込を承認しますか？' })).toBeNull()
  })

  it('ページ内の戻るリンクは出さない（戻るはパンくずだけ）', async () => {
    state.get.mockResolvedValue({ success: true, data: initial })
    render(<OpsApplicationDetail />)
    await screen.findByRole('button', { name: '連絡済みとして保存' })
    expect(screen.queryByRole('link', { name: /申込アカウントに戻る/ })).toBeNull()
  })

  it('保存中は「保存しています…」と出す', async () => {
    state.get.mockResolvedValue({ success: true, data: initial })
    let done: (value: unknown) => void = () => {}
    state.contact.mockReturnValue(new Promise((resolve) => { done = resolve }))
    render(<OpsApplicationDetail />)
    const save = await screen.findByRole('button', { name: '連絡済みとして保存' })
    fireEvent.change(screen.getByRole('textbox', { name: '担当者からの連絡メモ' }), { target: { value: '電話で内容を確認' } })
    fireEvent.click(save)
    expect(await screen.findByText('保存しています…')).not.toBeNull()
    done({ success: true, data: { ...initial, status: 'contacted', contact_note: '電話で内容を確認', contacted_at: '2026-10-29T02:30:00.000Z' } })
    await waitFor(() => expect(state.contact).toHaveBeenCalledWith('application-1', '電話で内容を確認'))
  })
})
