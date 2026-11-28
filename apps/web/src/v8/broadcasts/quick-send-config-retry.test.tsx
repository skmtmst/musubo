// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
  get: vi.fn(),
  request: vi.fn(),
  preflight: vi.fn(),
  config: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('@/components/shared/toast', () => ({ notifyToast: mocks.notify }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      tags: { list: async () => ({ success: true, data: [{ id: 'tag-a', name: '購入者' }] }) },
      broadcasts: {
        ...actual.api.broadcasts,
        ...mocks,
        approval: {
          config: mocks.config,
          request: mocks.request,
          candidates: async () => ({ success: true, data: [{ id: 'owner', name: '担当', role: 'owner' }] }),
        },
      },
    },
  }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}))
vi.mock('@/components/shared/select', () => ({
  default: ({ value, onChange, options, ...props }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; 'aria-label': string }) => (
    <select aria-label={props['aria-label']} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))
vi.mock('@/components/shared/date-time-field', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="送る日時" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}))

import QuickSend from './quick-send'

beforeEach(() => {
  forgetStaffIdentity()
  forgetSessionSnapshot()
  rememberStaffIdentity({ id: 'person', role: 'owner', permissionKeys: [] } as StaffMember)
  document.documentElement.dataset.theme = 'v8'
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  mocks.preflight.mockResolvedValue({
    success: true,
    data: { audienceCount: 12, hiddenExcluded: 0, quota: { remaining: 500 } },
  })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
})

describe('かんたんに送るの承認設定読み込み失敗時再読み込み', () => {
  it('入力中の本文を消さずに承認設定をその場で再読み込みし、送信可能へ復旧できる', async () => {
    mocks.config
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ success: true, data: { threshold: 1000, singleOperator: false, operatorCount: 2 } })

    render(<QuickSend open accountId="account-a" onClose={vi.fn()} onSent={vi.fn()} />)
    await act(async () => {})

    expect(screen.getByText('承認の設定を読み込めませんでした。開き直してください。')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '大事なご案内' } })
    fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
    fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
    await act(async () => {
      vi.advanceTimersByTime(501)
      await Promise.resolve()
    })

    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await act(async () => { await Promise.resolve() })

    expect(mocks.config).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('承認の設定を読み込めませんでした。開き直してください。')).toBeNull()
    expect((screen.getByLabelText('本文') as HTMLTextAreaElement).value).toBe('大事なご案内')
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
