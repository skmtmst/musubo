// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  routerPush: vi.fn(),
  termsAgreement: vi.fn(),
  agreeToTerms: vi.fn(),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.routerPush }),
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))
vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: {
    termsAgreement: fixture.termsAgreement,
    agreeToTerms: fixture.agreeToTerms,
  },
}))
import NewRestaurantStorePage from './page'

async function agree() {
  fireEvent.click(await screen.findByRole('checkbox', { name: /上記の利用規約/ }))
  fireEvent.click(screen.getByRole('button', { name: '同意して次へ進む' }))
}

// happy-dom は高さを測らない（0）。未計測では利用規約を読んだ扱いにしないので、読み切れる高さを与える。
const measured = ['clientHeight', 'scrollHeight'] as const
const original = Object.fromEntries(measured.map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]))

beforeEach(() => {
  for (const key of measured) Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 300 })
  fixture.termsAgreement.mockResolvedValue({ data: { agreedVersion: null, agreedAt: null } })
  fixture.agreeToTerms.mockResolvedValue({ data: { agreedAt: '2026-09-27 10:00:00' } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  for (const key of measured) {
    const descriptor = original[key]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  }
})

describe('R161: 店舗追加の書きかけがある間の離脱確認', () => {
  it('店舗名を入れて統括へ戻ると確認が出て、入力継続で内容が残る', async () => {
    render(<NewRestaurantStorePage />)
    await agree()
    await screen.findByRole('heading', { name: '店舗の基本情報' })
    const nameBox = screen.getByRole('textbox', { name: '店舗名' })
    fireEvent.change(nameBox, { target: { value: '渋谷店' } })

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await screen.findByText('保存していない変更があります')
    expect(fixture.routerPush).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    await waitFor(() => expect(screen.queryByText('保存していない変更があります')).toBeNull())
    expect((screen.getByRole('textbox', { name: '店舗名' }) as HTMLInputElement).value).toBe('渋谷店')
  })

  it('破棄を選んだときだけ統括へ進む', async () => {
    render(<NewRestaurantStorePage />)
    await agree()
    await screen.findByRole('heading', { name: '店舗の基本情報' })
    const nameBox = screen.getByRole('textbox', { name: '店舗名' })
    fireEvent.change(nameBox, { target: { value: '渋谷店' } })

    fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
    await screen.findByText('保存していない変更があります')

    fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
    await waitFor(() => expect(fixture.routerPush).toHaveBeenCalledWith('/hq'))
  })
})

describe('faGn4: 店舗の基本情報の案内', () => {
  it('プロバイダーの注意・同意済み・キャンセルが出る', async () => {
    render(<NewRestaurantStorePage />)
    await agree()
    await screen.findByRole('heading', { name: '店舗の基本情報' })
    await screen.findByText(/^店舗ごとに、新しいプロバイダーを作ってください。/)
    await screen.findByText(/利用規約に同意済み/, { selector: 'p' })
    expect(screen.getByRole('link', { name: 'キャンセル' })).toBeTruthy()
  })
})
