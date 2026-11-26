// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api, type ChatListItem } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import InstagramConversation from './instagram-conversation'
import InstagramCustomerInfo from './instagram-customer-info'
import { INSTAGRAM_REPLY_WINDOW_MS, instagramBlockedReason, instagramReplyDeadline, useInstagramThread } from './use-instagram-thread'

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => '/chats', useSearchParams: () => new URLSearchParams() }))

const chat = { id: 'ig:1', friendId: 'customer', friendName: 'Instagramユーザー', lineAccountId: 'a1', instagramId: 'ig-1', channel: 'instagram', lastMessageAt: new Date().toISOString() } as ChatListItem
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
const incoming = (id: string, hours: number) => ({ id, direction: 'incoming' as const, content: 'こんにちは', createdAt: hoursAgo(hours) })
type Detail = Awaited<ReturnType<typeof api.instagram.conversation>>['data']

function Harness({ target = chat, role = 'owner', onChanged = () => {} }: { target?: ChatListItem | null; role?: string | null; onChanged?: () => void }) {
  const thread = useInstagramThread(target, role, onChanged)
  return target ? <>
    <InstagramConversation chat={target} thread={thread} panel={{ open: false, onToggle: () => {} }} onBack={() => {}} />
    <InstagramCustomerInfo chat={target} thread={thread} />
  </> : null
}

function mockConversation(detail: Partial<Detail> & { messages: Detail['messages'] }) {
  return vi.spyOn(api.instagram, 'conversation').mockResolvedValue({ success: true, data: { replyState: 'ready', pendingReply: null, ...detail } as Detail })
}

beforeEach(() => { nav.push.mockReset(); forgetStaffIdentity() })
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.restoreAllMocks() })

