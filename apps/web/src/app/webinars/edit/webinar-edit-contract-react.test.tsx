import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * V8 ウェビナーの編集画面を描いて押す契約。
 * - 古い URL の段（actions・preview）は今の段（通知・確認）で開く
 * - 集計は公開後に見る3つの段を開いたときだけ1回取り、子は親から受け取る
 * - 通知・CTA は子の段が1回だけ取り、CTA の枚数は子の報告（取得・保存）で親の要約に流す
 * - 公開ページは、編集の口が検査した URL だけを公開中のときに別窓で開き、開けない理由を言い分ける
 * - 分析の CSV は参加者の口から書き出す
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
  return {
    search: 'id=webinar-1&pane=notifications',
    accountsLoading: false,
    accounts: [{ id: 'account-a', name: '本店', liffId: 'liff-1' }] as Array<{ id: string; name: string; liffId: string | null }>,
  }
})
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webinars/edit',
  useSearchParams: () => new URLSearchParams(state.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: state.accounts[0] ?? null, accounts: state.accounts, loading: state.accountsLoading }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({ ...(await importOriginal()), useStaffRole: () => 'owner' }))

import WebinarEditV8 from '@/v8/webinar-edit/edit'
import { clearApiReadCache } from '@/lib/api/transport/read-cache'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PUBLIC_URL = 'https://liff.line.me/liff-1/webinar/nen-start'
let webinar: Record<string, unknown>
const editor = {
  version: 3, deliveryKind: 'on_demand', ctaCount: 0, viewingCondition: { kind: 'registered', label: '申込者向け' },
  publicDescription: '', registrationFormId: null, notificationMessages: {}, notificationTest: null,
  actionPolicy: { templateBody: '', missingResultPolicy: 'escalate' },
  publicPage: { liffId: 'liff-1', url: PUBLIC_URL, unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'active', draftVersion: 3, publishedVersion: 3, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}
const analytics = {
  summary: { reservations: 10, viewers: 8, registeredAndJoined: 8, watched5m: 6, watched15m: 5, completed: 4, avgWatchedSeconds: 300, ctaClicks: 2, formSubmissions: 1 },
  daily: [], participants: [], sessions: [], dropoff: [], viewSegments: [],
  retention: { bucketSeconds: 60, started: 8, points: [{ atSeconds: 0, viewers: 8 }, { atSeconds: 600, viewers: 4 }] },
  heartbeatRejects: 0, ctaAtSeconds: 300, measurement: { state: 'available', reason: null }, formFunnel: null,
}
const notificationSettings = { webinarId: 'webinar-1', version: 1, registrationEnabled: true, dayBeforeEnabled: false, dayBeforeTime: '19:00', hourBeforeEnabled: false, hourBeforeMinutes: 15, startEnabled: false, missedEnabled: false, missedTime: '10:00', missedWindowDays: 3, completedEnabled: false, updatedAt: '' }
const CARD = { atSeconds: 300, kind: 'url', title: '資料', body: null, buttonLabel: '受け取る', autoOpen: false, formId: null, url: 'https://example.com' }

let requests: Array<{ method: string; path: string; body: unknown }> = []
const gets = (suffix: string) => requests.filter((request) => request.method === 'GET' && request.path.endsWith(suffix)).length
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/webinars/edit')
  // 取得の回数を数えるので、前の試験の GET の控えを残さない。
  clearApiReadCache()
  state.search = 'id=webinar-1&pane=notifications'
  state.accountsLoading = false
  state.accounts = [{ id: 'account-a', name: '本店', liffId: 'liff-1' }]
  webinar = {
    id: 'webinar-1', accountId: 'account-a', title: 'NEN活用スタートセミナー', slug: 'nen-start', status: 'active',
    videoPrefix: 'webinars/nen-start.mp4', durationSeconds: 872, schedule: [], cta: null, tagOnAttend: null, tagOnCtaClick: null,
    publicationState: 'always', publicationStartsAt: null, publicationEndsAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }
  requests = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, path, body })
    if (method === 'PUT' && path.endsWith('/ctas')) return json({ data: (body as { ctas: unknown[] }).ctas })
    if (method === 'PUT') return json({ data: { count: 0 } })
    if (path === '/api/webinars/webinar-1') return json({ data: webinar })
    if (path.endsWith('/editor')) return json({ data: editor })
    if (path.endsWith('/analytics')) return json({ data: analytics })
    if (path.endsWith('/participants.csv')) return new Response('name\n', { status: 200, headers: { 'Content-Type': 'text/csv' } })
    if (path.endsWith('/participants')) return json({ data: { items: [], nextCursor: null } })
    if (path.endsWith('/user-comments')) return json({ data: [] })
    if (path.endsWith('/comments')) return json({ data: [] })
    if (path.endsWith('/notifications')) return json({ data: { settings: notificationSettings, overview: null } })
    if (path.endsWith('/actions')) return json({ data: [] })
    if (path.endsWith('/ctas')) return json({ data: [CARD] })
    if (path.endsWith('/video-asset')) return json({ data: { asset: null } })
    if (path.endsWith('/publish-validation')) return json({ data: { version: 3, checks: [], blockers: [], warnings: [] } })
    if (path === '/api/common-actions/resources') return json({ success: true, data: { tags: [], scenarios: [], templates: [], webhooks: [], richMenus: [], commonActions: [] } })
    if (path === '/api/forms') return json({ success: true, data: [] })
    if (path.includes('/folders')) return json({ success: true, data: [] })
    return json({ data: null })
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function render() {
  await act(async () => { root.render(<WebinarEditV8 />) })
  for (let i = 0; i < 8; i += 1) await act(async () => {})
}
/* 一度開いた段は隠して残すので、いま見えている段の要約だけを読む。 */
const summary = () => [...host.querySelectorAll('[aria-label="設定済みの内容"]')].find((element) => !element.closest('[hidden]'))?.textContent ?? ''
/* ブラウザの戻る・進むと同じ道（URL の pane と popstate）で段を移る。 */
async function goStep(pane: string) {
  await act(async () => {
    window.history.replaceState(null, '', `/webinars/edit?id=webinar-1&pane=${pane}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
}
const tab = (label: string) => [...host.querySelectorAll('[role="tablist"] button, [role="tablist"] a, [role="tab"]')].find((element) => element.textContent?.startsWith(label)) as HTMLElement

it('古い URL の actions は通知の段、preview は確認の段で開く', async () => {
  state.search = 'id=webinar-1&pane=actions'
  await render()
  expect(host.querySelector('[data-design-node="E7iAYs"]')).not.toBeNull()
  act(() => { root.unmount() })
  root = createRoot(host)
  state.search = 'id=webinar-1&pane=preview'
  await render()
  expect(host.querySelector('[data-design-node="XCUNf"]')).not.toBeNull()
})

it('作る手順の段では集計を取らず、詳細の段を開いたときだけ1回取って段を移っても取り直さない', async () => {
  state.search = 'id=webinar-1&pane=basic'
  await render()
  expect(gets('/analytics')).toBe(0)
  act(() => { root.unmount() })
  root = createRoot(host)
  state.search = 'id=webinar-1&pane=participants'
  await render()
  expect(gets('/analytics')).toBe(1)
  for (const label of ['分析', 'コメント演出', '参加者']) {
    await act(async () => { tab(label).click() })
    for (let i = 0; i < 4; i += 1) await act(async () => {})
  }
  expect(host.querySelector('[data-design-node="uNsEy"]')).not.toBeNull()
  expect(gets('/analytics')).toBe(1)
})

it('分析の段（z2dgw）は親の集計を出し、CSV は参加者の口から書き出す', async () => {
  // 書き出しの a を押すと試験の窓が blob へ移ってしまうので、押した事だけを受ける。
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = vi.fn(() => 'blob:csv')
  URL.revokeObjectURL = vi.fn()
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  onTestFinished(() => { URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; clicked.mockRestore() })
  state.search = 'id=webinar-1&pane=analytics'
  await render()
  expect(host.querySelector('[data-design-node="z2dgw"]')).not.toBeNull()
  expect(gets('/analytics')).toBe(1)
  const csv = ([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('CSVで書き出す')) ?? querySupplementaryPageAction('CSVで書き出す')) as HTMLButtonElement
  await act(async () => { csv.click() })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
  expect(gets('/api/webinars/webinar-1/participants.csv')).toBe(1)
  expect(clicked).toHaveBeenCalledTimes(1)
})

it('通知と CTA は子の段が1回だけ取り、CTA の枚数は取得と保存の報告で要約に流す', async () => {
  state.search = 'id=webinar-1&pane=cta'
  await render()
  expect(gets('/ctas')).toBe(1)
  expect(gets('/notifications')).toBe(0)
  await goStep('notifications')
  expect(gets('/notifications')).toBe(1)
  expect(summary()).toContain('案内ボタン 1件')
  await goStep('cta')
  await act(async () => { (host.querySelector('button[aria-label="カード1の操作"]') as HTMLButtonElement).click() })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '複製する' })) })
  const save = ([...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '下書きを保存') ?? querySupplementaryPageAction('下書きを保存')) as HTMLButtonElement
  await act(async () => { save.click() })
  for (let i = 0; i < 4; i += 1) await act(async () => {})
  expect(requests.find((request) => request.method === 'PUT' && request.path.endsWith('/ctas'))?.body).toEqual({ ctas: [expect.objectContaining({ title: '資料' }), expect.objectContaining({ title: '資料' })] })
  await goStep('notifications')
  expect(summary()).toContain('案内ボタン 2件')
  expect(gets('/ctas')).toBe(1)
  expect(gets('/notifications')).toBe(1)
})

it('公開中で URL を検査済みなら、編集の口の URL を別窓で開く', async () => {
  await render()
  const link = ([...host.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes('公開ページを見る')) ?? querySupplementaryPageAction('公開ページを見る'))
  expect(host.textContent).not.toContain('プレビューは準備中です')
  expect(link?.getAttribute('href')).toBe(PUBLIC_URL)
  expect(link?.getAttribute('target')).toBe('_blank')
  expect(link?.getAttribute('rel')).toContain('noopener')
  expect(link?.getAttribute('rel')).toContain('noreferrer')
  expect(gets('/editor')).toBeGreaterThanOrEqual(1)
})

it.each([
  ['アカウントを読み込み中', () => { state.accountsLoading = true }, 'LINE公式アカウントを確認しています。'],
  ['ウェビナーのアカウントが見えない', () => { state.accounts = [] }, 'このウェビナーのLINE公式アカウントを確認できません。'],
  ['アカウントに LIFF ID が無い', () => { state.accounts = [{ id: 'account-a', name: '本店', liffId: null }] }, 'LINE公式アカウントにLIFF IDが設定されていません。'],
  ['公開していない', () => {}, '公開すると、友だちが見るページを確認できます。'],
])('%s ときは公開ページを開かず、その理由を出す', async (_name, arrange, reason) => {
  webinar.status = 'draft'
  arrange()
  await render()
  expect([...host.querySelectorAll('a')].some((anchor) => anchor.textContent?.includes('公開ページを見る'))).toBe(false)
  expect(host.textContent).toContain(reason)
  expect(host.textContent).not.toContain('プレビューは準備中です')
  for (const other of ['LINE公式アカウントを確認しています。', 'このウェビナーのLINE公式アカウントを確認できません。', 'LINE公式アカウントにLIFF IDが設定されていません。', '公開すると、友だちが見るページを確認できます。']) {
    if (other !== reason) expect(host.textContent).not.toContain(other)
  }
})

it('ウェビナー複製は変更と作りかけのフォルダを両方確認する', async () => {
  state.search = 'id=webinar-1&pane=basic'
  await render()
  await act(async () => { fireEvent.change(screen.getByLabelText('名前'), { target: { value: '変更中の名前' } }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' })) })
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '作成途中' } }); fireEvent.pointerDown(document.body) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ウェビナーの操作' })) })
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '複製する' })) })
  expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('作りかけのフォルダ')
  expect(requests.some(request => request.method === 'POST' && request.path.includes('duplicate'))).toBe(false)
})
