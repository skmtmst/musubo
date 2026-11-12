// @vitest-environment happy-dom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/hq/support',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('./auth-guard', () => ({
  default: ({ suspendedSupport }: { suspendedSupport?: React.ReactNode }) => <>{suspendedSupport}</>,
  useOnboardingAccess: () => false,
}))

vi.mock('./hq/platform-notices', () => ({
  default: () => <section data-design-node="EJ6sm">運営からのお知らせ</section>,
}))

vi.mock('./session-lost-notice', () => ({ default: () => null }))

import AppShell from './app-shell'

describe('停止中のお問い合わせシェル（管理画面 IwfA0）', () => {
  it('お問い合わせだけのメニュー、停止帯、切替なしのトップバー、利用停止中の札を出す', () => {
    const html = renderToStaticMarkup(<AppShell><div data-support-page>問い合わせフォーム</div></AppShell>)

    expect(html).toContain('data-design-node="IwfA0"')
    expect(html).toContain('data-design-node="MdTiR"')
    expect(html).toContain('ご契約の利用が停止されています')
    expect(html).toContain('お問い合わせ')
    expect(html).toContain('利用停止中')
    expect(html).toContain('data-design-node="EJ6sm"')
    expect(html).not.toContain('LINEアカウント')
    expect(html).not.toContain('店舗管理')
    expect(html).toContain('data-support-page')
  })
})
