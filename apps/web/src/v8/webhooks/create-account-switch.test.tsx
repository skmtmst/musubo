// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'
import { ApiError } from '@/lib/api'

const fixture = vi.hoisted(() => ({
  account: 'account-a',
  outgoingCreate: vi.fn(),
  outgoingUpdate: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.push, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account, accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({
  ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      webhooks: {
        ...actual.api.webhooks,
        outgoing: {
          ...actual.api.webhooks.outgoing,
          create: fixture.outgoingCreate,
          update: fixture.outgoingUpdate,
        },
      },
    },
  }
})

import WebhooksCreateV8 from './create'

beforeEach(() => {
  vi.resetAllMocks()
  fixture.account = 'account-a'
  verifiedStaffRole('owner')
  forgetSessionSnapshot()
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  forgetSessionSnapshot()
})

function fillForm() {
  fireEvent.change(screen.getByLabelText(/名前/), { target: { value: '外部CRM連携' } })
  fireEvent.change(screen.getByLabelText(/送り先の URL/), { target: { value: 'https://crm.example.com/hook' } })
  fireEvent.click(screen.getByRole('radio', { name: /すべて送る/ }))
}

describe('Webhook 送り先作成中のアカウント切替ガード', () => {
  it('作成通信中にアカウントを切り替えると保存中が解除され、古い作成完了で新しいアカウントから遷移しない', async () => {
    let resolveCreate!: (value: unknown) => void
    fixture.outgoingCreate.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve }))

    const { rerender } = render(<WebhooksCreateV8 />)
    fillForm()

    const submitButton = screen.getByRole('button', { name: 'つくって動かす' }) as HTMLButtonElement
    fireEvent.click(submitButton)
    await waitFor(() => expect(fixture.outgoingCreate).toHaveBeenCalledTimes(1))
    expect(submitButton.disabled).toBe(true)

    fixture.account = 'account-b'
    rerender(<WebhooksCreateV8 />)

    await waitFor(() => expect(submitButton.disabled).toBe(false))

    await act(async () => {
      resolveCreate({ success: true, data: { id: 'wh-old-account', isActive: true } })
    })

    expect(fixture.push).not.toHaveBeenCalled()
  })

  it('作成通信中にアカウントを切り替えたあとに古い本人確認やエラーが返っても、新しいアカウントへ出さない', async () => {
    let rejectCreate!: (reason: unknown) => void
    fixture.outgoingCreate.mockReturnValueOnce(new Promise((_, reject) => { rejectCreate = reject }))

    const { rerender } = render(<WebhooksCreateV8 />)
    fillForm()

    const submitButton = () => screen.getByRole('button', { name: 'つくって動かす' }) as HTMLButtonElement
    fireEvent.click(submitButton())
    await waitFor(() => expect(fixture.outgoingCreate).toHaveBeenCalledTimes(1))

    fixture.account = 'account-b'
    rerender(<WebhooksCreateV8 />)

    await act(async () => {
      rejectCreate(new ApiError(428, '本人確認が必要です', 'STEP_UP_REQUIRED'))
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/本人確認/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })
})