describe('Instagram の会話を開いて返す', () => {
  it('会話と既読は接続先の Instagram を指定し、返信を1回送って入力を空にする', async () => {
    const conversation = mockConversation({ messages: [incoming('m1', 1)] })
    const read = vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
    const refresh = vi.fn()
    window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
    render(<Harness />)
    expect(await screen.findByText('こんにちは')).toBeTruthy()
    expect(conversation).toHaveBeenCalledWith('a1', 'customer', 'ig-1')
    await waitFor(() => expect(read).toHaveBeenCalledWith('a1', 'customer', 'ig-1'))
    expect(screen.getByText(/^返信の期限 .*（あと2[23]時間）$/)).toBeTruthy()
    const box = screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '返信' } })
    const button = screen.getByRole('button', { name: '送る' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(box.value).toBe(''))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0].slice(0, 3)).toEqual(['a1', 'm1', '返信'])
    expect(refresh).toHaveBeenCalled()
    window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
  })

  it('送れなかった返信は同じ文なら同じ送信キーで送り直し、文を変えたら新しいキーにする', async () => {
    mockConversation({ messages: [incoming('m1', 1)] })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply').mockRejectedValue(new Error('送信結果を確認できません。Instagramで確認してください'))
    render(<Harness />)
    await screen.findByText('こんにちは')
    fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '返信' } })
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][3]).toBe(send.mock.calls[0][3])
    await waitFor(() => expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '別の返信' } })
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    expect(send.mock.calls[2][3]).not.toBe(send.mock.calls[0][3])
  })

  it('最後のお客さまのメッセージから24時間を過ぎたら理由を出し、送らない', async () => {
    mockConversation({ messages: [incoming('m1', 25)] })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText('最後のお客さまのメッセージから24時間を過ぎたため返信できません。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText('過ぎました')).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('期限切れの会話を開いたまま新着が届いたら、本文と期限を読み直して返信できるようにする', async () => {
    const conversation = vi.spyOn(api.instagram, 'conversation')
      .mockResolvedValueOnce({ success: true, data: { replyState: 'ready', pendingReply: null, messages: [incoming('m1', 25)] } as Detail })
      .mockResolvedValue({ success: true, data: { replyState: 'ready', pendingReply: null, messages: [incoming('m1', 25), { id: 'm2', direction: 'incoming', content: 'まだ間に合いますか', createdAt: hoursAgo(0) }] } as Detail })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
    const stale = { ...chat, lastMessageAt: hoursAgo(25) }
    const { rerender } = render(<Harness target={stale} />)
    expect(await screen.findByText('最後のお客さまのメッセージから24時間を過ぎたため返信できません。')).toBeTruthy()
    // 一覧の定期更新で同じ行が返っただけ（時刻が同じ）なら読み直さない。
    rerender(<Harness target={{ ...stale }} />)
    await act(async () => { await Promise.resolve() })
    expect(conversation).toHaveBeenCalledTimes(1)
    // 一覧の定期更新で最終受信の時刻が進んだ。
    rerender(<Harness target={{ ...stale, lastMessageAt: hoursAgo(0) }} />)
    expect(await screen.findByText('まだ間に合いますか')).toBeTruthy()
    expect(conversation).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('最後のお客さまのメッセージから24時間を過ぎたため返信できません。')).toBeNull()
    expect(screen.getByText(/^返信の期限 .*（あと2[34]時間）$/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '間に合います' } })
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0].slice(0, 3)).toEqual(['a1', 'm2', '間に合います'])
  })

  it.each([
    ['disconnected', '接続が切れているため返信できません。Instagram の接続を確認してください。', '接続が切れています'],
    ['permission_required', 'DM の権限がありません。Instagram をつなぎ直してください。', 'DM の権限なし'],
  ] as const)('%s の理由を示し、返信を止めて設定へ案内する', async (replyState, reason, connection) => {
    mockConversation({ messages: [incoming('m1', 1)], replyState })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText(reason)).toBeTruthy()
    expect(screen.getByText(connection)).toBeTruthy()
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }))
    expect(nav.push).toHaveBeenCalledWith('/settings/sns')
  })

  it('閲覧のみの人は会話を読めるが、既読にも返信にもしない', async () => {
    mockConversation({ messages: [incoming('m1', 1)] })
    const read = vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
    render(<Harness role="viewer" />)
    expect(await screen.findByText('こんにちは')).toBeTruthy()
    // 権限で押せないボタンは灰色のまま焦点を受け、理由を吹き出しで読ませる（共通の決まり）。
    const button = screen.getByRole('button', { name: '送る' }) as HTMLButtonElement
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('data-permission-locked')).toBe(true)
    expect(screen.getByText('閲覧のみのため変更できません。オーナーか管理者に頼んでください。')).toBeTruthy()
    expect((screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(send).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '設定を開く' })).toBeNull()
  })
})

