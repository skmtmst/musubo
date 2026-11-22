// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ inboxResponseApi: { get: fixture.get } }))
import InboxResponse from './inbox-response'
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('店舗を切り替えた瞬間から前の店舗の担当別集計を隠す', async () => {
  fixture.get.mockResolvedValueOnce({ data: { byStaff: [{staffId:'s',name:'担当者A',count:2,medianFirstResponseMinutes:5,withinSlaRate:100}], automatic:{count:0}, weekly:[] } }).mockImplementation(() => new Promise(() => {}))
  const view=render(<InboxResponse accountId="a" />)
  await screen.findByText('担当者A')
  view.rerender(<InboxResponse accountId="b" />)
  expect(screen.queryByText('担当者A')).toBeNull()
})
