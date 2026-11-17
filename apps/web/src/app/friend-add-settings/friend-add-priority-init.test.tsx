import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * 全ルート監査 A3（2026-09-25）: `?view=new` の優先順位の初期値が
 * 1000000 になっていた。いちばん最後に動く受け皿（優先順位 999999）を
 * 含めて最大+1していたため。通常設定の最後の次の番号にし、
 * 「1000000番目」の表示も出さない。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight component mocks for interaction coverage */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), conflicts: vi.fn(), createDraft: vi.fn(async () => ({ success: true, data: { id: 'new-rule', version: 1 } })) }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/friend-add-settings/new', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('step=basic'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/components/shared/condition-builder', () => ({ default: () => null }))
vi.mock('@/components/shared/dialog', async (importOriginal) => ({ ...await importOriginal<typeof import('@/components/shared/dialog')>(), default: () => null }))
vi.mock('@/components/shared/icon-button', () => ({ default: () => null }))
vi.mock('@/components/shared/list-state', () => ({ default: ({ title }: { title: string }) => <div>{title}</div> }))
vi.mock('@/components/shared/select', () => ({ default: () => null }))
vi.mock('@/components/shared/text-field', () => ({
  TextField: (props: any) => <input {...props} />,
  TextArea: (props: any) => <textarea {...props} />,
}))
vi.mock('@/components/shared/button', () => ({
  default: ({ href, children, ...props }: any) => (href ? <a href={href}>{children}</a> : <button {...props}>{children}</button>),
}))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { friendAddRules: { list: (...a: unknown[]) => api.list(...a), conflicts: (...a: unknown[]) => api.conflicts(...a), createDraft: api.createDraft } } }))

const { default: Editor } = await import('@/v8/friend-add/editor')

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
})

const options = { routes: [], scenarios: [], tags: [], folders: [] }

describe('friend-add 新規の優先順位の初期値', () => {
  it('受け皿を除いた最後の次の番号になり「○番目」を出さない', async () => {
    api.list.mockResolvedValue({
      success: true,
      data: {
        items: [
          { id: 'rule-shop', priority: 7, isFallback: false },
          { id: 'rule-fallback', priority: 999999, isFallback: true },
        ],
        options,
      },
    })
    api.conflicts.mockResolvedValue({
      success: true,
      data: {
        rules: [
          { id: 'rule-shop', priority: 7 },
          { id: 'rule-instagram', priority: 12 },
          { id: 'rule-fallback', priority: 999999 },
        ],
        conflicts: [],
      },
    })
    await act(async () => {
      root.render(<Editor />)
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
    })
    const name = host.querySelector<HTMLInputElement>('#fa-name')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '新しい案内')
      name.dispatchEvent(new Event('input', { bubbles: true }))
      name.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('下書きを保存')) ?? querySupplementaryPageAction('下書きを保存'))!
    await act(async () => { save.click(); await Promise.resolve() })
    expect(api.conflicts).toHaveBeenCalledWith('account-a', 'first_time')
    expect(api.createDraft).toHaveBeenCalledWith(expect.objectContaining({ priority: 13 }), expect.any(String))
    expect(host.textContent).not.toContain('番目')
  })
})
