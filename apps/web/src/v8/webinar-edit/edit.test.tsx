import { getPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'

import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditPage from '@/app/webinars/edit/page'
import WebinarEditV8 from './edit'

;
import { fireEvent, screen, within } from '@testing-library/react'
// @vitest-environment happy-dom
/*
 * V8 ウェビナーの編集（src/v8/webinar-edit）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * - 入口（app/webinars/edit/page.tsx）は V8 のときだけこの画面を出す
 * - 参加者・分析・コメント演出は詳細の頭とタブ、作る手順の段は5段の帯
 * - 閲覧のみ（staff）には、押せないボタンを置かない（変える操作は隠す）
 * - コメント演出はその場で直して、秒の順に並べて保存する
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
});

const routerPush = vi.hoisted(() => vi.fn())
const nav = vi.hoisted(() => ({ search: 'id=webinar-1&pane=participants' }))
const roleState = vi.hoisted(() => ({ role: 'owner' as string | null }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webinars/edit',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店', liffId: 'liff-1' }], loading: false }),
}));
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => roleState.role }
});


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const webinar = {
  id: 'webinar-1', accountId: 'account-a', title: 'NEN活用スタートセミナー', slug: 'nen-start', status: 'active',
  videoPrefix: 'webinars/nen-start.mp4', durationSeconds: 872, schedule: [{ type: 'daily', time: '10:00' }], cta: null,
  tagOnAttend: null, tagOnCtaClick: null, publicationState: 'always', publicationStartsAt: null, publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
}
const editor = {
  version: 3, deliveryKind: 'on_demand', ctaCount: 1, viewingCondition: { kind: 'registered', label: '申込者向け' },
  publicDescription: '15分で使い方がわかる', registrationFormId: null,
  notificationMessages: { dayBefore: '明日からです' }, notificationTest: null,
  actionPolicy: { templateBody: 'ありがとうございました', missingResultPolicy: 'escalate' },
  publicPage: { liffId: 'liff-1', url: 'https://liff.line.me/liff-1/webinar/nen-start', unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'active', draftVersion: 3, publishedVersion: 3, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}
const analytics = {
  summary: { reservations: 124, viewers: 100, registeredAndJoined: 100, watched5m: 90, watched15m: 80, completed: 71, avgWatchedSeconds: 372, ctaClicks: 23, formSubmissions: 9 },
  daily: [], participants: [], sessions: [], dropoff: [], viewSegments: [],
  retention: { bucketSeconds: 60, started: 100, points: [{ atSeconds: 0, viewers: 100 }, { atSeconds: 600, viewers: 70 }] },
  heartbeatRejects: 0, ctaAtSeconds: 300, measurement: { state: 'available', reason: null }, formFunnel: null,
}
const participants = {
  items: [
    { friendId: 'f-1', friendName: 'Demo Person', pictureUrl: null, sessions: 2, registered: true, firstJoinedAt: '2026-09-30T01:12:00Z', latestJoinedAt: '2026-09-30T01:12:00Z', maxWatchedSeconds: 872, ctaClickedAt: '2026-09-30T01:20:00Z', formSubmittedAt: null, classification: 'completed' },
    { friendId: 'f-2', friendName: '見本 141', pictureUrl: null, sessions: 0, registered: true, firstJoinedAt: null, latestJoinedAt: null, maxWatchedSeconds: 0, ctaClickedAt: null, formSubmittedAt: null, classification: 'unviewed' },
  ],
  nextCursor: null,
}
let comments = [
  { atSeconds: 45, authorName: 'まさ', body: 'わかりやすい！' },
  { atSeconds: -60, authorName: '田中', body: 'こんばんは' },
]
const puts: Array<{ path: string; body: unknown }> = []
const conflictState = vi.hoisted(() => ({ ctas: false, actions: false }))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const notificationSettings = { webinarId: 'webinar-1', version: 1, registrationEnabled: true, dayBeforeEnabled: true, dayBeforeTime: '19:00', hourBeforeEnabled: false, hourBeforeMinutes: 15, startEnabled: true, missedEnabled: false, missedTime: '10:00', missedWindowDays: 3, completedEnabled: true, updatedAt: '' }
let notificationReads = 0

const analyticsNet = { hold: false, pending: [] as Array<(value: Response) => void> }
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  clearToastsForTest()
  notificationReads = 0
  analyticsNet.hold = false
  analyticsNet.pending.length = 0
  routerPush.mockReset()
  document.documentElement.dataset.theme = 'v8'
  roleState.role = 'owner'
  puts.length = 0
  conflictState.ctas = false
  conflictState.actions = false
  comments = [
    { atSeconds: 45, authorName: 'まさ', body: 'わかりやすい！' },
    { atSeconds: -60, authorName: '田中', body: 'こんばんは' },
  ]
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname
    const method = init?.method ?? 'GET'
    if (method === 'POST' && path.endsWith('/duplicate')) { puts.push({ path, body: JSON.parse(String(init?.body)) }); return json({ data: { ...webinar, id: 'copied-webinar', status: 'draft' } }) }
    if (method === 'POST' && path.endsWith('/pause')) { puts.push({ path, body: JSON.parse(String(init?.body)) }); return json({ data: { ...webinar, status: 'paused' } }) }
    if (method === 'PUT') {
      puts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (conflictState.ctas && path.endsWith('/ctas')) return json({ success: false, error: 'ほかの人が保存しました', code: 'version_conflict' }, 409)
      if (path.endsWith('/notifications')) return json({ data: { settings: { ...notificationSettings, ...JSON.parse(String(init?.body)), version: 2 }, queued: 2, cancelled: 1 } })
      if (path.endsWith('/actions')) {
        if (conflictState.actions) return json({ success: false, error: '保存できませんでした' }, 503)
        return json({ data: JSON.parse(String(init?.body)).actions })
      }
      if (path.endsWith('/comments')) return json({ data: { count: (JSON.parse(String(init?.body)) as { comments: unknown[] }).comments.length } })
      return json({ data: { count: 0 } })
    }
    if (path === '/api/webinars/webinar-1') return json({ data: webinar })
    if (path === '/api/webinars/webinar-2') return json({ data: { ...webinar, id: 'webinar-2', title: '次のウェビナー' } })
    if (path.endsWith('/editor')) return json({ data: editor })
    if (path.endsWith('/analytics')) {
      if (analyticsNet.hold) return new Promise<Response>(done => analyticsNet.pending.push(done))
      return json({ data: analytics })
    }
    if (path.endsWith('/participants')) return json({ data: participants })
    if (path.endsWith('/user-comments')) return json({ data: [] })
    if (path.endsWith('/comments')) return json({ data: comments })
    if (path.endsWith('/notifications')) { notificationReads += 1; return json({ data: { settings: notificationSettings, overview: { total: 10, pending: 0, sent: 9, failed: 1, skipped: 0, cancelled: 0, skippedReasons: [], audience: { people: 10, bookings: 10, definition: 'active_registrations' } } } }) }
    if (path.endsWith('/actions')) return json({ data: [] })
    if (path.endsWith('/ctas')) return json({ data: [{ atSeconds: 300, kind: 'url', title: '資料', body: null, buttonLabel: '受け取る', autoOpen: false, formId: null, url: 'https://example.com' }] })
    if (path.endsWith('/video-asset')) return json({ data: { asset: null } })
    if (path.endsWith('/publish-validation')) return json({ data: { version: 3, checks: [{ key: 'video_ready', label: '動画の準備ができている', status: 'passed', detail: null }], blockers: [], warnings: [] } })
    if (path === '/api/common-actions/resources') return json({ success: true, data: { tags: [{ id: 'tag-owner', name: '完了のタグ' }], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [] } })
    if (path === '/api/forms') return json({ success: true, data: [] })
    if (path.includes('/folders')) return json({ success: true, data: [] })
    return json({ data: null })
  })
});

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
});

async function render(node: React.ReactNode) {
  await act(async () => { root.render(<>{node}<ToastHost /></>) })
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const buttonText = (text: string) => (buttons().find((button) => button.textContent?.trim() === text) ?? querySupplementaryPageAction(text))

describe('V8 ウェビナーの編集', () => {
  it('現在の通知の補足は有効フラグで組み立て、切ってある通知の時刻を出さない', async () => {
    nav.search = 'id=webinar-1&pane=notifications'
    await render(<WebinarEditV8 />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '送った数と通知の対象' })))
    const summary = screen.getByRole('button', { name: '送った数と通知の対象' }).parentElement!.querySelector('[role="note"]')!
    expect(summary.textContent).toContain('前日 19:00／開始時')
    expect(summary.textContent).toContain('送りません')
    expect(summary.textContent).toContain('見終わった人へお礼を送信')
    expect(summary.textContent).not.toContain('15分前')
    expect(summary.textContent).not.toContain('翌日10:00に送信')
    expect(screen.getByText('設定済み').closest('[data-design-node="xRvDB"]')?.getAttribute('data-tone')).toBe('success')
  })

  it('入口は保存された古いテーマがあっても現役のV8を出す', async () => {
    nav.search = 'id=webinar-1&pane=participants'
    await render(<EditPage />)
    expect(host.querySelector('[data-wc-editor="v8"]')).toBeTruthy()
    document.documentElement.dataset.theme = 'v7'
    act(() => { root.unmount() })
    root = createRoot(host)
    await render(<EditPage />)
    expect(host.querySelector('[data-wc-editor="v8"]')).toBeTruthy()
  })

  it('参加者（uNsEy）：頭・タブ（参加者の人数つき）・数の帯・表・チャットへの道', async () => {
    nav.search = 'id=webinar-1&pane=participants'
    await render(<WebinarEditV8 />)
    expect(host.textContent).toContain('NEN活用スタートセミナー')
    await act(async () => { (host.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement)?.click() })
    expect(host.textContent).toContain('オンデマンド・いつでも視聴・公開中（版 3）')
    const tabs = host.querySelector('[role="tablist"]')
    expect(tabs?.textContent).toContain('参加者 124')
    expect(tabs?.querySelector('[aria-current="page"]')?.textContent).toBe('参加者 124')
    expect(host.textContent).toContain('視聴完了 71')
    expect(host.textContent).toContain('平均離脱時間 —')
    expect(host.textContent).not.toContain('平均 6分で離脱')
    expect(host.textContent).toContain('見ていない・見逃し案内の対象')
    const menu = host.querySelector('tr[data-row-id="f-1"] button[aria-haspopup="menu"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    const chat = document.querySelector('a[href="/chats?friend=f-1"]')
    expect(chat?.textContent).toContain('チャットを見る')
    expect(buttonText('CSVで書き出す')).toBeTruthy()
  })

  it('分析のフォーム送信はAPIの重複を除いた人数として帯と棒の両方に表示する', async () => {
    nav.search = 'id=webinar-1&pane=analytics'
    await render(<WebinarEditV8 />)
    const funnel = host.querySelector('#webinar-analytics-funnel')
    const row = ([...(funnel?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes('フォーム送信')) ?? querySupplementaryPageAction('フォーム送信'))
    expect(row?.textContent).toContain('9人')
    const stats = host.querySelector('[data-template-region="stats"]')
    const metric = ([...(stats?.querySelectorAll('[data-kpi-presentation]') ?? [])].find(item => item.querySelector('[data-kpi-label]')?.textContent === 'フォーム送信') ?? querySupplementaryPageAction('フォーム送信'))
    expect(metric?.querySelector('[data-kpi-number]')?.textContent).toBe('9')
    expect(metric?.textContent).toContain('9人')
    expect(metric?.textContent).not.toContain('9件')
    const help = metric?.querySelector('[data-kpi-label] button') as HTMLButtonElement
    await act(async () => { help.click() })
    expect(help.getAttribute('aria-expanded')).toBe('true')
  })

  it('コメントの見え方は開始前2件で埋めず、開始後の最初のコメントも出す', async () => {
    comments = [
      { atSeconds: -30, authorName: 'さくら', body: '音声きこえます' },
      { atSeconds: -60, authorName: '田中', body: 'こんばんは' },
      { atSeconds: 45, authorName: 'まさ', body: 'わかりやすい！' },
    ]
    nav.search = 'id=webinar-1&pane=comments'
    await render(<WebinarEditV8 />)
    const preview = host.querySelector('aside[aria-labelledby="webinar-comments-preview"]')
    expect(preview?.textContent).toContain('まさ：わかりやすい！')
    expect(preview?.textContent).toContain('田中：こんばんは')
    expect(preview?.textContent).not.toContain('さくら：音声きこえます')
    // 狭い幅で開く欄にも同じ見本を渡す。
    expect(host.querySelector('details')?.textContent).toContain('まさ：わかりやすい！')
  })

  it('作る手順の段（④通知）：5段の帯から別の段へ移れる', async () => {
    nav.search = 'id=webinar-1&pane=notifications'
    await render(<EditPage />)
    expect(host.textContent).toContain('通知と視聴後のこと')
    expect(host.querySelector('[data-page-template="create"] [data-template-region="content"]')?.textContent).toContain('通知とリマインド')
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('通知')
    expect(host.querySelector('[aria-label="設定済みの内容"]')?.textContent).toContain('動画あり・配信枠 1件')
    const video = host.querySelector('[aria-label="動画を変える"]') as HTMLButtonElement | null
    expect(video).toBeTruthy()
    await act(async () => { video!.click() })
    for (let i = 0; i < 4; i += 1) await act(async () => {})
    expect(host.textContent).toContain('動画と公開期間')
  })

  it('対象を選んだ後に行を追加し、下書きの帯から視聴後の動きを保存する', async () => {
    nav.search = 'id=webinar-1&pane=notifications'
    await render(<WebinarEditV8 />)
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '行うことを足す' })[0]))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /タグを付ける/ })))
    const dialog = screen.getByRole('dialog', { name: 'タグを付ける対象を選ぶ' })
    await act(async () => fireEvent.click(within(dialog).getByRole('radio', { name: '完了のタグ' })))
    expect(puts.filter(item => item.path.endsWith('/actions'))).toHaveLength(0)
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' })))
    await act(async () => buttonText('下書きを保存')!.click())
    expect(puts.find(item => item.path.endsWith('/actions'))?.body).toEqual({ actions: [{ trigger: 'completed', actionType: 'add_tag', config: { tagId: 'tag-owner' } }] })
    expect(screen.getByRole('button', { name: '完了のタグ' })).toBeTruthy()
  })

  it('保存に失敗しても行を残し、もう一度保存できる', async () => {
    nav.search = 'id=webinar-1&pane=notifications'
    await render(<WebinarEditV8 />)
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: '行うことを足す' })[0]))
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /リッチメニューを外す/ })))
    conflictState.actions = true
    await act(async () => buttonText('下書きを保存')!.click())
    expect(host.textContent).toContain('保存できませんでした')
    expect(screen.getByRole('button', { name: 'リッチメニューを外す' })).toBeTruthy()
    conflictState.actions = false
    await act(async () => buttonText('下書きを保存')!.click())
    expect(puts.filter(item => item.path.endsWith('/actions'))).toHaveLength(2)
  })

  it('閲覧のみ（staff）には、押せないボタンを置かない（通知・CTA・コメント演出）', async () => {
    roleState.role = 'staff'
    for (const pane of ['notifications', 'cta', 'comments', 'basic', 'video', 'review']) {
      nav.search = `id=webinar-1&pane=${pane}`
      act(() => { root.unmount() })
      root = createRoot(host)
      await render(<WebinarEditV8 />)
      const disabled = buttons().filter((button) => button.disabled && host.contains(button))
      expect(disabled.map((button) => `${pane}:${button.textContent?.trim() || button.getAttribute('aria-label')}`)).toEqual([])
      expect(buttonText('下書きを保存')).toBeUndefined()
      expect(buttons().some((button) => /テストを送る|条件を足す|保存する|コメントを足す|案内ボタンのカードを足す|この版を公開/.test(button.textContent ?? ''))).toBe(false)
    }
  })

  it('コメント演出（Omqd4）：その場で直して、秒の順に並べて保存する', async () => {
    nav.search = 'id=webinar-1&pane=comments'
    await render(<WebinarEditV8 />)
    const body = host.querySelector('input[aria-label="1 行目の本文"]') as HTMLInputElement
    expect(body.value).toBe('わかりやすい！')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(body, 'とてもわかりやすい')
      body.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = (buttons().find((button) => button.textContent?.includes('保存する')) ?? querySupplementaryPageAction('保存する'))
    expect(save).toBeTruthy()
    await act(async () => { save!.click() })
    for (let i = 0; i < 4; i += 1) await act(async () => {})
    const put = puts.find((entry) => entry.path.endsWith('/comments'))
    expect(put?.body).toEqual({ comments: [
      { atSeconds: -60, authorName: '田中', body: 'こんばんは' },
      { atSeconds: 45, authorName: 'まさ', body: 'とてもわかりやすい' },
    ] })
    expect(document.body.textContent).toContain('2件保存しました')
  })
  it('CTA：別のカードに足りない欄があると、そのカードを開いて見出しの欄へ移り、カードの行に赤い印を付ける', async () => {
    nav.search = 'id=webinar-1&pane=cta'
    await render(<WebinarEditV8 />)
    await act(async () => { buttonText('案内ボタンのカードを足す')!.click() })
    // 1枚目（足りている）へ戻ってから保存する
    const picks = () => [...host.querySelectorAll('[data-wc-pane="cta"] button[aria-current], [data-wc-pane="cta"] button')].filter((b) => b.className.includes('cardPick')) as HTMLButtonElement[]
    await act(async () => { picks()[0].click() })
    expect((host.querySelector('#cta-title') as HTMLInputElement).value).toBe('資料')
    const before = puts.length
    await act(async () => { buttonText('下書きを保存')!.click() })
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(puts.length).toBe(before)
    expect(picks()[1].getAttribute('aria-current')).toBe('true')
    const title = host.querySelector('#cta-title') as HTMLInputElement
    expect(title.value).toBe('')
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(title)
    expect(host.querySelector('#cta-title-error')?.textContent).toBe('カードの見出しを入れてください')
    expect(host.querySelector('#cta-button-error')?.textContent).toBe('ボタンに出す文字を入れてください')
    expect(host.querySelector('#cta-link-error')?.textContent).toContain('公開中のフォームを選ぶ')
    const badges = [...host.querySelectorAll('[data-design-part="error-count-badge"]')]
    expect(badges.map((b) => b.getAttribute('aria-label'))).toEqual(['カード2に直す欄が3か所'])
    await act(async () => { picks()[0].click() })
    expect(host.querySelector('#cta-title')?.getAttribute('aria-invalid')).toBeNull()
  })

  it('動画：差し替えの長さが空なら保存せず、長さの欄に理由を出して移る', async () => {
    nav.search = 'id=webinar-1&pane=video'
    await render(<WebinarEditV8 />)
    const before = puts.length
    await act(async () => { buttonText('差し替える')!.click() })
    const minutes = host.ownerDocument.getElementById('wd-minutes') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(minutes, '')
      minutes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { ([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === '保存する') ?? querySupplementaryPageAction('保存する'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(puts.length).toBe(before)
    expect(document.getElementById('wd-minutes-error')?.textContent).toBe('動画の長さ（分）を入れてください。')
    expect(minutes.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(minutes)
  })

  it('CTA（pvimJ）：保存が競合したら帯を左右の列の上に出し、下書きの保存を「比べてから保存」に替える', async () => {
    conflictState.ctas = true
    nav.search = 'id=webinar-1&pane=cta'
    await render(<WebinarEditV8 />)
    expect(host.querySelector('[data-design-node="pvimJ"]')).toBeNull()
    await act(async () => { buttonText('下書きを保存')!.click() })
    for (let i = 0; i < 6; i += 1) await act(async () => {})
    const band = host.querySelector('[data-design-node="pvimJ"][role="alert"]')
    expect(band?.textContent).toContain('このまま保存すると、相手の変更が消えます')
    expect(buttonText('下書きを保存')).toBeUndefined()
    expect(buttonText('比べてから保存')).toBeTruthy()
    expect([...host.querySelectorAll('a')].some((link) => link.textContent?.trim() === 'キャンセル')).toBe(true)
  })

  it('CTAの自動表示をスイッチで切り替え、ほかのカードの内容と一緒に保存する', async () => {
    nav.search = 'id=webinar-1&pane=cta'
    await render(<WebinarEditV8 />)
    const toggle = screen.getByRole('switch', { name: 'ボタンを押したら、フォームを自動で開く' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fireEvent.click(toggle) })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => { buttonText('下書きを保存')!.click() })
    for (let i = 0; i < 4; i += 1) await act(async () => {})
    const saved = puts.find(entry => entry.path.endsWith('/ctas'))?.body as { ctas: Array<{ autoOpen: boolean; title: string; url: string }> }
    expect(saved.ctas).toEqual([expect.objectContaining({ autoOpen: true, title: '資料', url: 'https://example.com' })])
  })

  it('フォームの候補が持つフォルダで絞り込める', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/forms') return json({ success: true, data: [{ id: 'form-lead', name: '相談の申込', isActive: true, folderId: 'lead' }] })
      if (path.includes('/folders')) return json({ success: true, data: [{ id: 'lead', name: '相談受付', color: '#2563eb', kind: 'form', parentId: null, displayOrder: 0 }] })
      return originalFetch(input, init)
    })
    nav.search = 'id=webinar-1&pane=cta'
    await render(<WebinarEditV8 />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^申込に使う回答フォーム：/ })) })
    const picker = await screen.findByRole('dialog', { name: '回答フォームを選ぶ' })
    const folder = await within(picker).findByRole('button', { name: /相談受付/ })
    await act(async () => { fireEvent.click(folder) })
    await act(async () => { fireEvent.click(within(picker).getByRole('radio', { name: '相談の申込' })) })
    await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: '選ぶ', exact: true })) })
    expect(screen.getByRole('button', { name: '申込に使う回答フォーム：変える' })).toBeTruthy()
    expect(puts).toHaveLength(0)
  })
});

it('WEB-166：公開中は編集の…から版を確認して停止する', async () => {
  await render(<WebinarEditV8 />)
  const menu = buttons().find(b => b.getAttribute('aria-label') === 'ウェビナーの操作')!
  expect(menu).toBeTruthy()
  await act(async () => { menu.click() })
  const pause = ([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === '停止') ?? querySupplementaryPageAction('停止')) as HTMLElement
  expect(pause.textContent).toContain('停止')
  await act(async () => { pause.click() })
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
  expect(dialog?.textContent).toContain('LINEアカウント')
  expect(dialog?.textContent).toContain('本店')
  expect(dialog?.textContent).toContain('検証環境')
  const confirm = (buttons().find(b => b.textContent?.trim() === '停止する') ?? querySupplementaryPageAction('停止する'))!
  expect(confirm).toBeTruthy()
  await act(async () => { confirm.click() })
  expect(puts.some(p => p.path.endsWith('/pause') && (p.body as { expectedVersion: number }).expectedVersion === 3)).toBe(true)
});


it('停止の確認中に対象ウェビナーが切り替わると古い窓から停止しない', async () => {
  await render(<WebinarEditV8 />)
  await act(async () => { buttons().find(b => b.getAttribute('aria-label') === 'ウェビナーの操作')!.click() })
  const choice = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === '停止') as HTMLElement
  await act(async () => { choice.click() })
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain('停止')
  nav.search = 'id=webinar-2&pane=basic'
  await render(<WebinarEditV8 />)
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? '').not.toContain('停止しますか')
  expect(puts.some(p => p.path.endsWith('/pause'))).toBe(false)
})

it('編集の複製は保存済みの版を送り、一覧で下書きを光らせる行き先へ移る', async () => {
  nav.search = 'id=webinar-1&pane=participants'
  await render(<WebinarEditV8 />)
  await act(async () => { buttons().find(b => b.getAttribute('aria-label') === 'ウェビナーの操作')!.click() })
  const duplicate = ([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === '複製する') ?? querySupplementaryPageAction('複製する')) as HTMLElement
  await act(async () => { duplicate.click() })
  expect(puts).toContainEqual({ path: '/api/webinars/webinar-1/duplicate', body: { expectedVersion: 3 } })
  expect(routerPush).toHaveBeenCalledWith('/webinars?status=draft&highlight=copied-webinar')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
});

it('集計の通信中に段を移っても重複せず、相手切替前の遅い応答を捨てる', async () => {
  analyticsNet.hold = true
  nav.search = 'id=webinar-1&pane=participants'
  await render(<WebinarEditV8 />)
  expect(analyticsNet.pending).toHaveLength(1)
  nav.search = 'id=webinar-1&pane=analytics'
  await render(<WebinarEditV8 />)
  expect(analyticsNet.pending).toHaveLength(1)
  nav.search = 'id=webinar-2&pane=analytics'
  await render(<WebinarEditV8 />)
  expect(analyticsNet.pending).toHaveLength(2)
  await act(async () => { analyticsNet.pending[1](json({ data: { ...analytics, summary: { ...analytics.summary, reservations: 222 } } })) })
  expect(host.textContent).toContain('222')
  await act(async () => { analyticsNet.pending[0](json({ data: { ...analytics, summary: { ...analytics.summary, reservations: 111 } } })) })
  expect(host.textContent).toContain('222')
  expect(host.textContent).not.toContain('111')
})

// webinar-notifications-contractのソース文字固定を、実際の親と子の動きへ移す。
it('通知の段は初回だけ取得し、段を移ってブラウザで戻っても入力と未保存の印を保ち、親から保存できる', async () => {
  nav.search = 'id=webinar-1&pane=notifications'
  await render(<WebinarEditV8 />)
  expect(notificationReads).toBe(1)
  expect(host.textContent).not.toContain('保存していない変更があります')
  const toggle = screen.getByRole('switch', { name: '申込のお礼', exact: true }) as HTMLInputElement
  expect((toggle.getAttribute('aria-checked') === 'true')).toBe(true)
  await act(async () => { fireEvent.click(toggle) })
  expect((toggle.getAttribute('aria-checked') === 'true')).toBe(false)
  expect(host.textContent).toContain('保存していない変更があります')
  expect(puts.filter(row => row.path.endsWith('/notifications'))).toHaveLength(0)
  await act(async () => { screen.getByRole('button', { name: '基本設定に戻る', exact: true }).click() })
  await act(async () => {
    window.history.replaceState(null, '', '?id=webinar-1&pane=notifications')
    window.dispatchEvent(new Event('popstate'))
  })
  const leave = await screen.findByRole('dialog', { name: '保存していない変更があります' })
  await act(async () => { within(leave).getByRole('button', { name: '編集を続ける' }).click() })
  expect(notificationReads).toBe(1)
  const returned = screen.getByRole('switch', { name: '申込のお礼', exact: true }) as HTMLInputElement
  expect(returned).toBe(toggle)
  expect((returned.getAttribute('aria-checked') === 'true')).toBe(false)
  const save = getPageAction({ name: '下書きを保存', exact: true }) as HTMLButtonElement
  expect(save.disabled).toBe(false)
  await act(async () => { save.click() })
  const writes = puts.filter(row => row.path.endsWith('/notifications'))
  expect(writes).toHaveLength(1)
  expect(writes[0].body).toMatchObject({ registrationEnabled: false })
  expect((returned.getAttribute('aria-checked') === 'true')).toBe(false)
  expect(host.textContent).not.toContain('保存していない変更があります')
})
