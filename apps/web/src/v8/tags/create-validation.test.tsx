// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const net = vi.hoisted(() => ({ create: vi.fn(), tags: vi.fn(), account: 'acc', role: 'admin' as string | null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/tags/new' }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.ComponentProps<'a'>) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: net.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => net.role, canManageRole: (role: string | null) => role === 'admin' || role === 'owner' }))
vi.mock('@/lib/use-unsaved-guard', () => ({ useUnsavedGuard: () => ({ disarm: vi.fn(), dialogOpen: false }) }))
vi.mock('@/lib/unsaved-leave-dialog', () => ({ UnsavedLeaveDialog: () => null }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, tags: { ...actual.api.tags, list: net.tags, createDefinition: net.create }, tagGroups: { ...actual.api.tagGroups, list: async () => ({ success: true, data: [] }) } } }
})
import TagCreate from './create'
beforeEach(() => { net.account = 'acc'; net.tags.mockReset().mockResolvedValue({ success: true, data: [] }) })
afterEach(() => { cleanup(); vi.clearAllMocks(); net.role = 'admin' })

test.each(['admin', 'viewer'])('役割%sでも題の説明を読み、閉じて入力を保てる', async role => {
  net.role = role
  render(<TagCreate />)
  const help = await screen.findByRole('button', { name: 'タグを作るの説明' })
  const name = screen.queryByLabelText('タグ名')
  if (name) fireEvent.change(name, { target: { value: '説明を読んでいる途中の入力' } })
  fireEvent.click(help)
  expect(document.getElementById(help.getAttribute('aria-describedby')!)?.textContent).toContain('友だちを分類するタグ')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(help.getAttribute('aria-expanded')).toBe('false')
  if (name) expect((name as HTMLInputElement).value).toBe('説明を読んでいる途中の入力')
  expect(net.create).not.toHaveBeenCalled()
})

test('未入力で保存すると名前欄に理由を一度だけ出し、そこへ移動して送信を止める', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  render(<TagCreate />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'タグを作る', exact: true })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'タグを作る', exact: true }))
  const input = screen.getByLabelText('タグ名')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(input)
  expect(scroll).toHaveBeenCalledWith({ block: 'center' })
  expect(screen.getAllByText('タグ名を入力してください')).toHaveLength(1)
  expect(net.create).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '定期購入者' } })
  expect(input.getAttribute('aria-invalid')).not.toBe('true')
  scroll.mockRestore()
})

test('保存APIの422を名前欄の下に出し、最初の欄へ移り、打ち直すと消す', async () => {
  const { ApiError } = await import('@/lib/api')
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0))
  net.create.mockRejectedValueOnce(new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { name: 'このタグ名は使われています' }))
  render(<TagCreate />)
  const save = await screen.findByRole('button', { name: 'タグを作る', exact: true })
  const input = screen.getByLabelText('タグ名')
  fireEvent.change(input, { target: { value: '既存タグ' } })
  fireEvent.click(save)
  await waitFor(() => expect(screen.getByText('このタグ名は使われています')).toBeTruthy())
  await waitFor(() => expect(document.activeElement).toBe(input))
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toContain(screen.getByText('このタグ名は使われています').id)
  expect(screen.queryByText('入力を確認してください')).toBeNull()
  expect(net.create).toHaveBeenCalledTimes(1)
  fireEvent.change(input, { target: { value: '別のタグ名' } })
  expect(screen.queryByText('このタグ名は使われています')).toBeNull()
  scroll.mockRestore()
  vi.unstubAllGlobals()
})

for (const role of [null, 'viewer', 'staff']) test(`権限${role}の人には入力と保存を出さず、APIを送らない`, () => {
  net.role = role
  render(<TagCreate />)
  expect(screen.queryByLabelText('タグ名')).toBeNull()
  expect(screen.queryByRole('button', { name: 'タグを作る', exact: true })).toBeNull()
  expect(screen.getByRole('button', { name: '一覧へ戻る' })).toBeTruthy()
  expect(net.create).not.toHaveBeenCalled()
})

test('設定の見本は共通カードで囲み、利用できる付け方だけリンクにする', () => {
  render(<TagCreate />)
  const preview = document.querySelector('[data-template-region="preview"]')!
  expect(preview.querySelector('[data-card-variant="aside"]')).toBeTruthy()
  expect(screen.getByRole('link', { name: /回答フォーム/ }).getAttribute('href')).toBe('/form-submissions')
  expect(screen.getByRole('link', { name: /オートメーション/ }).getAttribute('href')).toBe('/automations')
  expect(screen.queryByRole('link', { name: /タグ連動/ })).toBeNull()
})

test('付け方のリンクだけに操作の印があり、右欄は共通の透明な面を使う', () => {
  render(<TagCreate />)
  for (const label of ['回答フォーム', 'オートメーション']) {
    const link = screen.getByRole('link', { name: new RegExp(label) })
    expect(link.hasAttribute('data-pressable-card')).toBe(true)
    expect(link.querySelector('[data-link-indicator]')).toBeTruthy()
  }
  const description = screen.getByText('タグ連動').closest('[data-design-part="card"]')!
  expect(description.querySelector('[data-link-indicator]')).toBeNull()
  expect(document.querySelector('[data-template-region="preview"]')?.getAttribute('data-preview-surface')).toBe('plain')
})

test('重複候補を読み込めなければ知らせ、名前を保って読み直せる', async () => {
  net.tags.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true, data: [{ id: 't', name: '同じ名前' }] })
  render(<TagCreate />)
  const name = await screen.findByLabelText('タグ名')
  fireEvent.change(name, { target: { value: '同じ名前' } })
  await screen.findByText(/同じ名前のタグを確認できませんでした/)
  fireEvent.click(screen.getByRole('button', { name: '重複を確認し直す' }))
  await waitFor(() => expect(screen.queryByText(/同じ名前のタグを確認できませんでした/)).toBeNull())
  expect((name as HTMLInputElement).value).toBe('同じ名前')
  expect(screen.getByText(/タグがすでにあります/)).toBeTruthy()
})

test('アカウントを替えた後の古い重複候補は出さない', async () => {
  let resolve!: (value: unknown) => void
  net.tags.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce({ success: true, data: [] })
  const view = render(<TagCreate />)
  const name = await screen.findByLabelText('タグ名')
  fireEvent.change(name, { target: { value: '古い名前' } })
  net.account = 'other'; view.rerender(<TagCreate />)
  await waitFor(() => expect(net.tags).toHaveBeenCalledTimes(2))
  await act(async () => { resolve({ success: true, data: [{ id: 'old', name: '古い名前' }] }) })
  expect(screen.queryByText(/タグがすでにあります/)).toBeNull()
})

test('切替先の読み込み中は前のアカウントの重複候補を見せない', async () => {
  net.tags.mockResolvedValueOnce({ success: true, data: [{ id: 'old', name: '同名' }] }).mockReturnValueOnce(new Promise(() => {}))
  const view = render(<TagCreate />)
  fireEvent.change(await screen.findByLabelText('タグ名'), { target: { value: '同名' } })
  await screen.findByText(/タグがすでにあります/)
  net.account = 'other'; view.rerender(<TagCreate />)
  expect(screen.queryByText(/タグがすでにあります/)).toBeNull()
})
