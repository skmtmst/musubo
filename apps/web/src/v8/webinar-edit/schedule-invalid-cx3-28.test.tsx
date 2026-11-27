import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 動画と公開期間（）・開催回（）の描画。
 * 差し替えるのは通信だけ。段の見出し・枠の一覧・数え方が実在する。
 */
import { fireEvent } from '@testing-library/react'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  editor: vi.fn(),
  update: vi.fn(),
  saveEditor: vi.fn(),
  videoAsset: vi.fn(),
  advanceVideoAsset: vi.fn(),
  webinarSession: vi.fn(),
  setSessionCapacity: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, media: { ...actual.api.media, list: async () => ({ success: true, data: { items: [] } }) } },
    webinarApi: {
      editor: apiMocks.editor,
      update: apiMocks.update,
      saveEditor: apiMocks.saveEditor,
      videoAsset: apiMocks.videoAsset,
      advanceVideoAsset: apiMocks.advanceVideoAsset,
      webinarSession: apiMocks.webinarSession,
      setSessionCapacity: apiMocks.setSessionCapacity,
    },
  }
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import WebinarVideoTestPane from '@/test-utils/webinar-video'
import type { Webinar, WebinarEditor } from '@/lib/api'

const WEBINAR = {
  id: 'webinar-1',
  accountId: 'account-1',
  title: 'NEN活用スタートセミナー',
  slug: 'nen-start',
  status: 'draft',
  videoPrefix: 'videos/nen-start.mp4',
  durationSeconds: 872,
  schedule: [
    { type: 'daily', time: '10:00' },
    { type: 'once', at: '2026-10-08T20:00:00+09:00' },
  ],
  cta: null,
  tagOnAttend: null,
  tagOnCtaClick: null,
  publicationStartsAt: '2026-10-01T10:00:00+09:00',
  publicationEndsAt: null,
  createdAt: '2026-09-01T00:00:00+09:00',
  updatedAt: '2026-10-01T00:00:00+09:00',
} as unknown as Webinar

const EDITOR = {
  version: 3,
  actionPolicy: { templateBody: '', missingResultPolicy: 'retry_next_day' },
} as WebinarEditor

const roots: Root[] = []
function render(editor = EDITOR, webinar = WEBINAR): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  roots.push(root)
  act(() => root.render(<WebinarVideoTestPane initialWebinar={webinar} initialEditor={editor} />))
  return host
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  vi.resetAllMocks()
  apiMocks.webinarSession.mockResolvedValue({ data: { session: null } })
  apiMocks.videoAsset.mockResolvedValue({ data: { asset: null } })
  apiMocks.editor.mockResolvedValue({ data: { version: 3 } })
})
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})
it('未知の配信枠を単発と決めつけない', () => {
  const host = render(EDITOR, { ...WEBINAR, schedule: [{ type: 'future' }] } as unknown as Webinar)
  expect(host.textContent).toContain('配信枠の種類を確認できません')
  expect(host.querySelector('[data-kind="future"]')?.textContent).not.toContain('単発')
})
it('不正な曜日を黙って落とさず確認できないと表示する', () => {
  const host = render(EDITOR, { ...WEBINAR, schedule: [{ type: 'weekly', days: [1, 9, 10], time: '10:00' }] } as Webinar)
  expect(host.textContent).toContain('曜日を確認できません')
  expect(host.textContent?.match(/曜日を確認できません/g)).toHaveLength(1)
  expect(host.textContent).toContain('10:00')
})
it('正しい曜日はこれまでどおり表示する', () => {
  const host = render(EDITOR, { ...WEBINAR, schedule: [{ type: 'weekly', days: [1, 3], time: '10:00' }] } as Webinar)
  expect(host.textContent).toContain('月・水 10:00')
})
