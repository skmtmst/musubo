import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebinarNotificationOverview, WebinarNotificationSettings } from '@/lib/api'
import WebinarNotifications from '@/test-utils/webinar-notifications'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

/*
 * WEBINAR-09 — 設定がまだ無いウェビナーは「空」のまま終わらせない。
 *
 * 以前は `settings === null` で入力欄の無い空状態だけが返り、新しい
 * ウェビナーから通知設定を始める術がなかった。いまは
 * 「通知の設定を入力する」で**全部OFF**の初期値から編集に入れる。
 * あわせて、読み込み失敗と正常な未設定を言い分けることを見張る。
 */

const net = vi.hoisted(() => ({
  notifications: vi.fn(),
  saveNotifications: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal: () => Promise<typeof import('../../lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    webinarApi: {
      ...actual.webinarApi, actions: async () => ({ data: [] }), editor: async () => ({ data: { version: 2 } }),
      notifications: (...args: unknown[]) => net.notifications(...args),
      saveNotifications: (...args: unknown[]) => net.saveNotifications(...args),
    },
  }
})

const overview = (): WebinarNotificationOverview => ({
  total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0,
  skippedReasons: [],
  audience: { people: 0, bookings: 0, definition: 'active_registrations' },
})

const savedSettings = (): WebinarNotificationSettings => ({
  webinarId: 'w1',
  version: 1,
  registrationEnabled: false, dayBeforeEnabled: false, dayBeforeTime: '18:00',
  hourBeforeEnabled: false, hourBeforeMinutes: 60, startEnabled: false,
  missedEnabled: false, missedTime: '20:00', completedEnabled: false,
  updatedAt: '2026-09-22T00:00:00.000Z',
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  net.notifications.mockReset()
  net.saveNotifications.mockReset()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

async function mount() {
  // 保存の知らせは Toast（右下・4秒）で出す。置き場所も一緒に描く。
  clearToastsForTest()
  await act(async () => {
    root.render(<><WebinarNotifications webinarId="w1" /><ToastHost /></>)
  })
}

function button(text: string): HTMLButtonElement {
  const found = ([...host.querySelectorAll('button')].find((node) => node.textContent === text) ?? querySupplementaryPageAction(text))
  if (!found) throw new Error(`ボタンが見つかりません: ${text}`)
  return found as HTMLButtonElement
}

describe('通知の設定がまだ無いウェビナー（WEBINAR-09）', () => {
  it('読み込み中は失敗や未設定にしない', async () => {
    net.notifications.mockImplementation(() => new Promise(() => {}))
    await mount()
    expect(host.querySelector('[data-list-state="loading"]')).not.toBeNull()
    expect(host.textContent).not.toContain('通知の設定がまだありません')
    expect(host.textContent).not.toContain('通知の設定を読み込めませんでした')
  })
  it('返事の器が不正なら失敗として表示する', async () => {
    net.notifications.mockResolvedValue({ data: null })
    await mount()
    expect(host.textContent).toContain('通知の設定を読み込めませんでした')
    expect(host.textContent).not.toContain('通知の設定がまだありません')
  })
  it('返事が物でないなら失敗として表示する', async () => {
    net.notifications.mockResolvedValue({ data: 'unexpected' })
    await mount()
    expect(host.textContent).toContain('通知の設定を読み込めませんでした')
    expect(host.textContent).not.toContain('通知の設定がまだありません')
  })
  it('未設定には入力入口を出し、押すと全部OFFの編集に入る', async () => {
    net.notifications.mockResolvedValue({ data: { settings: null, overview: overview() } })
    await mount()

    // 空状態には文言と入口がある。ここで止まると設定を始められない。
    expect(host.textContent).toContain('通知の設定がまだありません')
    const entry = button('通知の設定を入力する')

    await act(async () => { entry.click() })

    // 編集面が出る。勝手にONになっている通知は1つもない。
    expect(host.querySelector('section[aria-labelledby="webinar-notify-title"]')).not.toBeNull()
    const toggles = [...host.querySelectorAll('[role="switch"]')] as HTMLInputElement[]
    expect(toggles.length).toBe(6)
    for (const toggle of toggles) {
      expect((toggle.getAttribute('aria-checked') === 'true'), `${toggle.getAttribute('aria-label')} が勝手にONになっている`).toBe(false)
    }
  })

  it('入口から入った初期値のまま保存すると、全部OFFの設定として保存できる', async () => {
    // 1回目の読み込みは未設定。保存後の取り直しでは保存済みを返す。
    net.notifications
      .mockResolvedValueOnce({ data: { settings: null, overview: overview() } })
      .mockResolvedValue({ data: { settings: savedSettings(), overview: overview() } })
    net.saveNotifications.mockResolvedValue({
      data: { settings: savedSettings(), queued: 0, cancelled: 0 },
    })
    await mount()
    await act(async () => { button('通知の設定を入力する').click() })
    await act(async () => { button('下書きを保存').click() })

    expect(net.saveNotifications).toHaveBeenCalledWith('w1', {
      registrationEnabled: false,
      dayBeforeEnabled: false,
      dayBeforeTime: '18:00',
      hourBeforeEnabled: false,
      hourBeforeMinutes: 60,
      startEnabled: false,
      missedEnabled: false,
      missedTime: '20:00',
      missedWindowDays: 7,
      completedEnabled: false,
    })
    expect(host.textContent).toContain('保存しました。')
  })

  it('読み込み失敗は「未設定」と混ぜず、もう一度読み込める', async () => {
    net.notifications.mockRejectedValueOnce(new Error('network down'))
    await mount()

    // 失敗は失敗のまま出る。未設定の文や入口は出さない。
    expect(host.textContent).toContain('通知の設定を読み込めませんでした')
    expect(host.textContent).not.toContain('通知の設定がまだありません')

    net.notifications.mockResolvedValueOnce({ data: { settings: null, overview: overview() } })
    await act(async () => { button('もう一度読み込む').click() })

    // 復帰すると、正常な未設定（入口つき）へ戻る。
    expect(host.textContent).toContain('通知の設定がまだありません')
    expect(button('通知の設定を入力する')).toBeTruthy()
  })
})
