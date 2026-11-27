import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React from 'react'
import { fireEvent, render, screen, cleanup, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createEvent = vi.hoisted(() => vi.fn())
const createSlots = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const previewProps = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ eventsApi: { createEvent, createSlots }, ApiError: class extends Error {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-unsaved-guard', () => ({ useUnsavedGuard: () => ({ leaveTarget: null, confirmLeave: vi.fn(), cancelLeave: vi.fn() }) }))
vi.mock('./application-preview', () => ({ default: (props: unknown) => { previewProps(props); return null } }))
import EventsCreate from './create'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-03T08:00:00Z'))
  createEvent.mockReset()
  createSlots.mockReset()
  push.mockReset()
  previewProps.mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('イベント作成の入力確認', () => {
  it('概要と同じ画面で日付・開始・終了・定員を入力できる', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T08:00:00Z'))
    try {
      render(<EventsCreate />)
      expect(screen.getByLabelText('イベント名')).toBeTruthy()
      expect(screen.getByLabelText('日付').id).toBe('ev-new-date')
      expect(screen.getByLabelText('開始の時刻').id).toBe('ev-new-start')
      expect(screen.getByLabelText('終わりの時刻').id).toBe('ev-new-end')
      const capacity = screen.getByLabelText('定員') as HTMLInputElement
      expect(capacity.id).toBe('ev-new-cap')
      fireEvent.change(capacity, { target: { value: '25' } })
      expect(capacity.value).toBe('25')
    } finally { cleanup(); vi.useRealTimers() }
  })

  it('入力した名前・日付・定員を申込プレビューへ渡す', () => {
    render(<EventsCreate />)
    const preview = screen.getByLabelText('申込ページの見え方')
    expect(within(preview).getByText('イベント名')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('イベント名'), { target: { value: '体験会' } })
    expect(within(preview).getByText('体験会')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('日付'))
    fireEvent.click(screen.getByRole('button', { name: '2026年11月2日（月）' }))
    fireEvent.click(screen.getByRole('button', { name: '確定' }))
    fireEvent.change(screen.getByLabelText('定員'), { target: { value: '25' } })
    expect(previewProps.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      accountId: 'account-a', draft: expect.objectContaining({ name: '体験会' }),
      date: '2026-11-02', capacity: '25',
      startTime: (screen.getByLabelText('開始の時刻') as HTMLInputElement).value.replace(/\s/g, ''),
      endTime: (screen.getByLabelText('終わりの時刻') as HTMLInputElement).value.replace(/\s/g, ''),
    }))
  })

  it('保存前に不足する欄を知らせて名前へ移り、通信しない', () => {
    render(<EventsCreate />)
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    const name = screen.getByLabelText('イベント名')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(name)
    expect(screen.getByLabelText('定員').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual(['イベント名を入れてください', '定員は1以上の数で入れてください'])
    expect(screen.queryByText('直す所があります。赤い理由を確かめてください。')).toBeNull()
    expect(createEvent).not.toHaveBeenCalled()
    expect(name.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('名前を直すと名前の赤が消え、保存時は定員へ移る', () => {
    render(<EventsCreate />)
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    fireEvent.change(screen.getByLabelText('イベント名'), { target: { value: '体験会' } })
    expect(screen.getByLabelText('イベント名').getAttribute('aria-invalid')).toBeNull()
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    expect(document.activeElement).toBe(screen.getByLabelText('定員'))
    expect(createEvent).not.toHaveBeenCalled()
  })

  it('オンラインURLの誤りは、その欄だけで知らせる', () => {
    render(<EventsCreate />)
    fireEvent.change(screen.getByLabelText('イベント名'), { target: { value: '相談会' } })
    fireEvent.change(screen.getByLabelText('定員'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('オンラインの URL'), { target: { value: 'https://' } })
    fireEvent.click(screen.getByRole('button', { name: '公開する' }))
    expect(document.activeElement).toBe(screen.getByLabelText('オンラインの URL'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(createEvent).not.toHaveBeenCalled()
  })
})

it('初期日時は未来で、過去の日付を確認してから保存できる', async () => {
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00Z'))
 try {
  createEvent.mockResolvedValue({id:'past-event',version:1,is_published:0})
  createSlots.mockImplementation(async (_account, eventId, slots) => ({items:[{...slots[0],id:'past-slot',event_id:eventId,version:1}]}))
  render(<EventsCreate />)
  expect(screen.getByLabelText('日付').getAttribute('title')).toContain('2026年11月4日')
  fireEvent.click(screen.getByLabelText('日付'))
  fireEvent.click(screen.getByRole('button',{name:'2026年11月2日（月）'}))
  fireEvent.click(screen.getByRole('button',{name:'確定'}))
  expect(screen.getByText('開始日時が過去です。日時を確認してください。')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('イベント名'), { target: { value: '体験会' } })
  fireEvent.change(screen.getByLabelText('定員'), { target: { value: '20' } })
  fireEvent.click(getPageAction({ name: '下書きを保存' }))
  expect(createEvent).not.toHaveBeenCalled()
  const confirmation = screen.getByRole('dialog', { name: '過去の日時で保存しますか？' })
  expect(within(confirmation).getByText(/開始日時が過去/)).toBeTruthy()
  fireEvent.click(within(confirmation).getByRole('button', { name: 'この日時で保存する' }))
  await waitFor(() => expect(push).toHaveBeenCalled())
  expect(createEvent).toHaveBeenCalledTimes(1)
  expect(createSlots.mock.calls[0][2][0].starts_at).toBe('2026-11-02T05:00:00.000Z')
 } finally { cleanup(); vi.useRealTimers() }
})

it('過去日時の公開は確認を取り消すと送らず、確認すれば公開できる', async () => {
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-03T08:00:00Z'))
 createEvent.mockResolvedValue({id:'past-event',version:1,is_published:1})
 createSlots.mockImplementation(async (_account, eventId, slots) => ({items:[{...slots[0],id:'past-slot',event_id:eventId,version:1}]}))
 try {
  render(<EventsCreate />)
  fireEvent.click(screen.getByLabelText('日付'))
  fireEvent.click(screen.getByRole('button',{name:'2026年11月2日（月）'}))
  fireEvent.click(screen.getByRole('button',{name:'確定'}))
  fireEvent.change(screen.getByLabelText('イベント名'), { target: { value: '体験会' } })
  fireEvent.change(screen.getByLabelText('定員'), { target: { value: '20' } })
  const publish = () => { fireEvent.click(getPageAction({ name:'公開する' })); fireEvent.click(within(screen.getByRole('dialog',{name:'イベントを公開する'})).getByRole('button',{name:'公開する'})) }
  publish()
  const first=screen.getByRole('dialog',{name:'過去の日時で保存しますか？'})
  fireEvent.click(within(first).getByRole('button',{name:'キャンセル'}))
  expect(createEvent).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('dialog',{name:'過去の日時で保存しますか？'})).toBeNull())
  publish()
  fireEvent.click(within(screen.getByRole('dialog',{name:'過去の日時で保存しますか？'})).getByRole('button',{name:'この日時で保存する'}))
  await waitFor(() => expect(push).toHaveBeenCalled())
  expect(createEvent.mock.calls[0][1].is_published).toBe(1)
 } finally { cleanup(); vi.useRealTimers() }
})
