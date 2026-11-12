import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EditWebinarPage from './page'

/**
 * Issue #1002 DETAIL-03/04/05/06/07 の回帰試験。
 *
 * 本物のReactで本物の `EditWebinarPage` を mount し、`api.ts` も実物を通す。
 * 差し替えるのは通信(fetch)・アカウント文脈・ルーティングだけ。
 *
 * - DETAIL-04: 段を往復しても未保存の入力が消えない。保存してから段が変わり、
 *   保存に失敗したら入力も今の段も残る。固定バーの「下書き保存」は実際に保存する。
 * - DETAIL-05: 「公開ページを見る」「テスト送信」は実際の口へ繋がるか、
 *   まだ使えない理由を文字で出す。押せるのに何も起きない形にしない。
 * - DETAIL-06: 参加者一覧は nextCursor を辿って最後の1人まで読める。
 * - DETAIL-07: コメントの失敗・遅延で参加者一覧が消えない。
 */

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams('id=webinar-1'),
  push: vi.fn(),
  accountId: 'account-a',
}))

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  /** PUT /api/webinars/:id を失敗させる。 */
  updateFail: false,
  /** user-comments を 500 にする。 */
  commentsFail: false,
  /** 参加者の総数。カーソルは offset として振る舞う。 */
  participantTotal: 1,
  /** 参加者の1頁あたり（limit 指定がそのまま効く）。 */
  webinarStatus: 'draft' as 'draft' | 'active',
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => fixture.params,
  usePathname: () => '/webinars/edit',
  useRouter: () => ({ push: fixture.push }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, accounts: [{ id: fixture.accountId, liffId: 'liff' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))

/*
  通知の子タブは別口を持つのでここでは形だけにする。
  親の固定バーと同じ契約（onLoaded / registerSave / onDirtyChange）を守る。
  「通知を変更する」は入力を汚す操作の身代わり——実物ではON/OFFや時刻の
  変更が dirty を立て、保存で baseline が更新されて dirty が降りる。
*/
/* 確認ダイアログは枠だけにして、確認→実行の流れをそのまま試す。 */
vi.mock('@/components/shared/confirm-dialog', () => ({
  default: ({ open, confirmLabel, onConfirm, onCancel, children }: {
    open: boolean
    confirmLabel?: string
    onConfirm?: () => void
    onCancel: () => void
    children?: React.ReactNode
  }) => (open
    ? <div role="dialog"><div>{children}</div><button type="button" onClick={onConfirm}>{confirmLabel ?? 'OK'}</button><button type="button" onClick={onCancel}>閉じる</button></div>
    : null),
}))

vi.mock('@/components/shared/select', () => ({
  default: ({ value, onChange, options, size: _size, ...props }: {
    value: string
    onChange?: (value: string) => void
    options: Array<{ value: string; label: string }>
    size?: string
  } & React.ComponentProps<'select'>) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)} {...props}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  ),
}))
vi.mock('@/components/shared/sticky-bar', () => ({
  // 共通部品の契約どおり status も描く（status を落とすと未保存の印が見えなくなる）。
  default: ({ actions, status }: { actions: React.ReactNode; status?: React.ReactNode }) => <div>{status}{actions}</div>,
}))

