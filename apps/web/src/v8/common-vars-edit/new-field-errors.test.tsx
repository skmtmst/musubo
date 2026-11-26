// @vitest-environment happy-dom
/*
 * ：共通情報を作る。登録で落ちた欄は、下の帯ではなくその欄が赤くなり
 * 真下に理由が出て、1つ目の欄へ移る。名前・差し込み名・期間を一度に出す。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const create = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: { ...actual.api.commonVars, create },
      folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    },
  }
})
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

import NewCommonVarV8 from './new'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { document.documentElement.setAttribute('data-theme', 'v8'); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); create.mockReset() })
afterEach(() => { act(() => root.unmount()); host.remove(); clearToastsForTest(); document.documentElement.removeAttribute('data-theme') })

it('名前と差し込み名が空のまま保存して公開すると、口を呼ばず2つの欄が赤くなり、下の帯は出さず名前の欄へ移る', async () => {
  await act(async () => { root.render(<NewCommonVarV8 />) })
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
  const value = document.getElementById('cv-value') as HTMLInputElement
  expect(value.closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
  fireEvent.change(value, { target: { value: '営業時間 10〜19時' } })
  const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存して公開') as HTMLButtonElement
  await act(async () => { submit.click() })
  await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
  expect(create).not.toHaveBeenCalled()
  const name = document.getElementById('cv-name') as HTMLInputElement
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById('cv-key')?.getAttribute('aria-invalid')).toBe('true')
  expect(host.textContent).toContain('共通情報名を入力してください')
  expect(host.textContent).toContain('差し込み名を入力してください')
  expect(host.querySelector('[class*="formError"]')).toBeNull()
  expect(document.activeElement).toBe(name)
})


it('共通情報を作成できたら完了を知らせる', async () => {
  create.mockResolvedValueOnce({ success: true, data: { id: 'sample' } })
  await act(async () => { root.render(<><NewCommonVarV8 /><ToastHost /></>) })
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
  fireEvent.change(document.getElementById('cv-name')!, { target: { value: '営業時間' } })
  fireEvent.change(document.getElementById('cv-key')!, { target: { value: 'shop_hours' } })
  fireEvent.change(document.getElementById('cv-value')!, { target: { value: '10時から19時' } })
  const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存して公開') as HTMLButtonElement
  await act(async () => { submit.click() })
  expect(create).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('共通情報を作成しました。')
})

it('共通情報の保存が失敗したら完了を知らせない', async () => {
  create.mockResolvedValueOnce({ success: false, error: '保存できませんでした' })
  await act(async () => { root.render(<><NewCommonVarV8 /><ToastHost /></>) })
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve() })
  fireEvent.change(document.getElementById('cv-name')!, { target: { value: '営業時間' } })
  fireEvent.change(document.getElementById('cv-key')!, { target: { value: 'shop_hours' } })
  fireEvent.change(document.getElementById('cv-value')!, { target: { value: '10時から19時' } })
  const submit = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存して公開') as HTMLButtonElement
  await act(async () => { submit.click() })
  expect(create).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('保存できませんでした')
  expect(document.body.textContent).not.toContain('共通情報を作成しました。')
})
