// @vitest-environment happy-dom
/*
 * ：質問を作る。保存で足りない欄は、その欄が赤くなり真下に理由が出て、
 * 1つ目の欄へ移る。上の帯だけで終わらせない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const notifySaved = vi.hoisted(() => vi.fn())
vi.mock('@/components/shared/toast', async original => ({ ...await original<typeof import('@/components/shared/toast')>(), notifyToast: notifySaved }))
const navigationPush = vi.hoisted(() => vi.fn())
const templatesApi = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      templates: { ...api.templates, ...templatesApi },
      folders: { ...api.folders, list: async () => ({ success: true, data: [] }) },
      tags: { ...api.tags, list: async () => ({ success: true, data: [] }) },
      scenarios: { ...api.scenarios, list: async () => ({ success: true, data: [] }) },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigationPush, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('id=t1'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '然 - NEN -' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

import QuestionNewV8 from './question-new'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks() })
async function renderChoice(choice: Record<string, unknown>) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  const question = { text: '質問', tapMode: 'single', choices: [{ key: 'a', label: 'はい', ...choice }] }
  templatesApi.get.mockResolvedValue({ success: true, data: { id: 't1', name: '見本', accountId: 'account-a', publishedVersion: 1, draftRevision: 1, usedBy: {}, question } })
  await act(async () => { root.render(<QuestionNewV8 />) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

it('未知の動きを何もしないと誤表示しない', async () => {
  await renderChoice({ behavior: 'future-behavior' })
  expect(host.textContent).toContain('動きを確認できません')
  expect(host.textContent).not.toContain('何もしない')
})

it('未知のシナリオ操作を何もしないと誤表示しない', async () => {
  await renderChoice({ behavior: 'scenario', scenario: { op: 'future-operation' } })
  expect(host.textContent).toContain('動きを確認できません')
  expect(host.textContent).not.toContain('何もしない')
})

it('予約された名前の未知の動きを関数の文字列として表示しない', async () => {
  await renderChoice({ behavior: 'toString' })
  expect(host.textContent).toContain('動きを確認できません')
  expect(host.textContent).not.toContain('[native code]')
  expect(host.textContent).not.toContain('function toString')
})
