import { setTimeControl } from '@/test-utils/time-control'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatsPage from './page'

/*
 * N-025: 引用返信と送信予約の画面対照。
 *   - 「引用」を押すと送信欄の上に引用元が出て、送信に quotedMessageId が付く
 *   - × で引用を外せる
 *   - 予約パネルで日時を選ぶと /schedule へ送り、一覧に出て取消できる
 *   - 引用つき送信済みメッセージには引用元の要約が出る
 */

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams('friend=friend-a'),
  scheduled: [] as Array<{ id: string; scheduledAt: string; content: string; status: string }>,
  sentBodies: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<{ type: string | null; filename: string | null }>,
  scheduledTypes: [] as string[],
}))

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'account-a',
    selectedAccount: null,
    loading: false,
  }),
}))

/*
 * 時刻の選び欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * 予約の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

function responseFor(url: URL, init?: RequestInit): Response {
  if (url.pathname === '/api/chats') return json({ success: true, data: [] })
  if (url.pathname === '/api/chats/stats') {
    return json({ success: true, data: {
      total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
      oldestUnansweredMinutes: null, assigneeUnread: [],
    } })
  }
  if (url.pathname === '/api/support/inbox') {
    return json({ success: true, data: { items: [], summary: { total: 0 } } })
  }
  if (url.pathname === '/api/operators') return json({ success: true, data: [] })
  if (url.pathname === '/api/inbox/saved-views') return json({ success: true, data: [] })
  if (url.pathname === '/api/friends/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', displayName: '引用確認', pictureUrl: null, isFollowing: true,
      metadata: {}, lineAccountId: 'account-a', realName: null, systemDisplayName: null,
      refCode: null, createdAt: '2026-09-01T00:00:00.000Z', tags: [],
      formSubmissions: [], support: null,
    } })
  }
  if (url.pathname === '/api/chats/friend-a/scheduled' && init?.method !== 'DELETE' && init?.method !== 'PATCH') {
    return json({ success: true, data: { scheduled: fixture.scheduled } })
  }
  if (url.pathname === '/api/chats/friend-a/schedule' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { content: string; scheduledAt: string; quotedMessageId?: string; messageType?: string }
    fixture.scheduledTypes.push(body.messageType ?? 'text')
    const row = {
      id: `sched-${fixture.scheduled.length + 1}`,
      messageType: 'text',
      content: body.content,
      quotedMessageId: body.quotedMessageId ?? null,
      scheduledAt: new Date(body.scheduledAt).toISOString(),
      status: 'scheduled',
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: '2026-09-16T00:00:00.000Z',
    }
    fixture.scheduled.push(row)
    return json({ success: true, data: { ...row, replayed: false } })
  }
  if (url.pathname.startsWith('/api/chats/friend-a/scheduled/') && init?.method === 'DELETE') {
    const id = url.pathname.split('/').pop()!
    fixture.scheduled = fixture.scheduled.filter((row) => row.id !== id)
    return json({ success: true, data: { cancelled: true } })
  }
  /* ：受信箱の添付（API-15）。ファイルは期限30日のリンクとして届く。 */
  if (url.pathname === '/api/chats/friend-a/attachments/upload' && init?.method === 'POST') {
    const headers = new Headers(init.headers)
    fixture.uploads.push({ type: headers.get('Content-Type'), filename: headers.get('X-Filename') })
    return json({ success: true, data: {
      id: '11111111-2222-4333-8444-555555555555', key: 'private/chat-attachments/x', url: 'https://worker.example/a/x',
      filename: '案内.pdf', mimeType: 'application/pdf', size: 8, kind: 'file', expiresAt: '2026-11-07T03:00:00.000Z',
    } }, 201)
  }
  if (url.pathname === '/api/chats/friend-a/send' && init?.method === 'POST') {
    fixture.sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return json({ success: true, data: { sent: true, messageId: 'm-sent', sentByStaffName: '自分', revision: 2 } })
  }
  if (url.pathname === '/api/chats/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', friendId: 'friend-a', friendName: '引用確認',
      friendRealName: null, friendPictureUrl: null, isAttention: false,
      operatorId: null, status: 'unread', notes: '', revision: 1,
      lastMessageAt: '2026-09-16T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
      messages: [
        {
          id: 'm-in-1', direction: 'incoming', messageType: 'text',
          content: '値段はいくらですか？', isUnsent: false, source: null,
          originKind: null, sentByStaffId: null, sentByStaffName: null,
          scenarioName: null, quoted: null, createdAt: '2026-09-16T00:55:00.000Z',
        },
        {
          id: 'm-out-1', direction: 'outgoing', messageType: 'text',
          content: '1,980円です', isUnsent: false, source: 'manual',
          originKind: null, sentByStaffId: 'staff-1', sentByStaffName: 'オーナー',
          scenarioName: null,
          quoted: {
            id: 'm-in-1', direction: 'incoming', messageType: 'text',
            content: '値段はいくらですか？', isUnsent: false, createdAt: '2026-09-16T00:55:00.000Z',
          },
          createdAt: '2026-09-16T01:00:00.000Z',
        },
      ],
      hasMoreMessages: false,
    } })
  }
  if (url.pathname.endsWith('/mileage')) {
    return json({ success: true, data: {
      summary: { programId: 'p', programName: 'マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
      history: [],
    } })
  }
  if (url.pathname.endsWith('/rich-menu')) {
    return json({ success: true, data: { id: null, name: null, isDefault: false } })
  }
  if (url.pathname.endsWith('/read')) return json({ success: true, data: { isUnread: false } })
  return json({ success: true, data: [] })
}

