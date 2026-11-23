// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ get: vi.fn(), conversations:vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ inboxResponseApi: { get: fixture.get, conversations:fixture.conversations } }))
import InboxResponse from './inbox-response'
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('店舗を切り替えた瞬間から前の店舗の担当別集計を隠す', async () => {
  fixture.get.mockResolvedValueOnce({ data: { byStaff: [{staffId:'s',name:'担当者A',count:2,conversationCount:1,medianFirstResponseMinutes:5,withinSlaRate:100}], automatic:{count:0}, weekly:[] } }).mockImplementation(() => new Promise(() => {}))
  const view=render(<InboxResponse accountId="a" />)
  await screen.findByText('担当者A')
  view.rerender(<InboxResponse accountId="b" />)
  expect(screen.queryByText('担当者A')).toBeNull()
})
it('会話数を押すと、その担当の会話一覧を開く',async()=>{
 fixture.get.mockResolvedValue({data:{period:{from:'2026-10-01',to:'2026-10-31'},byStaff:[{staffId:'s',name:'担当者A',count:2,conversationCount:1,medianFirstResponseMinutes:5,withinSlaRate:100}],automatic:{count:0},weekly:[]}})
 fixture.conversations.mockResolvedValue({data:{items:[{chatId:'c',friendId:'f',name:'お客さまA',respondedAt:'2026-11-01'}],nextOffset:null}})
 render(<InboxResponse accountId="a" />)
 fireEvent.click(await screen.findByRole('button',{name:'2件（1会話）'}))
 expect((await screen.findByRole('link',{name:'お客さまA'})).getAttribute('href')).toBe('/chats?friend=f')
 expect(fixture.conversations).toHaveBeenCalledWith('a',expect.any(String),expect.any(String),'s',0)
})
