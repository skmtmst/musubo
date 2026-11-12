// @vitest-environment happy-dom
/*
 * ★V8 公開の前に確かめる（）の描画。
 * 差し替えるのは通信だけ。検査の一覧・まとめ・公開ボタンが実在する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  publishValidation: vi.fn(),
  notifications: vi.fn(),
  publish: vi.fn(),
  testPublicPage: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    webinarApi: {
      publishValidation: apiMocks.publishValidation,
      notifications: apiMocks.notifications,
      publish: apiMocks.publish,
      testPublicPage: apiMocks.testPublicPage,
    },
  }
})

import ReviewPane from '@/v8/webinar-edit/review'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import type { Webinar, WebinarEditor } from '@/lib/api'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

const WEBINAR = {
  id: 'webinar-1',
  title: 'NEN活用スタートセミナー',
  status: 'draft',
  videoPrefix: 'videos/nen-start.mp4',
  schedule: [{ type: 'daily', time: '10:00' }],
  cta: null,
  publicationState: 'unset',
  publicationStartsAt: '2026-10-01T10:00:00+09:00',
  publicationEndsAt: null,
} as unknown as Webinar

const EDITOR = {
  version: 4,
  monitoring: { notificationFailures: 0, viewSegmentFailures: 0, actionFailures: 0 },
} as unknown as WebinarEditor

let mounted: Root[] = []

function render(editor = EDITOR): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  mounted.push(root)
  act(() => {
    root.render(
      <ReviewPane
        ctx={webinarEditContext(WEBINAR, editor, { ctaCount: 2 })}
        chromeFor={(primary) => ({ ...webinarWizardChrome, footerActions: primary })}
      />,
    )
  })
  return host
}

describe('公開の前に確かめるのV8（XCUNf）', () => {
  beforeEach(() => {
    apiMocks.publishValidation.mockResolvedValue({
      data: {
        version: 4, blockers: [], warnings: [],
        checks: [
          { key: 'video', label: '動画の準備ができている', status: 'passed', detail: '' },
          { key: 'page', label: '公開ページを確かめた', status: 'failed', detail: 'ページをテストしてください' },
        ],
      },
    })
    apiMocks.notifications.mockResolvedValue({
      data: {
        settings: {
          registrationEnabled: true,
          dayBeforeEnabled: true,
          hourBeforeEnabled: false,
          startEnabled: false,
          missedEnabled: false,
          completedEnabled: false,
        },
      },
    })
  })

  afterEach(() => {
    act(() => { mounted.forEach((root) => root.unmount()); mounted = [] })
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('板IDと検査の一覧・まとめ・公開ボタンを描く', async () => {
    const host = render()
    await act(async () => undefined)
    expect(host.querySelector('[data-design-node="XCUNf"]')).not.toBeNull()
    expect(host.textContent).toContain('公開前の確認')
    expect(host.textContent).toContain('1/2')
    expect(host.textContent).toContain('できた')
    expect(host.textContent).toContain('まだ')
    expect(host.textContent).toContain('設定のまとめ')
    expect(host.textContent).toContain('この版を公開')
  })

  it('通っていないと公開ボタンを押せない', async () => {
    const host = render()
    await act(async () => undefined)
    const publish = [...host.querySelectorAll('button')].find((el) => el.textContent === 'この版を公開')
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    expect(apiMocks.publish).not.toHaveBeenCalled()
  })

  it('ページのテスト後は更新された保存版で公開し、二重クリックを一回にする', async () => {
    const checks = [{ key: 'page', label: '公開ページ', status: 'passed' }]
    apiMocks.publishValidation.mockResolvedValueOnce({ data: { version: 4, blockers: [], warnings: [], checks } }).mockResolvedValue({ data: { version: 5, blockers: [], warnings: [], checks } })
    apiMocks.testPublicPage.mockResolvedValue({ data: { ...EDITOR, version: 5, publicPage: { test: { status: 'passed' } } } })
    let reject!: (error: Error) => void
    apiMocks.publish.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
    const host = render()
    await act(async () => undefined)
    const button = (label: string) => [...host.querySelectorAll('button')].find((element) => element.textContent === label)!
    await act(async () => { button('ページをテスト').click() })
    expect(apiMocks.testPublicPage).toHaveBeenCalledWith('webinar-1', 4)
    await act(async () => { mounted[mounted.length - 1].render(<ReviewPane ctx={webinarEditContext(WEBINAR, { ...EDITOR, version: 5 }, { ctaCount: 2 })} chromeFor={(primary) => ({ ...webinarWizardChrome, footerActions: primary })} />) })
    await act(async () => { button('この版を公開').click(); button('この版を公開').click() })
    expect(apiMocks.publish).toHaveBeenCalledTimes(1)
    expect(apiMocks.publish).toHaveBeenCalledWith('webinar-1', 5)
    await act(async () => { reject(new Error('通信切れ')) })
    expect(host.textContent).toContain('公開できませんでした')
    expect((button('この版を公開') as HTMLButtonElement).disabled).toBe(false)
  })

  it('現在の補足から未確認のテストと監視の失敗件数を確認できる', async () => {
    const host = render({ ...EDITOR, monitoring: { ...EDITOR.monitoring, notificationFailures: 2, viewSegmentFailures: 1 } })
    await act(async () => undefined)
    fireEvent.click(host.querySelector('button[aria-label="ウェビナーの編集の説明"]')!)
    const note = host.querySelector('[role="note"]')
    expect(note?.textContent).toContain('通知のテスト送信・公開ページの確認が終わっていません。')
    expect(note?.textContent).toContain('3件の要確認')
  })

})
