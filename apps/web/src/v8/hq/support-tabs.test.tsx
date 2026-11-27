// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqSupportV8 from './support'

const source = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/hq/support' }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('./settings-nav', () => ({ default: () => null, useHqSettingsFolderNav: () => undefined }))
vi.mock('./notice-line-dialog', () => ({ default: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, hqSupport: {
    list: source.list, create: source.create,
    context: async () => ({ success: true, data: { kinds: [{ key: 'usage', label: '使い方' }], accounts: [] } }),
  } } }
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('履歴があれば先に表示し、最新の返事を出し、タブ間で書きかけを保つ', async () => {
  source.list.mockResolvedValue({ success: true, data: [{ id: 'r1', kind: 'usage', kindLabel: '使い方', subject: '予約の設定', status: 'answered', createdAt: '2026-10-25T01:00:00Z', replies: [
    { id: 'new', body: '新しい返事', createdAt: '2026-10-26T01:00:00Z', authorName: '運営' },
    { id: 'old', body: '前の返事', createdAt: '2026-10-25T02:00:00Z', authorName: '運営' },
  ] }] })
  render(<HqSupportV8 />)
  expect(await screen.findByText('最新の返事：新しい返事')).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'これまでの問い合わせ' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: '問い合わせを送る' }))
  fireEvent.change(screen.getByLabelText('件名'), { target: { value: '書きかけ' } })
  fireEvent.click(screen.getByRole('tab', { name: 'これまでの問い合わせ' }))
  expect(screen.queryByRole('textbox', { name: '件名' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '問い合わせを送る' }))
  expect(screen.getByDisplayValue('書きかけ')).toBeTruthy()
  expect(source.create).not.toHaveBeenCalled()
})

it('履歴が空なら送信タブ、取得失敗なら履歴の再読込を出す', async () => {
  source.list.mockResolvedValueOnce({ success: true, data: [] })
  const view = render(<HqSupportV8 />)
  await waitFor(() => expect(screen.getByRole('tab', { name: '問い合わせを送る' }).getAttribute('aria-selected')).toBe('true'))
  view.unmount()
  source.list.mockRejectedValueOnce(new Error('network failed'))
  render(<HqSupportV8 />)
  expect(await screen.findByText('履歴を読み込めませんでした。')).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'これまでの問い合わせ' }).getAttribute('aria-selected')).toBe('true')
})

it('取得失敗からの再読込中も履歴タブで待ち、送信へ移らない', async () => {
  let complete!: (value: { success: true; data: [] }) => void
  source.list.mockRejectedValueOnce(new Error('network failed'))
    .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  render(<HqSupportV8 />)
  expect(await screen.findByText('履歴を読み込めませんでした。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(screen.getByRole('tab', { name: 'これまでの問い合わせ' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('読み込んでいます…').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
  expect(screen.queryByRole('textbox', { name: '件名' })).toBeNull()
  complete({ success: true, data: [] })
  await waitFor(() => expect(screen.getByRole('tab', { name: '問い合わせを送る' }).getAttribute('aria-selected')).toBe('true'))
  expect(source.create).not.toHaveBeenCalled()
})

it.each(['constructor', 'toString', '__proto__', 'future'])('未知の問い合わせ状態 %s は解決と決めずに表示する', async status => {
  source.list.mockResolvedValue({ success: true, data: [{ id: 'r1', kind: 'usage', kindLabel: '使い方', subject: '予約の設定', status, createdAt: '2026-10-25T01:00:00Z', replies: [] }] })
  render(<HqSupportV8 />)
  expect(await screen.findByText('状態を確認できません')).toBeTruthy()
  expect(screen.queryByText('解決済み')).toBeNull()
})
