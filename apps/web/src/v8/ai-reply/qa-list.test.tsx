// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/*
 * G2 Q&A タブの動き（要件 AI-02・07・08・20・23）：
 * 自動で答えるのオンはオーナーだけ・確かめの窓（NmTj4）を通す・閲覧のみは隠す・読めないときは読み直しの押し口。
 */
const role = vi.hoisted(() => ({ value: 'owner' as string | null }))
const account = vi.hoisted(() => ({ id: 'acc-1' }))
const apiMock = vi.hoisted(() => ({
  settings: vi.fn(), saveSettings: vi.fn(), listQa: vi.fn(), test: vi.fn(),
  publishQa: vi.fn(), stopQa: vi.fn(), deleteQa: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/auto-replies' }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id, selectedAccount: { id: account.id, name: '渋谷店' }, accounts: [] }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '渋谷店' }] })) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => null, useStaffRole: () => role.value }))
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, ...apiMock } }
})
import QaListV8 from './qa-list'

const QA = { id: 'qa-1', questions: ['駐車場はありますか'], answerText: '店の裏に 3 台あります。', status: 'published', source: 'manual', useCount: 31, version: 1, updatedAt: '2026-10-01T00:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  account.id = 'acc-1'
  role.value = verifiedStaffRole('owner')
  apiMock.settings.mockResolvedValue({ success: true, data: { mode: 'draft_only', suspendedReason: null, publishedQaCount: 18, draftQaCount: 1, version: 4 } })
  apiMock.saveSettings.mockResolvedValue({ success: true, data: { mode: 'auto_qa', suspendedReason: null, publishedQaCount: 18, draftQaCount: 1, version: 5 } })
  apiMock.listQa.mockResolvedValue({ success: true, data: { items: [QA], total: 1 } })
})
afterEach(cleanup)

async function open() {
  render(<QaListV8 />)
  await act(async () => {})
}

it('取り込む窓の入力を画面移動から守り、続行で保持する', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '取り込む（PDF・Web）' }))
  fireEvent.change(screen.getByRole('textbox', { name: /ページの URL/ }), { target: { value: 'https://example.test/faq' } })
  const a = document.createElement('a'); a.href = '/templates'; document.body.appendChild(a)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  act(() => { a.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  fireEvent.click(within(screen.getByRole('dialog', { name: '保存していない変更があります' })).getByRole('button', { name: '編集を続ける' }))
  expect(screen.getByRole('textbox', { name: /ページの URL/ })).toHaveProperty('value', 'https://example.test/faq')
  a.remove()
})

it('取り込む窓の入力を戻る操作から守る', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '取り込む（PDF・Web）' }))
  fireEvent.change(screen.getByRole('textbox', { name: /ページの URL/ }), { target: { value: 'https://example.test/faq' } })
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
  fireEvent.popState(window)
  expect(go).toHaveBeenCalledExactlyOnceWith(1)
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
})

it('取り込む窓を閉じて開き直すと保留先を残さない', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '取り込む（PDF・Web）' }))
  const dialog = screen.getByRole('dialog', { name: 'Q&A を取り込む' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: /ページの URL/ }), { target: { value: 'https://example.test/faq' } })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).getByRole('button', { name: '破棄する' }))
  fireEvent.click(screen.getByRole('button', { name: '取り込む（PDF・Web）' }))
  expect(screen.queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull()
  expect(screen.getByRole('textbox', { name: /ページの URL/ })).toHaveProperty('value', '')
})

it.each([['draft', '公開する'], ['published', '止める'], ['published', '削除する']] as const)('%s の %s 確認に操作先と環境を示す', async (status, action) => {
  apiMock.listQa.mockResolvedValue({ success: true, data: { items: [{ ...QA, status }], total: 1 } })
  await open()
  fireEvent.click(screen.getByRole('button', { name: '「駐車場はありますか」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
  const dialog = screen.getByRole(action === '削除する' ? 'alertdialog' : 'dialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(await within(dialog).findByText('渋谷店')).toBeTruthy()
})

it('アカウント切替後は古い Q&A 削除確定を送らない', async () => {
  const view = render(<QaListV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '「駐車場はありますか」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const button = within(screen.getByRole('alertdialog')).getByRole('button', { name: '削除する' })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  account.id = 'acc-2'; view.rerender(<QaListV8 />)
  account.id = 'acc-1'; view.rerender(<QaListV8 />)
  await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
  expect(apiMock.deleteQa).not.toHaveBeenCalled()
})

it('オーナーが自動で答えるを選ぶと確かめの窓が開き、窓で押すまで段は変わらない', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '変える' }))
  fireEvent.click(screen.getByRole('button', { name: '自動で答える' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('自動で答える前の確かめ')).toBeTruthy()
  expect(within(dialog).getByText(/公開中の Q&A 18 件/)).toBeTruthy()
  expect(within(dialog).getByText('自動で送った答えは取り消せません。')).toBeTruthy()
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(apiMock.saveSettings).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /自動で答えるをオンにする/ })) })
  expect(apiMock.saveSettings).toHaveBeenCalledWith('acc-1', { mode: 'auto_qa', expectedVersion: 4 }, undefined)
})

