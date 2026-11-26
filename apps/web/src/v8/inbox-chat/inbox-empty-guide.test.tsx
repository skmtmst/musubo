// @vitest-environment happy-dom
/*
 * 未選択の中央の「次にやること」（ID27）。
 * - 件数があれば今の状況と［いちばん古い会話を開く］を出す
 * - 全部片づいた時は片づいたと言う（行き先は出さない）
 * - 件数が読めない時は数を出さず今までどおりの案内だけ
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import InboxEmptyGuide, { InboxChannelSetupGuide } from './inbox-empty-guide'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const base = {
  slaEnabled: true,
  chats: [{ id: 'chat-old', status: 'unread', lastMessageAt: '2026-08-11T00:00:00.000Z' }],
  emails: [],
  onOpenTarget: () => {},
} as const

describe('InboxEmptyGuide', () => {
  test('件数と行き先を出す', () => {
    const onOpenTarget = vi.fn()
    render(<InboxEmptyGuide {...base} unread={1} overdue={3} onOpenTarget={onOpenTarget} />)
    expect(screen.getByText('対応が必要な会話があります')).not.toBeNull()
    expect(screen.getByText('未対応 1 件・期限超過 3 件')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'いちばん古い会話を開く' }))
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'chat', id: 'chat-old' })
  })

  test('SLA無しは「1時間以上待ち」と言う', () => {
    render(<InboxEmptyGuide {...base} slaEnabled={false} unread={0} overdue={2} />)
    expect(screen.getByText('未対応 0 件・1時間以上待ち 2 件')).not.toBeNull()
  })

  test('片方が0件でもう片方が読めない時は断定しない', () => {
    render(<InboxEmptyGuide {...base} unread={0} overdue={null} />)
    expect(screen.getByText('会話を選ぶと、ここに表示されます')).not.toBeNull()
    expect(screen.queryByText('対応が必要な会話があります')).toBeNull()
  })

  test('全部片づいた時は行き先を出さない', () => {
    render(<InboxEmptyGuide {...base} unread={0} overdue={0} />)
    expect(screen.getByText('対応が必要な会話はありません')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'いちばん古い会話を開く' })).toBeNull()
  })

  test('件数が読めない時は数を出さない', () => {
    render(<InboxEmptyGuide {...base} unread={null} overdue={null} />)
    expect(screen.getByText('会話を選ぶと、ここに表示されます')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'いちばん古い会話を開く' })).toBeNull()
  })

  test('開ける会話が読み込み済みに無い時は行き先を出さない', () => {
    render(<InboxEmptyGuide {...base} chats={[]} unread={1} overdue={0} />)
    expect(screen.getByText('未対応 1 件・期限超過 0 件')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'いちばん古い会話を開く' })).toBeNull()
  })
})

describe('InboxChannelSetupGuide', () => {
  test('Instagram 未設定の案内と主ボタンを出し、押すと設定の Instagram 欄へ移る', () => {
    const onOpenSettings = vi.fn()
    const { container } = render(
      <InboxChannelSetupGuide channel="instagram" staffRole="owner" onOpenSettings={onOpenSettings} />,
    )
    expect(container.querySelector('svg[data-brand-mark="instagram"]')).toBeTruthy()
    expect(screen.getByText('Instagram をつなぐと、DM をここで読んで返せます')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Instagram を設定する' })
    expect(button.getAttribute('data-variant')).toBe('primary')
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onOpenSettings).toHaveBeenCalledWith('/settings/sns#instagram')
  })

  test('閲覧のみの人は Instagram 設定ボタンを灰色と理由の吹き出しで表示し、押しても移らない', () => {
    const onOpenSettings = vi.fn()
    render(<InboxChannelSetupGuide channel="instagram" staffRole="viewer" onOpenSettings={onOpenSettings} />)
    const button = screen.getByRole('button', { name: 'Instagram を設定する' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('data-permission-locked')).toBe(true)
    expect(screen.getByText(PERMISSION_LOCK_REASON.viewer)).toBeTruthy()
    fireEvent.click(button)
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  test('メール未設定も同じく案内と主ボタンを出し、閲覧のみは押せない表示にする', () => {
    const onOpenSettings = vi.fn()
    const view = render(<InboxChannelSetupGuide channel="email" staffRole="admin" onOpenSettings={onOpenSettings} />)
    expect(screen.getByText('メールを設定すると、問い合わせメールをここで読んで返せます')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'メールを設定する' }))
    expect(onOpenSettings).toHaveBeenCalledWith('/settings/sns')

    onOpenSettings.mockClear()
    view.rerender(<InboxChannelSetupGuide channel="email" staffRole="viewer" onOpenSettings={onOpenSettings} />)
    const locked = screen.getByRole('button', { name: 'メールを設定する' })
    expect(locked.getAttribute('aria-disabled')).toBe('true')
    expect(locked.hasAttribute('data-permission-locked')).toBe(true)
    fireEvent.click(locked)
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  test('権限確認中は設定ボタンを押せない状態にする', () => {
    const onOpenSettings = vi.fn()
    render(<InboxChannelSetupGuide channel="instagram" staffRole={null} onOpenSettings={onOpenSettings} />)
    const button = screen.getByRole('button', { name: 'Instagram を設定する' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(onOpenSettings).not.toHaveBeenCalled()
  })
})
