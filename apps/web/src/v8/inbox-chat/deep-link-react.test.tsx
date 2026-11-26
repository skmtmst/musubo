// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useInboxDeepLink } from './use-inbox-deep-link'

vi.mock('@/lib/api', () => ({ api: { friends: { get: vi.fn() } } }))

const selectChat = vi.fn()
const selectEmail = vi.fn()
const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }
type Options = Parameters<typeof useInboxDeepLink>[0]
let container: HTMLDivElement
let root: Root
let options: Options
function Harness() {
  const { deepLinkNotice } = useInboxDeepLink(options)
  return <output>{deepLinkNotice}</output>
}
const render = async () => { await act(async () => { root.render(<Harness />) }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.friends.get).mockResolvedValue({ success: true, data: { lineAccountId: 'account-a' } } as Awaited<ReturnType<typeof api.friends.get>>)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  options = {
    params: new URLSearchParams('friend=friend-a') as Options['params'],
    selectedAccountId: 'account-a', accountsLoading: false, sharedEmailEnabled: true, storeEmailEnabled: false,
    setSelectedChatId: selectChat, setSelectedEmail: selectEmail,
    router, channel: 'all', savedViewParam: '',
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('URLから開く会話の再照合', () => {
  it('新規アカウントでは共有URLのメール会話も開かない', async () => {
    options = { ...options, params: new URLSearchParams('thread=old-mail') as Options['params'], sharedEmailEnabled: false }
    await render()
    expect(selectEmail).toHaveBeenLastCalledWith(null)
    expect(container.textContent).toContain('メールを接続していません')
  })
  it('印の無い thread は共通のメール、source=store は店舗のメールとして開く', async () => {
    options = { ...options, params: new URLSearchParams('thread=mail-a') as Options['params'] }
    await render()
    expect(selectEmail).toHaveBeenLastCalledWith({ source: 'shared', threadId: 'mail-a' })
    options = { ...options, params: new URLSearchParams('thread=mail-a&source=store') as Options['params'], storeEmailEnabled: true }
    await render()
    expect(selectEmail).toHaveBeenLastCalledWith({ source: 'store', threadId: 'mail-a' })
    expect(selectChat).toHaveBeenLastCalledWith(null)
  })
  it('店舗のメールがつながっていないアカウントでは、店舗の指定を共通のメールとして開かない', async () => {
    options = { ...options, params: new URLSearchParams('thread=mail-a&source=store') as Options['params'], sharedEmailEnabled: true, storeEmailEnabled: false }
    await render()
    expect(selectEmail).toHaveBeenLastCalledWith(null)
    expect(selectEmail).not.toHaveBeenCalledWith({ source: 'shared', threadId: 'mail-a' })
    expect(container.textContent).toContain('店舗のメールを接続していません')
  })
  it('URLを変更すると新しい相手を照合し、戻る操作でも開き直す', async () => {
    await render()
    expect(selectChat).toHaveBeenLastCalledWith('friend-a')
    options = { ...options, params: new URLSearchParams('friendId=friend-b') as Options['params'] }
    await render()
    expect(api.friends.get).toHaveBeenLastCalledWith('friend-b')
    expect(selectChat).toHaveBeenLastCalledWith('friend-b')
    options = { ...options, params: new URLSearchParams('friend=friend-a') as Options['params'] }
    await render()
    expect(api.friends.get).toHaveBeenCalledTimes(3)
    expect(selectChat).toHaveBeenLastCalledWith('friend-a')
  })

  it('所属の照合が終わるまでは会話を選ばない', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.friends.get>>) => void
    vi.mocked(api.friends.get).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await render()
    expect(selectChat).not.toHaveBeenCalledWith('friend-a')
    await act(async () => {
      resolve({ success: true, data: { lineAccountId: 'account-a' } } as Awaited<ReturnType<typeof api.friends.get>>)
    })
    expect(selectChat).toHaveBeenLastCalledWith('friend-a')
  })

  it('アカウントを切り替えると再照合し、前の店の相手を選ばない', async () => {
    await render()
    selectChat.mockClear()
    options = { ...options, selectedAccountId: 'account-b' }
    await render()
    expect(api.friends.get).toHaveBeenCalledTimes(2)
    expect(selectChat).toHaveBeenLastCalledWith(null)
    expect(selectChat).not.toHaveBeenCalledWith('friend-a')
    expect(container.textContent).toContain('いま選んでいるLINEアカウントの相手ではありません')
  })

  it('アカウント一覧が届くまでは開かず、届いてから照合して開く', async () => {
    options = { ...options, accountsLoading: true }
    await render()
    expect(api.friends.get).not.toHaveBeenCalled()
    expect(selectChat).not.toHaveBeenCalledWith('friend-a')
    options = { ...options, accountsLoading: false }
    await render()
    expect(api.friends.get).toHaveBeenCalledExactlyOnceWith('friend-a')
    expect(selectChat).toHaveBeenLastCalledWith('friend-a')
  })
})
