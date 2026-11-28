// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import TemplateRichEditor from './rich'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const fixture = vi.hoisted(() => ({ account: 'acc-1', folders: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, accounts: [] }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({ useActionOptions: () => ({ tags: [], fields: [], marks: [], scenarios: [], vars: [], notificationRules: [] }) }))
const create = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { folders: { list: fixture.folders }, broadcastMessageAssets: { create } } }))
beforeEach(() => { fixture.account = 'acc-1'; fixture.folders.mockReset().mockResolvedValue({ success: true, data: [] }); document.documentElement.setAttribute('data-theme', 'v8') })
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-theme') })

/* ：保存で落ちた欄は帯ではなく欄で知らせ、別の面ならその面を選んで移る。面の一覧に赤い丸。 */
it('名前・画像が空、面 B の URL が空なら送らず、それぞれの欄に理由を出し、名前へ移る。面 B に赤い丸', async () => {
  render(<TemplateRichEditor />)
  fireEvent.click(screen.getByRole('radio', { name: '上下2面（面 A・B）' }))
  fireEvent.click(screen.getByRole('button', { name: '面 B「下」を選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '面 B を押したら' }))
  fireEvent.click(within(screen.getByRole('listbox')).getByText('URLを開く'))
  fireEvent.click(screen.getByRole('button', { name: '面 A「上」を選択する' }))
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  const name = document.getElementById('te-rich-name') as HTMLInputElement
  await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
  expect(document.getElementById('te-rich-name-error')?.textContent).toBe('リッチメッセージ名を入力してください')
  expect(screen.getByRole('group', { name: '画像を追加' }).getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole('img', { name: '面 下に直す欄が1か所' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(name))
  expect(create).not.toHaveBeenCalled()
  /* 名前と画像を入れて保存し直すと、残った面 B を開いてその欄へ移る。 */
  fireEvent.change(name, { target: { value: '夏の告知' } })
  fireEvent.change(screen.getByLabelText('画像のURL'), { target: { value: 'https://img.example/a.png' } })
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  await waitFor(() => expect(screen.getByRole('group', { name: '面 B' })).toBeTruthy())
  expect(document.getElementById('te-rich-area-error')?.textContent).toBe('この面のURLを入力してください')
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('面 B のURL')))
  expect(create).not.toHaveBeenCalled()
})

it('空の画像と名前では主保存を止め、名前を入れると画像の理由を出す', () => {
  render(<TemplateRichEditor />)
  const save = screen.getByRole('button', { name: '保存して公開' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '告知' } })
  expect(save.disabled).toBe(true)
  expect(screen.getByText('画像を選んでください。')).toBeTruthy()
  fireEvent.click(save);expect(create).not.toHaveBeenCalled()
})

it('フォルダの取得失敗を知らせ、読み直せる', async () => {
  fixture.folders.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true, data: [] })
  render(<TemplateRichEditor />)
  await screen.findByText(/フォルダを読み込めませんでした/)
  expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(screen.queryByText(/フォルダを読み込めませんでした/)).toBeNull())
  expect(fixture.folders).toHaveBeenCalledTimes(2)
})
it('アカウント切替後の古いフォルダ応答を使わない', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  fixture.folders.mockReturnValueOnce(pending).mockResolvedValueOnce({ success: true, data: [{ id: 'b', name: '新しい店' }] })
  const view = render(<TemplateRichEditor />)
  expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(true)
  fixture.account = 'acc-2'; view.rerender(<TemplateRichEditor />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalledTimes(2))
  await act(async () => resolve({ success: true, data: [{ id: 'a', name: '前の店' }] }))
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ' }))
  expect(await screen.findByText('新しい店')).toBeTruthy()
  expect(screen.queryByText('前の店')).toBeNull()
})

it('アカウント変更時は選択済みのフォルダ名を外す', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [{ id: 'a', name: '夏' }] })
  const view = render(<TemplateRichEditor />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ' }))
  fireEvent.click(await screen.findByText('夏'))
  expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).toContain('夏')
  fixture.account = 'acc-2'; view.rerender(<TemplateRichEditor />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'フォルダ' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.getByRole('button', { name: 'フォルダ' }).textContent).not.toContain('夏')
})