async function eventually(check: () => void, timeout = 1_500): Promise<void> {
  const started = Date.now()
  while (true) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

async function typeText(host: HTMLElement, text: string) {
  const textarea = document.querySelector('textarea[aria-label="メッセージを入力"]') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('N-025 引用返信と送信予約', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fixture.params = new URLSearchParams('friend=friend-a')
    fixture.scheduled = []
    fixture.sentBodies = []
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      Promise.resolve(responseFor(new URL(String(input), 'http://localhost'), init)))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('「引用」を押すと引用元が送信欄へ出て、送信に quotedMessageId が付く', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => {
      expect(host.textContent).toContain('値段はいくらですか？')
    })

    const quoteButtons = Array.from(document.querySelectorAll<HTMLElement>('[data-inbox-v6="quote-reply"]'))
    expect(quoteButtons.length).toBeGreaterThan(0)
    await act(async () => { quoteButtons[0].click() })
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v6="quote-preview"]')?.textContent).toContain('値段はいくらですか？')
    })

    await typeText(host, '1,980円です')
    const sendButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '送信する')!
    await act(async () => { sendButton.click() })
    await eventually(() => {
      expect(fixture.sentBodies).toHaveLength(1)
      expect(fixture.sentBodies[0].quotedMessageId).toBe('m-in-1')
    })
    // 送ったら引用は外れる。
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v6="quote-preview"]')).toBeNull()
    })
  })

  it('引用の×で外せる', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v6="quote-reply"]')).toBeTruthy()
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="quote-reply"]')!.click()
    })
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v6="quote-preview"]')).toBeTruthy()
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="quote-preview"] button')!.click()
    })
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v6="quote-preview"]')).toBeNull()
    })
  })

  it('引用つき送信済みメッセージには引用元の要約が出る', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => {
      const quoted = document.querySelector('[data-inbox-v6="quoted-message"]')
      expect(quoted?.textContent).toContain('値段はいくらですか？')
    })
  })

  it('予約パネルで日時を選ぶと予約が作られ、一覧に出て取消できる', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => {
      expect(host.textContent).toContain('値段はいくらですか？')
    })

    await typeText(host, '明日の朝に送ります')
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="schedule-toggle"]')!.click()
    })
    await eventually(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    })

    // 日時の選択（★管理画面）で 2027-09-17 09:00 を選ぶ。値は今までどおり日本時間の文字列。
    await act(async () => { document.querySelector<HTMLElement>('#schedule-at')!.click() })
    const dialog = () => document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')!
    for (let i = 0; i < 36; i += 1) {
      const grid = document.querySelector('[role="grid"]')
      if (grid?.getAttribute('aria-label') === '2027年9月') break
      await act(async () => {
        Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '次の月')!.click()
      })
    }
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? '').startsWith('2027年9月17日（金）'))!.click()
    })
    await setTimeControl(dialog().querySelector('input[role="combobox"]'), '09:00')
    await act(async () => { Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!.click() })

    const scheduleButton = Array.from(document.querySelectorAll('button'))
      .find((b) => /に予約$/.test(b.textContent ?? ''))!
    await act(async () => { scheduleButton.click() })
    await eventually(() => {
      expect(fixture.scheduled).toHaveLength(1)
      expect(fixture.scheduled[0].content).toBe('明日の朝に送ります')
    })

    // パネルは閉じる。もう一度開くと予約一覧に出る。
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="schedule-toggle"]')!.click()
    })
    await eventually(() => {
      const row = document.querySelector('[data-inbox-v6="scheduled-row"]')
      expect(row?.textContent).toContain('明日の朝に送ります')
    })

    const cancelButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '予約を取り消す')!
    await act(async () => { cancelButton.click() })
    await eventually(() => {
      expect(fixture.scheduled).toHaveLength(0)
      expect(document.querySelector('[data-inbox-v6="scheduled-row"]')).toBeNull()
    })
  })
})

