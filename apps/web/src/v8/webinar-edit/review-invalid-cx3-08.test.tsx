// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Webinar, WebinarAnalytics, WebinarEditor } from '@/lib/api'
import ReviewPane from './review'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'

vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), webinarApi: { publishValidation: vi.fn().mockResolvedValue({ data: { version: 2, blockers: [], warnings: [], checks: [] } }), notifications: vi.fn().mockResolvedValue({ data: { settings: null } }) } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
afterEach(cleanup)
const webinar = { id: 'w', accountId: 'a', title: '見本', slug: 'test', status: 'active', videoPrefix: 'v', durationSeconds: 100, schedule: [], cta: null } as unknown as Webinar
const editor = { version: 2 } as WebinarEditor
async function openSummary(data: Webinar, analytics: WebinarAnalytics | null) {
  render(<ReviewPane ctx={webinarEditContext(data, editor, { analytics })} chromeFor={primary => ({ ...webinarWizardChrome, footerActions: primary })} />)
  fireEvent.click(await screen.findByRole('button', { name: 'ウェビナーの編集の説明' }))
  return screen.getByRole('note')
}

it('未知の公開状態をアーカイブと表示しない', async () => {
  const note = await openSummary({ ...webinar, status: 'future' } as unknown as Webinar, null)
  expect(note.textContent).toContain('公開：確認できません')
  expect(note.textContent).not.toContain('公開：アーカイブ')
})

it('負の申込人数を正しい人数として表示しない', async () => {
  const data = { summary: { reservations: -4 } } as unknown as WebinarAnalytics
  const note = await openSummary(webinar, data)
  expect(note.textContent).toContain('申込：—')
  expect(note.textContent).not.toContain('申込：-4人')
})
