// @vitest-environment happy-dom
/*
 * 飲食店向けの店舗追加ウィザード（★V8 ao15G・faGn4）。
 * 利用規約を先頭にした5段を描き、段を進めるとチャネルシークレットを伏せ字の欄で受けること。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMS_DOCUMENT } from '@/content/terms/musubo-terms'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const termsAgreement = vi.hoisted(() => vi.fn())

vi.mock('@/lib/restaurant-test-api', async (importOriginal: () => Promise<typeof import('@/lib/restaurant-test-api')>) => {
  const actual = await importOriginal()
  return { ...actual, restaurantTestApi: { ...actual.restaurantTestApi, termsAgreement } }
})
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/restaurant-test/stores/new',
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

import StoreNewV8 from './store-new'

const STEP_LABELS = ['利用規約への同意', '店舗の基本情報', 'LINE公式アカウントを作る', 'Messaging APIで接続', '接続の確認']

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  termsAgreement.mockReset().mockResolvedValue({ success: true, data: { agreedVersion: TERMS_DOCUMENT.version, agreedAt: '2026-10-01T00:00:00.000Z' } })
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('店舗を追加（5段のウィザード）', () => {
  it('利用規約を先頭にした5段を、この順で描く', async () => {
    render(<StoreNewV8 />)
    await settle()
    const nav = screen.getByRole('navigation', { name: '店舗を追加する手順' })
    // 段の並び（ol の li）。下の「設定済みの内容」の一覧は数えない。
    const items = [...nav.querySelectorAll('ol > li')]
    expect(items).toHaveLength(5)
    STEP_LABELS.forEach((label, index) => expect(items[index].textContent).toContain(label))
  })

  it('規約に同意済みなら②から始め、説明に今の段を「ステップ 2 / 5」と書く', async () => {
    render(<StoreNewV8 />)
    await settle()
    expect(screen.getByRole('heading', { name: '店舗の基本情報' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '店舗を追加の説明' }))
    await settle()
    expect(document.body.textContent).toContain('ステップ 2 / 5')
  })

  it('④ではチャネルシークレットを伏せ字の欄で受ける', async () => {
    render(<StoreNewV8 />)
    await settle()
    fireEvent.input(screen.getByRole('textbox', { name: '店舗名' }), { target: { value: '然 本店' } })
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE公式アカウントを作成済みです' }))
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Messaging APIで接続' })).toBeTruthy()
    const secret = document.querySelector('input[aria-label="チャネルシークレット"]') as HTMLInputElement
    expect(secret?.type).toBe('password')
  })
})