/*
 * ★V8（ 段2）：書く欄の上に「送る日時」の段を出さず、［予約］から窓で開く。
 * 送信の設定は「送るキー」の切り替え、画像は「添付」で動画・ファイルは理由を出して止める。
 */
describe('★V8 書く欄：予約は窓・送るキーの切り替え・添付', () => {
  let host: HTMLDivElement
  let root: Root
  let values: Map<string, string>

  beforeEach(() => {
    fixture.params = new URLSearchParams('friend=friend-a')
    fixture.scheduled = []
    fixture.sentBodies = []
    values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
      Promise.resolve(responseFor(new URL(String(input), 'http://localhost'), init)))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.documentElement.dataset.theme = 'v8'
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    delete document.documentElement.dataset.theme
    vi.unstubAllGlobals()
  })

  it('［予約］で窓が開き、すぐ選ぶの日時で予約が作られ、窓が閉じる（書く欄の上の段は出ない）', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => { expect(host.textContent).toContain('値段はいくらですか？') })
    await typeText(host, '明日の朝に送ります')
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="schedule-toggle"]')!.click()
    })
    await eventually(() => {
      expect(document.querySelector('[role="dialog"][aria-labelledby]')?.textContent).toContain('予約して送る')
    })
    expect(document.querySelector('[data-inbox-v6="schedule-panel"]')).toBeNull()
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '明日 13:00')!.click()
    })
    const confirm = Array.from(document.querySelectorAll('button')).find((b) => /13:00 に予約$/.test(b.textContent ?? ''))!
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click() })
    await eventually(() => {
      expect(fixture.scheduled).toHaveLength(1)
      expect(fixture.scheduled[0].content).toBe('明日の朝に送ります')
      // 日本時間の 13:00 として送る（04:00 UTC）
      expect(fixture.scheduled[0].scheduledAt).toMatch(/T04:00:00/)
    })
    await eventually(() => {
      expect(Array.from(document.querySelectorAll('h2')).some((h) => h.textContent === '予約して送る')).toBe(false)
    })
    expect(fixture.sentBodies).toHaveLength(0)
  })

  it('送信の設定は「送るキー」の切り替え。選んだキーをこの端末に覚え、Enter で送れる', async () => {
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => { expect(host.textContent).toContain('値段はいくらですか？') })
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '送信の設定')!.click()
    })
    const group = document.querySelector('[role="group"][aria-label="送るキー"]')!
    expect(group).toBeTruthy()
    await act(async () => {
      Array.from(group.querySelectorAll('button')).find((b) => b.textContent === 'Enter')!.click()
    })
    await eventually(() => { expect(values.get('chat.sendMode')).toBe('enter') })
    expect(host.textContent).toContain('Enter で送る／Shift+Enter で改行（この端末に覚える）')
    await typeText(host, 'Enterで送る')
    const textarea = document.querySelector('textarea[aria-label="メッセージを入力"]') as HTMLTextAreaElement
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await eventually(() => { expect(fixture.sentBodies).toHaveLength(1) })
  })

  /*
   * （「7. 添付」I7Skn・API-15）：［添付］の道具はやめ、入力欄の左下のクリップから
   * 画像・動画／ファイルを選ぶ。ファイルは先に準備（アップロード）し、札を出してから本文と一緒に送る。
   */
  const pickFile = async (file: File) => {
    const input = document.querySelector('input[type=file][aria-label="ファイルを添付（ファイル）"]') as HTMLInputElement
    expect(input.accept).toContain('application/pdf')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  }

  it('［添付］の道具は無く、左下のクリップから選んだファイルを準備して、本文と一緒に送る', async () => {
    fixture.uploads = []
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => { expect(host.textContent).toContain('値段はいくらですか？') })
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === '添付')).toBe(false)
    expect(document.querySelector('button[aria-label="添付するものを選ぶ"]')).toBeTruthy()
    expect(host.textContent).toContain('画像・動画・ファイルを添付')
    await pickFile(new File(['%PDF-1.7'], '案内.pdf', { type: 'application/pdf' }))
    await eventually(() => {
      expect(fixture.uploads).toEqual([{ type: 'application/pdf', filename: encodeURIComponent('案内.pdf') }])
      expect(document.querySelector('[data-inbox-v8="attachment-chip"]')?.getAttribute('data-status')).toBe('ready')
    })
    expect(host.textContent).toContain('期限30日のリンクで届く')
    await typeText(host, '資料をお送りします')
    const send = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '送信する') as HTMLButtonElement
    await act(async () => { send.click() })
    await eventually(() => { expect(fixture.sentBodies).toHaveLength(2) })
    expect(fixture.sentBodies[0]).toMatchObject({ messageType: 'file', content: JSON.stringify({ attachmentId: '11111111-2222-4333-8444-555555555555' }) })
    expect(fixture.sentBodies[1]).toMatchObject({ content: '資料をお送りします' })
    await eventually(() => { expect(document.querySelector('[data-inbox-v8="attachment-chip"]')).toBeNull() })
  })

  it('送れない形式・大きすぎるものは、その場で理由を出して止める（何も上げない・送らない）', async () => {
    fixture.uploads = []
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => { expect(host.textContent).toContain('値段はいくらですか？') })
    await pickFile(new File(['a,b'], '名簿.csv', { type: 'text/csv' }))
    await eventually(() => { expect(host.textContent).toMatch(/のファイルを選んでください/) })
    const big = new File(['x'], '大きい.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 })
    await pickFile(big)
    await eventually(() => { expect(host.textContent).toContain('ファイルは10MBまでです') })
    expect(fixture.uploads).toHaveLength(0)
    expect(fixture.sentBodies).toHaveLength(0)
  })

  it('準備したファイルは予約でも送れる（ファイルの予約として作る）', async () => {
    fixture.scheduledTypes = []
    await act(async () => { root.render(<ChatsPage />) })
    await eventually(() => { expect(host.textContent).toContain('値段はいくらですか？') })
    await pickFile(new File(['%PDF-1.7'], '案内.pdf', { type: 'application/pdf' }))
    await eventually(() => {
      expect(document.querySelector('[data-inbox-v8="attachment-chip"]')?.getAttribute('data-status')).toBe('ready')
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[data-inbox-v6="schedule-toggle"]')!.click()
    })
    await eventually(() => {
      expect(document.querySelector('[role="dialog"][aria-labelledby]')?.textContent).toContain('ファイル「案内.pdf」')
    })
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '明日 13:00')!.click()
    })
    const confirm = Array.from(document.querySelectorAll('button')).find((b) => /13:00 に予約$/.test(b.textContent ?? ''))!
    await act(async () => { confirm.click() })
    await eventually(() => { expect(fixture.scheduledTypes).toEqual(['file']) })
    expect(fixture.sentBodies).toHaveLength(0)
  })
})
