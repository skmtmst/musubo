// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/api', () => ({ eventsApi: { applicationPreview: service.preview } }))
const { default: ApplicationPreview } = await import('./application-preview')
afterEach(() => { cleanup(); vi.clearAllMocks() })
const props = { accountId: 'a', draft: { name: '見本' } as never, date: '2026-12-01', startTime: '10:00', endTime: '11:00', capacity: '5' }
const response = (name: string) => ({ name, startsAt: '2026-12-01T01:00:00Z', endsAt: '2026-12-01T02:00:00Z', capacity: 5, requiresApproval: false, questions: [] })
it('アカウントが変わったら古い見本を閉じ、遅い応答を新しい見本に混ぜない', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  service.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(response('新しい見本'))
  const view = render(<ApplicationPreview {...props} />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(screen.getByRole('dialog', { name: 'お客さまの申込ページの見本' })).toBeTruthy()
  view.rerender(<ApplicationPreview {...props} accountId="b" />)
  expect(screen.queryByRole('dialog', { name: 'お客さまの申込ページの見本' })).toBeNull()
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText('新しい見本')).toBeTruthy()
  await act(async () => { finish(response('古い見本')) })
  expect(screen.queryByText('古い見本')).toBeNull()
  expect(screen.getByText('新しい見本')).toBeTruthy()
})
it('変更直後に古い応答が届いても見本を表示しない', async () => {
  let finish!: (value: ReturnType<typeof response>) => void
  service.preview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ApplicationPreview {...props} />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  view.rerender(<ApplicationPreview {...props} accountId="b" />)
  await act(async () => { finish(response('古い見本')) })
  expect(screen.queryByRole('dialog', { name: 'お客さまの申込ページの見本' })).toBeNull()
  expect(screen.queryByText('古い見本')).toBeNull()
})
it('定員を変えたときも古い見本を閉じる', async () => {
  service.preview.mockResolvedValueOnce(response('古い見本'))
  const view = render(<ApplicationPreview {...props} />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText('古い見本')).toBeTruthy()
  view.rerender(<ApplicationPreview {...props} capacity="8" />)
  expect(screen.queryByRole('dialog', { name: 'お客さまの申込ページの見本' })).toBeNull()
})
