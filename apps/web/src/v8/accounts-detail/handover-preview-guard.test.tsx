// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lineAccountsGet = vi.hoisted(() => vi.fn())
const lineAccountsList = vi.hoisted(() => vi.fn())
const staffMe = vi.hoisted(() => vi.fn())
const handoversListForAccount = vi.hoisted(() => vi.fn())
const handoversGet = vi.hoisted(() => vi.fn())
const handoversPreview = vi.hoisted(() => vi.fn())
const handoversSaveDecisions = vi.hoisted(() => vi.fn())
const handoversExecute = vi.hoisted(() => vi.fn())
const handoversCancel = vi.hoisted(() => vi.fn())
const handoversRollback = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: staffMe },
      lineAccounts: { ...actual.api.lineAccounts, get: lineAccountsGet, list: lineAccountsList },
      accountHandovers: {
        ...actual.api.accountHandovers,
        listForAccount: handoversListForAccount,
        get: handoversGet,
        preview: handoversPreview,
        saveDecisions: handoversSaveDecisions,
        execute: handoversExecute,
        cancel: handoversCancel,
        rollback: handoversRollback,
      },
    },
  }
})

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=acc-1'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}))

vi.mock('@/components/step-up-prompt', () => ({
  useStepUpGate: () => ({ gate: async () => 'token', prompt: null }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/lib/use-running-version', () => ({
  useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }),
}))

import HandoverV8 from './handover'

function handoverDetail(over: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    confirmationRevision: 4,
    status: 'previewed',
    code: 'ABC123',
    fromAccountId: 'acc-1',
    toAccountId: 'acc-2',
    providerMatch: 'same',
    counts: { sourceTotal: 14, auto: 10, review: 2, unmatched: 1, lookalike: 1 },
    decisions: [
      {
        id: 'd1',
        from_friend_id: 'f1',
        to_friend_id: 'f2',
        decision: 'link',
        bucket: 'review',
        note: null,
        sourceName: '見本 16',
        candidateName: '高橋 なおと',
        evidenceLabel: '電話番号が同じ',
      },
    ],
    unresolvedReviews: 1,
    declaredFriendTotal: null,
    rolledBackAt: null,
    rollbackDeadline: null,
    rollbackNote: null,
    linkedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)

  lineAccountsGet.mockResolvedValue({ success: true, data: { id: 'acc-1', name: '然-NEN-TEST' } })
  lineAccountsList.mockResolvedValue({ success: true, data: [{ id: 'acc-2', name: '然-NEN-本店' }] })
  staffMe.mockResolvedValue({ success: true, data: { role: 'owner' } })
  handoversListForAccount.mockResolvedValue({ success: true, data: [{ id: 'h1' }] })
  handoversGet.mockResolvedValue({ success: true, data: handoverDetail() })
  handoversPreview.mockResolvedValue({ success: true, data: {} })
  handoversCancel.mockResolvedValue({ success: true, data: {} })
  handoversRollback.mockResolvedValue({ success: true, data: { restoredCount: 1 } })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  document.body.innerHTML = ''
})

async function flush() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve()
  })
}

async function renderAndOpenDeclared() {
  await act(async () => {
    root.render(<HandoverV8 />)
  })
  await flush()
  const toggle = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('申告の数を入れる'))
  expect(toggle).toBeTruthy()
  await act(async () => {
    toggle!.click()
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('AccountHandoverV8 rerunPreview guards', () => {
  it('blocks negative or decimal declaredFriendTotal and shows an error without calling preview API', async () => {
    await renderAndOpenDeclared()
    const input = document.getElementById('acd-declared') as HTMLInputElement
    expect(input).toBeTruthy()

    await act(async () => {
      setInputValue(input, '-5')
    })
    const rerunButton = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('事前確認をやり直す'))
    expect(rerunButton).toBeTruthy()

    await act(async () => {
      rerunButton!.click()
    })
    await flush()

    expect(handoversPreview).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('申告の数は 0 以上の整数で入力してください。')
  })

  it('catches preview API rejection and shows a user-facing alert notice', async () => {
    handoversPreview.mockRejectedValueOnce(new Error('network down'))
    await renderAndOpenDeclared()
    const input = document.getElementById('acd-declared') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '14')
    })
    const rerunButton = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('事前確認をやり直す'))!

    await act(async () => {
      rerunButton.click()
    })
    await flush()

    expect(handoversPreview).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('事前確認をやり直せませんでした')
  })

  it('prevents duplicate preview calls when clicked twice while in flight', async () => {
    let resolvePreview!: (value: { success: true; data: Record<string, never> }) => void
    handoversPreview.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolvePreview = resolve
      }),
    )
    await renderAndOpenDeclared()
    const rerunButton = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('事前確認をやり直す'))!

    await act(async () => {
      rerunButton.click()
      rerunButton.click()
    })

    expect(handoversPreview).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvePreview({ success: true, data: {} })
    })
    await flush()
  })
})
