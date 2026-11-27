// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import type { Webinar, WebinarEditor } from '@/lib/api'
const mocks = vi.hoisted(() => ({ notifications: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, webinarApi: { ...actual.webinarApi, notifications: mocks.notifications, publishValidation: vi.fn(async () => ({ data: { checks: [], blockers: [], version: 2 } })) } } })
import ReviewPane from './review'
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('通知設定の取得失敗を示し、読み直して件数を表示する', async () => {
  mocks.notifications.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { settings: { registrationEnabled: true, dayBeforeEnabled: true, hourBeforeEnabled: false, startEnabled: false, missedEnabled: false, completedEnabled: false } } })
  const editor = { version: 2, deliveryKind: 'on_demand', viewingCondition: { label: '' }, actionPolicy: { missingResultPolicy: 'escalate' } } as WebinarEditor
  const ctx = webinarEditContext({ id: 'webinar', title: '確認用', slug: 'test', status: 'draft', schedule: [], durationSeconds: 3600, accountId: 'target' } as Webinar, editor)
  render(<ReviewPane ctx={ctx} chromeFor={primary => ({ ...webinarWizardChrome, footerActions: primary })} />)
  const row = (await screen.findByText('通知設定を確認できません')).parentElement!
  fireEvent.click(within(row).getByRole('button', { name: '通知設定を読み直す' }))
  await within(row).findByText('2 つ（見逃し案内は止めている）')
  expect(screen.queryByText('通知設定を確認できません')).toBeNull()
})