const webinar = {
  id: 'webinar-1', accountId: 'account-a', title: '採用ウェビナー', slug: 'recruit', status: 'draft' as const,
  videoPrefix: 'videos/recruit', durationSeconds: 600, schedule: [{ type: 'daily' as const, time: '20:00' }],
  cta: { label: '相談する', url: 'https://example.test', showAtSeconds: 60 },
  tagOnAttend: null, tagOnCtaClick: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

const editor = {
  version: 3, deliveryKind: 'on_demand' as const, viewingCondition: { kind: 'all', label: '全員' },
  publicDescription: '説明', registrationFormId: null, notificationMessages: {}, notificationTest: null,
  actionPolicy: { templateBody: '', missingResultPolicy: 'escalate' as const },
  publicPage: { liffId: 'liff', url: 'https://liff.example.test/preview', unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'draft' as const, draftVersion: 3, publishedVersion: null, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}

const analyticsData = {
  summary: { reservations: 1, viewers: 1, registeredAndJoined: 1, watched5m: 0, watched15m: 0, completed: 0, avgWatchedSeconds: 900, ctaClicks: 1, formSubmissions: 0 },
  daily: [], sessions: [], dropoff: [], viewSegments: [], participants: [],
  measurement: { state: 'available' as const, reason: null },
  formFunnel: { ctaImpressions: 0, ctaClicks: 0, formOpens: 0, formStarts: 0, submitAttempts: 0, submitSuccesses: 0, submitErrors: 0, fieldCompletions: [] },
}

function participantItem(index: number) {
  return {
    friendId: `friend-${index}`, friendName: `参加者 ${index}`, pictureUrl: null, sessions: 1,
    firstJoinedAt: '2026-09-10T20:00:00Z', latestJoinedAt: '2026-09-10T20:00:00Z',
    maxWatchedSeconds: 900, ctaClickedAt: null, registered: true,
    formSubmittedAt: null, actionStatus: null, errorDetail: null, staffIntegrationStatus: 'pending',
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { 'Content-Type': 'application/json' } })

/** 通信そのものを差し替える。api・fetchApiは実物を通す。 */
function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const url = new URL(raw.startsWith('http') ? raw : `https://test.local${raw}`)
    const path = url.pathname + url.search
    const method = init?.method ?? 'GET'
    net.calls.push({ path, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    if (path === '/api/staff/me') return json({ role: 'admin' })
    if (path.includes('/api/media')) return json({ items: [], nextCursor: null })
    if (path.includes('/api/webinars/webinar-1/participants')) {
      /* カーソルは offset。limit 指定があればその数だけ返す。 */
      const offset = Number(url.searchParams.get('cursor') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, net.participantTotal - offset)) },
        (_, i) => participantItem(offset + i + 1),
      )
      const nextOffset = offset + items.length
      return json({ items, nextCursor: nextOffset < net.participantTotal ? String(nextOffset) : null })
    }
    if (path.endsWith('/api/webinars/webinar-1/analytics')) return json(analyticsData)
    if (path.endsWith('/api/webinars/webinar-1/user-comments')) {
      if (net.commentsFail) return new Response(JSON.stringify({ success: false, error: 'comments unavailable' }), { status: 500 })
      return json([])
    }
    if (path.endsWith('/api/webinars/webinar-1/notifications')) return json({ settings: { webinarId: 'webinar-1', version: 3, registrationEnabled: method === 'PUT', dayBeforeEnabled: false, dayBeforeTime: '18:00', hourBeforeEnabled: false, hourBeforeMinutes: 60, startEnabled: false, missedEnabled: false, missedTime: '20:00', completedEnabled: false, updatedAt: '2026-10-01T00:00:00Z' }, overview: null })
    if (path.endsWith('/api/webinars/webinar-1/actions')) return json([])
    if (path.endsWith('/api/webinars/webinar-1/notifications/test')) return method === 'GET'
      ? json({ count: 1, recipients: [{ id: 'f1', displayName: '確認の人' }], token: 'a'.repeat(64), confirmationId: '00000000-0000-4000-8000-000000000001' })
      : json({ sent: 2, failed: 0 })
    if (path.endsWith('/api/webinars/webinar-1/publish-validation')) {
      return json({ version: 3, checks: [], blockers: [], warnings: [] })
    }
    if (path.endsWith('/api/webinars/webinar-1/publish')) {
      return json({ webinar: { ...webinar, status: 'active' }, validation: { version: 3, checks: [], blockers: [], warnings: [] } })
    }
    if (path.endsWith('/api/webinars/webinar-1/editor')) return json(editor)
    if (path.endsWith('/api/webinars/webinar-1')) {
      if (method === 'PUT') {
        if (net.updateFail) return new Response(JSON.stringify({ success: false, error: 'save failed' }), { status: 500 })
        const body = init?.body ? JSON.parse(String(init.body)) as Partial<typeof webinar> : {}
        return json({ ...webinar, ...body, status: net.webinarStatus === 'active' ? 'active' : (body.status ?? webinar.status) })
      }
      return json({ ...webinar, status: net.webinarStatus })
    }
    return json([])
  })
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  window.history.replaceState(null, '', '/webinars/edit?id=webinar-1')
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  fixture.params = new URLSearchParams('id=webinar-1')
  fixture.push.mockClear()
  net.calls.length = 0
  net.updateFail = false
  net.commentsFail = false
  net.participantTotal = 1
  net.webinarStatus = 'draft'
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<EditWebinarPage />) })
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