describe('結果の分からない返信', () => {
  const pendingReply = { key: 'k1', content: '在庫はあります', canResolve: true }

  it('未送信の確定までの残り時間を表示する', async () => {
    mockConversation({ messages: [incoming('m1', 1)], pendingReply: { ...pendingReply, canResolveNotSent: false, resolveAt: new Date(Date.now() + 4 * 60000).toISOString() } })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({ success: true })
    render(<Harness />)
    expect(await screen.findByText(/未送信の確定まであと4分/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '未送信にする' })).toBeNull()
  })

  it('未送信までの残り時間は端末ではなくWorkerの時刻から数える', async () => {
    mockConversation({ messages: [incoming('m1', 1)], pendingReply: { ...pendingReply, canResolveNotSent: false, serverNow: '2000-01-01T00:00:00.000Z', resolveAt: '2000-01-01T00:04:00.000Z' } })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText(/未送信の確定まであと4分/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '未送信にする' })).toBeNull()
  })

  it('接続切れでも結果待ちの会話から設定を開ける', async () => {
    mockConversation({ messages: [incoming('m1', 1)], replyState: 'disconnected', pendingReply })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText(/Instagram をつなぎ直すと照合できます。/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }))
    expect(nav.push).toHaveBeenCalledWith('/settings/sns')
  })

  it('Metaで届いていた返信は成功として表示し、入力欄に戻さない', async () => {
    const conversation = mockConversation({ messages: [incoming('m1', 1)], pendingReply })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    vi.spyOn(api.instagram, 'resolveReply').mockResolvedValue({ success: true, data: { outcome: 'sent', message: 'Instagram で届いていたので送信済みにしました。' } })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '未送信にする' }))
    const dialog = await screen.findByRole('dialog', { name: '未送信にしますか？' })
    conversation.mockResolvedValue({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } })
    fireEvent.click(within(dialog).getByRole('button', { name: '未送信にする' }))
    expect(await screen.findByText('Instagram で届いていたので送信済みにしました。')).toBeTruthy()
    expect((screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement).value).toBe('')
  })

  it('候補が複数の警告を閉じられる', async () => {
    mockConversation({ messages: [incoming('m1', 1)], reconciliationWarning: '送信通知の候補が複数あるため、Instagramで確かめてください。' })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText(/送信通知の候補が複数/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '通知を閉じる' }))
    expect(screen.queryByText(/送信通知の候補が複数/)).toBeNull()
  })

  it('後から送信済みと分かった知らせを閉じられる', async () => {
    mockConversation({ messages: [incoming('m1', 1)], lateEchoNotice: '未送信とした返信が実際には届いていました。' })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText('未送信とした返信が実際には届いていました。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '通知を閉じる' }))
    expect(screen.queryByText('未送信とした返信が実際には届いていました。')).toBeNull()
  })

  it('ある間は送らず、Instagram で確かめるよう知らせる', async () => {
    mockConversation({ messages: [incoming('m1', 1)], pendingReply: { ...pendingReply, canResolve: false } })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness />)
    expect(await screen.findByText('「在庫はあります」の送信結果が分かりません。Instagram で送信結果を確認してください。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '送信済みにする' })).toBeNull()
    expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy()
  })

  it('確かめた結果を窓で確認してから記録し、読み直す', async () => {
    const conversation = mockConversation({ messages: [incoming('m1', 1)], pendingReply })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const resolve = vi.spyOn(api.instagram, 'resolveReply').mockResolvedValue({})
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '送信済みにする' }))
    expect(resolve).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog', { name: '送信済みにしますか？' })
    conversation.mockResolvedValue({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } })
    fireEvent.click(within(dialog).getByRole('button', { name: '送信済みにする' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    expect(resolve).toHaveBeenCalledWith('a1', 'customer', 'ig-1', 'k1', 'sent')
    await waitFor(() => expect(screen.queryByText(/の送信結果が分かりません/)).toBeNull())
    expect(conversation.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('未送信と記録したら、理由を添えて送信キーを新しくして再送できる', async () => {
    const conversation = vi.spyOn(api.instagram, 'conversation')
      .mockResolvedValueOnce({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } })
      .mockResolvedValueOnce({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply } })
      .mockResolvedValue({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const send = vi.spyOn(api.instagram, 'sendReply')
      .mockRejectedValueOnce(new Error('送信結果を確認できません。Instagramで確認してください'))
      .mockResolvedValueOnce({})
    const resolve = vi.spyOn(api.instagram, 'resolveReply').mockResolvedValue({})
    render(<Harness />)
    await screen.findByText('こんにちは')
    fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '在庫はあります' } })
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const firstKey = send.mock.calls[0][3]
    fireEvent.click(await screen.findByRole('button', { name: '未送信にする' }))
    const dialog = await screen.findByRole('dialog', { name: '未送信にしますか？' })
    fireEvent.change(within(dialog).getByLabelText('確認した理由'), { target: { value: 'Instagramアプリで未着を確認' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '未送信にする' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('a1', 'customer', 'ig-1', 'k1', 'not_sent', 'Instagramアプリで未着を確認'))
    await waitFor(() => expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '送る' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][3]).not.toBe(firstKey)
    expect(conversation).toHaveBeenCalled()
  })

  it('未送信と記録したら、空の入力欄へ同じ文を戻す', async () => {
    const conversation = mockConversation({ messages: [incoming('m1', 1)], pendingReply })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const resolve = vi.spyOn(api.instagram, 'resolveReply').mockResolvedValue({})
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: '未送信にする' }))
    const dialog = await screen.findByRole('dialog', { name: '未送信にしますか？' })
    conversation.mockResolvedValue({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } })
    fireEvent.click(within(dialog).getByRole('button', { name: '未送信にする' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('a1', 'customer', 'ig-1', 'k1', 'not_sent'))
    await waitFor(() => expect((screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement).value).toBe('在庫はあります'))
  })

  it('担当者は送信済みも未送信も確定できない', async () => {
    rememberStaffIdentity({ id: 'staff-1', name: '見本 担当者', role: 'staff', readOnly: false, permissionKeys: ['/chats'] } as StaffMember)
    mockConversation({ messages: [incoming('m1', 1)], pendingReply })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    render(<Harness role="staff" />)
    expect(await screen.findByText(/管理者に確定を頼んでください/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '送信済みにする' })).toBeNull()
    expect(screen.queryByRole('button', { name: '未送信にする' })).toBeNull()
  })

  it('閲覧のみの人には記録の操作を出さない', async () => {
    mockConversation({ messages: [incoming('m1', 1)], pendingReply })
    render(<Harness role="viewer" />)
    expect(await screen.findByText(/の送信結果が分かりません/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '送信済みにする' })).toBeNull()
    expect(screen.queryByRole('button', { name: '未送信にする' })).toBeNull()
  })
})

