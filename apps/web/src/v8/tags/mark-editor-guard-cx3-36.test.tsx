// @vitest-environment happy-dom
/*
 * 監査 WEB090：対応マークの編集で、初めの読み込みに失敗してやり直したら、
 * 入力欄に保存済みの名前を入れる（初期値「要確認」のまま保存させない）。
 */
import React from 'react'
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/tags/marks/edit',
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a> }))
const account = vi.hoisted(() => ({ id: 'acc' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, loading: false }) }))
const chrome = vi.hoisted(() => ({ title: vi.fn() }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: (...args: unknown[]) => chrome.title(...args), usePageCrumbs: () => undefined }))

const net = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), create: vi.fn(), rules: vi.fn(async () => ({ success: true, data: [] as unknown[] })), stopRule: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      supportMarks: {
        ...actual.api.supportMarks,
        list: (...args: unknown[]) => net.list(...args),
        update: (...args: unknown[]) => net.update(...args),
        create: (...args: unknown[]) => net.create(...args),
        automationRules: net.rules,
        archiveAutomationRule: net.stopRule,
      },
    },
  }
})

import MarkEditor from './mark-editor'
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
afterEach(cleanup)

test('一覧の応答が不正なら作成せず読み直せる', async () => {
  net.list.mockReset().mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValue({ success: true, data: [] })
  render(<MarkEditor />)
  await screen.findByText('対応マークを読み込めませんでした')
  expect(net.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('textbox', { name: 'マーク名' })).toBeTruthy()
})
test('作成の処理中に同じ押下が重なっても一度だけ送る', async () => {
  net.list.mockReset().mockResolvedValue({ success: true, data: [] })
  net.create.mockReset().mockReturnValue(new Promise(() => {}))
  render(<MarkEditor />)
  const input = await screen.findByRole('textbox', { name: 'マーク名' })
  fireEvent.change(input, { target: { value: '確認待ち' } })
  const button = screen.getByRole('button', { name: '対応マークを作る' })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const click = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  await act(async () => { click(); click() })
  expect(net.create).toHaveBeenCalledTimes(1)
})
test('作成が失敗した後は読み直さず再試行できる', async () => {
  net.list.mockReset().mockResolvedValue({ success: true, data: [] })
  net.create.mockReset().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(new Promise(() => {}))
  render(<MarkEditor />)
  const input = await screen.findByRole('textbox', { name: 'マーク名' })
  fireEvent.change(input, { target: { value: '確認待ち' } })
  fireEvent.click(screen.getByRole('button', { name: '対応マークを作る' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '対応マークを作る' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '対応マークを作る' }))
  expect(net.create).toHaveBeenCalledTimes(2)
})