function buttonByText(label: string): HTMLButtonElement {
  const button = (Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? querySupplementaryPageAction(label))
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

function buttonContaining(label: string): HTMLButtonElement {
  const button = (Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) ?? querySupplementaryPageAction(label))
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

function stepButton(label: string): HTMLButtonElement {
  const button = ([...host.querySelectorAll('[data-part="steps"] button')].find((button) => button.textContent?.includes(label)) ?? querySupplementaryPageAction(label))
  if (!button) throw new Error(`step not found: ${label}`)
  return button as HTMLButtonElement
}

function titleInput(): HTMLInputElement {
  const input = Array.from(host.querySelectorAll('input')).find((el) => el.value === webinar.title || el.placeholder.includes('定期便'))
  if (!input) throw new Error('title input not found')
  return input
}

function paneWrapper(nodeSelector: string): HTMLElement | null {
  const node = host.querySelector(nodeSelector)
  return node?.parentElement ?? null
}

function paneVisible(nodeSelector: string): boolean {
  const wrapper = paneWrapper(nodeSelector)
  return wrapper !== null && !wrapper.hasAttribute('hidden')
}

const putCalls = () => net.calls.filter((call) => call.method === 'PUT' && call.path === '/api/webinars/webinar-1')
const participantCalls = () => net.calls.filter((call) => call.path.includes('/participants'))

function listLink(): HTMLAnchorElement {
  const link = (Array.from(host.querySelectorAll('a')).find((a) => a.textContent?.includes('キャンセル')) ?? querySupplementaryPageAction('キャンセル'))
  if (!link) throw new Error('list link not found')
  return link
}

describe('DETAIL-04 残存経路: 未保存の通知を持ったまま画面を離れない', () => {
  async function openNotificationsPane() {
    fixture.params = new URLSearchParams('id=webinar-1&pane=notifications')
    await render()
    await flush()
  }

  it('通知を直したまま一覧リンクを押すと確認が出て、閉じると入力を保ったまま残る', async () => {
    await openNotificationsPane()

    /* 6通知のON・時刻変更の身代わり。未保存の印が固定バーに出る。 */
    await act(async () => { fireEvent.click(host.querySelector('[role="switch"]')!) })
    await flush()
    expect(host.textContent).toContain('保存していない変更があります')

    await act(async () => { listLink().click() })
    await flush()

    /* 遷移しない。破棄か編集継続かを選ばせる確認が出る。 */
    expect(fixture.push).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    /* 閉じる（キャンセル）では画面に留まり、未保存の印も入力も残る。 */
    await act(async () => { buttonByText('閉じる').click() })
    await flush()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(fixture.push).not.toHaveBeenCalled()
    expect(host.textContent).toContain('保存していない変更があります')
  })

  it('「保存せずに移る」を選んだときだけ入力を捨てて一覧へ遷移する', async () => {
    await openNotificationsPane()
    await act(async () => { fireEvent.click(host.querySelector('[role="switch"]')!) })
    await flush()

    await act(async () => { listLink().click() })
    await flush()
    await act(async () => { buttonByText('保存せずに移る').click() })
    await flush()

    expect(fixture.push).toHaveBeenCalledWith('/webinars')
  })

  it('通知を保存してから一覧リンクを押すと確認は出ない', async () => {
    await openNotificationsPane()
    await act(async () => { fireEvent.click(host.querySelector('[role="switch"]')!) })
    await flush()

    /* 固定バーの「下書き保存」は通知の保存を呼ぶ。成功で未保存の印が降りる。 */
    await act(async () => { buttonByText('下書きを保存').click() })
    await flush()
    expect(host.textContent).not.toContain('保存していない変更があります')

    await act(async () => { listLink().click() })
    await flush()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('Issue #1060 pane内の戻ると公開後の遷移では離脱確認を出さない', () => {
  async function openNotificationsAndMakeDirty() {
    fixture.params = new URLSearchParams('id=webinar-1&pane=notifications')
    await render()
    await flush()
    await act(async () => { fireEvent.click(host.querySelector('[role="switch"]')!) })
    await flush()
    expect(host.textContent).toContain('保存していない変更があります')
    expect(host.querySelector('[role="switch"]')?.closest('[hidden]')).toBeNull()
  }

  function beforeUnload() {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('未保存でも同じ画面の段への戻るは確認を出さず、戻った先の段を開く', async () => {
    const go = vi.spyOn(window.history, 'go')
    await openNotificationsAndMakeDirty()

    await act(async () => {
      window.history.pushState(null, '', '/webinars/edit?id=webinar-1&pane=basic')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await flush()

    /* 画面内の移動なので履歴を戻さず、確認も出さない。通知の段は畳まれる。 */
    expect(go).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[role="switch"]')?.closest('[hidden]')).not.toBeNull()
    /* 未保存の入力と印はそのまま残る。 */
    expect(host.textContent).toContain('保存していない変更があります')
  })

  it('未保存のまま一覧など外へ戻るときは、これまで通り確認を出す', async () => {
    const go = vi.spyOn(window.history, 'go')
    await openNotificationsAndMakeDirty()

    await act(async () => {
      window.history.pushState(null, '', '/webinars')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await flush()

    expect(go).toHaveBeenCalledWith(1)
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('未保存のまま別のウェビナーへ戻るときも確認を出す', async () => {
    const go = vi.spyOn(window.history, 'go')
    await openNotificationsAndMakeDirty()

    await act(async () => {
      window.history.pushState(null, '', '/webinars/edit?id=webinar-2&pane=basic')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await flush()

    expect(go).toHaveBeenCalledWith(1)
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('「この版を公開」のあとの画面遷移ではブラウザ標準の離脱確認を出さない', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    await openNotificationsAndMakeDirty()

    /* dirtyの間は beforeunload が確認を出す（ガードは生きている）。 */
    expect(beforeUnload().defaultPrevented).toBe(true)

    /* STEP 5 確認へ進み、公開を実行する。 */
    await act(async () => { buttonContaining('確認へ').click() })
    await flush()
    await act(async () => { buttonByText('この版を公開').click() })
    await flush()

    /* 公開成功で公開済み画面へ遷移し、その遷移では標準の確認を出さない。 */
    expect(net.calls.some((call) => call.method === 'POST' && call.path.endsWith('/api/webinars/webinar-1/publish'))).toBe(true)
    expect(assign).toHaveBeenCalledWith('/webinars/published?id=webinar-1')
    expect(beforeUnload().defaultPrevented).toBe(false)
  })
})

describe('DETAIL-04 未保存の入力を段の往復で消さない', () => {
  it('タイトルを直して「保存して動画へ」→ 保存してから動画の段へ進み、戻っても新しいタイトルのまま', async () => {
    await render()
    await flush()

    const input = titleInput()
    await act(async () => { fireEvent.change(input, { target: { value: '変更したタイトル' } }) })
    await flush()

    /* 固定バーの「下書き保存」は飾りではない。押せて、実際に保存する。 */
    expect(buttonByText('下書きを保存').disabled).toBe(false)

    await act(async () => { buttonContaining('動画の設定へ').click() })
    await flush()

    expect(putCalls()).toHaveLength(1)
    expect(host.querySelector('[data-wc-pane="video"]')?.closest('[hidden]')).toBeNull()

    /* STEP 1 へ戻る。保存済みの新しいタイトルがそのまま残る。 */
    await act(async () => { stepButton('基本設定').click() })
    await flush()

    expect(host.querySelector('[data-wc-pane="video"]')?.closest('[hidden]')).not.toBeNull()
    expect(Array.from(host.querySelectorAll('input')).some((el) => el.value === '変更したタイトル')).toBe(true)
  })

  it('段の自由移動でも未保存の入力は残る（画面を畳まない）', async () => {
    await render()
    await flush()

    await act(async () => { fireEvent.change(titleInput(), { target: { value: 'まだ保存していない題名' } }) })
    await flush()

    /* 保存せず STEP 4（通知）へ。戻ると入力は残っている。 */
    await act(async () => {
      window.history.pushState(null, '', '/webinars/edit?id=webinar-1&pane=notifications')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await flush()
    await act(async () => { stepButton('基本設定').click() })
    await flush()

    expect(Array.from(host.querySelectorAll('input')).some((el) => el.value === 'まだ保存していない題名')).toBe(true)
    expect(putCalls()).toHaveLength(0)
    expect(host.textContent).toContain('保存していない変更があります')
  })

  it('「下書き保存」はその場で保存して段を変えない', async () => {
    await render()
    await flush()

    await act(async () => { fireEvent.change(titleInput(), { target: { value: '下書きで保存する題名' } }) })
    await act(async () => { buttonByText('下書きを保存').click() })
    await flush()

    expect(putCalls()).toHaveLength(1)
    /* 段は基本設定のまま。保存できたので未保存の印は消える。 */
    expect(host.querySelector('[data-design-node="VWNaA"]')).toBeNull()
    expect(Array.from(host.querySelectorAll('input')).some((el) => el.value === '下書きで保存する題名')).toBe(true)
    expect(host.textContent).not.toContain('保存していない変更があります')
  })

  it('保存に失敗したら段も入力もそのまま残す', async () => {
    net.updateFail = true
    await render()
    await flush()

    await act(async () => { fireEvent.change(titleInput(), { target: { value: '失敗時に残る題名' } }) })
    await flush()
    await act(async () => { buttonContaining('動画の設定へ').click() })
    await flush()

    expect(putCalls()).toHaveLength(1)
    /* 動画の段へは進まず、入力は消えない。 */
    expect(host.querySelector('[data-design-node="VWNaA"]')).toBeNull()
    expect(Array.from(host.querySelectorAll('input')).some((el) => el.value === '失敗時に残る題名')).toBe(true)
    expect(host.textContent).toContain('保存できませんでした')
  })
})

describe('DETAIL-05 無反応のボタンを残さない', () => {
  it('動画の段: 非公開ではページを開く口を隠し、理由を出す', async () => {
    fixture.params = new URLSearchParams('id=webinar-1&pane=video')
    await render()
    await flush()

    expect([...host.querySelectorAll('a')].some((link) => link.textContent?.includes('PC で見る'))).toBe(false)
    expect(host.textContent).toContain('公開すると、友だちが見るページを確認できます。')
  })

  it('動画の段: 公開中なら「PCで見る」は公開URLへのリンクになる', async () => {
    net.webinarStatus = 'active'
    fixture.params = new URLSearchParams('id=webinar-1&pane=video')
    await render()
    await flush()

    const link = (Array.from(host.querySelectorAll('a')).find((a) => a.textContent?.includes('PC で見る')) ?? querySupplementaryPageAction('PC で見る'))
    expect(link?.getAttribute('href')).toBe('https://liff.example.test/preview')
  })

  it('通知の段: 「テスト送信」は確認を挟んで実際にテスト送信の口を呼ぶ', async () => {
    fixture.params = new URLSearchParams('id=webinar-1&pane=notifications')
    await render()
    await flush()

    await act(async () => { buttonByText('テストを送る').click() })
    await flush()
    /* 送信前に相手と文面を確認する。押した瞬間に送らない。 */
    expect(document.body.textContent).toContain('確認の人')
    expect(net.calls.some((call) => call.method === 'POST' && call.path.endsWith('/notifications/test'))).toBe(false)
    const confirm = (Array.from(host.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'テストを送る') ?? querySupplementaryPageAction('テストを送る')) as HTMLButtonElement | undefined
    expect(confirm).toBeDefined()
    await act(async () => { confirm!.click() })
    await flush()

    expect(net.calls.some((call) => call.method === 'POST' && call.path.endsWith('/notifications/test'))).toBe(true)
    expect(JSON.parse(net.calls.find(call => call.method === 'POST' && call.path.endsWith('/notifications/test'))!.body!)).toMatchObject({ expectedRecipientToken: 'a'.repeat(64), confirmationId: '00000000-0000-4000-8000-000000000001' })
    expect(host.textContent).toContain('テスト送信しました。成功 2 件・失敗 0 件')
  })

  it('通知の段: 非公開ではページを開く口を隠し、理由を出す', async () => {
    fixture.params = new URLSearchParams('id=webinar-1&pane=notifications')
    await render()
    await flush()

    expect([...host.querySelectorAll('a')].some((link) => link.textContent?.includes('公開ページを見る'))).toBe(false)
    expect(host.textContent).toContain('公開すると、友だちが見るページを確認できます。')
  })
})

describe('DETAIL-06 参加者一覧を最後の1人まで読める', () => {
  async function openParticipants() {
    fixture.params = new URLSearchParams('id=webinar-1&pane=participants')
    await render()
    await flush()
  }

  async function loadAllPages() {
    for (let i = 0; i < 20; i += 1) {
      const more = (Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '続きを読み込む') ?? querySupplementaryPageAction('続きを読み込む'))
      if (!more) return
      await act(async () => { more.click() })
      await flush()
    }
    throw new Error('ページ送りが終わりませんでした')
  }

  function renderedNames(): string[] {
    return Array.from(host.querySelectorAll('a[href^="/friends/detail?id="]')).map((a) => a.textContent ?? '')
  }

  it.each([9, 50])('%i人: 検索とページ送りで最後の人まで届く', async (total) => {
    net.participantTotal = total
    await openParticipants()

    expect(renderedNames()).toHaveLength(Math.min(total, 20))
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => { fireEvent.change(search, { target: { value: `参加者 ${total}` } }) })
    expect(host.textContent).toContain(`参加者 ${total}`)
    /* 続きが無いときは「続きを読み込む」を出さない。 */
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent?.trim() === '続きを読み込む')).toBe(false)
  })

  it('201人: nextCursor を辿って全頁読み、201人目まで届く（重複・欠落なし）', async () => {
    net.participantTotal = 201
    await openParticipants()

    expect(host.textContent).toContain('参加者 20')
    expect(renderedNames()).not.toContain('参加者 51')

    await loadAllPages()

    expect(host.querySelector('[data-pagination-summary]')?.textContent?.replace(/\s/g, '')).toContain('201件中')
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => { fireEvent.change(search, { target: { value: '参加者 201' } }) })
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flush()
    expect(host.textContent).toContain('参加者 201')
    expect(renderedNames()).toHaveLength(1)
    /* 初回 + カーソル4回 = 5頁。limit と cursor が実際に付く。 */
    const calls = participantCalls()
    expect(calls).toHaveLength(5)
    expect(calls[0].path).toContain('limit=50')
    expect(calls[1].path).toContain('cursor=50')
    expect(calls[4].path).toContain('cursor=200')
  })
})

describe('DETAIL-07 コメントと参加者の読み込みを分ける', () => {
  it('コメントの口が500でも参加者一覧は表示され、コメントは取りに行かない', async () => {
    net.commentsFail = true
    net.participantTotal = 9
    fixture.params = new URLSearchParams('id=webinar-1&pane=participants')
    await render()
    await flush()

    /* 参加者管理の面ではコメントを取らない。失敗の有無に関わらず一覧は出る。 */
    expect(net.calls.some((call) => call.path.includes('user-comments'))).toBe(false)
    expect(host.textContent).toContain('参加者 1')
    expect(host.textContent).toContain('参加者 9')
    expect(host.textContent).not.toContain('分析データを読み込めませんでした')
  })

  it('参加者の口が失敗しても集計側の段はそのまま、失敗部分だけ再読込できる', async () => {
    let failOnce = true
    const baseParticipants = net.participantTotal
    void baseParticipants
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : String(input)
      const url = new URL(raw.startsWith('http') ? raw : `https://test.local${raw}`)
      const path = url.pathname + url.search
      const method = init?.method ?? 'GET'
      net.calls.push({ path, method })
      if (path.includes('/api/webinars/webinar-1/participants') && failOnce) {
        failOnce = false
        return new Response(JSON.stringify({ success: false, error: 'temporary' }), { status: 500 })
      }
      if (path.includes('/api/webinars/webinar-1/participants')) {
        const offset = Number(url.searchParams.get('cursor') ?? '0')
        const limit = Number(url.searchParams.get('limit') ?? '50')
        const items = Array.from({ length: Math.max(0, Math.min(limit, 9 - offset)) }, (_, i) => participantItem(offset + i + 1))
        const nextOffset = offset + items.length
        return json({ items, nextCursor: nextOffset < 9 ? String(nextOffset) : null })
      }
      if (path.includes('/api/media')) return json({ items: [], nextCursor: null })
      if (path.endsWith('/api/webinars/webinar-1/analytics')) return json(analyticsData)
      if (path.endsWith('/api/webinars/webinar-1/user-comments')) return json([])
      if (path.endsWith('/api/webinars/webinar-1/editor')) return json(editor)
      if (path.endsWith('/api/webinars/webinar-1')) return json({ ...webinar, status: net.webinarStatus })
      return json([])
    })
    net.participantTotal = 9
    fixture.params = new URLSearchParams('id=webinar-1&pane=participants')
    await render()
    await flush()

    expect(host.textContent).toContain('参加者の一覧を読み込めませんでした')
    /* 失敗したのは参加者だけ。集計のカードは出続ける。 */
    expect(host.textContent).toContain('申込')

    await act(async () => { buttonByText('もう一度読み込む').click() })
    await flush()

    expect(host.textContent).toContain('参加者 1')
    expect(host.textContent).toContain('参加者 9')
  })
})
