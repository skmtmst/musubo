// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
const fixture = vi.hoisted(() => ({ picker: {} as { canPick?: boolean; lockedReason?: string; channel?: string }, reason: undefined as string | undefined }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'acc-1', name: '本店' }, { id: 'acc-2', name: '別店舗' }] }) }))
vi.mock('@/components/chats/template-picker', () => ({ default: (props: typeof fixture.picker) => { fixture.picker = props; return null } }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: () => fixture.reason }))
vi.mock('@/components/shared/sender-select', () => ({ default: () => null }))
vi.mock('./schedule-dialog', () => ({ default: () => null }))
const { default: InboxReplyComposer } = await import('./inbox-reply-composer')
type Props = ComponentProps<typeof InboxReplyComposer>
function props(role: string | null): Props {
  return {
    staffRole: role, scheduledSends: [], pendingPack: null, messageContent: '', messageLength: 0,
    pendingImage: null, pendingAttachment: null, quotedMessage: null, chatDetail: null,
    textareaRef: { current: null }, imageInputRef: { current: null }, isComposingRef: { current: false },
    memoPopoverRef: { current: null }, showTemplatePicker: true,
    setShowTemplatePicker: () => {}, setMessageContent: () => {}, selectedChatId: 'chat-1', selectedAccountId: 'acc-1',
  } as Props
}
afterEach(() => { cleanup(); fixture.reason = undefined })
it.each([['viewer', false], [null, false], ['owner', true]] as const)('返信欄から%sの選択窓へ挿入権限を配線する', (role, allowed) => {
  fixture.reason = role === 'viewer' ? '閲覧のみのため変更できません' : undefined
  render(<InboxReplyComposer {...props(role)} />)
  expect(fixture.picker).toMatchObject({ channel: 'line', canPick: allowed, lockedReason: fixture.reason })
})
it('代理の閲覧へ切り替わった理由も、開いている選択窓へ渡す', () => {
  const view = render(<InboxReplyComposer {...props('owner')} />)
  fixture.reason = '代理ログイン（閲覧）中のため変更できません'
  view.rerender(<InboxReplyComposer {...props('owner')} />)
  expect(fixture.picker.lockedReason).toBe(fixture.reason)
})

it('時刻を指定して送る操作は送信予約と表示する', () => {
  render(<InboxReplyComposer {...props('owner')} />)
  expect(screen.getByRole('button', { name: '送信予約' })).toBeTruthy()
})
it('送信の設定は開閉しても同じ名前で、状態を伝える', () => {
  const view = render(<InboxReplyComposer {...props('owner')} showComposerOptions={false} />)
  const toggle = screen.getByRole('button', { name: '送信の設定', exact: true })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  view.rerender(<InboxReplyComposer {...props('owner')} showComposerOptions />)
  expect(screen.getByRole('button', { name: '送信の設定', exact: true })).toBe(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})

it('テンプレートの束の送信確認に送信元と環境を示す', async () => {
  render(<InboxReplyComposer {...props('owner')} pendingPack={{ texts: ['本文'], chatId: 'chat-1', accountId: 'acc-1' }} />)
  expect(screen.getByText('LINEアカウント')).toBeTruthy()
  expect(await screen.findByText('本店')).toBeTruthy()
  expect(screen.queryByText('別店舗')).toBeNull()
  expect(screen.getByText('環境')).toBeTruthy()
})

it('差し込みがある返信だけ、解決後の見本を返信欄に出す', async () => {
  const api = (await import('@/lib/api')).api
  const preview = vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '山田さん、こんにちは', unresolved: [] } } as never)
  const view = render(<InboxReplyComposer {...props('owner')} messageContent="{{name}}さん、こんにちは" />)
  expect(await screen.findByText('送るとこうなります：')).toBeTruthy()
  expect(screen.getByText('山田さん、こんにちは')).toBeTruthy()
  expect(preview).toHaveBeenCalledTimes(1)
  view.rerender(<InboxReplyComposer {...props('owner')} messageContent="こんにちは" />)
  expect(screen.queryByText('送るとこうなります：')).toBeNull()
  preview.mockRestore()
})

it('宛先を変えたら古い見本と遅れた応答を表示しない', async () => {
  const api = (await import('@/lib/api')).api
  const pending: Array<{ chat: string; resolve: (value: Awaited<ReturnType<typeof api.chats.renderPreview>>) => void }> = []
  const preview = vi.spyOn(api.chats, 'renderPreview').mockImplementation(chat => new Promise(resolve => pending.push({ chat, resolve })))
  const view = render(<InboxReplyComposer {...props('owner')} selectedChatId="old" messageContent="{{name}}さん" />)
  await waitFor(() => expect(pending.some(item => item.chat === 'old')).toBe(true))
  view.rerender(<InboxReplyComposer {...props('owner')} selectedChatId="new" messageContent="{{name}}さん" />)
  await waitFor(() => expect(pending.some(item => item.chat === 'new')).toBe(true))
  await act(async () => { pending.find(item => item.chat === 'old')!.resolve({ success: true, data: { content: '旧さん', unresolved: [] } }) })
  expect(screen.queryByText('旧さん')).toBeNull()
  await act(async () => { pending.find(item => item.chat === 'new')!.resolve({ success: true, data: { content: '新さん', unresolved: [] } }) })
  expect(await screen.findByText('新さん')).toBeTruthy()
  preview.mockRestore()
})
