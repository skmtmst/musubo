import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { fireEvent } from '@testing-library/react'
import React, { act, type ReactElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number
    code: string | null

    constructor(status: number, code: string | null = null) {
      super(`api_${status}`)
      this.status = status
      this.code = code
    }
  }

  return {
    ApiError: MockApiError,
    extractApiErrorCode: vi.fn(() => null),
    fetchApi: vi.fn(),
    get: vi.fn(),
    editor: vi.fn(),
    notifications: vi.fn(),
    analytics: vi.fn(),
    userComments: vi.fn(),
    participants: vi.fn(),
    ctas: vi.fn(),
    saveCtas: vi.fn(),
    saveEditor: vi.fn(),
    publishValidation: vi.fn(),
    publish: vi.fn(),
  }
})

const navigationMocks = vi.hoisted(() => ({ query: 'id=webinar-1' }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ApiError: apiMocks.ApiError,
  extractApiErrorCode: apiMocks.extractApiErrorCode,
  fetchApi: apiMocks.fetchApi,
  webinarApi: {
    get: apiMocks.get,
    editor: apiMocks.editor,
    notifications: apiMocks.notifications,
    analytics: apiMocks.analytics,
    userComments: apiMocks.userComments,
    participants: apiMocks.participants,
    participantsCsvUrl: (id: string) => `/api/webinars/${id}/participants.csv`,
    ctas: apiMocks.ctas,
    saveCtas: apiMocks.saveCtas,
    saveEditor: apiMocks.saveEditor,
    publishValidation: apiMocks.publishValidation,
    publish: apiMocks.publish,
  },
}))

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigationMocks.query),
  usePathname: () => '/webinars/edit',
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/components/shared/button', () => ({
  default: ({ children, href, variant, ...props }: React.ComponentProps<'button'> & { href?: string; variant?: string }) =>
    href ? <a href={href}>{children}</a> : <button data-variant={variant} {...props}>{children}</button>,
}))
vi.mock('@/components/shared/sticky-bar', () => ({
  default: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div>,
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
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))

import EditWebinarPage from './page'

type FakeElement = HTMLButtonElement
const documentStub = document
const mountedRoots: Root[] = []
beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  window.history.replaceState(null, '', '/webinars/edit?id=webinar-1')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  navigationMocks.query = 'id=webinar-1'
  apiMocks.get.mockImplementation((id: string) => Promise.resolve({ data: { ...webinar, id } }))
  apiMocks.editor.mockResolvedValue({ data: editor })
  apiMocks.notifications.mockResolvedValue({ data: { settings: null } })
  apiMocks.analytics.mockResolvedValue({ data: analytics })
  apiMocks.ctas.mockResolvedValue({ data: [] })
  apiMocks.userComments.mockResolvedValue({ data: [] })
  apiMocks.participants.mockResolvedValue({ data: { items: [], nextCursor: null } })
})

afterEach(async () => {
  await act(async () => {
    while (mountedRoots.length > 0) mountedRoots.pop()?.unmount()
  })
  documentStub.body.textContent = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  })
}

/*
  「切替直後」を見るための一コマ。`flushSync` で描画だけ先に確定させ、
  useEffect が走る前の画面をそのまま写す。ここに前のウェビナーの中身が
  写っていたら、利用者は一瞬でもそれを見て触れることになる。
*/
type Frame = { text: string; options: string[]; inputs: string[]; loading: boolean }

function frameOf(container: FakeElement): Frame {
  return { text: container.textContent, options: optionLabels(container), inputs: inputValues(container), loading: Boolean(container.querySelector('[data-list-state="loading"][aria-busy="true"]')) }
}

async function mount(element: ReactElement) {
  const container = documentStub.createElement('div')
  documentStub.body.appendChild(container)
  const root = createRoot(container as unknown as HTMLElement)
  mountedRoots.push(root)
  await act(async () => { root.render(element) })
  await flush()
  return {
    container,
    /* 返すのは切替の一コマ目。反映後の画面は container から読む。 */
    rerender: async (next: ReactElement): Promise<Frame> => {
      let firstFrame: Frame = { text: '', options: [], inputs: [], loading: false }
      await act(async () => {
        flushSync(() => { root.render(next) })
        firstFrame = frameOf(container)
      })
      await flush()
      return firstFrame
    },
  }
}

