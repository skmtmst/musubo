// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { within } from '@testing-library/react'
import AccountDetailPage from './page'

/**
 * R73: 詳細の「編集する」「差し替える」が、入力欄も保存操作も無い
 * 資格情報タブへ飛ばすだけで終わっていた。
 *
 * 直し: どちらも既存の編集窓（AccountEditModal）を開く。「編集する」は
 * 登録内容、「差し替える」は資格情報の入力欄を開いた状態。保存口は
 * 統括・管理者だけに開く。
 */


const fixture = vi.hoisted(() => ({
  tab: 'overview' as string | null,
  role: 'owner' as 'owner' | 'staff',
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.ComponentProps<'a'>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => ({
    get: (key: string) => (key === 'id' ? 'a1' : key === 'tab' ? fixture.tab : null),
  }),
  usePathname: () => '/accounts/detail',
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
  usePageChrome: () => ({ title: null, fullWidth: false }),
}))

vi.mock('@/components/accounts/test-recipients-setting', () => ({
  default: () => <div data-testid="test-recipients-stub" />,
}))

vi.mock('@/components/step-up-prompt', () => ({
  default: () => null,
  isStepUpRequired: () => false,
}))

const ACCOUNT = {
  id: 'a1', channelId: '2007123456', name: '然-NEN- TEST',
  loginChannelId: null, liffId: null, isActive: true,
  channelSecretConfigured: true, channelAccessTokenConfigured: true,
  loginChannelSecretConfigured: false,
  channelSecretLast4: null, channelAccessTokenLast4: null, loginChannelSecretLast4: null,
  channelSecretUpdatedAt: null, channelAccessTokenUpdatedAt: null, loginChannelSecretUpdatedAt: null,
  country: null, role: null, timezone: 'Asia/Tokyo', displayOrder: 0,
  ogSiteName: null, ogDefaultDescription: null, ogDefaultImageUrl: null,
  parentLineAccountId: null, friendCapacity: null, capacityWarnAt: null, iconUrl: null,
  archivedAt: null, inactivatedAt: null, inactiveReasonDetail: null,
  webhook: { expectedUrl: 'https://w.example.com/webhook', actualUrl: 'https://w.example.com/webhook', active: true, status: 'matched' },
  connection: { lastTestStatus: 'succeeded', lastTestAt: '2026-09-26T10:00:00+09:00', lastReceivedAt: null },
  stats: { friendCount: 120, activeScenarios: 1, messagesThisMonth: 10 },
  createdAt: '2026-09-01T00:00:00+09:00', updatedAt: '2026-09-01T00:00:00+09:00',
}

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    let body: unknown
    if (path === '/api/staff/me') body = { success: true, data: { role: fixture.role } }
    else if (path.includes('/test-recipients')) body = {success:true,data:[]}
    else if (path === '/api/line-accounts/a1') body = { success: true, data: ACCOUNT }
    else if (path === '/api/line-accounts' || path.startsWith('/api/line-accounts?')) {
      body = { success: true, data: [ACCOUNT] }
    } else body = { success: false, error: `未設定: ${path}` }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme='v8'
  fixture.tab = 'overview'
  fixture.role = 'owner'
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove(); delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

async function renderPage() {
  await act(async () => { root.render(<AccountDetailPage />) })
  // load の二重取得と staff/me を流す。
  await act(async () => { await Promise.resolve() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function clickButton(label: string) {
  const button = [...document.body.querySelectorAll('button')].find((el) => el.textContent?.trim() === label)
  expect(button, `ボタン「${label}」がある`).toBeTruthy()
  act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('R73 編集・差替えの入口', () => {
  it('「編集」で登録内容の入力窓が開く', async () => {
    await renderPage()
    clickButton('編集する')
    expect(document.body.textContent).toContain('登録の内容を編集する')
    expect(within(document.body).getByLabelText('タイムゾーン')).toBeTruthy()
    const nameInput = document.body.querySelector('input[value="然-NEN- TEST"]')
    expect(nameInput).toBeTruthy()
  })

  it('「差し替える」で資格情報の入力窓が開く', async () => {
    await renderPage()
    clickButton('差し替える')
    expect(document.body.textContent).toContain('資格情報を差し替える')
  })

  it('運用担当には入力の入口を灰色＋理由で出し、押しても開かない', async () => {
    fixture.role = 'staff'
    await renderPage()
    const locked = (label: string) => [...host.querySelectorAll('button')].filter((el) => el.textContent?.includes(label))
    for (const label of ['編集する', '差し替える']) {
      expect(locked(label).length, label).toBeGreaterThan(0)
      for (const el of locked(label)) expect(el.getAttribute('aria-disabled'), label).toBe('true')
    }
    clickButton('差し替える')
    expect(document.body.textContent).not.toContain('資格情報を差し替える')
  })

  it('資格情報タブにも保存の入口がある', async () => {
    fixture.tab = 'credentials'
    await renderPage()
    expect(document.body.textContent).toContain('秘密値そのものは表示しません')
    clickButton('差し替える')
    expect(document.body.textContent).toContain('資格情報を差し替える')
  })
})

describe('91 登録の内容は1枚のカード', () => {
  it('つづきに割らず、友だち数・状態・国・地域・役割メモを同じカードに出す', async () => {
    await renderPage()
    const card = host.querySelector('[aria-labelledby="acd-basic"]')
    expect(card).toBeTruthy()
    for (const label of ['友だち数', '状態', '国・地域', '役割メモ']) {
      expect(within(card as HTMLElement).getByText(label)).toBeTruthy()
    }
    expect(host.textContent).not.toContain('登録の内容（つづき）')
  })
})

 it('V8 saves timezone through PUT and reloads the account', async () => {
    await renderPage(); clickButton('編集する');
    const input = within(document.body).getByLabelText('タイムゾーン') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Europe/Paris');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return original(url, init);
    });
    await act(async () => { [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '保存する')!.click(); });
    expect(requests.some((r) => r.init?.method === 'PUT' && JSON.parse(String(r.init.body)).timezone === 'Europe/Paris')).toBe(true);
 });

vi.mock('@/contexts/account-context', () => ({useAccount: () => ({selectedAccountId:'a1',selectedAccount:{id:'a1',name:'Fixture'},accounts:[],loading:false})}))
