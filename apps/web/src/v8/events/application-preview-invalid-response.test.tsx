// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/api', () => ({ eventsApi: { applicationPreview: service.preview } }))
const { default: ApplicationPreview } = await import('./application-preview')
afterEach(() => { cleanup(); vi.clearAllMocks() })
const props = { accountId: 'a', draft: { name: '見本' } as never, date: '2026-12-01', startTime: '10:00', endTime: '11:00', capacity: '5' }
it('不正な見本は画面を壊さず、読み直して表示できる', async () => {
  service.preview.mockResolvedValueOnce({ name: '見本', questions: null }).mockResolvedValueOnce({ name: '見本', startsAt: '2026-12-01T01:00:00Z', endsAt: '2026-12-01T02:00:00Z', capacity: 5, requiresApproval: false, questions: [] })
  render(<ApplicationPreview {...props} />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText(/見本の内容を確認できませんでした/)).toBeTruthy()
  await act(async () => { screen.getByRole('button', { name: 'もう一度読み込む' }).click() })
  expect(await screen.findByText('残り 5 席')).toBeTruthy()
})
