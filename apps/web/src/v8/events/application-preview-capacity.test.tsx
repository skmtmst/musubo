// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/api', () => ({ eventsApi: { applicationPreview: service.preview } }))
const { default: ApplicationPreview } = await import('./application-preview')
afterEach(() => { cleanup(); vi.clearAllMocks() })
const props = { accountId: 'a', draft: { name: '見本' } as never, date: '2026-12-01', startTime: '10:00', endTime: '11:00' }
const response = (capacity: number) => ({ name: '見本', startsAt: '2026-12-01T01:00:00Z', endsAt: '2026-12-01T02:00:00Z', capacity, requiresApproval: false, questions: [] })
it('定員が未入力なら仮の数を表示せず「定員なし」と出す', async () => {
  service.preview.mockResolvedValueOnce(response(1))
  render(<ApplicationPreview {...props} capacity="" />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText('定員なし')).toBeTruthy()
  expect(screen.queryByText(/残り.*席/)).toBeNull()
})
it('定員を入力したときは見本にその席数を出す', async () => {
  service.preview.mockResolvedValueOnce(response(5))
  render(<ApplicationPreview {...props} capacity="5" />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText('残り 5 席')).toBeTruthy()
  expect(screen.queryByText('定員なし')).toBeNull()
  expect(service.preview).toHaveBeenCalledWith('a', expect.objectContaining({ slot: expect.objectContaining({ capacity: 5 }) }))
})
it('0は1席と偽らず、定員の入力を直すよう伝える', async () => {
  render(<ApplicationPreview {...props} capacity="0" />)
  await act(async () => { screen.getByRole('button', { name: /プレビューを開く/ }).click() })
  expect(await screen.findByText('定員は1以上の整数で入力してください。')).toBeTruthy()
  expect(screen.queryByText(/残り.*席/)).toBeNull()
  expect(service.preview).not.toHaveBeenCalled()
})
