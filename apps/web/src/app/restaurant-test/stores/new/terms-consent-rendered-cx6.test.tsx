// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TERMS_DOCUMENT } from '@/content/terms/musubo-terms'

const fixture = vi.hoisted(() => ({ terms: vi.fn(), agree: vi.fn(), account: 'account-a' }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { termsAgreement: fixture.terms, agreeToTerms: fixture.agree } }))
import Page from './page'

let contentHeight = 400
let resize: (() => void) | undefined
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

beforeEach(() => {
  contentHeight = 400
  resize = undefined
  fixture.account = 'account-a'
  fixture.terms.mockResolvedValue({ data: { agreedVersion: null, agreedAt: null } })
  fixture.agree.mockResolvedValue({ data: { agreedAt: '2026-09-27 10:00:00' } })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => contentHeight })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalHeight)
  else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  if (originalClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClient)
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

function checkbox() { return screen.getByRole('checkbox', { name: /上記の利用規約/ }) as HTMLInputElement }
function submit() { return screen.getByRole('button', { name: '同意して次へ進む' }) as HTMLButtonElement }

it('規約が枠に収まるときは初めから読み終わり、同意チェックを求める', async () => {
  render(<Page />)
  const region = await screen.findByRole('region', { name: '利用規約' })
  expect(region.tabIndex).toBe(0)
  expect(checkbox().disabled).toBe(false)
  expect(submit().disabled).toBe(true)
  expect(screen.getByText('同意する場合は、チェックを入れてください。')).toBeTruthy()
  fireEvent.click(checkbox())
  expect(submit().disabled).toBe(false)
})

it('長い規約は最後まで読んだ後だけ同意でき、領域の大きさが変わっても再判定する', async () => {
  contentHeight = 900
  render(<Page />)
  const region = await screen.findByRole('region', { name: '利用規約' })
  expect(checkbox().disabled).toBe(true)
  expect(screen.getByText('利用規約を最後までお読みください。')).toBeTruthy()
  region.scrollTop = 493
  fireEvent.scroll(region)
  expect(checkbox().disabled).toBe(false)
  cleanup()
  contentHeight = 900
  render(<Page />)
  expect(checkbox().disabled).toBe(true)
  contentHeight = 400
  act(() => resize?.())
  expect(checkbox().disabled).toBe(false)
})

it('同意の保存中はチェックを変えられず、保存後は手順が完了になる', async () => {
  let finish!: (value: unknown) => void
  fixture.agree.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<Page />)
  await screen.findByRole('region', { name: '利用規約' })
  fireEvent.click(checkbox())
  fireEvent.click(submit())
  expect(checkbox().disabled).toBe(true)
  await act(async () => finish({ data: { agreedAt: '2026-09-27 10:00:00' } }))
  await screen.findByRole('heading', { name: '店舗の基本情報' })
  const steps = screen.getByRole('navigation', { name: '店舗を追加する手順' })
  expect(within(steps).getByRole('button', { name: '利用規約への同意に戻る' }).textContent).toContain('済み')
})

it('同意取得が失敗した新しいアカウントでは、前の基本情報を消して規約から始める', async () => {
  fixture.terms.mockResolvedValueOnce({ data: { agreedVersion: TERMS_DOCUMENT.version, agreedAt: '2026-09-27 10:00:00' } }).mockRejectedValueOnce(new Error('offline'))
  const view = render(<Page />)
  await screen.findByRole('heading', { name: '店舗の基本情報' })
  fixture.account = 'account-b'
  view.rerender(<Page />)
  await waitFor(() => expect(fixture.terms).toHaveBeenCalledWith('account-b'))
  expect(await screen.findByRole('heading', { name: '利用規約への同意' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '店舗の基本情報' })).toBeNull()
})