describe('相手を替えた時', () => {
  it('前の相手の入力と遅れて届いた応答を持ち越さない', async () => {
    let late!: (value: Awaited<ReturnType<typeof api.instagram.conversation>>) => void
    const conversation = vi.spyOn(api.instagram, 'conversation')
      .mockImplementationOnce(() => new Promise((done) => { late = done }))
      .mockResolvedValue({ success: true, data: { messages: [{ ...incoming('m2', 1), content: '別の相手' }], replyState: 'ready', pendingReply: null } })
    vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
    const view = render(<Harness />)
    fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '書きかけ' } })
    view.rerender(<Harness target={{ ...chat, id: 'ig:2', friendId: 'other' }} />)
    expect(await screen.findByText('別の相手')).toBeTruthy()
    await act(async () => { late({ success: true, data: { messages: [incoming('m1', 1)], replyState: 'ready', pendingReply: null } }) })
    expect(screen.queryByText('こんにちは')).toBeNull()
    expect((screen.getByLabelText('メッセージを入力') as HTMLTextAreaElement).value).toBe('')
    expect(conversation).toHaveBeenLastCalledWith('a1', 'other', 'ig-1')
  })
})

describe('返信の期限の物差し', () => {
  it('お客さまの最後のメッセージから24時間。ちょうど24時間で締める（Worker と同じ）', () => {
    const at = Date.parse('2026-11-24T00:00:00.000Z')
    const messages = [
      { id: 'a', direction: 'incoming' as const, content: '', createdAt: '2026-11-23T00:00:00.000Z' },
      { id: 'b', direction: 'incoming' as const, content: '', createdAt: '2026-11-24T00:00:00.000Z' },
      { id: 'c', direction: 'outgoing' as const, content: '', createdAt: '2026-11-24T05:00:00.000Z' },
    ]
    const deadline = instagramReplyDeadline(messages)
    expect(deadline).toBe(at + INSTAGRAM_REPLY_WINDOW_MS)
    const detail = { messages, replyState: 'ready' as const }
    expect(instagramBlockedReason(detail, deadline, at + INSTAGRAM_REPLY_WINDOW_MS - 1)).toBe('')
    expect(instagramBlockedReason(detail, deadline, at + INSTAGRAM_REPLY_WINDOW_MS)).toBe('最後のお客さまのメッセージから24時間を過ぎたため返信できません。')
    expect(instagramReplyDeadline(messages.filter((message) => message.direction === 'outgoing'))).toBeNull()
    expect(instagramBlockedReason({ messages: [], replyState: 'ready' }, null, at)).toBe('お客さまからのメッセージが無いため、まだ返信できません。')
  })
})