it('AI を使わない確認に操作先と環境を示す', async () => {
  await open()
  fireEvent.click(screen.getByRole('button', { name: '変える' }))
  fireEvent.click(screen.getByRole('button', { name: '使わない' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  expect(apiMock.saveSettings).not.toHaveBeenCalled()
})

it('AI の使い方を選んだ後に切り替えて戻しても古い確定を送らない', async () => {
  const view = render(<QaListV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '変える' }))
  fireEvent.click(screen.getByRole('button', { name: '自動で答える' }))
  const button = within(screen.getByRole('dialog')).getByRole('button', { name: /自動で答えるをオンにする/ })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  account.id = 'acc-2'; view.rerender(<QaListV8 />)
  account.id = 'acc-1'; view.rerender(<QaListV8 />)
  await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
  expect(apiMock.saveSettings).not.toHaveBeenCalled()
})

it('切替先の AI 設定を読んでいる間は前のアカウントの操作を出さない', async () => {
  const seen: boolean[] = []
  function Probe() {
    React.useLayoutEffect(() => { if (account.id === 'acc-2') seen.push(Boolean(screen.queryByRole('button', { name: '変える' }))) })
    return <QaListV8 />
  }
  const view = render(<Probe />)
  expect(await screen.findByRole('button', { name: '変える' })).toBeTruthy()
  apiMock.settings.mockReturnValueOnce(new Promise(() => {}))
  account.id = 'acc-2'; view.rerender(<Probe />)
  expect(seen).toEqual([false])
  expect(screen.queryByRole('button', { name: '変える' })).toBeNull()
})

it('管理者には自動で答えるの選択肢を出さない（オーナーだけ）', async () => {
  role.value = verifiedStaffRole('admin')
  await open()
  fireEvent.click(screen.getByRole('button', { name: '変える' }))
  expect(screen.queryByRole('button', { name: '自動で答える' })).toBeNull()
  expect(screen.getByText('自動で答えるのオンはオーナーだけが変えられます')).toBeTruthy()
})

it('閲覧のみには追加・取り込み・変える・行の「…」を出さず、帯を出す', async () => {
  role.value = verifiedStaffRole('viewer')
  await open()
  expect(screen.getByText(/閲覧のみで見ています。Q&A の追加/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Q&A を追加/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /取り込む/ })).toBeNull()
  expect(screen.queryByRole('button', { name: '変える' })).toBeNull()
  expect(screen.queryByRole('button', { name: '「駐車場はありますか」の操作' })).toBeNull()
  expect(screen.getByText('駐車場はありますか')).toBeTruthy()
})

it('一覧を読めないときは読み直しの押し口を出し、押すと読み直す', async () => {
  apiMock.listQa.mockRejectedValueOnce(new Error('network'))
  await open()
  expect(screen.getByText('読み込めませんでした')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /もう一度/ })) })
  expect(apiMock.listQa).toHaveBeenCalledTimes(2)
  expect(screen.getByText('駐車場はありますか')).toBeTruthy()
})

afterEach(() => { verifiedStaffRole(null) })

it.each(['owner', 'viewer'])('Q&Aの説明は %s が使える操作に合う', async currentRole => {
  role.value = verifiedStaffRole(currentRole)
  await open()
  fireEvent.click(screen.getByRole('button', { name: '自動応答の説明' }))
  const note = screen.getAllByRole('note').find(element => element.textContent?.includes('公開した Q&A は返信案の元'))!
  expect(note).toBeTruthy()
  expect(Boolean(note.textContent?.includes('行を押すと編集'))).toBe(currentRole === 'owner')
  expect(Boolean(note.textContent?.includes('公開・止める・削除'))).toBe(currentRole === 'owner')
})
