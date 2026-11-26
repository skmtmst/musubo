// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ account: 'acc-a', log: 'log-1', stop: vi.fn(), detail: vi.fn(), held: null as null | (() => unknown), heldSelect: null as null | (() => void) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/auto-replies', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/shared/list-url-state', () => ({ useListUrlState: () => [{ action: '', days: '30', page: '1', size: '20', log: fx.log }, vi.fn()] }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-a', name: '元のアカウント' }, { id: 'acc-b', name: '別のアカウント' }] })) }))
vi.mock('./use-ai-settings', () => ({ useAiSettings: () => ({ permissions: { publishQa: true, editQa: true } }) }))
vi.mock('@/components/shared/drawer', () => ({ default: ({ open, actions, children, status }: { open: boolean; status?: React.ReactNode; actions?: { menuItems?: Array<{ label: string; onSelect?: () => void }> }; children: React.ReactNode }) => {
  if (open && fx.account === 'acc-a') fx.heldSelect = actions?.menuItems?.find(item => item.label === 'この答えを止める')?.onSelect ?? fx.heldSelect
  return open ? <div>{status}{children}{actions?.menuItems?.filter(item => item.onSelect).map(item => <button key={item.label} onClick={item.onSelect}>{item.label}</button>)}</div> : null
} }))
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.onConfirm) fx.held = props.onConfirm
    return <actual.default {...props} />
  } }
})
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, logs: vi.fn(async () => ({ data: { items: [], total: 0, summary: { answered: 0, handedOff: 0, askedAgainRate: null } } })), log: fx.detail, stopQa: fx.stop } }
})
import AnswerLogV8 from './answer-log'
const detail = { id: 'log-1', createdAt: '2026-10-01T00:00:00Z', chatId: 'chat-1', friendId: 'friend-1', friendName: '確認用', questionText: '質問', action: 'answered', handoffReason: null, qaEntryId: 'qa-1', qaTitle: '答え', qaVersion: 1, answerText: '答え', afterNote: null, qa: { id: 'qa-1', title: '答え', status: 'published', useCount: 1, updatedAt: '2026-10-01', version: 1, currentAnswerText: '答え' } }
beforeEach(() => { fx.account = 'acc-a'; fx.log = 'log-1'; fx.held = null; fx.heldSelect = null; fx.stop.mockReset().mockResolvedValue({ success: true }); fx.detail.mockReset().mockResolvedValue({ data: detail }) })
afterEach(cleanup)

it('答えを止める窓は元のアカウントと環境を示し、切替後に古い停止を送らない', async () => {
  const view = render(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  const dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  expect(await within(dialog).findByText('元のアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  const held = fx.held!
  fx.account = 'acc-b'
  view.rerender(<AnswerLogV8 />)
  expect(screen.queryByRole('dialog', { name: '「答え」の答えを止めますか？' })).toBeNull()
  await act(async () => { await held() })
  expect(fx.stop).not.toHaveBeenCalled()
})

it('確認したアカウントの答えだけを停止する', async () => {
  render(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  const dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '止める' })) })
  expect(fx.stop).toHaveBeenCalledExactlyOnceWith('acc-a', 'qa-1', 1)
})

it('キャンセルした確認の古い操作は停止を送らない', async () => {
  render(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  const dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  const held = fx.held!
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await held() })
  expect(fx.stop).not.toHaveBeenCalled()
})

it('停止に失敗したら同じ窓から再試行できる', async () => {
  fx.stop.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true })
  render(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  const dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '止める' })) })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '止める' })) })
  expect(fx.stop).toHaveBeenCalledTimes(2)
})

it('元のアカウントの停止中に切り替えても新しい停止窓を閉じない', async () => {
  let finishOld!: (value: { success: boolean }) => void
  fx.stop.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  const view = render(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  let dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  fireEvent.click(within(dialog).getByRole('button', { name: '止める' }))
  fx.account = 'acc-b'
  view.rerender(<AnswerLogV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'この答えを止める' }))
  dialog = await screen.findByRole('dialog', { name: '「答え」の答えを止めますか？' })
  expect(await within(dialog).findByText('別のアカウント')).toBeTruthy()
  await act(async () => { finishOld({ success: true }) })
  expect(screen.getByRole('dialog', { name: '「答え」の答えを止めますか？' })).toBeTruthy()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '止める' })) })
  expect(fx.stop).toHaveBeenLastCalledWith('acc-b', 'qa-1', 1)
})

it('切替前の遅い詳細は新しいアカウントの画面を上書きしない', async () => {
  let finishOld!: (value: { data: typeof detail }) => void
  fx.detail.mockImplementation((account: string) => account === 'acc-a' ? new Promise(resolve => { finishOld = resolve }) : Promise.resolve({ data: { ...detail, qa: null } }))
  const view = render(<AnswerLogV8 />)
  await act(async () => {})
  fx.account = 'acc-b'
  view.rerender(<AnswerLogV8 />)
  await act(async () => { finishOld({ data: detail }) })
  expect(screen.queryByRole('button', { name: 'この答えを止める' })).toBeNull()
  expect(fx.stop).not.toHaveBeenCalled()
})

it('切替前の詳細操作を保持しても別アカウントの停止窓を開かない', async () => {
  const view = render(<AnswerLogV8 />)
  await screen.findByRole('button', { name: 'この答えを止める' })
  const held = fx.heldSelect!
  fx.account = 'acc-b'
  view.rerender(<AnswerLogV8 />)
  await act(async () => { held() })
  expect(screen.queryByRole('dialog', { name: '「答え」の答えを止めますか？' })).toBeNull()
  expect(fx.stop).not.toHaveBeenCalled()
})

it('閉じた詳細の遅い応答では窓を開き直さない', async () => {
  let finish!: (value: { data: typeof detail }) => void
  fx.detail.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<AnswerLogV8 />)
  await act(async () => {})
  fx.log = ''
  view.rerender(<AnswerLogV8 />)
  await act(async () => { finish({ data: detail }) })
  expect(screen.queryByRole('button', { name: 'この答えを止める' })).toBeNull()
})


it.each(['constructor', 'toString', '__proto__', 'future'])('未知の回答結果とQ&Aの状態 %s は確認中と表示する', async value => {
  fx.detail.mockResolvedValue({ data: { ...detail, action: value, qa: { ...detail.qa, status: value } } })
  render(<AnswerLogV8 />)
  expect(await screen.findByText('内容を確認できません')).toBeTruthy()
  expect(screen.getByText(/状態を確認できません/)).toBeTruthy()
})
