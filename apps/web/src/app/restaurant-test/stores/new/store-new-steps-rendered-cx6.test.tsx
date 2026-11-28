// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ terms: vi.fn(), agree: vi.fn(), connect: vi.fn(), account: 'account-1' as string | null }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { termsAgreement: fixture.terms, agreeToTerms: fixture.agree, connectStore: fixture.connect } }))
import Page from './page'

// 規約が枠に収まる高さにして、初めから読み終わった状態で手順を進める。
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 400 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
  fixture.terms.mockResolvedValue({ data: { agreedVersion: null, agreedAt: null } })
  fixture.agree.mockResolvedValue({ data: { agreedAt: '2026-09-27 10:00:00' } })
  fixture.connect.mockResolvedValue({ data: { store: { id: 'store-1', name: '試験店舗' }, lineAccountName: '試験LINE' } })
  fixture.account = 'account-1'
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
  else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

function expectStep(step: number) {
  const help = screen.getByRole('button', { name: '店舗を追加の説明' })
  fireEvent.click(help)
  expect(document.getElementById(help.getAttribute('aria-describedby')!)?.textContent).toContain(`ステップ ${step} / 5`)
  fireEvent.keyDown(document, { key: 'Escape' })
}

async function completeSteps() {
  render(<Page />)
  expect(await screen.findByRole('heading', { name: '利用規約への同意' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'キャンセル' }).getAttribute('href')).toBe('/hq')
  expect(fixture.terms).toHaveBeenCalledWith(fixture.account)
  expectStep(1)
  fireEvent.click(screen.getByRole('checkbox', { name: /上記の利用規約/ }))
  fireEvent.click(screen.getByRole('button', { name: '同意して次へ進む' }))
  expect(await screen.findByRole('heading', { name: '店舗の基本情報' })).toBeTruthy()
  expectStep(2)
  expect(screen.getByText(/店舗ごとに、新しいプロバイダーを作ってください。/).textContent).toContain('同じお客様を店舗ごとに別々に管理できなくなります。')
  fireEvent.change(screen.getByRole('textbox', { name: '店舗名' }), { target: { value: '試験店舗' } })
  fireEvent.click(screen.getByRole('button', { name: '次へ' }))
  expect(await screen.findByRole('heading', { name: 'LINE公式アカウントを作る' })).toBeTruthy()
  expect(screen.getByText('まずはLINE公式アカウントの登録を行いましょう。')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '次へ' }))
  expect(await screen.findByRole('heading', { name: 'Messaging APIで接続' })).toBeTruthy()
  expect(screen.getByText('よくある質問')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('チャネルID', { exact: true }), { target: { value: '1234567890' } })
  const secret = screen.getByLabelText('チャネルシークレット', { exact: true }) as HTMLInputElement
  expect(secret.type).toBe('password')
  fireEvent.change(secret, { target: { value: 'test-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '次へ' }))
  expect(await screen.findByRole('heading', { name: '接続の確認' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'アカウントセットアップ実行' })).toBeTruthy()
  expectStep(5)
  expect(fixture.agree).toHaveBeenCalledTimes(1)
}

it('規約同意から接続確認まで５段階を進み、必要な入力と案内を表示する', async () => {
  await completeSteps()
})

it('店舗未選択でも規約同意から登録でき、統括の店舗一覧へ戻れる', async () => {
  fixture.account = null
  await completeSteps()
  fireEvent.click(screen.getByRole('button', { name: 'アカウントセットアップ実行' }))
  expect((await screen.findByRole('link', { name: '統括の店舗一覧へ' })).getAttribute('href')).toBe('/hq')
  expect(fixture.connect).toHaveBeenCalledWith(null, expect.objectContaining({ name: '試験店舗' }))
})