function elements(root: HTMLElement): FakeElement[] {
  return [...root.querySelectorAll('*')] as FakeElement[]
}

function findButton(container: FakeElement, label: string): FakeElement {
  const button = (elements(container).find((element) => element.tagName === 'BUTTON' && element.textContent.includes(label)) ?? querySupplementaryPageAction(label))
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

function findExactButton(container: FakeElement, label: string): FakeElement {
  const button = (elements(container).find((element) => element.tagName === 'BUTTON' && element.textContent === label) ?? querySupplementaryPageAction(label))
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

/* 押せないことは属性でも性質でも表れる。両方見る。 */
function isDisabled(button: FakeElement): boolean {
  return button.disabled === true || button.getAttribute('disabled') !== null
}

/* CTA カードの見出しは入力欄の値。textContent には出ないので値で見る。 */
function inputValues(container: FakeElement): string[] {
  return elements(container)
    .filter((element) => element.tagName === 'INPUT')
    .map((element) => element.value || element.getAttribute('value') || '')
}

function optionLabels(container: FakeElement): string[] {
  return elements(container).filter((element) => element.tagName === 'OPTION').map((element) => element.textContent)
}

async function clickButton(container: FakeElement, label: string): Promise<void> {
  const button = findButton(container, label)
  await act(async () => { fireEvent.click(button) })
  await flush()
}

async function changeSelect(container: FakeElement, ariaLabel: string, value: string): Promise<void> {
  const select = elements(container).find((element) => element.tagName === 'SELECT' && element.getAttribute('aria-label') === ariaLabel)
  if (!select) throw new Error(`select not found: ${ariaLabel}`)
  await act(async () => { fireEvent.change(select, { target: { value } }) })
  await flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const webinar = {
  id: 'webinar-1', accountId: 'account-a', title: '採用ウェビナー', slug: 'recruit', status: 'draft' as const,
  videoPrefix: 'videos/recruit', durationSeconds: 600, schedule: [],
  cta: { label: '相談する', url: 'https://example.test', showAtSeconds: 60 },
  tagOnAttend: null, tagOnCtaClick: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

const editor = {
  version: 3, deliveryKind: 'on_demand' as const, viewingCondition: { kind: 'all', label: '全員' },
  publicDescription: '説明', registrationFormId: null, notificationMessages: {}, notificationTest: null,
  actionPolicy: { templateBody: '', missingResultPolicy: 'escalate' as const },
  publicPage: { liffId: null, url: null, unavailableReason: null, description: '', test: null, form: null },
  publication: { status: 'draft' as const, draftVersion: 3, publishedVersion: null, publishedAt: null },
  monitoring: { notificationFailures: 0, duplicateRegistrations: 0, viewSegmentFailures: 0, actionFailures: 0 },
}

type FormsResponse = { success: boolean; data: Array<{ id: string; name: string; isActive: boolean }> }
type CtaCardFixture = { atSeconds: number; kind: 'form' | 'url'; title: string; body: string | null; buttonLabel: string; autoOpen: boolean; formId: string | null; url: string | null }
type CtaListResponse = { data: CtaCardFixture[] }

function ctaCard(title: string, atSeconds: number, formId: string): CtaCardFixture {
  return { atSeconds, kind: 'form', title, body: null, buttonLabel: '開く', autoOpen: false, formId, url: null }
}

const analytics = {
  summary: { reservations: 3, viewers: 2, registeredAndJoined: 2, watched5m: 0, watched15m: 0, completed: 0, avgWatchedSeconds: 0, ctaClicks: 0, formSubmissions: 0 },
  daily: [], participants: [], sessions: [], dropoff: [], viewSegments: [], measurement: { state: 'available' as const, reason: null },
  formFunnel: { ctaImpressions: 0, ctaClicks: 0, formOpens: 0, formStarts: 0, submitAttempts: 0, submitSuccesses: 0, submitErrors: 1, fieldCompletions: [] },
}

describe('Issue #674 ウェビナー編集の実挙動', () => {
  it('公開前の確認の失敗を表示し、操作で再試行して成功状態へ復帰する', async () => {
    navigationMocks.query = 'id=webinar-1&pane=review'
    apiMocks.publishValidation
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ data: { version: 3, checks: [], blockers: [], warnings: [] } })

    const view = await mount(<EditWebinarPage />)
    expect(view.container.textContent).toContain('公開前の確認を読み込めませんでした。このままでは公開できません。')
    expect(view.container.textContent).not.toContain('必要なものはそろっています。')

    await clickButton(view.container, 'もう一度読み込む')

    expect(apiMocks.publishValidation).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('必要なものはそろっています。')
    expect(view.container.textContent).not.toContain('公開前の確認を読み込めませんでした。')
  })

  it('フォーム候補の失敗を表示し、操作で再試行して候補を描画する', async () => {
    navigationMocks.query = 'id=webinar-1&pane=cta'
    apiMocks.ctas.mockResolvedValue({ data: [{ atSeconds: 30, kind: 'form', title: '相談', body: null, buttonLabel: '開く', autoOpen: false, formId: 'form-a', url: null }] })
    apiMocks.fetchApi
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'form-a', name: '相談フォームA', isActive: true }] })

    const view = await mount(<EditWebinarPage />)
    expect(view.container.textContent).toContain('回答フォームを読み込めませんでした。')


    await clickButton(view.container, 'もう一度読み込む')

    expect(apiMocks.fetchApi).toHaveBeenCalledTimes(2)
    expect(view.container.textContent).toContain('相談フォームA')
    expect(view.container.textContent).not.toContain('回答フォームを読み込めませんでした。')
  })

  it('account切替後は、古いaccountの遅延応答で候補を上書きしない', async () => {
    const slowA = deferred<{ success: boolean; data: Array<{ id: string; name: string; isActive: boolean }> }>()
    const fastB = deferred<{ success: boolean; data: Array<{ id: string; name: string; isActive: boolean }> }>()
    navigationMocks.query = 'id=webinar-a&pane=cta'
    apiMocks.get.mockImplementation((id: string) => Promise.resolve({ data: { ...webinar, id, accountId: id === 'webinar-a' ? 'account-a' : 'account-b' } }))
    apiMocks.ctas.mockResolvedValue({ data: [{ atSeconds: 30, kind: 'form', title: '相談', body: null, buttonLabel: '開く', autoOpen: false, formId: 'form-b', url: null }] })
    apiMocks.fetchApi.mockImplementation((url: string) => url.includes('account-a') ? slowA.promise : fastB.promise)

    const view = await mount(<EditWebinarPage />)
    navigationMocks.query = 'id=webinar-b&pane=cta'
    await view.rerender(<EditWebinarPage />)

    fastB.resolve({ success: true, data: [{ id: 'form-b', name: '相談フォームB', isActive: true }] })
    await flush()
    expect(view.container.textContent).toContain('相談フォームB')

    slowA.resolve({ success: true, data: [{ id: 'form-a', name: '古いフォームA', isActive: true }] })
    await flush()
    expect(view.container.textContent).toContain('相談フォームB')
    expect(view.container.textContent).not.toContain('古いフォームA')
  })

  it('0秒は実ステータス別にエラー・開始直後・未視聴へ分け、取得済み公開状態を描画する', async () => {
    navigationMocks.query = 'id=webinar-1&pane=participants'
    apiMocks.participants.mockResolvedValue({ data: { nextCursor: null, items: [
      { friendId: 'error', friendName: 'エラー例', pictureUrl: null, sessions: 1, firstJoinedAt: null, latestJoinedAt: null, maxWatchedSeconds: 0, ctaClickedAt: null, registered: true, formSubmittedAt: null, actionStatus: null, errorDetail: '再生に失敗', staffIntegrationStatus: 'needs_attention' },
      { friendId: 'left', friendName: '開始直後例', pictureUrl: null, sessions: 1, firstJoinedAt: '2026-09-09T00:00:00Z', latestJoinedAt: '2026-09-09T00:00:00Z', maxWatchedSeconds: 0, ctaClickedAt: null, registered: true, formSubmittedAt: null, actionStatus: null, errorDetail: null, staffIntegrationStatus: 'pending' },
      { friendId: 'unviewed', friendName: '未視聴例', pictureUrl: null, sessions: 0, firstJoinedAt: null, latestJoinedAt: null, maxWatchedSeconds: 0, ctaClickedAt: null, registered: true, formSubmittedAt: null, actionStatus: null, errorDetail: null, staffIntegrationStatus: 'pending' },
    ] } })

    const view = await mount(<EditWebinarPage />)
    expect(view.container.textContent).toContain('視聴エラー')
    expect(view.container.textContent).toContain('入場のみ')
    expect(view.container.textContent).toContain('見ていない・見逃し案内の対象')
    await act(async () => (view.container.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement).click())
    expect(view.container.textContent).toContain('下書き')
    expect(view.container.textContent).not.toContain('有効')

    apiMocks.get.mockResolvedValue({ data: { ...webinar, id: 'webinar-active', status: 'active' } })
    navigationMocks.query = 'id=webinar-active&pane=participants'
    await view.rerender(<EditWebinarPage />)
    await act(async () => (view.container.querySelector('button[aria-label$="の説明"]') as HTMLButtonElement).click())
    expect(view.container.textContent).toContain('公開中')
  })

  it('初期loadが逆順で届いても、切替後のウェビナーだけを描く', async () => {
    const loadA = deferred<{ data: typeof webinar }>()
    const loadB = deferred<{ data: typeof webinar }>()
    navigationMocks.query = 'id=webinar-a&pane=review'
    apiMocks.publishValidation.mockResolvedValue({ data: { version: 3, checks: [], blockers: [], warnings: [] } })
    apiMocks.get.mockImplementation((id: string) => (id === 'webinar-a' ? loadA.promise : loadB.promise))

    const view = await mount(<EditWebinarPage />)
    expect(view.container.querySelector('[data-list-state="loading"][aria-busy="true"]')).toBeTruthy()

    navigationMocks.query = 'id=webinar-b&pane=review'
    const frame = await view.rerender(<EditWebinarPage />)
    /* 切替の一コマ目から、前のウェビナーの中身を出さない。 */
    expect(frame.loading).toBe(true)

    /* 前のウェビナーの応答が先に届く。 */
    loadA.resolve({ data: { ...webinar, id: 'webinar-a', title: '前のウェビナーA' } })
    await flush()
    expect(view.container.textContent).not.toContain('前のウェビナーA')
    expect(view.container.querySelector('[data-list-state="loading"][aria-busy="true"]')).toBeTruthy()

    loadB.resolve({ data: { ...webinar, id: 'webinar-b', title: '後のウェビナーB' } })
    await flush()
    expect(view.container.textContent).toContain('後のウェビナーB')
    expect(view.container.textContent).not.toContain('前のウェビナーA')
  })

  it('切替前の読み込み失敗は、切替後の成功で消える', async () => {
    navigationMocks.query = 'id=webinar-a&pane=review'
    apiMocks.publishValidation.mockResolvedValue({ data: { version: 3, checks: [], blockers: [], warnings: [] } })
    apiMocks.get.mockImplementation((id: string) => (id === 'webinar-a'
      ? Promise.reject(new apiMocks.ApiError(404, 'not_found'))
      : Promise.resolve({ data: { ...webinar, id, title: '後のウェビナーB' } })))

    const view = await mount(<EditWebinarPage />)
    // 404 は ★管理画面 TargetMissing の not-found で出す。
    expect(view.container.textContent).toContain('このウェビナーは見つかりません')

    navigationMocks.query = 'id=webinar-b&pane=review'
    const frame = await view.rerender(<EditWebinarPage />)
    /* 切替の一コマ目に前の失敗文を持ち越さない。 */
    expect(frame.loading).toBe(true)
    expect(frame.text).not.toContain('このウェビナーは見つかりません')
    expect(view.container.textContent).toContain('後のウェビナーB')
    expect(view.container.textContent).not.toContain('このウェビナーは見つかりません')
  })

  it('切替直後は前のウェビナーの候補とCTAを出さず、揃うまで保存も止める', async () => {
    const formsA = deferred<FormsResponse>()
    const formsB = deferred<FormsResponse>()
    const ctasA = deferred<CtaListResponse>()
    const ctasB = deferred<CtaListResponse>()
    navigationMocks.query = 'id=webinar-a&pane=cta'
    apiMocks.get.mockImplementation((id: string) => Promise.resolve({ data: { ...webinar, id, accountId: id === 'webinar-a' ? 'account-a' : 'account-b' } }))
    apiMocks.fetchApi.mockImplementation((url: string) => (url.includes('account-a') ? formsA.promise : formsB.promise))
    apiMocks.ctas.mockImplementation((id: string) => (id === 'webinar-a' ? ctasA.promise : ctasB.promise))

    const view = await mount(<EditWebinarPage />)
    formsA.resolve({ success: true, data: [{ id: 'form-a', name: '旧フォームA', isActive: true }] })
    ctasA.resolve({ data: [ctaCard('旧CTA・A', 30, 'form-a')] })
    await flush()
    expect(optionLabels(view.container)).toContain('旧フォームA')
    expect(inputValues(view.container)).toContain('旧CTA・A')

    navigationMocks.query = 'id=webinar-b&pane=cta'
    const frame = await view.rerender(<EditWebinarPage />)

    /* 切替の一コマ目から、前のウェビナーの候補もCTAも画面に無い。 */
    expect(frame.options).not.toContain('旧フォームA')
    expect(frame.inputs).not.toContain('旧CTA・A')

    /* B の候補も CTA もまだ届いていない間。 */
    expect(optionLabels(view.container)).not.toContain('旧フォームA')
    expect(inputValues(view.container)).not.toContain('旧CTA・A')
    expect(view.container.textContent).toContain('回答フォームを読み込んでいます。')
    expect(isDisabled(findButton(view.container, '下書きを保存'))).toBe(true)
    expect(isDisabled(findExactButton(view.container, '下書きを保存'))).toBe(true)

    formsB.resolve({ success: true, data: [{ id: 'form-b', name: '新フォームB', isActive: true }] })
    ctasB.resolve({ data: [ctaCard('新CTA・B', 60, 'form-b')] })
    await flush()
    expect(optionLabels(view.container)).toContain('新フォームB')
    expect(inputValues(view.container)).toContain('新CTA・B')
    expect(optionLabels(view.container)).not.toContain('旧フォームA')
    expect(inputValues(view.container)).not.toContain('旧CTA・A')
  })

  it('候補とCTAが逆順で届いても、切替後のウェビナーの分だけが残る', async () => {
    const formsA = deferred<FormsResponse>()
    const formsB = deferred<FormsResponse>()
    const ctasA = deferred<CtaListResponse>()
    const ctasB = deferred<CtaListResponse>()
    navigationMocks.query = 'id=webinar-a&pane=cta'
    apiMocks.get.mockImplementation((id: string) => Promise.resolve({ data: { ...webinar, id, accountId: id === 'webinar-a' ? 'account-a' : 'account-b' } }))
    apiMocks.fetchApi.mockImplementation((url: string) => (url.includes('account-a') ? formsA.promise : formsB.promise))
    apiMocks.ctas.mockImplementation((id: string) => (id === 'webinar-a' ? ctasA.promise : ctasB.promise))

    const view = await mount(<EditWebinarPage />)
    navigationMocks.query = 'id=webinar-b&pane=cta'
    const frame = await view.rerender(<EditWebinarPage />)
    expect(frame.options).not.toContain('旧フォームA')
    expect(frame.inputs).not.toContain('旧CTA・A')

    /* 前のウェビナーの応答が、後のウェビナーの応答より先に届く。 */
    formsA.resolve({ success: true, data: [{ id: 'form-a', name: '旧フォームA', isActive: true }] })
    ctasA.resolve({ data: [ctaCard('旧CTA・A', 30, 'form-a')] })
    await flush()
    expect(optionLabels(view.container)).not.toContain('旧フォームA')
    expect(inputValues(view.container)).not.toContain('旧CTA・A')
    expect(view.container.textContent).toContain('回答フォームを読み込んでいます。')

    formsB.resolve({ success: true, data: [{ id: 'form-b', name: '新フォームB', isActive: true }] })
    ctasB.resolve({ data: [ctaCard('新CTA・B', 60, 'form-b')] })
    await flush()
    expect(optionLabels(view.container)).toContain('新フォームB')
    expect(inputValues(view.container)).toContain('新CTA・B')
    expect(optionLabels(view.container)).not.toContain('旧フォームA')
    expect(inputValues(view.container)).not.toContain('旧CTA・A')
  })

  it('候補を取り直す間は前の候補を消し、揃うまで申込フォームを保存できない', async () => {
    const retry = deferred<FormsResponse>()
    navigationMocks.query = 'id=webinar-1&pane=cta'
    /* CTA カードのフォーム選択にも候補が出る。取り直しの間はそこからも消す。 */
    apiMocks.ctas.mockResolvedValue({ data: [ctaCard('相談', 30, 'form-a')] })
    apiMocks.fetchApi
      .mockResolvedValueOnce({ success: true, data: [{ id: 'form-a', name: '旧フォームA', isActive: true }] })
      .mockImplementationOnce(() => retry.promise)
    apiMocks.saveEditor.mockRejectedValue(new apiMocks.ApiError(409, 'form_inactive_or_missing'))

    const view = await mount(<EditWebinarPage />)
    expect(optionLabels(view.container)).toContain('旧フォームA')

    await changeSelect(view.container, '申込に使う回答フォーム', 'form-a')
    await clickButton(view.container, '下書きを保存')

    /* サーバーが拒否したので候補を取り直す。取り直しの間は前の候補を出さない。 */
    expect(apiMocks.fetchApi).toHaveBeenCalledTimes(2)
    expect(optionLabels(view.container)).not.toContain('旧フォームA')
    expect(view.container.textContent).toContain('回答フォームを読み込んでいます。')
    expect(isDisabled(findButton(view.container, '下書きを保存'))).toBe(true)

    retry.resolve({ success: true, data: [{ id: 'form-c', name: '選び直し用フォームC', isActive: true }] })
    await flush()
    expect(optionLabels(view.container)).toContain('選び直し用フォームC')
    expect(isDisabled(findButton(view.container, '下書きを保存'))).toBe(false)
  })

  it('分析は実際に表示している集計とグラフだけを案内する', async () => {
    navigationMocks.query = 'id=webinar-1&pane=analytics'
    const view = await mount(<EditWebinarPage />)
    const ids = new Set(elements(view.container).map((element) => element.getAttribute('id')))
    for (const id of ['webinar-analytics-funnel', 'webinar-analytics-retention']) expect(ids.has(id)).toBe(true)
    expect(view.container.querySelector('[data-kpi-presentation]')).not.toBeNull()
    expect(elements(view.container).some((element) => element.getAttribute('aria-label') === 'この段の見出しへ移動')).toBe(false)
    expect(view.container.textContent).not.toContain('設定サマリー')
  })})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))

// 保存/API境界は現役の選ぶ欄も以前のSelectと同じ土台へ合わせる。
vi.mock('@/components/shared/entity-picker-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/entity-picker-sources')>()),
  EntityKindField: ({label,options,value,onChange,disabled}: {label:string; options: Array<{id:string;name?:string;label?:string}>; value:string; onChange:(id:string)=>void;disabled?:boolean}) => <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}><option value="">未設定</option>{options.map(option => <option key={option.id} value={option.id}>{option.name ?? option.label}</option>)}</select>,
}))
