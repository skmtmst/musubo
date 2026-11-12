// @vitest-environment happy-dom
/*
 * D006: 必須の名前・送り先URLが空のまま保存を押しても、画面側で止めて
 * POSTを送らない（/webinars/new と同じ振る舞い）。欄に理由を出す。
 * D005: 保存が405で失敗しても `API error: 405` の生文面を出さず、
 * 運用者向けの立て直し文を出す（共有CreatePage経由の結合確認）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  outgoingCreate: vi.fn(),
  staffMe: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.push }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      staff: { me: fixture.staffMe },
      webhooks: { outgoing: { create: fixture.outgoingCreate } },
    },
  }
})

import NewWebhookPage from './page'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.push.mockClear()
  fixture.outgoingCreate.mockReset()
  fixture.staffMe.mockReset()
  fixture.staffMe.mockResolvedValue({ success: true, data: { role: 'owner' } })
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

async function render() {
  await act(async () => { root.render(<NewWebhookPage />) })
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

function saveButton(): HTMLButtonElement {
  const buttons = Array.from(host.querySelectorAll('button'))
  const button = buttons.find((b) => b.textContent?.trim() === 'つくって動かす')
  if (!button) throw new Error('保存ボタンが見つかりません')
  return button as HTMLButtonElement
}

describe('webhooks/new の保存前検証（D006）', () => {
  it('名前が空のまま保存を押してもPOSTを送らず、理由を出す', async () => {
    await render()
    await flush()

    await act(async () => { (host.querySelector('input[value="all"]') as HTMLInputElement).click(); saveButton().click() })
    await flush()

    expect(fixture.outgoingCreate).not.toHaveBeenCalled()
    expect(host.textContent).toContain('名前を入力してください')
  })

  it('名前だけ入れてURLが空でもPOSTを送らない', async () => {
    await render()
    await flush()

    await act(async () => {
      fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '外部CRM連携' } })
    })
    await act(async () => { (host.querySelector('input[value="all"]') as HTMLInputElement).click(); saveButton().click() })
    await flush()

    expect(fixture.outgoingCreate).not.toHaveBeenCalled()
  })

  it('https以外ではPOSTを送らず、httpsの書き方を案内する', async () => {
    await render()
    await flush()

    await act(async () => {
      fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '外部CRM連携' } })
      fireEvent.change(host.querySelector('#wh-new-url')!, { target: { value: 'http://insecure.example.com/hook' } })
    })
    await act(async () => { (host.querySelector('input[value="all"]') as HTMLInputElement).click(); saveButton().click() })
    await flush()

    expect(fixture.outgoingCreate).not.toHaveBeenCalled()
    expect(host.textContent).toContain('URLは https:// で始めてください')
  })

  it('全部入れたらPOSTを1回だけ送る', async () => {
    fixture.outgoingCreate.mockResolvedValue({ success: true, data: { id: 'wh-out-new-1' } })
    await render()
    await flush()

    await act(async () => {
      fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '外部CRM連携' } })
      fireEvent.change(host.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/hook' } })
    })
    await act(async () => { (host.querySelector('input[value="all"]') as HTMLInputElement).click(); saveButton().click() })
    await flush()

    expect(fixture.outgoingCreate).toHaveBeenCalledTimes(1)
    expect(fixture.push).toHaveBeenCalledWith('/webhooks?highlight=wh-out-new-1')
  })
})

describe('webhooks/new の保存失敗文（D005・結合）', () => {
  it('405で失敗しても生文面を出さず、立て直し文を出す', async () => {
    const { ApiError } = await import('@/lib/api')
    fixture.outgoingCreate.mockRejectedValue(new ApiError(405, 'API error: 405'))
    await render()
    await flush()

    await act(async () => {
      fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '外部CRM連携' } })
      fireEvent.change(host.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/hook' } })
    })
    await act(async () => { (host.querySelector('input[value="all"]') as HTMLInputElement).click(); saveButton().click() })
    await flush()

    expect(host.textContent).not.toContain('API error')
    expect(host.textContent).toContain('もう一度お試しください')
  })
})

for (const role of [null, 'staff', 'viewer']) it(`作成に必要なowner権限${role}の確認なしでは操作と送信を出さない`, async () => {
  if (role === null) fixture.staffMe.mockImplementation(() => new Promise(() => {}))
  else fixture.staffMe.mockResolvedValue({ success: true, data: { role } })
  await render(); await flush()
  expect(host.querySelector('#wh-new-name')).toBeNull()
  expect(host.querySelector('a[href="/webhooks"]')).toBeTruthy()
  expect(host.textContent).not.toContain('つくって動かす')
  expect(fixture.outgoingCreate).not.toHaveBeenCalled()
})

it('管理者は通常の送り先を明示操作で1回だけ作る', async () => {
  fixture.staffMe.mockResolvedValue({ success: true, data: { role: 'admin' } })
  fixture.outgoingCreate.mockResolvedValue({ success: true, data: { id: 'wh-admin-1' } })
  await render(); await flush()
  expect(host.querySelector('#wh-new-name')).toBeTruthy()
  expect(fixture.outgoingCreate).not.toHaveBeenCalled()
  const secret = (host.querySelector('#wh-new-secret') as HTMLInputElement).value
  expect(secret.length).toBeGreaterThan(0)
  await act(async () => {
    fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '管理者の連携' } })
    fireEvent.change(host.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/admin-hook' } })
    ;(host.querySelector('input[value="all"]') as HTMLInputElement).click()
  })
  expect(fixture.outgoingCreate).not.toHaveBeenCalled()
  await act(async () => { saveButton().click() }); await flush()
  expect(fixture.outgoingCreate.mock.calls).toEqual([[{
    lineAccountId: 'account-a', name: '管理者の連携', url: 'https://example.com/admin-hook',
    eventTypes: ['*'], secret, maxRetries: 3, isActive: true,
  }, undefined]])
  expect(fixture.push).toHaveBeenCalledTimes(1)
  expect(fixture.push).toHaveBeenCalledWith('/webhooks?highlight=wh-admin-1')
})
